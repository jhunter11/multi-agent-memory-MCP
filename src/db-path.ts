/**
 * Which files this project uses, decided in one place.
 *
 * The MCP server and the portability CLI both have to land on the same database,
 * or an export reads a different memory than the one the harnesses write to. That
 * is a silent failure: both commands succeed and the snapshot is simply of the
 * wrong store. The snapshot path is here for the same reason — `memory_export`
 * and `npm run export` must mean the same file when neither is told otherwise.
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { DATABASE_ENV_VAR, EXPORT_DIR_ENV_VAR } from './public-identity.js';

export const DATABASE_FILE_NAME = 'memory.sqlite';
export const DATABASE_DIR_NAME = 'multi-agent-memory-mcp';

export const SNAPSHOT_DIR_NAME = 'exports';
export const SNAPSHOT_FILE_NAME = 'memory.jsonl';

export { DATABASE_ENV_VAR, EXPORT_DIR_ENV_VAR };

export type EnvLike = Record<string, string | undefined>;

function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

/**
 * The safe default is in the operating-system data directory, outside a source
 * checkout. Snapshots contain plaintext memory and should not enter Git by
 * accident.
 */
export function defaultSnapshotPath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return pathFor(platform).join(defaultExportDirectory(env, platform), SNAPSHOT_FILE_NAME);
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return null;
}

function homeDirectory(env: EnvLike): string {
  return firstNonEmpty(env['HOME'], env['USERPROFILE']) ?? homedir();
}

/**
 * The per-OS location used when neither `--db` nor the environment says otherwise.
 *
 * On Windows this is `LOCALAPPDATA`, never the roaming `APPDATA`. A roaming
 * profile is copied between machines by the domain, and a copied live SQLite file
 * is the exact corruption this project tells users to avoid. On Linux it honours
 * `XDG_DATA_HOME` when the user set one.
 */
export function defaultDatabasePath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const home = homeDirectory(env);
  const path = pathFor(platform);
  if (platform === 'win32') {
    const base = firstNonEmpty(env['LOCALAPPDATA']) ?? path.join(home, 'AppData', 'Local');
    return path.join(base, DATABASE_DIR_NAME, DATABASE_FILE_NAME);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', DATABASE_DIR_NAME, DATABASE_FILE_NAME);
  }
  const base = firstNonEmpty(env['XDG_DATA_HOME']) ?? path.join(home, '.local', 'share');
  return path.join(base, DATABASE_DIR_NAME, DATABASE_FILE_NAME);
}

export function defaultExportDirectory(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const path = pathFor(platform);
  const configured = firstNonEmpty(env[EXPORT_DIR_ENV_VAR]);
  if (configured !== null) return path.resolve(configured);
  return path.join(defaultDatabasePath(env, platform), '..', SNAPSHOT_DIR_NAME);
}

export function resolveMcpExportTarget(
  fileName: string,
  exportDirectory: string,
  platform: NodeJS.Platform = process.platform
): string {
  const path = pathFor(platform);
  const clean = fileName.trim();
  const safeName = path.basename(clean);
  if (
    clean.length === 0 ||
    clean.includes('/') ||
    clean.includes('\\') ||
    safeName !== clean ||
    !safeName.toLowerCase().endsWith('.jsonl')
  ) {
    throw new Error('fileName must be one JSONL file name without directory segments');
  }
  return path.resolve(exportDirectory, safeName);
}

/** Reads `--db <path>` or `--db=<path>` out of the argument list. */
export function readDatabaseArgument(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--db needs a path, for example --db D:\\memory\\memory.sqlite');
      }
      return next;
    }
    if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length);
      if (value.length === 0) {
        throw new Error('--db= needs a path after the equals sign');
      }
      return value;
    }
  }
  return null;
}

/**
 * `--db` beats `MULTI_AGENT_MEMORY_DB`, which beats the OS default.
 *
 * Explicit beats ambient beats convention. The three harnesses launch this server
 * differently, and the one that states a path in its own config must win over a
 * stale variable left in a shell.
 */
export function resolveDatabasePath(
  argv: readonly string[] = process.argv.slice(2),
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const path = pathFor(platform);
  const fromArgs = readDatabaseArgument(argv);
  if (fromArgs !== null && fromArgs.trim().length > 0) {
    return path.resolve(fromArgs.trim());
  }
  const fromEnv = firstNonEmpty(env[DATABASE_ENV_VAR]);
  if (fromEnv !== null) {
    return path.resolve(fromEnv);
  }
  const fallback = defaultDatabasePath(env, platform);
  return path.isAbsolute(fallback) ? fallback : path.resolve(fallback);
}
