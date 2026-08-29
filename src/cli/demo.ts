import { createStore } from '../store/index.js';

const store = createStore(':memory:');
try {
  const seed = store.write({
    kind: 'decision',
    scope: 'demo/engineering',
    title: 'Release checklist owner',
    body: 'The release checklist is maintained by the operations agent.',
    source: 'synthetic-demo'
  });
  const target = store.write({
    kind: 'procedure',
    scope: 'demo/operations',
    title: 'Rollback procedure',
    body: 'Restore the previous artifact, verify health, and record the outcome.',
    source: 'synthetic-demo'
  });
  store.relate(seed.id, target.id, 'refers_to');
  const recalled = store.recall({
    task: 'release checklist owner',
    entryScope: 'demo/engineering',
    maxHops: 2
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        query: 'release checklist owner',
        configuration: { maxHops: 2, graphDecay: 0.3 },
        hits: recalled.hits.map((hit) => ({ title: hit.entry.title, hop: hit.hop, path: hit.path }))
      },
      null,
      2
    )}\n`
  );
} finally {
  store.close();
}
