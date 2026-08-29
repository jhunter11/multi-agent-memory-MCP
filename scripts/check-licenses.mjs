import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const allowed =
  /^(?:0BSD|Apache-2\.0|BSD(?:-2-Clause|-3-Clause)?|BlueOak-1\.0\.0|CC0-1\.0|ISC|MIT|MPL-2\.0|Python-2\.0|Unlicense)(?: OR (?:Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|MIT))*$/u;
const reviewedCompound = new Set(['(MIT OR CC0-1.0)', 'MIT AND Zlib', 'MIT OR Apache-2.0']);
const unknown = [];

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || !metadata.license) continue;
  if (!allowed.test(metadata.license) && !reviewedCompound.has(metadata.license)) {
    unknown.push(`${path}: ${metadata.license}`);
  }
}

assert.deepEqual(unknown, [], `review dependency licenses:\n${unknown.join('\n')}`);
process.stdout.write(
  `${JSON.stringify({ ok: true, packages: Object.keys(lock.packages ?? {}).length })}\n`
);
