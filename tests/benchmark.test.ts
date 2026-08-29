import assert from 'node:assert/strict';
import test from 'node:test';

import { runBenchmark } from '../src/benchmark/run.ts';

test('the synthetic benchmark rewards bounded two-hop recall without direct loss', () => {
  const report = runBenchmark(20);
  const lexical = report.configurations.find((row) => row.name === 'lexical');
  const twoHop = report.configurations.find((row) => row.name === 'two-hop-0.3');
  assert.equal(lexical?.directRecallAt5, 1);
  assert.equal(lexical?.oneHopRecallAt5, 0);
  assert.equal(lexical?.twoHopRecallAt5, 0);
  assert.equal(twoHop?.directRecallAt5, 1);
  assert.equal(twoHop?.oneHopRecallAt5, 1);
  assert.equal(twoHop?.twoHopRecallAt5, 1);
  assert.equal(twoHop?.negativeAbstention, 1);
  assert.equal(twoHop?.directLoss, 0);
  assert.equal(report.winner, 'two-hop-0.3');
});
