import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Edge, Entry, Feedback, MemoryStore } from '../src/contracts.js';

/**
 * Node's type stripping does not rewrite a `.js` specifier to the `.ts` file
 * next to it, and NodeNext requires the source to say `.js`. This hook closes
 * that gap for the test process only, so the modules under test can be loaded
 * straight from source with no build step.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { SCHEMA_VERSION } = await import('../src/contracts.js');
const { exportToFile, exportToJsonl, importFromFile, importFromJsonl, SchemaVersionMismatchError } =
  await import('../src/portability/index.js');

// --- A fake store -----------------------------------------------------------

/**
 * Enough of `MemoryStore` for the portability layer, and nothing else. The real
 * store is another agent's file; depending on it here would test their work
 * instead of this one's, and would stall these tests until it lands.
 */
class FakeStore implements MemoryStore {
  readonly entries = new Map<string, Entry>();
  readonly edges = new Map<string, Edge>();
  readonly feedbackRows = new Map<string, Feedback>();
  /** Mimics a store with foreign keys, which refuses an edge to a missing entry. */
  enforceReferences = false;

  allEntries(): Entry[] {
    return [...this.entries.values()];
  }

  allEdges(): Edge[] {
    return [...this.edges.values()];
  }

  allFeedback(): Feedback[] {
    return [...this.feedbackRows.values()];
  }

  upsertEntry(entry: Entry): 'inserted' | 'updated' | 'skipped_older' {
    if (
      this.enforceReferences &&
      entry.supersededBy !== null &&
      !this.entries.has(entry.supersededBy)
    ) {
      throw new Error(`FOREIGN KEY constraint failed: supersededBy ${entry.supersededBy}`);
    }
    const existing = this.entries.get(entry.id);
    if (existing === undefined) {
      this.entries.set(entry.id, entry);
      return 'inserted';
    }
    if (Date.parse(entry.updatedAt) > Date.parse(existing.updatedAt)) {
      this.entries.set(entry.id, entry);
      return 'updated';
    }
    return 'skipped_older';
  }

  upsertEdge(edge: Edge): 'inserted' | 'skipped_older' {
    if (this.enforceReferences && !(this.entries.has(edge.fromId) && this.entries.has(edge.toId))) {
      throw new Error(`FOREIGN KEY constraint failed: ${edge.fromId} -> ${edge.toId}`);
    }
    const key = `${edge.fromId}|${edge.toId}|${edge.kind}`;
    if (this.edges.has(key)) {
      return 'skipped_older';
    }
    this.edges.set(key, edge);
    return 'inserted';
  }

  upsertFeedback(row: Feedback): 'inserted' | 'skipped_older' {
    if (this.enforceReferences && !this.entries.has(row.entryId)) {
      throw new Error(`FOREIGN KEY constraint failed: entryId ${row.entryId}`);
    }
    if (this.feedbackRows.has(row.id)) {
      return 'skipped_older';
    }
    this.feedbackRows.set(row.id, row);
    return 'inserted';
  }

  close(): void {
    // Nothing to release.
  }

  // The rest of the interface. The portability layer never calls these, and a
  // silent stub would hide it if that ever changed.
  write(): never {
    throw new Error('FakeStore.write is not implemented');
  }

  get(): never {
    throw new Error('FakeStore.get is not implemented');
  }

  search(): never {
    throw new Error('FakeStore.search is not implemented');
  }

  recall(): never {
    throw new Error('FakeStore.recall is not implemented');
  }

  relate(): never {
    throw new Error('FakeStore.relate is not implemented');
  }

  neighbors(): never {
    throw new Error('FakeStore.neighbors is not implemented');
  }

  feedback(): never {
    throw new Error('FakeStore.feedback is not implemented');
  }

  stats(): never {
    throw new Error('FakeStore.stats is not implemented');
  }
}

// --- Fixtures ---------------------------------------------------------------

/** Ids must match `mem_` plus 26 Crockford base32 characters. */
function id(seed: string): string {
  return `mem_${seed.padEnd(26, '0')}`;
}

const ALPHA = id('a');
const BETA = id('b');
const GAMMA = id('c');

function makeEntry(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    kind: 'fact',
    scope: 'agency/engineering',
    title: 'a title',
    body: 'a body',
    source: 'test',
    trust: 0.5,
    tags: ['one', 'two'],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    supersededBy: null,
    ...overrides
  };
}

