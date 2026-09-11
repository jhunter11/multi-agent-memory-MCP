import { createHash } from 'node:crypto';
import type { Edge, Entry, RecallInput } from '../contracts.js';
import { RecallInputSchema } from '../contracts.js';

export const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
export const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');
export const trustWeight = (t: number): number => 0.25 + 0.75 * t;
const stop = new Set(
  'a an and or of the to in on for with by at as is are was were be been it its this that these those from into if then than so do does did done can could should would will shall may might must have has had we you they he she i our your their when where which who whom what why how all any each few more most other some such only own same too very just also but while about after before between during through under over again earlier later current saved'.split(
    ' '
  )
);
export const terms = (s: string): string[] => [
  ...new Set(
    (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? []).filter(
      (w) => w.length > 1 && !stop.has(w)
    )
  )
];
const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
const norm = (a: number[]): number[] => {
  const n = Math.sqrt(dot(a, a)) || 1;
  return a.map((x) => x / n);
};
export interface VectorInput {
  records: Map<string, number[]>;
  query: number[];
  status: string;
}
interface Candidate {
  id: string;
  score: number;
  via: string[];
  path: string[];
  pathTrust: number;
}
interface Node {
  ids: string[];
  counts: Map<string, number>;
  words: Set<string>;
  vector: number[];
}
export interface EvidenceHit {
  entry: Entry;
  score: number;
  origin: string;
  hop: number;
  path: string[];
  why: string;
  trustBasis: string;
  bodySha256: string;
  edges: Edge[];
  otherEdgeCount: number;
}
export interface MetaPacket {
  schema: 'agent-evidence/v2';
  authority: 'retrieved-data-only';
  answerStatus: 'unverified';
  actionsAuthorized: false;
  trustPolicy: 'uncalibrated-rating';
  missingSupport: 'unknown';
  strategy: string;
  vectorStatus: string;
  maxHops: number;
  graphDecay: number;
  usedBytes: number;
  omittedForBudget: number;
  hits: EvidenceHit[];
}

