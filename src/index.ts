/**
 * The library surface, for code that wants the store without the server.
 *
 * The MCP layer is deliberately absent: importing this must not pull in the MCP
 * SDK or a stdio transport. The server has its own entry point at `mcp/bin.js`.
 */

export * from './contracts.js';
export * from './public-identity.js';
export {
  DATABASE_DIR_NAME,
  DATABASE_ENV_VAR,
  DATABASE_FILE_NAME,
  EXPORT_DIR_ENV_VAR,
  defaultExportDirectory,
  defaultDatabasePath,
  defaultSnapshotPath,
  readDatabaseArgument,
  resolveMcpExportTarget,
  resolveDatabasePath
} from './db-path.js';
export type { EnvLike } from './db-path.js';
export * from './store/index.js';
export * from './portability/index.js';
