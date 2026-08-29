import type DatabaseConstructor from 'better-sqlite3';
import { SCHEMA_VERSION } from '../contracts.js';

/**
 * The SQL shape of the store, applied every time the database opens.
 *
 * Every statement is `IF NOT EXISTS`, so opening an existing file is a no-op and
 * opening a new file builds it. `user_version` records which shape is on disk, so
 * a later version can migrate instead of guessing.
 */

type Db = DatabaseConstructor.Database;

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(`Unsupported memory schema version ${found}; this release supports ${supported}.`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

/**
 * Column weights for `bm25(entries_fts, ...)`, in table column order.
 *
 * The first column is the unindexed id and never matches, so it weighs nothing.
 * A hit in the title says more about the entry than a hit in the body, so the
 * title weighs five times as much.
 */
export const FTS_WEIGHT_ID = 0;
export const FTS_WEIGHT_TITLE = 5;
export const FTS_WEIGHT_BODY = 1;

/**
 * `entries_fts` stores its own copy of the title and body rather than reading
 * them from `entries` as an external content table. The copy costs disk that a
 * local store can spare, and it removes the one failure mode of external content
 * tables: the index is keyed by the text id, not by a rowid that `VACUUM` is free
 * to renumber underneath it.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  scope         TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  source        TEXT NOT NULL,
  trust         REAL NOT NULL DEFAULT 0.5,
  tags          TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- Deliberately not a foreign key. An import reads records in file order, so an
  -- entry can arrive before the newer entry that superseded it. A foreign key
  -- would reject that line. Nothing in this store deletes an entry, so the key
  -- would buy no integrity that the writer does not already enforce.
  superseded_by TEXT
);

CREATE INDEX IF NOT EXISTS entries_scope_idx ON entries (scope);
CREATE INDEX IF NOT EXISTS entries_kind_idx ON entries (kind);
CREATE INDEX IF NOT EXISTS entries_superseded_by_idx ON entries (superseded_by);
CREATE INDEX IF NOT EXISTS entries_updated_at_idx ON entries (updated_at);

CREATE TABLE IF NOT EXISTS edges (
  from_id    TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE INDEX IF NOT EXISTS edges_to_id_idx ON edges (to_id);

CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS feedback_entry_id_idx ON feedback (entry_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (
  id UNINDEXED,
  title,
  body,
  tokenize = "porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS entries_after_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (id, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS entries_after_delete AFTER DELETE ON entries BEGIN
  DELETE FROM entries_fts WHERE id = old.id;
END;

-- Trust moves on every piece of feedback, which rewrites the row without
-- touching the text. The guard keeps those writes out of the text index.
CREATE TRIGGER IF NOT EXISTS entries_after_update AFTER UPDATE ON entries
WHEN new.id <> old.id OR new.title <> old.title OR new.body <> old.body
BEGIN
  DELETE FROM entries_fts WHERE id = old.id;
  INSERT INTO entries_fts (id, title, body) VALUES (new.id, new.title, new.body);
END;
`;

function hasApplicationObjects(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'`
    )
    .get() as { count: number };
  return row.count > 0;
}

/** Builds a fresh schema or verifies the exact supported version. */
export function applySchema(db: Db): void {
  const initialize = db.transaction(() => {
    const version = readSchemaVersion(db);
    if (version === 0 && !hasApplicationObjects(db)) {
      db.exec(SCHEMA_DDL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }
    if (version !== SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(version, SCHEMA_VERSION);
    }
    db.exec(SCHEMA_DDL);
  });
  initialize.immediate();
}

/** Reads the schema version stamped on the file. Returns 0 for a fresh database. */
export function readSchemaVersion(db: Db): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

export { SCHEMA_VERSION };
