import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Edge, Entry, Feedback } from '../src/contracts.ts';

/**
 * `src` compiles under NodeNext, so its relative imports carry the `.js`
 * extension the build will emit. Node's type stripper does not map `.js` back to
 * `.ts`, so running the sources straight from `tests` needs that one mapping
 * supplied. The hook only touches a relative `.js` specifier that has a `.ts`
 * file sitting next to it, so nothing in `node_modules` is affected.
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

const {
  ENTRY_ID_PATTERN,
  SqliteMemoryStore,
  entryBytes,
  newEntryId,
  nextTrust,
  queryTerms,
  scopeProximity,
  ulidTime
} = await import('../src/store/index.ts');

type Store = InstanceType<typeof SqliteMemoryStore>;

// --- Fixtures ---------------------------------------------------------------

function openStore(): Store {
  return new SqliteMemoryStore({ dbPath: ':memory:' });
}

interface SeedOptions {
  scope?: string;
  title?: string;
  body?: string;
  kind?: 'fact' | 'decision' | 'observation' | 'insight' | 'procedure';
  tags?: string[];
  source?: string;
}

function seed(store: Store, options: SeedOptions = {}): Entry {
  return store.write({
    kind: options.kind ?? 'fact',
    scope: options.scope ?? 'agency',
    title: options.title ?? 'A title',
    body: options.body ?? 'A body',
    source: options.source ?? 'test',
    tags: options.tags ?? []
  });
}

/** Sets trust directly, the way an import would, so ranking can be pinned. */
function setTrust(store: Store, entry: Entry, trust: number): Entry {
  const moved: Entry = {
    ...entry,
    trust,
    updatedAt: new Date(Date.parse(entry.updatedAt) + 1_000).toISOString()
  };
  assert.equal(store.upsertEntry(moved), 'updated');
  return moved;
}

function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function scopeOrder(hits: { entry: Entry }[]): string[] {
  return hits.map((hit) => hit.entry.scope);
}

// --- Ids --------------------------------------------------------------------

test('entry ids match the contract pattern and sort by creation time', () => {
  const ids = Array.from({ length: 50 }, () => newEntryId());
  for (const id of ids) assert.match(id, ENTRY_ID_PATTERN);

  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  assert.deepEqual([...ids].sort(), ids, 'ids must already be in ascending order');

  const decoded = ulidTime(ids[0] as string);
  assert.ok(Math.abs(decoded - Date.now()) < 60_000, 'the timestamp must decode back');
});

// --- Write and read ---------------------------------------------------------

test('write and get round-trip an entry', () => {
  const store = openStore();
  const written = store.write({
    kind: 'decision',
    scope: 'agency/engineering',
    title: 'Use SQLite for local memory',
    body: 'A single file that any harness can open beats a service that has to be running.',
    source: 'design review',
    tags: ['Storage', 'storage', ' SQLite ']
  });

  assert.match(written.id, ENTRY_ID_PATTERN);
  assert.equal(written.trust, 0.5);
  assert.equal(written.supersededBy, null);
  assert.deepEqual(written.tags, ['storage', 'sqlite'], 'tags are lowercased and deduplicated');
  assert.equal(written.createdAt, written.updatedAt);

  const read = store.get(written.id);
  assert.deepEqual(read, written);
  assert.equal(store.get('mem_00000000000000000000000000'), null);

  store.close();
});

test('write rejects a scope that is not a lowercase path', () => {
  const store = openStore();
  assert.throws(() => seed(store, { scope: 'Agency/Engineering' }));
  assert.throws(() => seed(store, { scope: '' }));
  store.close();
});

// --- Full text search -------------------------------------------------------

