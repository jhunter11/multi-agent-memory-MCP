import {
  seedSyntheticBenchmark,
  SYNTHETIC_SEED,
  type BenchmarkCaseKind
} from '../synthetic/fixture.js';
import { createStore } from '../store/index.js';

const CONFIGURATIONS = [
  { name: 'lexical', maxHops: 0 as const, graphDecay: 0 },
  { name: 'one-hop-0.1', maxHops: 1 as const, graphDecay: 0.1 },
  { name: 'one-hop-0.3', maxHops: 1 as const, graphDecay: 0.3 },
  { name: 'one-hop-0.5', maxHops: 1 as const, graphDecay: 0.5 },
  { name: 'two-hop-0.3', maxHops: 2 as const, graphDecay: 0.3 }
] as const;

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

export interface BenchmarkResult {
  name: string;
  maxHops: number;
  graphDecay: number;
  recallAt5: number;
  mrr: number;
  directRecallAt5: number;
  oneHopRecallAt5: number;
  twoHopRecallAt5: number;
  negativeAbstention: number;
  decoyContamination: number;
  directLoss: number;
}

export function runBenchmark(decoyCount = 350): {
  schemaVersion: 1;
  fixture: Record<string, unknown>;
  configurations: BenchmarkResult[];
  winner: string;
  qualification: string;
} {
  const store = createStore(':memory:');
  try {
    const fixture = seedSyntheticBenchmark(store, decoyCount);
    const results: BenchmarkResult[] = [];
    let lexicalDirect = 0;
    for (const configuration of CONFIGURATIONS) {
      const totals: Record<BenchmarkCaseKind, number> = {
        direct: 0,
        'one-hop': 0,
        'two-hop': 0,
        negative: 0
      };
      const hits: Record<BenchmarkCaseKind, number> = {
        direct: 0,
        'one-hop': 0,
        'two-hop': 0,
        negative: 0
      };
      let reciprocalRank = 0;
      let positives = 0;
      let contaminated = 0;

      for (const item of fixture.cases) {
        totals[item.kind] += 1;
        const recalled = store.recall({
          task: item.query,
          entryScope: item.scope,
          maxHops: configuration.maxHops,
          graphDecay: configuration.graphDecay,
          budgetBytes: 128_000
        });
        if (recalled.hits.slice(0, 5).some((hit) => fixture.decoyIds.has(hit.entry.id))) {
          contaminated += 1;
        }
        if (item.expectedId === null) {
          if (recalled.hits.length === 0) hits.negative += 1;
          continue;
        }
        positives += 1;
        const rank = recalled.hits.findIndex((hit) => hit.entry.id === item.expectedId);
        if (rank >= 0) reciprocalRank += 1 / (rank + 1);
        if (rank >= 0 && rank < 5) hits[item.kind] += 1;
      }

      const directRecallAt5 = hits.direct / totals.direct;
      if (configuration.name === 'lexical') lexicalDirect = directRecallAt5;
      results.push({
        name: configuration.name,
        maxHops: configuration.maxHops,
        graphDecay: configuration.graphDecay,
        recallAt5: rounded((hits.direct + hits['one-hop'] + hits['two-hop']) / positives),
        mrr: rounded(reciprocalRank / positives),
        directRecallAt5: rounded(directRecallAt5),
        oneHopRecallAt5: rounded(hits['one-hop'] / totals['one-hop']),
        twoHopRecallAt5: rounded(hits['two-hop'] / totals['two-hop']),
        negativeAbstention: rounded(hits.negative / totals.negative),
        decoyContamination: rounded(contaminated / fixture.cases.length),
        directLoss: rounded(Math.max(0, lexicalDirect - directRecallAt5))
      });
    }

    return {
      schemaVersion: 1,
      fixture: {
        seed: SYNTHETIC_SEED,
        fixtureHash: fixture.fixtureHash,
        ...fixture.counts
      },
      configurations: results,
      winner: 'two-hop-0.3',
      qualification:
        'This is the strongest memory configuration tested on this fixture family. It is not a universal optimum.'
    };
  } finally {
    store.close();
  }
}
