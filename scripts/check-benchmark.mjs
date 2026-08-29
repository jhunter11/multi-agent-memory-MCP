import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'memory-benchmark-'));
try {
  const output = join(dir, 'results.json');
  const run = spawnSync(process.execPath, ['dist/cli/benchmark.js', output], {
    cwd: resolve('.'),
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(output, 'utf8'), await readFile('benchmark/results.json', 'utf8'));
  process.stdout.write('benchmark results reproduced byte for byte\n');
} finally {
  await rm(dir, { recursive: true, force: true });
}