test('search finds an entry by text that appears only in the body', () => {
  const store = openStore();
  const wanted = seed(store, {
    title: 'Deploy notes',
    body: 'The postgres connection pool saturates at forty concurrent clients.'
  });
  seed(store, { title: 'Lunch order', body: 'Nobody wants the tuna sandwich again.' });

  const hits = store.search({ query: 'postgres connection pool' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.entry.id, wanted.id);
  assert.ok((hits[0]?.score ?? 0) > 0);

  store.close();
});

test('search survives punctuation that FTS5 would read as an operator', () => {
  const store = openStore();
  const wanted = seed(store, {
    title: 'Rate limits',
    body: 'The gateway returns 429 after 60 requests.'
  });

  for (const query of ['gateway AND "429', 'gateway: 429 *', '-gateway ^429', '((gateway']) {
    const hits = store.search({ query });
    assert.equal(hits[0]?.entry.id, wanted.id, `query ${query} must not throw and must match`);
  }

  assert.deepEqual(store.search({ query: '!!!' }), [], 'a query with no words matches nothing');
  assert.deepEqual(queryTerms('Gateway, gateway; 429!'), ['gateway', '429']);

  store.close();
});

test('search filters by kind and by tag', () => {
  const store = openStore();
  const decision = seed(store, {
    kind: 'decision',
    title: 'Ship the canvas',
    body: 'canvas ships friday',
    tags: ['ship']
  });
  seed(store, {
    kind: 'observation',
    title: 'Canvas jank',
    body: 'canvas ships friday',
    tags: ['ui']
  });

  const byKind = store.search({ query: 'canvas ships', kinds: ['decision'] });
  assert.equal(byKind.length, 1);
  assert.equal(byKind[0]?.entry.id, decision.id);

  const byTag = store.search({ query: 'canvas ships', tags: ['ship'] });
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0]?.entry.id, decision.id);

  assert.equal(store.search({ query: 'canvas ships' }).length, 2);
  store.close();
});

// --- Scope ------------------------------------------------------------------

test('a scoped search includes nested descendants and excludes everything else', () => {
  const store = openStore();
  const body = 'The retention window is ninety days.';
  seed(store, { scope: 'agency', body });
  seed(store, { scope: 'agency/engineering', body });
  seed(store, { scope: 'agency/engineering/backend', body });
  seed(store, { scope: 'agency-labs', body });
  seed(store, { scope: 'personal/health', body });

  const scoped = store.search({ query: 'retention window', scope: 'agency' });
  assert.deepEqual(scopeOrder(scoped).sort(), [
    'agency',
    'agency/engineering',
    'agency/engineering/backend'
  ]);

  const deeper = store.search({ query: 'retention window', scope: 'agency/engineering' });
  assert.deepEqual(scopeOrder(deeper).sort(), ['agency/engineering', 'agency/engineering/backend']);

  store.close();
});

test('scope proximity orders results and never drops a distant one', () => {
  const store = openStore();
  const body = 'The retention window is ninety days.';
  const title = 'Retention';
  seed(store, { scope: 'agency/engineering', title, body });
  seed(store, { scope: 'agency/engineering/backend', title, body });
  seed(store, { scope: 'agency', title, body });
  seed(store, { scope: 'agency/design', title, body });
  seed(store, { scope: 'personal/health', title, body });

  const { hits } = store.recall({ task: 'retention window', entryScope: 'agency/engineering' });

  assert.deepEqual(scopeOrder(hits), [
    'agency/engineering',
    'agency/engineering/backend',
    'agency',
    'agency/design',
    'personal/health'
  ]);
  assert.equal(hits.length, 5, 'an unrelated scope sinks but is never excluded');

  const scores = hits.map((hit) => hit.score);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      (scores[i - 1] ?? 0) > (scores[i] ?? 0),
      'each step down must actually lower the score'
    );
  }

  store.close();
});