/** One immutable read snapshot. Gold answers never enter this engine. */
export class MetaIndex {
  readonly byId: Map<string, Entry>;
  readonly adjacency = new Map<string, Edge[]>();
  readonly words = new Map<string, Set<string>>();
  readonly tree = new Map<string, Node>();
  readonly paths = new Map<string, string[]>();
  readonly df = new Map<string, number>();
  readonly hdc = new Map<string, Map<number, number>>();
  constructor(
    readonly entries: Entry[],
    readonly edges: Edge[],
    readonly vectors?: Map<string, number[]>
  ) {
    this.byId = new Map(entries.map((e) => [e.id, e]));
    for (const e of edges)
      for (const id of [e.fromId, e.toId]) {
        const adj = this.adjacency.get(id) ?? [];
        adj.push(e);
        this.adjacency.set(id, adj);
      }
    for (const e of entries) {
      const words = new Set(terms(e.title + ' ' + e.body));
      this.words.set(e.id, words);
      for (const w of words) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      const parts = e.scope.split('/'),
        paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
      this.paths.set(e.id, paths);
      if (e.supersededBy) continue;
      for (const path of paths) {
        const node: Node = this.tree.get(path) ?? {
          ids: [],
          counts: new Map(),
          words: new Set(),
          vector: []
        };
        node.ids.push(e.id);
        const headings = (e.body.match(/^#{1,6}\s+.+$/gm) ?? []).join(' ');
        for (const t of terms(e.title + ' ' + path + ' ' + headings))
          node.counts.set(t, (node.counts.get(t) ?? 0) + 1);
        const v = vectors?.get(e.id);
        if (v) v.forEach((x, i) => (node.vector[i] = (node.vector[i] ?? 0) + x));
        this.tree.set(path, node);
      }
    }
    for (const [path, n] of this.tree) {
      n.vector = norm(n.vector);
      n.words = new Set(
        [...n.counts]
          .sort((a, b) => b[1] * this.idf(b[0]) - a[1] * this.idf(a[0]) || a[0].localeCompare(b[0]))
          .slice(0, 32)
          .map((x) => x[0])
      );
      terms(path).forEach((t) => n.words.add(t));
    }
    for (const e of entries) this.hdc.set(e.id, this.encode(terms(e.title + ' ' + e.body)));
  }
  idf(w: string): number {
    return Math.log2((this.entries.length + 1) / ((this.df.get(w) ?? 0) + 1));
  }
  encode(words: string[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const w of words) {
      let seed = [...w].reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0), 7) >>> 0;
      const random = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let i = 0; i < 32; i++) {
        const k = Math.floor(random() * 4096),
          v = (random() < 0.5 ? -1 : 1) * this.idf(w);
        out.set(k, (out.get(k) ?? 0) + v);
      }
    }
    const n = Math.sqrt([...out.values()].reduce((s, v) => s + v * v, 0)) || 1;
    return new Map([...out].map(([k, v]) => [k, v / n]));
  }
  sort(hits: Candidate[]): Candidate[] {
    return hits.sort(
      (a, b) =>
        b.score - a.score ||
        (this.byId.get(b.id)?.updatedAt ?? '').localeCompare(
          this.byId.get(a.id)?.updatedAt ?? ''
        ) ||
        a.id.localeCompare(b.id)
    );
  }
  fuse(streams: { hits: Candidate[]; weight: number }[]): Candidate[] {
    const out = new Map<string, Candidate>();
    for (const { hits, weight } of streams)
      hits.slice(0, 80).forEach((h, i) => {
        const x = out.get(h.id) ?? { ...h, score: 0, via: [] };
        x.score += weight / (61 + i);
        x.via = [...new Set([...x.via, ...h.via])];
        out.set(h.id, x);
      });
    return this.sort([...out.values()]);
  }
  rank(input: RecallInput, lexical: Map<string, number>, vector?: VectorInput): Candidate[] {
    const q = RecallInputSchema.parse(input),
      ts = terms(q.task),
      den = ts.reduce((s, t) => s + this.idf(t), 0) || 1;
    if (!ts.length) return [];
    const coverage = (ws: Set<string>) =>
      ts.reduce((s, t) => s + (ws.has(t) ? this.idf(t) : 0), 0) / den;
    const hv = this.encode(ts),
      qv = vector?.query;
    const ns = new Map(
      [...this.tree].map(([k, n]) => [
        k,
        { lex: coverage(n.words), dense: qv ? Math.max(0, dot(n.vector, qv)) : 0 }
      ])
    );
    const raw = new Map<string, number[]>();
    for (const e of this.entries) {
      if (e.supersededBy && !q.includeSuperseded) continue;
      const nodes = (this.paths.get(e.id) ?? []).map((k) => ns.get(k) ?? { lex: 0, dense: 0 });
      const h = this.hdc.get(e.id) ?? new Map();
      let hd = 0;
      for (const [k, v] of hv) hd += v * (h.get(k) ?? 0);
      const v = vector?.records.get(e.id);
      raw.set(e.id, [
        lexical.get(e.id) ?? 0,
        qv && v ? Math.max(0, dot(v, qv)) : 0,
        Math.max(0, hd),
        Math.max(0, ...nodes.map((n) => n.lex)),
        Math.max(0, ...nodes.map((n) => n.dense))
      ]);
    }
    const proximity = (id: string) => {
      const scope = this.byId.get(id)!.scope;
      return scope === q.entryScope ? 1.05 : scope.startsWith(q.entryScope + '/') ? 1.03 : 1;
    };
    const stream = (field: number, label: string): Candidate[] =>
      this.sort(
        [...raw]
          .filter(([, f]) => (f[field] ?? 0) > 0)
          .map(([id, f]) => ({
            id,
            score: (f[field] ?? 0) * trustWeight(this.byId.get(id)!.trust) * proximity(id),
            via: [label],
            path: [id],
            pathTrust: this.byId.get(id)!.trust
          }))
      );
    const fts = stream(0, 'fts5'),
      dense = stream(1, 'dense'),
      hdc = stream(2, 'hdc'),
      cl = stream(3, 'concept-lexical'),
      cv = stream(4, 'concept-vector');
    // Hashed collisions alone cannot establish a relevant seed.
    const anchoredHdc = hdc.filter(
      (h) => (lexical.get(h.id) ?? 0) > 0 || (qv && (raw.get(h.id)?.[1] ?? 0) > 0.25)
    );
    const fusion = this.fuse([
      { hits: fts, weight: 1 },
      { hits: dense, weight: 1 }
    ]);
    const concept = this.fuse([
      { hits: fts, weight: 1 },
      { hits: dense, weight: 1 },
      { hits: cl, weight: 0.35 },
      { hits: cv, weight: 0.35 },
      { hits: anchoredHdc, weight: 0.5 }
    ]);
    const treelex = this.sort(
      [...raw]
        .map(([id, f]) => ({
          id,
          score: (0.65 * f[0]! + 0.35 * f[3]!) * trustWeight(this.byId.get(id)!.trust),
          via: ['lexical-concepts'],
          path: [id],
          pathTrust: this.byId.get(id)!.trust
        }))
        .filter((h) => h.score > 0)
    );
    const exactIdentifier =
      ts.length === 1 && /\d/u.test(ts[0]!) && fts.length > 0 && fts.length <= 8;
    const ranked =
      q.strategy === 'fusion'
        ? fusion
        : q.strategy === 'concept'
          ? concept
          : q.strategy === 'lexical' || (q.strategy === 'meta' && exactIdentifier)
            ? fts
            : this.fuse([
                { hits: fusion, weight: 1 },
                { hits: concept, weight: 0.65 },
                { hits: treelex, weight: 0.35 }
              ]);
    const peak = ranked[0]?.score || 1;
    const seeds = ranked.map((h) => ({ ...h, score: h.score / peak }));
    const best = new Map(seeds.map((h) => [h.id, h]));
    let frontier = seeds.slice(0, 8);
    for (let hop = 0; hop < q.maxHops; hop++) {
      const next: Candidate[] = [];
      for (const s of frontier)
        for (const e of this.adjacency.get(s.id) ?? []) {
          const id = e.fromId === s.id ? e.toId : e.fromId,
            r = this.byId.get(id);
          if (!r || s.path.includes(id) || (r.supersededBy && !q.includeSuperseded)) continue;
          const conflict = e.kind === 'contradicts' || e.kind === 'supersedes';
          const pathTrust = Math.min(s.pathTrust, r.trust);
          const score =
            (s.score *
              (q.graphDecay === 0 ? 0 : conflict ? 0.9 : q.graphDecay) *
              trustWeight(pathTrust)) /
            trustWeight(s.pathTrust) /
            (conflict ? 1 : Math.sqrt(Math.max(1, (this.adjacency.get(s.id)?.length ?? 1) / 5)));
          if (score <= 0) continue;
          if (!best.has(id) || score > best.get(id)!.score) {
            const h = { id, score, via: ['graph:' + e.kind], path: [...s.path, id], pathTrust };
            best.set(id, h);
            next.push(h);
          }
        }
      frontier = this.sort(next).slice(0, 12);
    }
    return this.sort([...best.values()]).slice(0, 200);
  }
  pack(input: RecallInput, hits: Candidate[], vectorStatus = 'disabled'): MetaPacket {
    const q = RecallInputSchema.parse(input);
    const p: MetaPacket = {
      schema: 'agent-evidence/v2',
      authority: 'retrieved-data-only',
      answerStatus: 'unverified',
      actionsAuthorized: false,
      trustPolicy: 'uncalibrated-rating',
      missingSupport: 'unknown',
      strategy: q.strategy,
      vectorStatus,
      maxHops: q.maxHops,
      graphDecay: q.graphDecay,
      usedBytes: 0,
      omittedForBudget: 0,
      hits: []
    };
    const measure = () => {
      p.usedBytes = 0;
      for (let i = 0; i < 5; i++) {
        const n = jsonBytes(p);
        if (n === p.usedBytes) break;
        p.usedBytes = n;
      }
      return p.usedBytes;
    };
    if (measure() > q.budgetBytes)
      throw new Error('budgetBytes is too small for the evidence envelope; use at least 512.');
    let ordered = hits;
    if (q.strategy === 'information') {
      const covered = new Set<string>(),
        wanted = new Set(terms(q.task));
      ordered = [];
      const remaining = hits.slice(0, 60);
      while (remaining.length) {
        const scored = remaining
          .map((h, i) => {
            const words = this.words.get(h.id)!;
            const novelty = [...words]
              .filter((t) => wanted.has(t) && !covered.has(t))
              .reduce((s, t) => s + this.idf(t), 0);
            return { i, s: (h.score + 0.1 * novelty) / Math.sqrt(jsonBytes(this.byId.get(h.id))) };
          })
          .sort((a, b) => b.s - a.s || a.i - b.i);
        const h = remaining.splice(scored[0]!.i, 1)[0]!;
        ordered.push(h);
        this.words.get(h.id)!.forEach((t) => covered.add(t));
      }
    }
    for (const h of ordered) {
      const entry = this.byId.get(h.id)!;
      const allEdges = this.adjacency.get(h.id) ?? [];
      const pathEdges = h.path.flatMap((id, i) =>
        i === 0
          ? []
          : (this.adjacency.get(id) ?? []).filter(
              (e) =>
                (e.fromId === id && e.toId === h.path[i - 1]) ||
                (e.toId === id && e.fromId === h.path[i - 1])
            )
      );
      const edges = [
        ...new Set([
          ...allEdges.filter((e) => e.kind === 'contradicts' || e.kind === 'supersedes'),
          ...pathEdges
        ])
      ];
      p.hits.push({
        entry,
        score: Number(h.score.toFixed(6)),
        origin: h.path.length > 1 ? 'graph' : 'fusion',
        hop: h.path.length - 1,
        path: h.path,
        why: h.via.join('+'),
        trustBasis: entry.trust === 0.5 ? 'default-or-untracked' : 'stored-feedback-not-audited',
        bodySha256: digest(entry.body),
        edges,
        otherEdgeCount: allEdges.filter((e) => !edges.includes(e)).length
      });
      if (measure() > q.budgetBytes) {
        p.hits.pop();
        p.omittedForBudget++;
      }
    }
    // Changing the omission count may grow its decimal representation.
    while (measure() > q.budgetBytes && p.hits.length) {
      p.hits.pop();
      p.omittedForBudget++;
    }
    measure();
    return p;
  }
}
