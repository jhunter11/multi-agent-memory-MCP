import DatabaseConstructor from 'better-sqlite3';
import type { z } from 'zod';

import {
  DEFAULT_TRUST,
  EdgeKindSchema,
  EdgeSchema,
  EntrySchema,
  FeedbackSchema,
  ListScopeInputSchema,
  RecallInputSchema,
  SearchInputSchema,
  WriteEntryInputSchema
} from '../contracts.js';
import type {
  Edge,
  EdgeKind,
  Entry,
  EntryKind,
  Feedback,
  MemoryStore,
  SearchHit
} from '../contracts.js';
import { newEntryId, newFeedbackId } from './id.js';
import {
  applySchema,
  FTS_WEIGHT_BODY,
  FTS_WEIGHT_ID,
  FTS_WEIGHT_TITLE,
  readSchemaVersion
} from './schema.js';

type Db = DatabaseConstructor.Database;

/** The three inputs are accepted before zod fills their defaults in. */
export type WriteEntryArgs = z.input<typeof WriteEntryInputSchema>;
export type SearchArgs = z.input<typeof SearchInputSchema>;
export type RecallArgs = z.input<typeof RecallInputSchema>;
export type ListScopeArgs = z.input<typeof ListScopeInputSchema>;

export interface SqliteMemoryStoreOptions {
  /** A file path, or `:memory:` for a database that lives only in this process. */
  dbPath: string;
}

// --- Ranking constants ------------------------------------------------------

/** How much of the gap to 1 or to 0 one piece of feedback closes. */
export const TRUST_STEP = 0.2;

/**
 * Scope proximity, the third factor in the score.
 *
 * The bands never overlap, so the relationship always outranks the depth inside
 * it: the entry's own scope beats any child, every child beats every parent, and
 * a scope that shares nothing still scores above zero. Nothing is filtered out by
 * being far away. A distant entry sinks, which is the same thing low trust does.
 */
const SCOPE_EXACT = 1;
const SCOPE_DESCENDANT_DECAY = 0.9;
const SCOPE_DESCENDANT_FLOOR = 0.6;
const SCOPE_ANCESTOR_TOP = 0.5;
const SCOPE_ANCESTOR_DECAY = 0.8;
const SCOPE_ANCESTOR_FLOOR = 0.3;
const SCOPE_SIBLING_BASE = 0.1;
const SCOPE_SIBLING_STEP = 0.05;
const SCOPE_SIBLING_CEILING = 0.25;
const SCOPE_UNRELATED = 0.1;

/**
 * How many text matches are pulled out of SQLite before trust and scope are
 * applied. The cut has to be wider than the caller's limit, because a strong
 * text match with low trust can lose its place to a weaker match that is trusted.
 */
const CANDIDATE_FLOOR = 500;
const CANDIDATE_MULTIPLE = 20;
/** How many ranked hits `recall` considers when it fills the byte budget. */
const RECALL_CANDIDATES = 200;
/** Query words past this point add noise, not recall. */
const MAX_QUERY_TERMS = 24;

export type ScopeRelation = 'none' | 'exact' | 'descendant' | 'ancestor' | 'sibling' | 'unrelated';

export interface ScopeProximity {
  factor: number;
  relation: ScopeRelation;
  /** Levels between the two scopes. Zero unless one contains the other. */
  distance: number;
  /** Leading segments the two scopes have in common. */
  shared: number;
}

interface EntryRow {
  id: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  source: string;
  trust: number;
  tags: string;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
}

interface RankedRow extends EntryRow {
  bm: number;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  kind: string;
  created_at: string;
}

/** An edge selected next to an entry, where `kind` and `created_at` would collide. */
interface NeighborEdgeRow {
  edge_from_id: string;
  edge_to_id: string;
  edge_kind: string;
  edge_created_at: string;
}

interface FeedbackRow {
  id: string;
  entry_id: string;
  verdict: string;
  note: string | null;
  created_at: string;
}

