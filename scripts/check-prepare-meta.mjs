import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createStore } from '../dist/store/index.js';
import { atomicJson } from '../dist/store/vectors.js';

const directory = await mkdtemp(join(tmpdir(), 'memory-prepare-'));
try {
  const path = join(directory, 'memory.sqlite');
  const store = createStore(path);
  const entry = store.write({
    kind: 'fact',
    scope: 'fixture',
    title: 'Fixture evidence',
    body: 'Private database fixture.',
    source: 'synthetic-test'
  });
  store.close();
  await atomicJson(path + '.meta.json', { strategy: 'lexical' });
  const run = spawnSync(
    process.execPath,
    ['scripts/prepare-meta.mjs', '--db', path, '--strategy', 'meta'],
    { encoding: 'utf8' }
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.vectors, false);
  assert.equal(result.reloadClients, true);
  assert.deepEqual(JSON.parse(await readFile(result.backup + '.meta.json', 'utf8')), {
    strategy: 'lexical'
  });
  assert.deepEqual(JSON.parse(await readFile(path + '.meta.json', 'utf8')), { strategy: 'meta' });
  const backup = new Database(result.backup, { readonly: true });
  try {
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    backup.close();
  }
  const reopened = createStore(path),
    restored = createStore(result.backup);
  try {
    assert.deepEqual(reopened.allEntries(), [entry]);
    assert.deepEqual(restored.allEntries(), [entry]);
  } finally {
    reopened.close();
    restored.close();
  }
  for (const args of [
    ['--unknown'],
    ['--db', path, '--strategy', 'wrong'],
    ['--db', path, '--download']
  ]) {
    assert.notEqual(
      spawnSync(process.execPath, ['scripts/prepare-meta.mjs', ...args], { encoding: 'utf8' })
        .status,
      0
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      network: 'not used',
      backup: 'verified',
      records: 'unchanged',
      settings: 'backed up and updated',
      invalidArguments: 'rejected'
    })
  );
} finally {
  assert.equal(
    resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')),
    true
  );
  await rm(directory, { recursive: true, force: true });
}