function populated(): FakeStore {
  const store = new FakeStore();
  // Inserted out of id order on purpose: the export has to sort, not echo.
  store.upsertEntry(
    makeEntry({ id: GAMMA, title: 'third', updatedAt: '2026-08-03T10:00:00.000Z' })
  );
  store.upsertEntry(makeEntry({ id: ALPHA, title: 'first', tags: [] }));
  store.upsertEntry(
    makeEntry({ id: BETA, title: 'second', body: 'lines\nand "quotes" and é', trust: 0.75 })
  );
  store.upsertEdge({
    fromId: GAMMA,
    toId: ALPHA,
    kind: 'refers_to',
    createdAt: '2026-08-02T10:00:00.000Z'
  });
  store.upsertEdge({
    fromId: ALPHA,
    toId: BETA,
    kind: 'contains',
    createdAt: '2026-08-02T09:00:00.000Z'
  });
  store.upsertFeedback({
    id: 'fb-2',
    entryId: BETA,
    verdict: 'unhelpful',
    note: null,
    createdAt: '2026-08-02T11:00:00.000Z'
  });
  store.upsertFeedback({
    id: 'fb-1',
    entryId: ALPHA,
    verdict: 'helpful',
    note: 'held up',
    createdAt: '2026-08-02T11:00:00.000Z'
  });
  return store;
}

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function lines(jsonl: string): string[] {
  return jsonl.split('\n').filter((line) => line.length > 0);
}

// --- Tests ------------------------------------------------------------------

test('export then import round-trips every record', () => {
  const source = populated();
  const jsonl = exportToJsonl(source, { origin: 'desktop' });

  const target = new FakeStore();
  const result = importFromJsonl(target, jsonl);

  assert.deepEqual(result.rejected, []);
  assert.equal(result.origin, 'desktop');
  assert.equal(result.inserted, 7); // 3 entries, 2 edges, 2 feedback
  assert.equal(result.updated, 0);
  assert.equal(result.skippedOlder, 0);

  assert.deepEqual(byId(target.allEntries()), byId(source.allEntries()));
  assert.deepEqual(target.allEdges().length, 2);
  assert.deepEqual(byId(target.allFeedback()), byId(source.allFeedback()));

  // A snapshot of the import is the same file as the snapshot it came from.
  assert.equal(exportToJsonl(target, { origin: 'desktop' }), jsonl);
});