interface RankRequest {
  query: string;
  /** Restricts the result to this scope and everything nested beneath it. */
  filterScope: string | null;
  /** Where the reader is standing. Drives proximity but excludes nothing. */
  seedScope: string | null;
  kinds: EntryKind[];
  tags: string[];
  limit: number;
  includeSuperseded: boolean;
}

const ENTRY_COLUMNS = `
  e.id AS id,
  e.kind AS kind,
  e.scope AS scope,
  e.title AS title,
  e.body AS body,
  e.source AS source,
  e.trust AS trust,
  e.tags AS tags,
  e.created_at AS created_at,
  e.updated_at AS updated_at,
  e.superseded_by AS superseded_by
`;

// --- Small pure helpers -----------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length > 0 && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 24);
}

function parseTags(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function rowToEntry(row: EntryRow): Entry {
  return EntrySchema.parse({
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    title: row.title,
    body: row.body,
    source: row.source,
    trust: row.trust,
    tags: parseTags(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededBy: row.superseded_by
  });
}

function rowToEdge(row: EdgeRow): Edge {
  return EdgeSchema.parse({
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    createdAt: row.created_at
  });
}

function rowToFeedback(row: FeedbackRow): Feedback {
  return FeedbackSchema.parse({
    id: row.id,
    entryId: row.entry_id,
    verdict: row.verdict,
    note: row.note,
    createdAt: row.created_at
  });
}

/**
 * Splits a plain sentence into the words FTS5 will look for.
 *
 * The query arrives as free text an agent typed, so it can hold quotes, colons,
 * `AND`, `*` and anything else the FTS5 grammar treats as an operator. Passing it
 * through raw turns a normal question into a syntax error. Each word is taken out
 * and quoted instead, which makes every input a legal query.
 */
export function queryTerms(query: string): string[] {
  const found = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  const unique: string[] = [];
  for (const term of found) {
    if (!unique.includes(term)) unique.push(term);
    if (unique.length >= MAX_QUERY_TERMS) break;
  }
  return unique;
}

function matchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replace(/"/gu, '""')}"`).join(' OR ');
}

function segments(scope: string): string[] {
  return scope.split('/').filter((part) => part.length > 0);
}

function sharedSegments(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * Scores how close an entry's scope is to where the reader is standing.
 *
 * `agency` contains `agency/engineering`, so a search that starts at `agency`
 * ranks its own entries first, then its children, then its parents, then scopes
 * that only share a prefix, then everything else. The factor is never zero.
 */
export function scopeProximity(seedScope: string | null, entryScope: string): ScopeProximity {
  if (seedScope === null) {
    return { factor: 1, relation: 'none', distance: 0, shared: 0 };
  }
  if (seedScope === entryScope) {
    return {
      factor: SCOPE_EXACT,
      relation: 'exact',
      distance: 0,
      shared: segments(seedScope).length
    };
  }

  const seed = segments(seedScope);
  const entry = segments(entryScope);
  const shared = sharedSegments(seed, entry);

  if (entryScope.startsWith(`${seedScope}/`)) {
    const distance = entry.length - seed.length;
    const factor = clamp(
      SCOPE_DESCENDANT_DECAY ** distance,
      SCOPE_DESCENDANT_FLOOR,
      SCOPE_DESCENDANT_DECAY
    );
    return { factor, relation: 'descendant', distance, shared };
  }

  if (seedScope.startsWith(`${entryScope}/`)) {
    const distance = seed.length - entry.length;
    const raw = SCOPE_ANCESTOR_TOP * SCOPE_ANCESTOR_DECAY ** (distance - 1);
    const factor = clamp(raw, SCOPE_ANCESTOR_FLOOR, SCOPE_ANCESTOR_TOP);
    return { factor, relation: 'ancestor', distance, shared };
  }

  if (shared > 0) {
    const raw = SCOPE_SIBLING_BASE + SCOPE_SIBLING_STEP * shared;
    return {
      factor: clamp(raw, SCOPE_SIBLING_BASE, SCOPE_SIBLING_CEILING),
      relation: 'sibling',
      distance: 0,
      shared
    };
  }

  return { factor: SCOPE_UNRELATED, relation: 'unrelated', distance: 0, shared: 0 };
}

function pluralize(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

function listTerms(terms: readonly string[]): string {
  const quoted = terms.map((term) => `"${term}"`);
  if (quoted.length === 0) return '';
  if (quoted.length === 1) return quoted[0] ?? '';
  const head = quoted.slice(0, -1).join(', ');
  const tail = quoted[quoted.length - 1] ?? '';
  return `${head} and ${tail}`;
}

function describeScope(
  proximity: ScopeProximity,
  seedScope: string | null,
  entryScope: string
): string {
  switch (proximity.relation) {
    case 'exact':
      return `scope ${entryScope} is exactly the scope that was searched`;
    case 'descendant':
      return `scope ${entryScope} sits ${pluralize(proximity.distance, 'level')} below the searched scope ${String(seedScope)}`;
    case 'ancestor':
      return `scope ${entryScope} sits ${pluralize(proximity.distance, 'level')} above the searched scope ${String(seedScope)}`;
    case 'sibling':
      return `scope ${entryScope} shares ${pluralize(proximity.shared, 'leading segment')} with the searched scope ${String(seedScope)}`;
    case 'unrelated':
      return `scope ${entryScope} shares nothing with the searched scope ${String(seedScope)}`;
    default:
      return `no scope was given, so scope ${entryScope} did not move the rank`;
  }
}

/**
 * One sentence a reader can check: what matched, how far the entry is trusted,
 * and where it sits relative to the scope the search started from.
 */
export function explainHit(
  entry: Entry,
  terms: readonly string[],
  query: string,
  proximity: ScopeProximity,
  seedScope: string | null
): string {
  const title = entry.title.toLowerCase();
  const body = entry.body.toLowerCase();
  const inTitle = terms.filter((term) => title.includes(term));
  const inBody = terms.filter((term) => body.includes(term));

  let where: string;
  if (inTitle.length > 0 && inBody.length > 0) where = 'title and body';
  else if (inTitle.length > 0) where = 'title';
  else if (inBody.length > 0) where = 'body';
  else where = 'indexed text';

  const hit: string[] = [];
  for (const term of [...inTitle, ...inBody]) {
    if (!hit.includes(term)) hit.push(term);
  }
  const what = hit.length > 0 ? listTerms(hit) : `the query "${query}"`;

  return `Matched ${what} in the ${where}, trust ${entry.trust.toFixed(2)}, and ${describeScope(proximity, seedScope, entry.scope)}.`;
}

/** Moves trust toward 1 or toward 0 without ever arriving. */
export function nextTrust(trust: number, verdict: 'helpful' | 'unhelpful'): number {
  const current = clamp(trust, 0, 1);
  const moved =
    verdict === 'helpful' ? current + (1 - current) * TRUST_STEP : current - current * TRUST_STEP;
  return clamp(moved, 0, 1);
}

/**
 * The cost of one entry in the recall budget: its JSON encoding in UTF-8 bytes.
 *
 * The caller is assembling a prompt out of these, so the number has to be the
 * size of the thing that gets handed over, not the size of the body alone.
 */
export function entryBytes(entry: Entry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

/**
 * Matches a scope and everything nested beneath it.
 *
 * `substr` rather than `LIKE`, because a scope may contain `_`, which LIKE reads
 * as a single-character wildcard: `LIKE 'agency_%'` would also match `agencyx`.
 */
function scopeFilter(scope: string): { sql: string; params: unknown[] } {
  const prefix = `${scope}/`;
  return {
    sql: '(e.scope = ? OR substr(e.scope, 1, ?) = ?)',
    params: [scope, prefix.length, prefix]
  };
}

function isNewer(incoming: string, stored: string): boolean {
  const a = Date.parse(incoming);
  const b = Date.parse(stored);
  if (Number.isNaN(a) || Number.isNaN(b)) return incoming > stored;
  return a > b;
}

// --- The store --------------------------------------------------------------

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Db;
  private readonly writeTx: (input: unknown) => Entry;
  private readonly feedbackTx: (
    entryId: string,
    verdict: 'helpful' | 'unhelpful',
    note: string | null
  ) => Entry;

  constructor(options: SqliteMemoryStoreOptions) {
    const db = new DatabaseConstructor(options.dbPath);
    try {
      // WAL lets a reader and a writer work at once. An in-memory database reports
      // `memory` back and carries on, which is why this is set and not asserted.
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      applySchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;

    this.writeTx = this.db.transaction((input: unknown): Entry => this.writeInner(input));
    this.feedbackTx = this.db.transaction(
      (entryId: string, verdict: 'helpful' | 'unhelpful', note: string | null): Entry =>
        this.feedbackInner(entryId, verdict, note)
    );
  }

  /** The schema version stamped on the open file. */
  get schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  // --- Writing --------------------------------------------------------------

  write(input: WriteEntryArgs): Entry {
    return this.writeTx(input);
  }

  private writeInner(input: unknown): Entry {
    const parsed = WriteEntryInputSchema.parse(input);
    const now = nowIso();
    const entry: Entry = EntrySchema.parse({
      id: newEntryId(),
      kind: parsed.kind,
      scope: parsed.scope,
      title: parsed.title,
      body: parsed.body,
      source: parsed.source,
      trust: DEFAULT_TRUST,
      tags: normalizeTags(parsed.tags),
      createdAt: now,
      updatedAt: now,
      supersededBy: null
    });

    this.insertEntryRow(entry);

    if (parsed.supersedes !== null) {
      const target = this.get(parsed.supersedes);
      if (target === null) {
        throw new Error(`cannot supersede ${parsed.supersedes}: no such entry`);
      }
      this.db
        .prepare('UPDATE entries SET superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(entry.id, now, target.id);
      this.putEdge({ fromId: entry.id, toId: target.id, kind: 'supersedes', createdAt: now });
    }

    return entry;
  }

  private insertEntryRow(entry: Entry): void {
    this.db
      .prepare(
        `INSERT INTO entries
           (id, kind, scope, title, body, source, trust, tags, created_at, updated_at, superseded_by)
         VALUES
           (@id, @kind, @scope, @title, @body, @source, @trust, @tags, @createdAt, @updatedAt, @supersededBy)`
      )
      .run({
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        title: entry.title,
        body: entry.body,
        source: entry.source,
        trust: entry.trust,
        tags: JSON.stringify(entry.tags),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        supersededBy: entry.supersededBy
      });
  }

  private updateEntryRow(entry: Entry): void {
    this.db
      .prepare(
        `UPDATE entries SET
           kind = @kind, scope = @scope, title = @title, body = @body, source = @source,
           trust = @trust, tags = @tags, created_at = @createdAt, updated_at = @updatedAt,
           superseded_by = @supersededBy
         WHERE id = @id`
      )
      .run({
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        title: entry.title,
        body: entry.body,
        source: entry.source,
        trust: entry.trust,
        tags: JSON.stringify(entry.tags),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        supersededBy: entry.supersededBy
      });
  }

  // --- Reading --------------------------------------------------------------

  get(id: string): Entry | null {
    const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries e WHERE e.id = ?`).get(id) as
      EntryRow | undefined;
    return row === undefined ? null : rowToEntry(row);
  }

  /**
   * A scope's entries with no text query, most trusted first.
   *
   * This exists because `search` cannot answer "what is in this scope". A scope
   * name is a filing decision, not words in the entries filed under it, so a
   * search for `agency engineering` finds an entry about agency engineering and
   * misses every other entry in that scope. Ordering by trust and then recency
   * puts the material worth reading at the top without inventing a query.
   */
  list(input: ListScopeArgs): Entry[] {
    const parsed = ListScopeInputSchema.parse(input);
    const scope = scopeFilter(parsed.scope);
    const where = parsed.includeSuperseded ? [scope.sql] : [scope.sql, 'e.superseded_by IS NULL'];

    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}
         FROM entries e
         WHERE ${where.join(' AND ')}
         ORDER BY e.trust DESC, e.updated_at DESC, e.id ASC
         LIMIT ?`
      )
      .all(...scope.params, parsed.limit) as EntryRow[];

    return rows.map(rowToEntry);
  }

  search(input: SearchArgs): SearchHit[] {
    const parsed = SearchInputSchema.parse(input);
    return this.rank({
      query: parsed.query,
      // `scope` is a filter, exactly as the contract states, and it is also the
      // point the proximity factor measures from, so the entries that belong to
      // the scope itself outrank the ones that only sit under it.
      filterScope: parsed.scope,
      seedScope: parsed.scope,
      kinds: parsed.kinds,
      tags: parsed.tags,
      limit: parsed.limit,
      includeSuperseded: parsed.includeSuperseded
    });
  }

  recall(input: RecallArgs): {
    hits: SearchHit[];
    usedBytes: number;
    maxHops: 0 | 1 | 2;
    graphDecay: number;
  } {
    const parsed = RecallInputSchema.parse(input);
    // Recall reads the whole store and starts at the agent's own scope. Nothing
    // is filtered out by scope here: a far away entry ranks low, but if the
    // budget has room for it, it is better in the prompt than missing from it.
    const ranked = this.rank({
      query: parsed.task,
      filterScope: null,
      seedScope: parsed.entryScope,
      kinds: [],
      tags: [],
      limit: RECALL_CANDIDATES,
      includeSuperseded: false
    });

    const best = new Map<string, SearchHit>();
    const queue: SearchHit[] = [];
    for (const hit of ranked) {
      best.set(hit.entry.id, hit);
      queue.push(hit);
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current.hop >= parsed.maxHops) continue;
      const nextHop = (current.hop + 1) as 1 | 2;
      for (const linked of this.neighbors(current.entry.id)) {
        if (linked.edge.kind === 'supersedes' || linked.entry.supersededBy !== null) continue;
        if (current.path.includes(linked.entry.id)) continue;
        const proximity = scopeProximity(parsed.entryScope, linked.entry.scope);
        const candidate: SearchHit = {
          entry: linked.entry,
          score: current.score * parsed.graphDecay * linked.entry.trust * proximity.factor,
          origin: 'graph',
          hop: nextHop,
          path: [...current.path, linked.entry.id],
          why: `Reached at hop ${nextHop} through ${linked.edge.kind} from ${current.entry.id}; trust ${linked.entry.trust.toFixed(2)} and ${describeScope(proximity, parsed.entryScope, linked.entry.scope)}.`
        };
        const previous = best.get(linked.entry.id);
        if (previous?.hop === 0) continue;
        const candidateKey = candidate.path.join('/');
        const previousKey = previous?.path.join('/') ?? '';
        if (
          previous !== undefined &&
          (previous.score > candidate.score ||
            (previous.score === candidate.score &&
              (previous.hop < candidate.hop ||
                (previous.hop === candidate.hop && previousKey <= candidateKey))))
        ) {
          continue;
        }
        best.set(candidate.entry.id, candidate);
        queue.push(candidate);
      }
    }

    const ordered = [...best.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.hop !== b.hop) return a.hop - b.hop;
      if (b.entry.updatedAt !== a.entry.updatedAt) {
        return b.entry.updatedAt < a.entry.updatedAt ? -1 : 1;
      }
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    });

    const hits: SearchHit[] = [];
    let usedBytes = 0;
    for (const hit of ordered) {
      const cost = entryBytes(hit.entry);
      // An entry goes in whole or not at all. A body cut in half is worse than
      // no body, because the reader cannot tell that it was cut.
      if (usedBytes + cost > parsed.budgetBytes) continue;
      hits.push(hit);
      usedBytes += cost;
    }

    return {
      hits,
      usedBytes,
      maxHops: parsed.maxHops as 0 | 1 | 2,
      graphDecay: parsed.graphDecay
    };
  }

  private rank(request: RankRequest): SearchHit[] {
    const terms = queryTerms(request.query);
    if (terms.length === 0) return [];

    const where: string[] = ['entries_fts MATCH ?'];
    const params: unknown[] = [matchExpression(terms)];

    if (!request.includeSuperseded) {
      where.push('e.superseded_by IS NULL');
    }
    if (request.filterScope !== null) {
      const scope = scopeFilter(request.filterScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    if (request.kinds.length > 0) {
      where.push(`e.kind IN (${request.kinds.map(() => '?').join(', ')})`);
      params.push(...request.kinds);
    }

    const candidates = Math.max(CANDIDATE_FLOOR, request.limit * CANDIDATE_MULTIPLE);
    params.push(candidates);

    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS},
                bm25(entries_fts, ${FTS_WEIGHT_ID}, ${FTS_WEIGHT_TITLE}, ${FTS_WEIGHT_BODY}) AS bm
         FROM entries_fts
         JOIN entries e ON e.id = entries_fts.id
         WHERE ${where.join(' AND ')}
         ORDER BY bm ASC
         LIMIT ?`
      )
      .all(...params) as RankedRow[];

    const wanted = normalizeTags(request.tags);
    const kept: { entry: Entry; relevance: number }[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (wanted.length > 0 && !wanted.every((tag) => entry.tags.includes(tag))) continue;
      // bm25 hands back a negative number where more negative is a better match.
      // Flipping the sign here is what keeps the two multipliers honest: with a
      // negative relevance, low trust would move the score toward zero and lift
      // a distrusted entry to the top.
      kept.push({ entry, relevance: Math.max(-row.bm, 0) });
    }

    // The raw values land around 1e-7, so a product of three of them is hard to
    // read and fragile to compare. Dividing by the best match in this result set
    // rescales without reordering, because every relevance shares one divisor.
    let best = 0;
    for (const candidate of kept) best = Math.max(best, candidate.relevance);
    const divisor = best > 0 ? best : 1;

    const hits: SearchHit[] = kept.map(({ entry, relevance }) => {
      const proximity = scopeProximity(request.seedScope, entry.scope);
      const score = (relevance / divisor) * entry.trust * proximity.factor;
      return {
        entry,
        score,
        origin: 'lexical',
        hop: 0,
        path: [entry.id],
        why: explainHit(entry, terms, request.query, proximity, request.seedScope)
      };
    });

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.entry.updatedAt !== a.entry.updatedAt) {
        return b.entry.updatedAt < a.entry.updatedAt ? -1 : 1;
      }
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    });

    return hits.slice(0, request.limit);
  }

  // --- Graph ----------------------------------------------------------------

  relate(fromId: string, toId: string, kind: EdgeKind): Edge {
    const parsedKind = EdgeKindSchema.parse(kind);
    if (this.get(fromId) === null) throw new Error(`cannot relate from ${fromId}: no such entry`);
    if (this.get(toId) === null) throw new Error(`cannot relate to ${toId}: no such entry`);
    return this.putEdge({ fromId, toId, kind: parsedKind, createdAt: nowIso() });
  }

  /** Inserts the edge, or hands back the one that is already there. */
  private putEdge(edge: Edge): Edge {
    const parsed = EdgeSchema.parse(edge);
    const existing = this.db
      .prepare(
        'SELECT from_id, to_id, kind, created_at FROM edges WHERE from_id = ? AND to_id = ? AND kind = ?'
      )
      .get(parsed.fromId, parsed.toId, parsed.kind) as EdgeRow | undefined;
    if (existing !== undefined) return rowToEdge(existing);

    this.db
      .prepare('INSERT INTO edges (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(parsed.fromId, parsed.toId, parsed.kind, parsed.createdAt);
    return parsed;
  }

  /**
   * The edge columns carry an `edge_` prefix because `edges` and `entries` both
   * have a `kind` and a `created_at`.
   *
   * One result set cannot hold two columns of one name: the driver builds a
   * single object, so the second `kind` overwrites the first. Aliasing them apart
   * is what keeps an edge's kind from becoming its entry's kind.
   */
  neighbors(id: string): { edge: Edge; entry: Entry }[] {
    const rows = this.db
      .prepare(
        `SELECT g.from_id AS edge_from_id, g.to_id AS edge_to_id,
                g.kind AS edge_kind, g.created_at AS edge_created_at,
                ${ENTRY_COLUMNS}
         FROM edges g
         JOIN entries e ON e.id = CASE WHEN g.from_id = @id THEN g.to_id ELSE g.from_id END
         WHERE g.from_id = @id OR g.to_id = @id
         ORDER BY g.created_at ASC, g.from_id ASC, g.to_id ASC, g.kind ASC`
      )
      .all({ id }) as (NeighborEdgeRow & EntryRow)[];

    return rows.map((row) => ({
      edge: rowToEdge({
        from_id: row.edge_from_id,
        to_id: row.edge_to_id,
        kind: row.edge_kind,
        created_at: row.edge_created_at
      }),
      entry: rowToEntry(row)
    }));
  }

  // --- Feedback -------------------------------------------------------------

  feedback(entryId: string, verdict: 'helpful' | 'unhelpful', note: string | null = null): Entry {
    return this.feedbackTx(entryId, verdict, note);
  }

  private feedbackInner(
    entryId: string,
    verdict: 'helpful' | 'unhelpful',
    note: string | null
  ): Entry {
    const entry = this.get(entryId);
    if (entry === null) throw new Error(`cannot record feedback on ${entryId}: no such entry`);

    const now = nowIso();
    const row = FeedbackSchema.parse({
      id: newFeedbackId(),
      entryId: entry.id,
      verdict,
      note,
      createdAt: now
    });
    this.db
      .prepare(
        'INSERT INTO feedback (id, entry_id, verdict, note, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(row.id, row.entryId, row.verdict, row.note, row.createdAt);

    // The new trust travels with the entry, so a later import carries the
    // judgement without replaying the feedback rows that produced it.
    const updated: Entry = { ...entry, trust: nextTrust(entry.trust, verdict), updatedAt: now };
    this.db
      .prepare('UPDATE entries SET trust = ?, updated_at = ? WHERE id = ?')
      .run(updated.trust, updated.updatedAt, updated.id);

    return updated;
  }

  // --- Counting -------------------------------------------------------------

  stats(): { entries: number; edges: number; feedback: number; scopes: Record<string, number> } {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
        { n: number } | undefined;
      return row?.n ?? 0;
    };

    const scopeRows = this.db
      .prepare('SELECT scope, COUNT(*) AS n FROM entries GROUP BY scope ORDER BY scope ASC')
      .all() as { scope: string; n: number }[];

    const scopes: Record<string, number> = {};
    for (const row of scopeRows) scopes[row.scope] = row.n;

    return {
      entries: count('entries'),
      edges: count('edges'),
      feedback: count('feedback'),
      scopes
    };
  }

  // --- Portability ----------------------------------------------------------

  /** Ordered by id, which is ordered by time, so two exports of one store match. */
  allEntries(): Entry[] {
    const rows = this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM entries e ORDER BY e.id ASC`)
      .all() as EntryRow[];
    return rows.map(rowToEntry);
  }

  allEdges(): Edge[] {
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, kind, created_at FROM edges
         ORDER BY created_at ASC, from_id ASC, to_id ASC, kind ASC`
      )
      .all() as EdgeRow[];
    return rows.map(rowToEdge);
  }

  allFeedback(): Feedback[] {
    const rows = this.db
      .prepare('SELECT id, entry_id, verdict, note, created_at FROM feedback ORDER BY id ASC')
      .all() as FeedbackRow[];
    return rows.map(rowToFeedback);
  }

  /**
   * Last write wins, decided on `updatedAt`.
   *
   * Two machines reconcile through this method and nothing else, so the rule is
   * plain: an entry that is not here lands, an entry with a later `updatedAt`
   * replaces what is stored, and anything else is reported as older and left
   * alone. A tie counts as older, which makes importing the same file twice a
   * no-op the second time.
   */
  upsertEntry(entry: Entry): 'inserted' | 'updated' | 'skipped_older' {
    const incoming = EntrySchema.parse(entry);
    const stored = this.get(incoming.id);
    if (stored === null) {
      this.insertEntryRow(incoming);
      return 'inserted';
    }
    if (!isNewer(incoming.updatedAt, stored.updatedAt)) return 'skipped_older';
    this.updateEntryRow(incoming);
    return 'updated';
  }

  /**
   * Same rule, decided on `createdAt`, because an edge has no other timestamp.
   *
   * The contract offers no `updated` result, so a newer record that lands on an
   * existing key is reported as `inserted`: the stored row is replaced by it.
   */
  upsertEdge(edge: Edge): 'inserted' | 'skipped_older' {
    const incoming = EdgeSchema.parse(edge);
    const stored = this.db
      .prepare(
        'SELECT from_id, to_id, kind, created_at FROM edges WHERE from_id = ? AND to_id = ? AND kind = ?'
      )
      .get(incoming.fromId, incoming.toId, incoming.kind) as EdgeRow | undefined;

    if (stored === undefined) {
      this.db
        .prepare('INSERT INTO edges (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)')
        .run(incoming.fromId, incoming.toId, incoming.kind, incoming.createdAt);
      return 'inserted';
    }
    if (!isNewer(incoming.createdAt, stored.created_at)) return 'skipped_older';

    this.db
      .prepare('UPDATE edges SET created_at = ? WHERE from_id = ? AND to_id = ? AND kind = ?')
      .run(incoming.createdAt, incoming.fromId, incoming.toId, incoming.kind);
    return 'inserted';
  }

  /** Same rule again, on `createdAt`. A feedback row's note and verdict can differ. */
  upsertFeedback(row: Feedback): 'inserted' | 'skipped_older' {
    const incoming = FeedbackSchema.parse(row);
    const stored = this.db
      .prepare('SELECT id, entry_id, verdict, note, created_at FROM feedback WHERE id = ?')
      .get(incoming.id) as FeedbackRow | undefined;

    if (stored === undefined) {
      this.db
        .prepare(
          'INSERT INTO feedback (id, entry_id, verdict, note, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(incoming.id, incoming.entryId, incoming.verdict, incoming.note, incoming.createdAt);
      return 'inserted';
    }
    if (!isNewer(incoming.createdAt, stored.created_at)) return 'skipped_older';

    this.db
      .prepare(
        'UPDATE feedback SET entry_id = ?, verdict = ?, note = ?, created_at = ? WHERE id = ?'
      )
      .run(incoming.entryId, incoming.verdict, incoming.note, incoming.createdAt, incoming.id);
    return 'inserted';
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Opens the store at a path. This is the seam every caller outside `src/store`
 * uses.
 *
 * It takes a bare path rather than the options object the class takes, because
 * the two callers that matter — the MCP server and the portability CLI — have a
 * path and nothing else. A single named factory also means neither of them has to
 * know how the class is constructed, and both break loudly at compile time if
 * this signature ever changes.
 */
export function createStore(dbPath: string): SqliteMemoryStore {
  return new SqliteMemoryStore({ dbPath });
}
