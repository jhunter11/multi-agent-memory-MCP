import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Entry } from '../src/contracts.ts';

/**
 * Tests for the tool layer: the surface three harnesses actually call.
 *
 * These drive the handlers directly, with no transport in the way, which is what
 * `MEMORY_TOOLS` carrying its own schemas buys. The protocol itself is checked
 * separately, by a probe that speaks JSON-RPC over a real process.
 *
 * Two invariants get pinned here again and again, because breaking either one
 * costs a harness its memory mid-task. Nothing throws: a failure is a result with
 * `isError` set. And an export is deterministic: the same store produces the same
 * bytes, or the snapshot cannot be merged by git.
 */

/** See `tests/store.test.ts`: maps the emitted `.js` specifiers back to sources. */
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

const { MEMORY_TOOLS, callTool, createToolContext, getTool } = await import('../src/mcp/tools.ts');
const { createStore } = await import('../src/store/index.ts');
const { defaultSnapshotPath } = await import('../src/db-path.ts');

type ToolContext = ReturnType<typeof createToolContext>;
type ToolResult = Awaited<ReturnType<typeof callTool>>;

const EXPECTED_TOOLS = [
  'memory_export',
  'memory_feedback',
  'memory_neighbors',
  'memory_recall',
  'memory_reflect',
  'memory_relate',
  'memory_search',
  'memory_stats',
  'memory_write'
];

const READ_ONLY_TOOLS = ['memory_search', 'memory_recall', 'memory_neighbors', 'memory_stats'];

// --- Fixtures ---------------------------------------------------------------

interface Harness {
  store: ReturnType<typeof createStore>;
  context: ToolContext;
  call(name: string, args?: unknown): Promise<ToolResult>;
  close(): void;
}

function openHarness(options: Parameters<typeof createToolContext>[1] = {}): Harness {
  const store = createStore(':memory:');
  const context = createToolContext(store, { origin: 'test-machine', ...options });
  return {
    store,
    context,
    call: (name, args) => callTool(name, context, args),
    close: () => store.close()
  };
}

/** Exact structured content for a client to consume without scraping prose. */
function payload(result: ToolResult): Record<string, unknown> {
  assert.equal(
    result.isError,
    undefined,
    `expected success, got: ${result.content[0]?.text ?? ''}`
  );
  assert.ok(
    result.structuredContent !== undefined,
    'a successful result carries structured content'
  );
  return result.structuredContent;
}