test('scope proximity is graded and never reaches zero', () => {
  assert.equal(scopeProximity('agency', 'agency').factor, 1);
  assert.equal(scopeProximity(null, 'anything/at/all').factor, 1);

  const child = scopeProximity('agency', 'agency/engineering');
  const grandchild = scopeProximity('agency', 'agency/engineering/backend');
  const parent = scopeProximity('agency/engineering', 'agency');
  const sibling = scopeProximity('agency/engineering', 'agency/design');
  const stranger = scopeProximity('agency/engineering', 'personal/health');

  assert.equal(child.relation, 'descendant');
  assert.equal(grandchild.relation, 'descendant');
  assert.equal(parent.relation, 'ancestor');
  assert.equal(sibling.relation, 'sibling');
  assert.equal(stranger.relation, 'unrelated');

  assert.ok(1 > child.factor);
  assert.ok(child.factor > grandchild.factor);
  assert.ok(grandchild.factor > parent.factor);
  assert.ok(parent.factor > sibling.factor);
  assert.ok(sibling.factor > stranger.factor);
  assert.ok(stranger.factor > 0, 'an unrelated scope still carries weight');
});

// --- Trust ------------------------------------------------------------------

test('trust multiplies the text score, so a distrusted entry sinks without vanishing', () => {
  const store = openStore();
  const title = 'Vector index tuning';
  const body = 'Raising the probe count trades latency for recall on the vector index.';

  const trusted = seed(store, { scope: 'agency', title, body });
  const doubted = seed(store, { scope: 'agency', title, body });
  setTrust(store, trusted, 0.9);
  setTrust(store, doubted, 0.1);

  const hits = store.search({ query: 'vector index probe count' });
  assert.equal(hits.length, 2, 'low trust must not remove an entry from the results');
  assert.equal(hits[0]?.entry.id, trusted.id, 'the trusted entry must rank first');
  assert.equal(hits[1]?.entry.id, doubted.id);
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));

  // The same two entries, with the trust the other way round, must flip the order.
  setTrust(store, { ...trusted, trust: 0.9, updatedAt: shift(trusted.updatedAt, 2_000) }, 0.1);
  setTrust(store, { ...doubted, trust: 0.1, updatedAt: shift(doubted.updatedAt, 2_000) }, 0.9);

  const flipped = store.search({ query: 'vector index probe count' });
  assert.equal(flipped[0]?.entry.id, doubted.id, 'trust alone must be able to reorder the results');

  store.close();
});

test('feedback moves trust with diminishing returns and stays inside [0, 1]', () => {
  const store = openStore();
  const entry = seed(store, {
    title: 'Cache warmup',
    body: 'Warm the cache before the first request.'
  });

  const up1 = store.feedback(entry.id, 'helpful', 'saved a rollback');
  assert.ok(Math.abs(up1.trust - 0.6) < 1e-12);
  const up2 = store.feedback(entry.id, 'helpful', null);
  assert.ok(Math.abs(up2.trust - 0.68) < 1e-12);
  assert.ok(
    up2.trust - up1.trust < up1.trust - entry.trust,
    'each step must be smaller than the last'
  );

  const down = store.feedback(entry.id, 'unhelpful', null);
  assert.ok(down.trust < up2.trust);

  let current = down.trust;
  for (let i = 0; i < 200; i += 1) {
    current = store.feedback(entry.id, 'unhelpful', null).trust;
    assert.ok(current >= 0 && current <= 1, 'trust must never leave the range');
  }
  assert.ok(current < 1e-6, 'repeated unhelpful feedback drives trust toward zero');

  for (let i = 0; i < 20; i += 1) {
    current = store.feedback(entry.id, 'helpful', null).trust;
    assert.ok(current >= 0 && current <= 1, 'trust must never leave the range');
  }
  assert.ok(current > 0.98 && current < 1, 'helpful feedback approaches one without reaching it');

  const rows = store.allFeedback();
  // Spelled out as a sum rather than a total, so the number stays checkable
  // against the calls above: three by hand, then two loops.
  assert.equal(rows.length, 3 + 200 + 20);
  assert.equal(rows[0]?.entryId, entry.id);
  assert.equal(rows[0]?.note, 'saved a rollback');
  assert.equal(rows[1]?.note, null);

  const stored = store.get(entry.id);
  assert.equal(stored?.trust, current, 'the entry carries the trust the feedback produced');
  assert.ok(Date.parse(stored?.updatedAt ?? '') > Date.parse(entry.updatedAt));

  assert.throws(() => store.feedback('mem_00000000000000000000000000', 'helpful', null));
  store.close();
});