test('the header comes first, then entries, then edges, then feedback', () => {
  const jsonl = exportToJsonl(populated(), { origin: 'desktop' });
  const types = lines(jsonl).map((line) => (JSON.parse(line) as { type: string }).type);

  assert.deepEqual(types, [
    'header',
    'entry',
    'entry',
    'entry',
    'edge',
    'edge',
    'feedback',
    'feedback'
  ]);

  const header = JSON.parse(lines(jsonl)[0] ?? '') as {
    schemaVersion: number;
    counts: { entries: number; edges: number; feedback: number };
  };
  assert.equal(header.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(header.counts, { entries: 3, edges: 2, feedback: 2 });
  assert.ok(jsonl.endsWith('\n'));
  assert.ok(!jsonl.includes('\r'), 'line endings must be LF wherever the export runs');
});

test('export is byte-identical across runs and across insertion orders', () => {
  const store = populated();
  assert.equal(
    exportToJsonl(store, { origin: 'desktop' }),
    exportToJsonl(store, { origin: 'desktop' })
  );

  // Same content, built in a different order: the bytes still have to match, or
  // desktop and laptop would fight over a file neither of them changed.
  const shuffled = new FakeStore();
  for (const entry of [...store.allEntries()].reverse()) {
    shuffled.upsertEntry(entry);
  }
  for (const edge of [...store.allEdges()].reverse()) {
    shuffled.upsertEdge(edge);
  }
  for (const row of [...store.allFeedback()].reverse()) {
    shuffled.upsertFeedback(row);
  }

  assert.equal(
    exportToJsonl(shuffled, { origin: 'desktop' }),
    exportToJsonl(store, { origin: 'desktop' })
  );
});

test('a corrupted middle line is rejected and every other line still imports', () => {
  const source = populated();
  const original = lines(exportToJsonl(source, { origin: 'desktop' }));

  const damaged = [...original];
  damaged[2] = '{"type":"entry","data":{"id":"mem_'; // truncated by a bad copy
  damaged[5] = JSON.stringify({
    type: 'edge',
    data: { fromId: ALPHA, toId: BETA, kind: 'not_a_kind', createdAt: '2026-08-02T09:00:00.000Z' }
  }); // parses as JSON, fails the schema

  const target = new FakeStore();
  const result = importFromJsonl(target, `${damaged.join('\n')}\n`);

  assert.equal(result.rejected.length, 2);
  assert.deepEqual(
    result.rejected.map((rejection) => rejection.line),
    [3, 6]
  );
  assert.match(result.rejected[0]?.reason ?? '', /invalid JSON/u);
  assert.match(result.rejected[1]?.reason ?? '', /kind/u);

  // Six of eight lines were good, and all six landed.
  assert.equal(result.inserted, 5);
  assert.equal(target.allEntries().length, 2);
  assert.equal(target.allEdges().length, 1);
  assert.equal(target.allFeedback().length, 2);
});

test('an older incoming record is skipped and a newer one updates', () => {
  const store = new FakeStore();
  store.upsertEntry(
    makeEntry({ id: ALPHA, title: 'current', updatedAt: '2026-08-05T12:00:00.000Z' })
  );

  const older = exportToJsonl(
    (() => {
      const other = new FakeStore();
      other.upsertEntry(
        makeEntry({ id: ALPHA, title: 'stale', updatedAt: '2026-08-01T12:00:00.000Z' })
      );
      return other;
    })(),
    { origin: 'laptop' }
  );

  const skipped = importFromJsonl(store, older);
  assert.deepEqual(skipped.rejected, []);
  assert.equal(skipped.skippedOlder, 1);
  assert.equal(skipped.updated, 0);
  assert.equal(store.entries.get(ALPHA)?.title, 'current');

  const newer = exportToJsonl(
    (() => {
      const other = new FakeStore();
      other.upsertEntry(
        makeEntry({ id: ALPHA, title: 'fresher', updatedAt: '2026-08-09T12:00:00.000Z' })
      );
      return other;
    })(),
    { origin: 'laptop' }
  );

  const applied = importFromJsonl(store, newer);
  assert.equal(applied.updated, 1);
  assert.equal(applied.skippedOlder, 0);
  assert.equal(store.entries.get(ALPHA)?.title, 'fresher');
});

test('a schemaVersion mismatch throws before anything is written', () => {
  const jsonl = [
    JSON.stringify({
      type: 'header',
      schemaVersion: SCHEMA_VERSION + 1,
      exportedAt: '2026-08-06T10:00:00.000Z',
      origin: 'from-the-future',
      counts: { entries: 1, edges: 0, feedback: 0 }
    }),
    JSON.stringify({ type: 'entry', data: makeEntry({ id: ALPHA }) })
  ].join('\n');

  const store = new FakeStore();
  assert.throws(
    () => importFromJsonl(store, jsonl),
    (error: unknown) => {
      assert.ok(error instanceof SchemaVersionMismatchError);
      assert.equal(error.name, 'SchemaVersionMismatchError');
      assert.equal(error.expected, SCHEMA_VERSION);
      assert.equal(error.found, SCHEMA_VERSION + 1);
      assert.match(error.message, /schemaVersion/u);
      return true;
    }
  );

  // The entry on line 2 was perfectly valid. Nothing was written anyway.
  assert.equal(store.allEntries().length, 0);
});

test('an empty store exports a header-only file that imports cleanly', () => {
  const jsonl = exportToJsonl(new FakeStore(), { origin: 'fresh-laptop' });

  assert.equal(lines(jsonl).length, 1);
  const header = JSON.parse(lines(jsonl)[0] ?? '') as {
    type: string;
    origin: string;
    counts: { entries: number; edges: number; feedback: number };
  };
  assert.equal(header.type, 'header');
  assert.equal(header.origin, 'fresh-laptop');
  assert.deepEqual(header.counts, { entries: 0, edges: 0, feedback: 0 });

  const target = new FakeStore();
  const result = importFromJsonl(target, jsonl);
  assert.deepEqual(result, {
    inserted: 0,
    updated: 0,
    skippedOlder: 0,
    rejected: [],
    origin: 'fresh-laptop'
  });
});

test('a missing header rejects line 1 without losing the record on it', () => {
  const withoutHeader = lines(exportToJsonl(populated(), { origin: 'desktop' })).slice(1);

  const store = new FakeStore();
  const result = importFromJsonl(store, `${withoutHeader.join('\n')}\n`);

  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.line, 1);
  assert.match(result.rejected[0]?.reason ?? '', /header/u);
  assert.equal(result.origin, 'unknown');
  // The entry that happened to sit on line 1 is still a valid record.
  assert.equal(store.allEntries().length, 3);
  assert.equal(result.inserted, 7);
});

