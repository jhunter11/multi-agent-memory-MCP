import assert from 'node:assert/strict';
import { basename, dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';

import {
  DATABASE_ENV_VAR,
  defaultDatabasePath,
  defaultExportDirectory,
  defaultSnapshotPath,
  readDatabaseArgument,
  resolveDatabasePath,
  resolveMcpExportTarget
} from '../src/db-path.ts';

/**
 * Where the database lives is the one setting that has to agree across three
 * harnesses and two CLI commands. A disagreement here does not raise an error: it
 * silently opens a second, empty store, and every command reports success.
 */

const WINDOWS_ENV = {
  LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local',
  APPDATA: 'C:\\Users\\alex\\AppData\\Roaming',
  USERPROFILE: 'C:\\Users\\alex'
};

/**
 * Expectations are assembled with `join` rather than written out.
 *
 * The `platform` argument selects which folder convention applies, but the
 * separator is always the host's, because `node:path` is the host's. Writing a
 * literal would only pass on one operating system, and this suite has to run on
 * whichever machine the developer is at.
 */
function expected(...segments: string[]): string {
  return join(...segments, 'multi-agent-memory-mcp', 'memory.sqlite');
}

test('the Windows default is the local profile, never the roaming one', () => {
  const path = defaultDatabasePath(WINDOWS_ENV, 'win32');

  assert.equal(path, expected('C:\\Users\\alex\\AppData\\Local'));
  // Roaming is copied between machines by the domain, and a copied live SQLite
  // file is the corruption this project tells its users to avoid.
  assert.ok(!path.includes('Roaming'), 'the roaming profile is a synced folder');
});

test('a Windows box with no LOCALAPPDATA falls back under the user profile', () => {
  const path = defaultDatabasePath({ USERPROFILE: 'C:\\Users\\alex' }, 'win32');
  assert.equal(path, expected('C:\\Users\\alex', 'AppData', 'Local'));
});

test('the macOS default is Application Support', () => {
  const path = defaultDatabasePath({ HOME: '/Users/alex' }, 'darwin');
  assert.equal(path, expected('/Users/alex', 'Library', 'Application Support'));
});

test('the Linux default honours XDG_DATA_HOME and falls back to .local/share', () => {
  assert.equal(
    defaultDatabasePath({ HOME: '/home/alex', XDG_DATA_HOME: '/home/alex/.data' }, 'linux'),
    expected('/home/alex/.data')
  );
  assert.equal(
    defaultDatabasePath({ HOME: '/home/alex' }, 'linux'),
    expected('/home/alex', '.local', 'share')
  );
  // An empty variable is not a setting.
  assert.equal(
    defaultDatabasePath({ HOME: '/home/alex', XDG_DATA_HOME: '   ' }, 'linux'),
    expected('/home/alex', '.local', 'share')
  );
});

test('--db is read in both spellings', () => {
  assert.equal(readDatabaseArgument(['--db', '/tmp/a.sqlite']), '/tmp/a.sqlite');
  assert.equal(readDatabaseArgument(['--db=/tmp/b.sqlite']), '/tmp/b.sqlite');
  assert.equal(readDatabaseArgument(['--other', 'x']), null);
  assert.equal(readDatabaseArgument([]), null);

  // A missing value must not silently swallow the next flag.
  assert.throws(() => readDatabaseArgument(['--db', '--origin']), /needs a path/u);
  assert.throws(() => readDatabaseArgument(['--db']), /needs a path/u);
  assert.throws(() => readDatabaseArgument(['--db=']), /after the equals sign/u);
});

test('--db beats the environment variable, which beats the default', () => {
  const env = { ...WINDOWS_ENV, [DATABASE_ENV_VAR]: 'D:\\from-env\\memory.sqlite' };

  assert.equal(
    resolveDatabasePath(['--db', 'D:\\from-flag\\memory.sqlite'], env, 'win32'),
    'D:\\from-flag\\memory.sqlite',
    'the harness that states a path in its own config wins'
  );
  assert.equal(resolveDatabasePath([], env, 'win32'), 'D:\\from-env\\memory.sqlite');
  assert.equal(
    resolveDatabasePath([], WINDOWS_ENV, 'win32'),
    defaultDatabasePath(WINDOWS_ENV, 'win32'),
    'with neither, the OS default'
  );
});

test('a blank environment variable is ignored rather than obeyed', () => {
  const env = { ...WINDOWS_ENV, [DATABASE_ENV_VAR]: '   ' };
  assert.equal(resolveDatabasePath([], env, 'win32'), defaultDatabasePath(WINDOWS_ENV, 'win32'));
});

test('the default snapshot lives outside the source checkout', () => {
  const env = { HOME: '/home/alex', XDG_DATA_HOME: '/home/alex/.data' };
  const path = defaultSnapshotPath(env, 'linux');

  assert.ok(isAbsolute(path), path);
  assert.equal(basename(path), 'memory.jsonl');
  assert.equal(dirname(path), defaultExportDirectory(env, 'linux'));
  assert.equal(basename(dirname(path)), 'exports');
});

test('MCP exports stay inside the configured export directory', () => {
  const root = join('C:\\Data', 'memory exports');
  assert.equal(resolveMcpExportTarget('snapshot.jsonl', root), join(root, 'snapshot.jsonl'));
  assert.throws(() => resolveMcpExportTarget('..\\private.jsonl', root), /one JSONL file name/u);
  assert.throws(() => resolveMcpExportTarget('../private.jsonl', root), /one JSONL file name/u);
  assert.throws(() => resolveMcpExportTarget('snapshot.txt', root), /one JSONL file name/u);
});

test('the resolved path is always absolute', () => {
  const resolved = resolveDatabasePath(
    ['--db', 'relative/memory.sqlite'],
    WINDOWS_ENV,
    process.platform
  );
  assert.notEqual(
    resolved,
    'relative/memory.sqlite',
    'a relative --db is resolved against the cwd'
  );
  assert.ok(resolved.length > 'relative/memory.sqlite'.length);
});