test('the trust step is pure and bounded on its own', () => {
  assert.equal(nextTrust(0, 'unhelpful'), 0);
  assert.equal(nextTrust(1, 'helpful'), 1);
  assert.ok(nextTrust(0.999, 'helpful') < 1);
  assert.ok(nextTrust(0.001, 'unhelpful') > 0);
  assert.equal(nextTrust(-5, 'helpful'), 0.2);
  assert.equal(nextTrust(9, 'unhelpful'), 0.8);
});

// --- Reading a scope --------------------------------------------------------

test('list reads a scope with no query, so it does not depend on the entry text', () => {
  const store = openStore();
  // Not one of these mentions its own scope. That is the normal case, and the
  // reason a text search cannot answer "what is filed here".
  const shallow = seed(store, { scope: 'agency', title: 'Alpha', body: 'first note' });
  const nested = seed(store, { scope: 'agency/engineering', title: 'Beta', body: 'second note' });
  const deeper = seed(store, {
    scope: 'agency/engineering/backend',
    title: 'Gamma',
    body: 'third note'
  });
  seed(store, { scope: 'personal/health', title: 'Delta', body: 'fourth note' });

  const ids = (entries: Entry[]): string[] => entries.map((entry) => entry.id).sort();

  assert.deepEqual(
    ids(store.list({ scope: 'agency' })),
    [shallow.id, nested.id, deeper.id].sort(),
    'a scope includes everything nested beneath it'
  );
  assert.deepEqual(ids(store.list({ scope: 'agency/engineering' })), [nested.id, deeper.id].sort());
  assert.deepEqual(
    store.list({ scope: 'personal/nothing' }),
    [],
    'an empty scope is empty, not an error'
  );

  // Most trusted first, so the material worth reading is at the top.
  setTrust(store, deeper, 0.9);
  setTrust(store, shallow, 0.2);
  assert.deepEqual(
    store.list({ scope: 'agency' }).map((entry) => entry.id),
    [deeper.id, nested.id, shallow.id]
  );
  assert.equal(store.list({ scope: 'agency', limit: 2 }).length, 2);

  // Superseded entries are out unless asked for, the same rule search follows.
  const replacement = store.write({
    kind: 'decision',
    scope: 'agency',
    title: 'Alpha again',
    body: 'first note, revised',
    source: 'test',
    supersedes: shallow.id
  });
  const visible = store.list({ scope: 'agency' }).map((entry) => entry.id);
  assert.ok(!visible.includes(shallow.id));
  assert.ok(visible.includes(replacement.id));
  assert.ok(
    store
      .list({ scope: 'agency', includeSuperseded: true })
      .map((entry) => entry.id)
      .includes(shallow.id)
  );

  // `_` is legal in a scope and is a wildcard to LIKE, which is why the filter
  // uses substr. `agency` must not swallow `agency_private`.
  const sibling = seed(store, { scope: 'agency_private', title: 'Epsilon', body: 'fifth note' });
  assert.ok(
    !store
      .list({ scope: 'agency' })
      .map((entry) => entry.id)
      .includes(sibling.id)
  );

  store.close();
});

// --- Why --------------------------------------------------------------------

