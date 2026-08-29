/**
 * The storage layer. Everything above it talks to `MemoryStore`, never to SQLite.
 */

export {
  ENTRY_ID_PATTERN,
  ENTRY_ID_PREFIX,
  FEEDBACK_ID_PREFIX,
  ULID_PATTERN,
  isEntryId,
  newEntryId,
  newFeedbackId,
  newUlid,
  ulidTime
} from './id.js';

export {
  FTS_WEIGHT_BODY,
  FTS_WEIGHT_ID,
  FTS_WEIGHT_TITLE,
  SCHEMA_DDL,
  SCHEMA_VERSION,
  applySchema,
  readSchemaVersion
} from './schema.js';

export {
  SqliteMemoryStore,
  TRUST_STEP,
  createStore,
  entryBytes,
  explainHit,
  nextTrust,
  queryTerms,
  scopeProximity
} from './sqlite-store.js';

export type {
  ListScopeArgs,
  RecallArgs,
  ScopeProximity,
  ScopeRelation,
  SearchArgs,
  SqliteMemoryStoreOptions,
  WriteEntryArgs
} from './sqlite-store.js';