function prose(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

async function writeEntry(
  harness: Harness,
  overrides: Record<string, unknown> = {}
): Promise<Entry> {
  const result = await harness.call('memory_write', {
    kind: 'decision',
    scope: 'agency/engineering',
    title: 'Sync the snapshot, never the database file',
    body: 'Two machines writing one SQLite file can corrupt it, so the artifact that travels is a JSONL snapshot.',
    source: 'tests/mcp.test.ts',
    ...overrides
  });
  return payload(result)['entry'] as Entry;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jm-mcp-'));
}

// --- The registry -----------------------------------------------------------

test('nine tools are registered, each named, described, and annotated', () => {
  assert.deepEqual(
    MEMORY_TOOLS.map((tool) => tool.name).sort(),
    EXPECTED_TOOLS,
    'the nine names the README and both harness configurations promise'
  );

  for (const tool of MEMORY_TOOLS) {
    assert.ok(tool.title.length > 0, `${tool.name} has a title`);
    assert.ok(tool.description.length > 40, `${tool.name} tells a model when to reach for it`);
    assert.equal(
      typeof tool.annotations.readOnlyHint,
      'boolean',
      `${tool.name} declares readOnlyHint`
    );
    assert.equal(
      tool.annotations.openWorldHint,
      false,
      `${tool.name} touches nothing outside this machine`
    );
    assert.equal(getTool(tool.name), tool);
  }

  for (const tool of MEMORY_TOOLS) {
    assert.equal(
      tool.annotations.readOnlyHint,
      READ_ONLY_TOOLS.includes(tool.name),
      `${tool.name} must declare truthfully whether it writes`
    );
  }
});

// --- Write, search, recall --------------------------------------------------

test('a write returns prose for a person and the stored entry as JSON', async () => {
  const harness = openHarness();
  const entry = await writeEntry(harness);

  assert.match(entry.id, /^mem_[0-9a-hjkmnp-tv-z]{26}$/u);
  assert.equal(entry.scope, 'agency/engineering');
  assert.equal(entry.trust, 0.5, 'a new entry starts at the default trust');
  assert.equal(entry.supersededBy, null);
  assert.deepEqual(
    harness.store.get(entry.id),
    entry,
    'the JSON is what actually landed in the store'
  );

  harness.close();
});

test('search finds what write stored and names the scope it looked in', async () => {
  const harness = openHarness();
  const entry = await writeEntry(harness);

  const result = await harness.call('memory_search', {
    query: 'corrupt sqlite snapshot',
    scope: 'agency'
  });
  const body = payload(result);

  assert.equal(body['count'], 1, 'a parent scope search reaches a nested entry');
  assert.match(prose(result), /scope agency/u);
  const hits = body['hits'] as { entry: Entry; why: string }[];
  assert.equal(hits[0]?.entry.id, entry.id);
  assert.ok(hits[0]?.why.includes('trust 0.50'), 'the hit explains its own rank');
  assert.ok(prose(result).includes('why:'), 'the prose carries the explanation too');

  harness.close();
});

test('a search that matches nothing is an ordinary result, not an error', async () => {
  const harness = openHarness();
  await writeEntry(harness);

  const result = await harness.call('memory_search', { query: 'kangaroo hovercraft' });
  const body = payload(result);

  assert.equal(body['count'], 0);
  assert.deepEqual(body['hits'], []);
  assert.match(prose(result), /No entries/u);

  harness.close();
});

test('recall reports the budget it used and never exceeds it', async () => {
  const harness = openHarness();
  for (let index = 0; index < 5; index += 1) {
    await writeEntry(harness, {
      title: `Snapshot rule ${index}`,
      body: 'Sync the snapshot. '.repeat(40)
    });
  }

  const budget = 2_000;
  const result = await harness.call('memory_recall', {
    task: 'decide how to sync memory between two machines',
    entryScope: 'agency/engineering',
    budgetBytes: budget
  });
  const body = payload(result);
  const used = body['usedBytes'] as number;

  assert.ok(used > 0 && used <= budget, `usedBytes ${used} must sit inside the budget ${budget}`);
  assert.ok((body['count'] as number) > 0);
  assert.match(prose(result), new RegExp(`using ${used} of ${budget} bytes`, 'u'));

  harness.close();
});

test('recall on an empty store says so rather than failing', async () => {
  const harness = openHarness();
  const result = await harness.call('memory_recall', {
    task: 'anything at all',
    entryScope: 'agency'
  });

  assert.equal(payload(result)['count'], 0);
  assert.match(prose(result), /Nothing recalled/u);

  harness.close();
});

// --- Nothing throws ---------------------------------------------------------

test('invalid arguments come back as an error result, never as an exception', async () => {
  const harness = openHarness();

  const cases: { name: string; args: unknown; expect: RegExp }[] = [
    { name: 'memory_write', args: { kind: 'not_a_kind' }, expect: /kind/u },
    {
      name: 'memory_write',
      args: { kind: 'fact', scope: 'NOT A SCOPE', title: 't', body: 'b', source: 's' },
      expect: /scope/u
    },
    { name: 'memory_write', args: {}, expect: /Invalid arguments/u },
    { name: 'memory_neighbors', args: { id: 'not-an-id' }, expect: /id/u },
    { name: 'memory_search', args: { query: '' }, expect: /query/u },
    {
      name: 'memory_recall',
      args: { task: 'x', entryScope: 'agency', budgetBytes: 1 },
      expect: /budgetBytes/u
    },
    { name: 'memory_relate', args: { fromId: 'x', toId: 'y', kind: 'refers_to' }, expect: /Id/u },
    {
      name: 'memory_feedback',
      args: { entryId: 'mem_' + '0'.repeat(26), verdict: 'maybe' },
      expect: /verdict/u
    }
  ];

  for (const item of cases) {
    const result = await harness.call(item.name, item.args);
    assert.equal(
      result.isError,
      true,
      `${item.name} with ${JSON.stringify(item.args)} must be an error result`
    );
    assert.match(prose(result), item.expect);
    assert.match(prose(result), /Invalid arguments/u);
  }

  harness.close();
});

test('a store failure is an error result too, with the reason in it', async () => {
  const harness = openHarness();
  const entry = await writeEntry(harness);
  const missing = `mem_${'0'.repeat(26)}`;

  const related = await harness.call('memory_relate', {
    fromId: entry.id,
    toId: missing,
    kind: 'refers_to'
  });
  assert.equal(related.isError, true);
  assert.match(prose(related), /no such entry/u);

  const rated = await harness.call('memory_feedback', { entryId: missing, verdict: 'helpful' });
  assert.equal(rated.isError, true);
  assert.match(prose(rated), /no such entry/u);

  const superseded = await harness.call('memory_write', {
    kind: 'fact',
    scope: 'agency',
    title: 'Dangling',
    body: 'Points at nothing.',
    source: 'test',
    supersedes: missing
  });
  assert.equal(superseded.isError, true);
  assert.match(prose(superseded), /no such entry/u);

  harness.close();
});

test('an unknown tool name lists the nine instead of throwing', async () => {
  const harness = openHarness();
  const result = await harness.call('memory_delete_everything', {});

  assert.equal(result.isError, true);
  assert.match(prose(result), /Unknown tool memory_delete_everything/u);
  for (const name of EXPECTED_TOOLS) {
    assert.ok(prose(result).includes(name), `the error names ${name} as one that does exist`);
  }

  harness.close();
});

test('memory_stats accepts no arguments, including none at all', async () => {
  const harness = openHarness();
  await writeEntry(harness);
  await writeEntry(harness, {
    scope: 'personal/health',
    title: 'Sleep',
    body: 'Sleep is the first lever.'
  });

  for (const args of [undefined, null, {}]) {
    const result = (await getTool('memory_stats')?.run(harness.context, args)) as ToolResult;
    const body = payload(result);
    assert.equal(body['entries'], 2);
    assert.deepEqual(body['scopes'], { 'agency/engineering': 1, 'personal/health': 1 });
    assert.equal(body['origin'], 'test-machine');
    assert.match(prose(result), /2 entries/u);
  }

  harness.close();
});

// --- The graph --------------------------------------------------------------

test('neighbors reports direction from the point of view of the entry asked about', async () => {
  const harness = openHarness();
  const from = await writeEntry(harness, { title: 'The decision', body: 'Sync a snapshot.' });
  const to = await writeEntry(harness, {
    kind: 'fact',
    title: 'The reason',
    body: 'File locking is unreliable.'
  });

  const linked = await harness.call('memory_relate', {
    fromId: from.id,
    toId: to.id,
    kind: 'refers_to'
  });
  assert.match(prose(linked), /-\[refers_to\]->/u);

  const outward = payload(await harness.call('memory_neighbors', { id: from.id }));
  const outNeighbors = outward['neighbors'] as { direction: string; kind: string; entry: Entry }[];
  assert.equal(outNeighbors[0]?.direction, 'out');
  assert.equal(outNeighbors[0]?.kind, 'refers_to', 'the edge kind, not the entry kind');
  assert.equal(outNeighbors[0]?.entry.id, to.id);

  const inward = payload(await harness.call('memory_neighbors', { id: to.id }));
  const inNeighbors = inward['neighbors'] as { direction: string; entry: Entry }[];
  assert.equal(inNeighbors[0]?.direction, 'in');
  assert.equal(inNeighbors[0]?.entry.id, from.id);

  const alone = await harness.call('memory_neighbors', { id: (await writeEntry(harness)).id });
  assert.equal(payload(alone)['count'], 0);
  assert.match(prose(alone), /no links yet/u);

  harness.close();
});

test('feedback moves trust and says where it landed', async () => {
  const harness = openHarness();
  const entry = await writeEntry(harness);

  const up = payload(
    await harness.call('memory_feedback', {
      entryId: entry.id,
      verdict: 'helpful',
      note: 'held up'
    })
  );
  assert.equal((up['entry'] as Entry).trust, 0.6);

  const down = await harness.call('memory_feedback', { entryId: entry.id, verdict: 'unhelpful' });
  assert.ok((payload(down)['entry'] as Entry).trust < 0.6);
  assert.match(prose(down), /Trust is now/u);
  assert.ok(harness.store.get(entry.id) !== null, 'a distrusted entry is still there');

  harness.close();
});

// --- Reflect ----------------------------------------------------------------

test('reflect gathers material first, then records the synthesis it is handed', async () => {
  const harness = openHarness();
  await writeEntry(harness, {
    title: 'Locking is unreliable on synced drives',
    body: 'SQLite needs real locks.'
  });
  await writeEntry(harness, {
    title: 'JSONL merges line by line',
    body: 'Text merges, binary does not.'
  });

  const gathered = await harness.call('memory_reflect', { scope: 'agency/engineering' });
  const gatherBody = payload(gathered);
  assert.equal(gatherBody['mode'], 'gather');
  assert.equal(gatherBody['count'], 2);
  assert.match(prose(gathered), /No insight written yet/u);
  assert.match(
    prose(gathered),
    /has no model access/u,
    'the server says plainly that it does not think'
  );

  const sources = (gatherBody['entries'] as Entry[]).map((entry) => entry.id);
  const written = await harness.call('memory_reflect', {
    scope: 'agency/engineering',
    insight: 'The database is the wrong unit of sync; the text snapshot is the right one.',
    sources
  });
  const writeBody = payload(written);

  assert.equal(writeBody['mode'], 'write');
  const insight = writeBody['entry'] as Entry;
  assert.equal(insight.kind, 'insight', 'insight entries are written here and nowhere else');
  assert.equal(insight.scope, 'agency/engineering');
  assert.equal(
    (writeBody['edges'] as unknown[]).length,
    2,
    'the insight is linked to what it came from'
  );
  assert.deepEqual(writeBody['linkErrors'], []);

  const links = payload(await harness.call('memory_neighbors', { id: insight.id }));
  assert.equal(links['count'], 2, 'the reasoning stays traceable from the insight');

  const empty = await harness.call('memory_reflect', { scope: 'personal/nothing' });
  assert.match(prose(empty), /nothing to reflect on yet/u);

  harness.close();
});

// --- Export -----------------------------------------------------------------

test('export writes a snapshot, and two exports of one store are byte identical', async () => {
  const dir = tempDir();
  const harness = openHarness({ exportDirectory: dir });
  try {
    const entry = await writeEntry(harness);
    await harness.call('memory_feedback', { entryId: entry.id, verdict: 'helpful' });
    const first = payload(await harness.call('memory_export', { fileName: 'a.jsonl' }));
    const second = payload(await harness.call('memory_export', { fileName: 'b.jsonl' }));

    assert.deepEqual(first['counts'], { entries: 1, edges: 0, feedback: 1 });
    assert.equal(first['origin'], 'test-machine', 'the header names the machine that wrote it');
    assert.equal(first['schemaVersion'], 1);

    const a = readFileSync(join(dir, 'a.jsonl'));
    const b = readFileSync(join(dir, 'b.jsonl'));
    // The whole git-merge story rests on this. A writer that stamped a wall clock
    // would pass every other test here and fail this one.
    assert.ok(a.equals(b), 'the same memory must produce the same bytes');
    assert.equal(first['exportedAt'], second['exportedAt']);
    assert.equal(a.byteLength, first['bytes']);

    const lines = a.toString('utf8').trimEnd().split('\n');
    const header = JSON.parse(lines[0] ?? '') as {
      type: string;
      exportedAt: string;
      counts: unknown;
    };
    assert.equal(header.type, 'header', 'the header comes first');
    assert.equal(lines.length, 3, 'a header, an entry, and a feedback row');
    assert.ok(a.toString('utf8').endsWith('\n'), 'the file ends with a newline');
    assert.ok(!a.toString('utf8').includes('\r'), 'LF only, whatever the host platform');

    // Stamped from the newest record in the store, not from the clock.
    const newest = harness.store
      .allEntries()
      .map((row) => row.updatedAt)
      .sort()
      .at(-1);
    assert.equal(header.exportedAt, newest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    harness.close();
  }
});

test('export with no file name writes the safe default snapshot', async () => {
  // The writer is stubbed on purpose: this asserts which path the tool resolves
  // to, and it must not put a file in the repository to find out.
  const asked: string[] = [];
  const harness = openHarness({
    exportDirectory: defaultSnapshotPath().slice(0, -'memory.jsonl'.length),
    exportSnapshot: (_store, filePath, options) => {
      asked.push(filePath);
      return Promise.resolve({
        path: filePath,
        origin: options.origin,
        exportedAt: '2026-08-06T00:00:00.000Z',
        schemaVersion: 1,
        entries: 1,
        edges: 0,
        feedback: 0,
        bytes: 512
      });
    }
  });
  await writeEntry(harness);

  const result = await harness.call('memory_export', {});
  assert.deepEqual(asked, [defaultSnapshotPath()], 'the CLI and the tool mean one file');
  assert.equal(payload(result)['path'], defaultSnapshotPath());
  assert.ok(prose(result).includes('memory.jsonl'), 'and the summary says which file it was');

  harness.close();
});

test('an export that fails is reported as a failure, not quietly written another way', async () => {
  const dir = tempDir();
  const harness = openHarness({
    exportDirectory: dir,
    exportSnapshot: () => Promise.reject(new Error('disk is full'))
  });
  await writeEntry(harness);

  try {
    const result = await harness.call('memory_export', { fileName: 'nope.jsonl' });
    assert.equal(result.isError, true);
    assert.match(prose(result), /disk is full/u);
    assert.ok(!existsSync(join(dir, 'nope.jsonl')), 'nothing half-written is left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    harness.close();
  }
});

test('the export tool refuses an origin the header schema would refuse', async () => {
  const dir = tempDir();
  const harness = openHarness({ exportDirectory: dir });
  await writeEntry(harness);
  try {
    const result = await harness.call('memory_export', { fileName: 'x.jsonl', origin: '   ' });
    assert.equal(result.isError, true, 'a blank origin is caught before a file exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    harness.close();
  }
});