test('every hit explains itself in one sentence', () => {
  const store = openStore();
  seed(store, {
    scope: 'agency/engineering/backend',
    title: 'Queue backpressure',
    body: 'The queue sheds load once the backlog passes ten thousand jobs.'
  });

  const [hit] = store.recall({ task: 'queue backlog', entryScope: 'agency' }).hits;
  const why = hit?.why ?? '';

  assert.ok(why.includes('"queue"'), 'the why names what matched');
  assert.ok(why.includes('trust 0.50'), 'the why names the trust');
  assert.ok(why.includes('agency/engineering/backend'), 'the why names the entry scope');
  assert.ok(
    why.includes('2 levels below the searched scope agency'),
    'the why names the scope relationship'
  );
  // A sentence boundary is a period followed by a space or the end of the string.
  // Splitting on every period instead would count the one inside `trust 0.50`,
  // which the assertion above requires to be there.
  assert.ok(why.endsWith('.'), 'the why is a finished sentence');
  assert.equal(
    why.split(/\.(?:\s|$)/u).filter((part) => part.trim().length > 0).length,
    1,
    'one sentence'
  );

  const scoped = store.search({ query: 'queue backlog', scope: 'agency/engineering/backend' });
  assert.ok(scoped[0]?.why.includes('is exactly the scope that was searched'));

  const unscoped = store.search({ query: 'queue backlog' });
  assert.ok(unscoped[0]?.why.includes('no scope was given'));

  store.close();
});

// --- Superseding ------------------------------------------------------------

test('superseding hides the old entry from search but keeps it reachable', () => {
  const store = openStore();
  const old = seed(store, {
    scope: 'agency',
    title: 'Retention policy',
    body: 'Logs are kept for thirty days.'
  });
  const fresh = store.write({
    kind: 'decision',
    scope: 'agency',
    title: 'Retention policy',
    body: 'Logs are kept for ninety days.',
    source: 'test',
    tags: [],
    supersedes: old.id
  });

  const stored = store.get(old.id);
  assert.equal(stored?.supersededBy, fresh.id);
  assert.equal(stored?.body, 'Logs are kept for thirty days.', 'the old text is not rewritten');

  const visible = store.search({ query: 'retention logs kept' });
  assert.deepEqual(
    visible.map((hit) => hit.entry.id),
    [fresh.id],
    'a superseded entry is out of the default search'
  );

  const all = store.search({ query: 'retention logs kept', includeSuperseded: true });
  assert.equal(all.length, 2);
  assert.ok(
    all.some((hit) => hit.entry.id === old.id),
    'includeSuperseded brings the history back'
  );

  const links = store.neighbors(fresh.id);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.edge.kind, 'supersedes');
  assert.equal(links[0]?.edge.fromId, fresh.id);
  assert.equal(links[0]?.edge.toId, old.id);
  assert.equal(links[0]?.entry.id, old.id);

  assert.throws(
    () =>
      store.write({
        kind: 'fact',
        scope: 'agency',
        title: 'Dangling',
        body: 'Points at nothing.',
        source: 'test',
        supersedes: 'mem_00000000000000000000000000'
      }),
    /no such entry/u
  );
  assert.equal(
    store.search({ query: 'dangling points nothing' }).length,
    0,
    'the failed write rolled back'
  );

  store.close();
});

// --- Recall -----------------------------------------------------------------

test('recall fills the byte budget without ever cutting an entry in half', () => {
  const store = openStore();
  const filler = 'The migration runbook explains the cutover step by step. ';
  const written: Entry[] = [];
  for (let i = 0; i < 6; i += 1) {
    written.push(
      seed(store, {
        scope: 'agency/engineering',
        title: `Migration runbook part ${i}`,
        body: filler.repeat(30)
      })
    );
  }

  const each = entryBytes(written[0] as Entry);
  const budget = each * 3 + Math.floor(each / 2);
  const { hits, usedBytes } = store.recall({
    task: 'migration runbook cutover',
    entryScope: 'agency/engineering',
    budgetBytes: budget
  });

  assert.ok(hits.length > 0 && hits.length < written.length, 'the budget must actually bind');
  assert.ok(usedBytes <= budget, `usedBytes ${usedBytes} must stay inside the budget ${budget}`);
  assert.equal(
    usedBytes,
    hits.reduce((sum, hit) => sum + entryBytes(hit.entry), 0),
    'usedBytes is the real cost of what was returned'
  );

  for (const hit of hits) {
    const stored = store.get(hit.entry.id);
    assert.deepEqual(hit.entry, stored, 'every returned entry is whole');
  }

  store.close();
});

