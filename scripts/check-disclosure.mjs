import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['.git', 'node_modules', 'dist', '.audit-tmp']);
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.sh',
  '.toml',
  '.ts',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
]);
const deniedFiles = /\.(?:db|sqlite|sqlite3|jsonl|pem|key)$/iu;
const privateName = ['jar', 'vis'].join('');
const privateUser = ['ja', 'chu'].join('');
const coAuthor = ['co-authored', '-by:'].join('');
const generatedBy = ['generated', '-by:'].join('');
const contentRules = [
  [new RegExp(privateName, 'iu'), 'private project name'],
  [new RegExp(privateUser, 'iu'), 'private user path'],
  [new RegExp(coAuthor, 'iu'), 'co-author attribution trailer'],
  [new RegExp(generatedBy, 'iu'), 'generator attribution trailer'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, 'private key'],
  [/(?:api[_-]?key|token|secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}/iu, 'credential']
];

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}

await walk(root);
for (const file of files) {
  const shown = relative(root, file).replaceAll('\\', '/');
  assert.ok(!deniedFiles.test(shown), `private data extension: ${shown}`);
  if (!textExtensions.has(extname(file).toLowerCase()) || shown === 'package-lock.json') continue;
  const content = await readFile(file, 'utf8');
  for (const [pattern, label] of contentRules) {
    assert.ok(!pattern.test(content), `${label} in ${shown}`);
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, files: files.length })}\n`);
