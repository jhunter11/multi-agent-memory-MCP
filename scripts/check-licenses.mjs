import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const allowed =
  /^(?:0BSD|Apache-2\.0|BSD(?:-2-Clause|-3-Clause)?|BlueOak-1\.0\.0|CC0-1\.0|ISC|MIT|MPL-2\.0|Python-2\.0|Unlicense)(?: OR (?:Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|MIT))*$/u;
const reviewedCompound = new Set([
  '(MIT OR CC0-1.0)',
  '(MIT OR WTFPL)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  'MIT AND Zlib',
  'MIT OR Apache-2.0'
]);
const unknown = [];
// Optional Sharp binaries include libvips and its LGPL components. See THIRD_PARTY_NOTICES.md.
// Pin each reviewed family to its version and declared license so an upgrade requires review.
const reviewedLibvipsPlatforms = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm',
  'linux-arm64',
  'linux-ppc64',
  'linux-riscv64',
  'linux-s390x',
  'linux-x64',
  'linuxmusl-arm64',
  'linuxmusl-x64'
]);
const reviewedSharpBinaries = new Map([
  ['win32-arm64', 'Apache-2.0 AND LGPL-3.0-or-later'],
  ['win32-ia32', 'Apache-2.0 AND LGPL-3.0-or-later'],
  ['win32-x64', 'Apache-2.0 AND LGPL-3.0-or-later'],
  ['wasm32', 'Apache-2.0 AND LGPL-3.0-or-later AND MIT']
]);

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || !metadata.license) continue;
  if (
    path.startsWith('node_modules/@img/sharp-libvips-') &&
    reviewedLibvipsPlatforms.has(path.slice('node_modules/@img/sharp-libvips-'.length)) &&
    metadata.version === '1.3.4' &&
    metadata.license === 'LGPL-3.0-or-later'
  )
    continue;
  if (
    path.startsWith('node_modules/@img/sharp-') &&
    metadata.version === '0.35.5' &&
    reviewedSharpBinaries.get(path.slice('node_modules/@img/sharp-'.length)) === metadata.license
  )
    continue;
  // FlatBuffers 1.12.0 declares its license by filename. The pinned package contains Apache 2.0.
  if (
    path === 'node_modules/flatbuffers' &&
    metadata.version === '1.12.0' &&
    metadata.license === 'SEE LICENSE IN LICENSE.txt'
  )
    continue;
  if (!allowed.test(metadata.license) && !reviewedCompound.has(metadata.license)) {
    unknown.push(`${path}: ${metadata.license}`);
  }
}

assert.deepEqual(unknown, [], `review dependency licenses:\n${unknown.join('\n')}`);
process.stdout.write(
  `${JSON.stringify({ ok: true, packages: Object.keys(lock.packages ?? {}).length })}\n`
);