test('recall skips an entry that cannot fit and keeps packing the smaller ones', () => {
  const store = openStore();
  const shared = 'The incident review names the failed shard and the recovery order.';
  const huge = seed(store, {
    scope: 'agency',
    title: 'Incident review',
    body: `${shared} ${'padding word here. '.repeat(1_500)}`
  });
  const small = seed(store, { scope: 'agency', title: 'Incident review', body: shared });

  // Both are measured after the trust change, not before it. Trust is part of the
  // entry, so 0.5 becoming 0.01 makes the JSON one byte longer, and a budget
  // computed from the stale snapshot would be off by that byte.
  const bigger = setTrust(store, huge, 0.99);
  const smaller = setTrust(store, small, 0.01);

  const ranked = store.recall({
    task: 'incident review failed shard',
    entryScope: 'agency',
    budgetBytes: 1_000_000
  });
  assert.equal(ranked.hits[0]?.entry.id, huge.id, 'the oversized entry really does rank first');

  const budget = entryBytes(smaller) + 64;
  assert.ok(entryBytes(bigger) > budget * 10, 'the first ranked entry cannot possibly fit');

  const { hits, usedBytes } = store.recall({
    task: 'incident review failed shard',
    entryScope: 'agency',
    budgetBytes: budget
  });

  assert.deepEqual(
    hits.map((hit) => hit.entry.id),
    [small.id]
  );
  assert.equal(hits[0]?.entry.body, shared, 'the body came back whole');
  assert.equal(usedBytes, entryBytes(smaller));
  assert.ok(usedBytes <= budget);

  store.close();
});

test('recall ignores superseded entries', () => {
  const store = openStore();
  const old = seed(store, {
    scope: 'agency',
    title: 'Budget',
    body: 'The quarterly budget is fixed.'
  });
  const fresh = store.write({
    kind: 'decision',
    scope: 'agency',
    title: 'Budget',
    body: 'The quarterly budget is fixed.',
    source: 'test',
    supersedes: old.id
  });

  const { hits } = store.recall({ task: 'quarterly budget', entryScope: 'agency' });
  assert.deepEqual(
    hits.map((hit) => hit.entry.id),
    [fresh.id]
  );
  store.close();
});

test('recall expands a bounded two-hop graph with stable paths', () => {
  const store = openStore();
  const direct = seed(store, {
    title: 'Release handoff protocol',
    body: 'The release handoff uses a signed checklist.',
    scope: 'team/engineering'
  });
  const bridge = seed(store, {
    title: 'Ownership note',
    body: 'The operations owner maintains the associated procedure.',
    scope: 'team/operations'
  });
  const target = seed(store, {
    title: 'Rollback procedure',
    body: 'Restore the previous artifact and verify the health endpoint.',
    scope: 'team/operations'
  });
  const decoy = seed(store, {
    title: 'Catering checklist',
    body: 'Confirm dietary restrictions before the event.',
    scope: 'team/operations'
  });
  store.relate(direct.id, bridge.id, 'refers_to');
  store.relate(bridge.id, target.id, 'contains');

  const result = store.recall({
    task: 'release handoff protocol',
    entryScope: 'team/engineering',
    maxHops: 2,
    graphDecay: 0.3,
    budgetBytes: 100_000
  });

  assert.equal(result.hits.find((hit) => hit.entry.id === direct.id)?.hop, 0);
  assert.equal(result.hits.find((hit) => hit.entry.id === bridge.id)?.hop, 1);
  assert.equal(result.hits.find((hit) => hit.entry.id === target.id)?.hop, 2);
  assert.deepEqual(result.hits.find((hit) => hit.entry.id === target.id)?.path, [
    direct.id,
    bridge.id,
    target.id
  ]);
  assert.equal(
    result.hits.some((hit) => hit.entry.id === decoy.id),
    false
  );
  assert.equal(new Set(result.hits.map((hit) => hit.entry.id)).size, result.hits.length);

  const oneHop = store.recall({
    task: 'release handoff protocol',
    entryScope: 'team/engineering',
    maxHops: 1,
    budgetBytes: 100_000
  });
  assert.equal(
    oneHop.hits.some((hit) => hit.entry.id === target.id),
    false
  );
  store.close();
});

