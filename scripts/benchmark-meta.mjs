import { seedSyntheticBenchmark } from '../dist/synthetic/fixture.js';
import assert from 'node:assert/strict';
import { createStore } from '../dist/store/index.js';
const store = createStore(':memory:');
try {
  const fixture = seedSyntheticBenchmark(store, 350);
  const results = [];
  for (const strategy of ['meta', 'fusion', 'concept', 'lexical', 'information']) {
    const totals = {},
      top5 = {};
    let reciprocalRank = 0,
      positives = 0,
      negatives = 0,
      abstained = 0,
      decoys = 0;
    const start = performance.now();
    for (const item of fixture.cases) {
      const packet = await store.recallMeta({
        task: item.query,
        entryScope: item.scope,
        strategy,
        budgetBytes: 16384
      });
      if (
        Buffer.byteLength(JSON.stringify(packet), 'utf8') !== packet.usedBytes ||
        packet.usedBytes > 16384
      )
        throw new Error('Invalid packet budget');
      if (packet.hits.slice(0, 5).some((h) => fixture.decoyIds.has(h.entry.id))) decoys++;
      totals[item.kind] = (totals[item.kind] ?? 0) + 1;
      if (item.expectedId === null) {
        negatives++;
        if (!packet.hits.length) abstained++;
        continue;
      }
      positives++;
      const rank = packet.hits.findIndex((h) => h.entry.id === item.expectedId);
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
      if (rank >= 0 && rank < 5) top5[item.kind] = (top5[item.kind] ?? 0) + 1;
    }
    results.push({
      strategy,
      vectorStatus: 'disabled',
      budgetBytes: 16384,
      meanMs: (performance.now() - start) / fixture.cases.length,
      recallAt5: Object.values(top5).reduce((s, n) => s + n, 0) / positives,
      mrr: reciprocalRank / positives,
      direct: (top5.direct ?? 0) / totals.direct,
      oneHop: (top5['one-hop'] ?? 0) / totals['one-hop'],
      twoHop: (top5['two-hop'] ?? 0) / totals['two-hop'],
      negativeAbstention: abstained / negatives,
      decoyContamination: decoys / fixture.cases.length
    });
  }
  const primary = results.find((result) => result.strategy === 'meta');
  for (const metric of ['direct', 'oneHop', 'twoHop', 'negativeAbstention'])
    assert.equal(primary[metric], 1, 'Meta fixture regression: ' + metric);
  assert.equal(primary.decoyContamination, 0);
  console.log(
    JSON.stringify(
      {
        schema: 'meta-synthetic-benchmark/v1',
        fixture: fixture.counts,
        limitation:
          'Synthetic lexical graph fixture with local vectors disabled; not proof of general retrieval or answer quality.',
        results
      },
      null,
      2
    )
  );
} finally {
  store.close();
}