test('records that arrive before what they reference are retried, not dropped', () => {
  // Edge first, then its endpoints: the order a hand-merged file can end up in.
  const jsonl = `${[
    JSON.stringify({
      type: 'header',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: '2026-08-06T10:00:00.000Z',
      origin: 'laptop',
      counts: { entries: 2, edges: 1, feedback: 0 }
    }),
    JSON.stringify({
      type: 'edge',
      data: { fromId: ALPHA, toId: BETA, kind: 'refers_to', createdAt: '2026-08-02T10:00:00.000Z' }
    }),
    JSON.stringify({ type: 'entry', data: makeEntry({ id: ALPHA, supersededBy: BETA }) }),
    JSON.stringify({ type: 'entry', data: makeEntry({ id: BETA }) })
  ].join('\n')}\n`;

  const store = new FakeStore();
  store.enforceReferences = true;
  const result = importFromJsonl(store, jsonl);

  assert.deepEqual(result.rejected, []);
  assert.equal(result.inserted, 3);
  assert.equal(store.allEdges().length, 1);
  assert.equal(store.allEntries().length, 2);
});

test('a record the store can never accept is reported, not thrown', () => {
  const jsonl = `${[
    JSON.stringify({
      type: 'header',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: '2026-08-06T10:00:00.000Z',
      origin: 'laptop',
      counts: { entries: 1, edges: 1, feedback: 0 }
    }),
    JSON.stringify({
      type: 'edge',
      data: { fromId: ALPHA, toId: GAMMA, kind: 'refers_to', createdAt: '2026-08-02T10:00:00.000Z' }
    }),
    JSON.stringify({ type: 'entry', data: makeEntry({ id: ALPHA }) })
  ].join('\n')}\n`;

  const store = new FakeStore();
  store.enforceReferences = true;
  const result = importFromJsonl(store, jsonl);

  assert.equal(result.inserted, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.line, 2);
  assert.match(result.rejected[0]?.reason ?? '', /FOREIGN KEY/u);
  assert.equal(store.allEntries().length, 1);
});

test('CRLF line endings survive the trip', () => {
  const jsonl = exportToJsonl(populated(), { origin: 'desktop' });
  const crlf = jsonl.replace(/\n/gu, '\r\n');

  const store = new FakeStore();
  const result = importFromJsonl(store, crlf);

  assert.deepEqual(result.rejected, []);
  assert.equal(result.inserted, 7);
});

test('a UTF-8 byte order mark on line 1 does not break the header', () => {
  const jsonl = `﻿${exportToJsonl(populated(), { origin: 'desktop' })}`;

  const store = new FakeStore();
  const result = importFromJsonl(store, jsonl);

  assert.deepEqual(result.rejected, []);
  assert.equal(result.origin, 'desktop');
});

test('exportToFile and importFromFile round-trip through the filesystem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-memory-portability-'));
  try {
    const target = join(dir, 'nested', 'memory.jsonl');
    const source = populated();

    const summary = await exportToFile(source, target, { origin: 'desktop' });
    assert.equal(summary.path, target);
    assert.equal(summary.entries, 3);
    assert.equal(summary.edges, 2);
    assert.equal(summary.feedback, 2);
    assert.equal(summary.schemaVersion, SCHEMA_VERSION);
    assert.equal(
      summary.bytes,
      Buffer.byteLength(exportToJsonl(source, { origin: 'desktop' }), 'utf8')
    );
    assert.ok(
      !existsSync(`${target}.${process.pid}.tmp`),
      'the temporary file must be renamed away'
    );

    const restored = new FakeStore();
    const result = importFromFile(restored, target);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(byId(restored.allEntries()), byId(source.allEntries()));

    // Re-exporting unchanged memory rewrites the same bytes, so git sees nothing.
    const again = await exportToFile(source, target, { origin: 'desktop' });
    assert.equal(again.bytes, summary.bytes);
    assert.equal(again.exportedAt, summary.exportedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an origin the header schema refuses fails the export instead of writing it', () => {
  assert.throws(() => exportToJsonl(new FakeStore(), { origin: '   ' }), /origin|String/u);
});