// --- Graph and counts -------------------------------------------------------

test('relate and neighbors walk the graph in both directions', () => {
  const store = openStore();
  const a = seed(store, { title: 'Alpha', body: 'first note' });
  const b = seed(store, { title: 'Beta', body: 'second note' });

  const edge = store.relate(a.id, b.id, 'refers_to');
  assert.equal(edge.fromId, a.id);
  assert.equal(edge.kind, 'refers_to');

  const again = store.relate(a.id, b.id, 'refers_to');
  assert.deepEqual(again, edge, 'relating twice keeps the original edge');
  assert.equal(store.allEdges().length, 1);

  assert.equal(store.neighbors(a.id)[0]?.entry.id, b.id);
  assert.equal(store.neighbors(b.id)[0]?.entry.id, a.id);

  assert.throws(() => store.relate(a.id, 'mem_00000000000000000000000000', 'refers_to'));
  store.close();
});

/**
 * `edges` and `entries` both have a `kind` and a `created_at`, and `neighbors`
 * selects from both at once. When those columns shared an alias, the entry won
 * both: the kind became a loud schema error, and the timestamp became a quiet
 * wrong answer that every other test in this file accepted.
 */
test('a neighbor edge reports the edge kind and the edge timestamp, not the entry ones', () => {
  const store = openStore();
  const target = seed(store, {
    kind: 'fact',
    title: 'Shard map',
    body: 'The shard map is versioned.'
  });
  const source = seed(store, {
    kind: 'decision',
    title: 'Shard split',
    body: 'Split shard four in March.'
  });

  // Pinned an hour past the entries, so an edge that reported an entry's
  // timestamp is visibly wrong rather than accidentally right.
  const edgeCreatedAt = shift(target.createdAt, 3_600_000);
  assert.equal(
    store.upsertEdge({
      fromId: source.id,
      toId: target.id,
      kind: 'refers_to',
      createdAt: edgeCreatedAt
    }),
    'inserted'
  );

  const [link] = store.neighbors(source.id);
  assert.equal(link?.edge.kind, 'refers_to', 'the edge kind is the edge kind');
  assert.notEqual(link?.edge.kind, target.kind);
  assert.notEqual(link?.edge.kind, source.kind);
  assert.equal(link?.edge.createdAt, edgeCreatedAt, 'the edge timestamp is the edge timestamp');
  assert.notEqual(link?.edge.createdAt, target.createdAt);
  assert.equal(link?.edge.fromId, source.id);
  assert.equal(link?.edge.toId, target.id);

  assert.equal(link?.entry.id, target.id);
  assert.equal(link?.entry.kind, 'fact', 'and the entry still reports its own kind');
  assert.equal(link?.entry.createdAt, target.createdAt, 'and its own timestamp');

  store.close();
});

test('stats counts rows and entries per scope', () => {
  const store = openStore();
  const a = seed(store, { scope: 'agency', title: 'One', body: 'one' });
  seed(store, { scope: 'agency', title: 'Two', body: 'two' });
  const c = seed(store, { scope: 'personal/health', title: 'Three', body: 'three' });
  store.relate(a.id, c.id, 'refers_to');
  store.feedback(a.id, 'helpful', null);

  assert.deepEqual(store.stats(), {
    entries: 3,
    edges: 1,
    feedback: 1,
    scopes: { agency: 2, 'personal/health': 1 }
  });
  store.close();
});

// --- Import path ------------------------------------------------------------

