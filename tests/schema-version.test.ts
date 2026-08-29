import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SqliteMemoryStore } from '../src/store/sqlite-store.ts';
import { UnsupportedSchemaVersionError } from '../src/store/schema.ts';

test('refuses a database created by a newer schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-future-schema-'));
  const path = join(directory, 'memory.sqlite');
  try {
    const db = new Database(path);
    db.pragma('user_version = 99');
    db.close();
    assert.throws(
      () => new SqliteMemoryStore({ dbPath: path }),
      (error) => error instanceof UnsupportedSchemaVersionError && error.found === 99
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
