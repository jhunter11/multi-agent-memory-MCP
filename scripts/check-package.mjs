import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result =
  process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], {
        encoding: 'utf8'
      })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const [manifest] = JSON.parse(result.stdout);
assert.ok(manifest, 'npm did not return a package manifest');

const allowedRoots = new Set([
  'dist',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json'
]);
const deniedExtensions = /\.(?:db|sqlite|sqlite3|jsonl)$/iu;

for (const file of manifest.files) {
  const path = file.path.replaceAll('\\', '/');
  const root = path.split('/')[0];
  assert.ok(allowedRoots.has(root), `unexpected package file: ${path}`);
  assert.ok(!deniedExtensions.test(path), `private data file in package: ${path}`);
}

assert.ok(manifest.files.some((file) => file.path === 'dist/mcp/bin.js'));
assert.ok(manifest.files.some((file) => file.path === 'LICENSE'));
process.stdout.write(
  `${JSON.stringify({ ok: true, files: manifest.files.length, bytes: manifest.size })}\n`
);