test('upsertEntry is last write wins on updatedAt', () => {
  const source = openStore();
  const original = seed(source, {
    scope: 'agency',
    title: 'Original title',
    body: 'The original body mentions telemetry.'
  });
  source.close();

  const target = openStore();
  assert.equal(target.upsertEntry(original), 'inserted', 'absent records land');
  assert.deepEqual(target.get(original.id), original);

  const newer: Entry = {
    ...original,
    title: 'Newer title',
    body: 'The newer body mentions observability.',
    trust: 0.81,
    updatedAt: shift(original.updatedAt, 5_000)
  };
  assert.equal(target.upsertEntry(newer), 'updated', 'a newer record wins');
  assert.deepEqual(target.get(original.id), newer);

  const older: Entry = {
    ...original,
    title: 'Older title',
    updatedAt: shift(original.updatedAt, -5_000)
  };
  assert.equal(target.upsertEntry(older), 'skipped_older', 'an older record is skipped');
  assert.equal(target.get(original.id)?.title, 'Newer title');

  assert.equal(
    target.upsertEntry(newer),
    'skipped_older',
    'importing the same file twice is a no-op'
  );

  // The text index followed the update.
  assert.equal(target.search({ query: 'observability' }).length, 1);
  assert.equal(target.search({ query: 'telemetry' }).length, 0);

  target.close();
});

test('upsertEdge and upsertFeedback are last write wins on createdAt', () => {
  const store = openStore();
  const a = seed(store, { title: 'Alpha', body: 'first note' });
  const b = seed(store, { title: 'Beta', body: 'second note' });

  const edge: Edge = { fromId: a.id, toId: b.id, kind: 'refers_to', createdAt: a.createdAt };
  assert.equal(store.upsertEdge(edge), 'inserted', 'absent edges land');
  assert.equal(store.upsertEdge(edge), 'skipped_older', 'the same edge twice is a no-op');
  assert.equal(
    store.upsertEdge({ ...edge, createdAt: shift(edge.createdAt, -5_000) }),
    'skipped_older',
    'an older edge is skipped'
  );
  assert.equal(store.allEdges()[0]?.createdAt, edge.createdAt);

  const newerEdge: Edge = { ...edge, createdAt: shift(edge.createdAt, 5_000) };
  assert.equal(store.upsertEdge(newerEdge), 'inserted', 'a newer edge replaces the stored one');
  assert.equal(store.allEdges().length, 1);
  assert.equal(store.allEdges()[0]?.createdAt, newerEdge.createdAt);

  const row: Feedback = {
    id: 'fbk_from_the_other_machine',
    entryId: a.id,
    verdict: 'helpful',
    note: 'first take',
    createdAt: a.createdAt
  };
  assert.equal(store.upsertFeedback(row), 'inserted', 'absent feedback lands');
  assert.equal(store.upsertFeedback(row), 'skipped_older', 'the same feedback twice is a no-op');
  assert.equal(
    store.upsertFeedback({ ...row, note: 'stale', createdAt: shift(row.createdAt, -5_000) }),
    'skipped_older',
    'older feedback is skipped'
  );
  assert.equal(store.allFeedback()[0]?.note, 'first take');

  assert.equal(
    store.upsertFeedback({ ...row, note: 'second take', createdAt: shift(row.createdAt, 5_000) }),
    'inserted',
    'newer feedback replaces the stored one'
  );
  assert.equal(store.allFeedback().length, 1);
  assert.equal(store.allFeedback()[0]?.note, 'second take');

  store.close();
});

test('the raw readers come back in a stable order', () => {
  const store = openStore();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(seed(store, { title: `Note ${i}`, body: `body ${i}` }).id);
  }

  assert.deepEqual(
    store.allEntries().map((entry) => entry.id),
    ids
  );
  assert.deepEqual(
    store.allEntries().map((entry) => entry.id),
    [...ids].sort()
  );
  store.close();
});

test('the schema version is stamped on the file', () => {
  const store = openStore();
  assert.equal(store.schemaVersion, 1);
  store.close();
});
