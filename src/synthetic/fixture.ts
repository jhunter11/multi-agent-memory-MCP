import { createHash } from 'node:crypto';
import type { Entry, MemoryStore } from '../contracts.js';

export const SYNTHETIC_SEED = 20_260_828;

export type BenchmarkCaseKind = 'direct' | 'one-hop' | 'two-hop' | 'negative';

export interface BenchmarkCase {
  kind: BenchmarkCaseKind;
  query: string;
  scope: string;
  expectedId: string | null;
}

export interface SeededBenchmark {
  cases: BenchmarkCase[];
  decoyIds: Set<string>;
  fixtureHash: string;
  counts: { direct: number; oneHop: number; twoHop: number; negative: number; decoys: number };
}

function write(
  store: MemoryStore,
  scope: string,
  title: string,
  body: string,
  tags: string[] = []
): Entry {
  return store.write({ kind: 'fact', scope, title, body, source: 'synthetic-fixture', tags });
}

export function seedSyntheticBenchmark(store: MemoryStore, decoyCount = 350): SeededBenchmark {
  const cases: BenchmarkCase[] = [];
  const decoyIds = new Set<string>();

  for (let index = 0; index < 100; index += 1) {
    const token = `directkey${String(index).padStart(3, '0')}`;
    const target = write(
      store,
      'synthetic/research',
      `Direct answer ${token}`,
      `The stable direct answer for ${token} is protocol-${index}.`,
      ['benchmark-direct']
    );
    cases.push({
      kind: 'direct',
      query: token,
      scope: 'synthetic/research',
      expectedId: target.id
    });
  }

  for (let index = 0; index < 100; index += 1) {
    const token = `bridgekey${String(index).padStart(3, '0')}`;
    const bridge = write(
      store,
      'synthetic/engineering',
      `Bridge record ${token}`,
      `This record routes ${token} to its linked decision.`,
      ['benchmark-bridge']
    );
    const target = write(
      store,
      'synthetic/operations',
      `Linked decision ${index}`,
      `The one-hop result is rollback-window-${index}.`,
      ['benchmark-target']
    );
    store.relate(bridge.id, target.id, 'refers_to');
    cases.push({
      kind: 'one-hop',
      query: token,
      scope: 'synthetic/engineering',
      expectedId: target.id
    });
  }

  for (let index = 0; index < 100; index += 1) {
    const token = `twostepkey${String(index).padStart(3, '0')}`;
    const seed = write(
      store,
      'synthetic/coordination',
      `Coordination record ${token}`,
      `This record begins the two-step route for ${token}.`,
      ['benchmark-seed']
    );
    const bridge = write(
      store,
      'synthetic/engineering',
      `Intermediate architecture record ${index}`,
      `The intermediate record links coordination to the final procedure.`,
      ['benchmark-bridge']
    );
    const target = write(
      store,
      'synthetic/operations',
      `Final procedure ${index}`,
      `The two-hop result is recovery-sequence-${index}.`,
      ['benchmark-target']
    );
    store.relate(seed.id, bridge.id, 'refers_to');
    store.relate(bridge.id, target.id, 'contains');
    cases.push({
      kind: 'two-hop',
      query: token,
      scope: 'synthetic/coordination',
      expectedId: target.id
    });
  }

  for (let index = 0; index < 100; index += 1) {
    cases.push({
      kind: 'negative',
      query: `absentkey${String(index).padStart(3, '0')}`,
      scope: 'synthetic/research',
      expectedId: null
    });
  }

  for (let index = 0; index < decoyCount; index += 1) {
    const decoy = write(
      store,
      `synthetic/decoys/group-${index % 7}`,
      `Routine decoy ${index}`,
      `General coordination status record ${index} with no benchmark key.`,
      ['benchmark-decoy']
    );
    decoyIds.add(decoy.id);
  }

  const counts = { direct: 100, oneHop: 100, twoHop: 100, negative: 100, decoys: decoyCount };
  const fixtureHash = createHash('sha256')
    .update(JSON.stringify({ seed: SYNTHETIC_SEED, counts }))
    .digest('hex');
  return { cases, decoyIds, fixtureHash, counts };
}
