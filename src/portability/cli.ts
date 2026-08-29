#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { ImportResult } from '../contracts.js';
import { defaultSnapshotPath, resolveDatabasePath } from '../db-path.js';
import { exportToFile } from './export.js';
import type { ExportSummary } from './export.js';
import { importFromFile, SchemaVersionMismatchError } from './import.js';

/**
 * The hand-operated half of sync: write a snapshot on one machine, read it on
 * the other. Deliberately two commands and no daemon. Copying the file is the
 * user's job, whether that is git, a shared drive, or a stick, and the tool
 * stays out of the way of whichever they picked.
 *
 * Both commands default to the database the MCP server uses. That default is not
 * a convenience: a CLI with its own idea of where the database lives would export
 * an empty store and report success, and nothing in the output would say which
 * file it read. So the path is resolved by `src/db-path.ts`, which the server
 * imports too, and every run prints the path it settled on.
 */

const DEFAULT_SNAPSHOT = defaultSnapshotPath();

const USAGE = `multi-agent-memory portability

  export [--out <path>] [--db <path>] [--origin <name>]
      Write a JSONL snapshot of the database.
      --out    defaults to memory-export/memory.jsonl
      --db     defaults to the same database the MCP server opens
      --origin defaults to this machine's hostname, and is recorded in the header

  import [--in <path>] [--db <path>]
      Merge a JSONL snapshot into the database. Last write wins per record id,
      compared on updatedAt. Nothing is deleted.

The snapshot path may also be given as a bare argument:
  import memory-export/memory.jsonl

Exit codes: 0 clean, 1 finished with rejected lines, 2 could not run.`;

interface CliValues {
  db?: string | undefined;
  out?: string | undefined;
  in?: string | undefined;
  origin?: string | undefined;
  help?: boolean | undefined;
}

/** 0 clean, 1 finished but some lines were rejected, 2 could not run at all. */
export async function runCli(argv: readonly string[]): Promise<number> {
  let command: string | undefined;
  let positionalPath: string | undefined;
  let values: CliValues;

  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        db: { type: 'string' },
        out: { type: 'string' },
        in: { type: 'string' },
        origin: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    });
    values = parsed.values;
    command = parsed.positionals[0];
    positionalPath = parsed.positionals[1];
  } catch (error) {
    console.error(`${message(error)}\n\n${USAGE}`);
    return 2;
  }

  if (values.help === true || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command === undefined) {
    console.error(`a command is required\n\n${USAGE}`);
    return 2;
  }

  try {
    if (command === 'export') {
      return await runExport(values, positionalPath);
    }
    if (command === 'import') {
      return await runImport(values, positionalPath);
    }
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (error) {
    console.error(error instanceof SchemaVersionMismatchError ? error.message : message(error));
    return 2;
  }
}

async function runExport(values: CliValues, positionalPath: string | undefined): Promise<number> {
  const db = databasePath(values.db);
  const out = snapshotPath(values.out, positionalPath);
  const origin = firstNonEmpty(values.origin) ?? hostname();

  /*
   * Opening a database creates it, which is right for a server on first start and
   * wrong here. A typo in --db would otherwise leave a new empty file on disk and
   * report a successful export of nothing, and the summary would look the same as
   * a real one. An export needs a database that already exists.
   */
  if (!existsSync(db)) {
    throw new Error(
      `no database at ${db}\n\n` +
        'Nothing has been exported. Check --db, or check MULTI_AGENT_MEMORY_DB, or start a\n' +
        'harness once so the server creates the database.'
    );
  }

  const store = await openStore(db);
  let summary: ExportSummary;
  try {
    summary = await exportToFile(store, out, { origin });
  } finally {
    store.close();
  }

  console.log(
    `exported ${count(summary.entries, 'entry', 'entries')}, ` +
      `${count(summary.edges, 'edge', 'edges')}, ` +
      `${count(summary.feedback, 'feedback row', 'feedback rows')}`
  );
  console.log(`  from      ${db}`);
  console.log(`  to        ${summary.path} (${formatBytes(summary.bytes)})`);
  console.log(`  origin    ${summary.origin}`);
  console.log(`  snapshot  ${summary.exportedAt} (schemaVersion ${summary.schemaVersion})`);
  return 0;
}

async function runImport(values: CliValues, positionalPath: string | undefined): Promise<number> {
  const db = databasePath(values.db);
  const input = snapshotPath(values.in, positionalPath);

  const store = await openStore(db);
  let result: ImportResult;
  try {
    result = importFromFile(store, input);
  } finally {
    store.close();
  }

  console.log(`imported ${input}`);
  console.log(`  into          ${db}`);
  console.log(`  origin        ${result.origin}`);
  console.log(`  inserted      ${result.inserted}`);
  console.log(`  updated       ${result.updated}`);
  console.log(`  skippedOlder  ${result.skippedOlder}`);
  console.log(`  rejected      ${result.rejected.length}`);
  for (const rejection of result.rejected) {
    console.log(`    line ${rejection.line}: ${rejection.reason}`);
  }
  return result.rejected.length > 0 ? 1 : 0;
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Every path this tool prints is absolute.
 *
 * The database path already goes through `resolveDatabasePath`, so a snapshot
 * path printed as the user typed it would sit next to a resolved one in the same
 * summary. Both are answers to "which file", and they have to read alike.
 */
function snapshotPath(...values: (string | undefined)[]): string {
  const chosen = firstNonEmpty(...values);
  return chosen === null ? DEFAULT_SNAPSHOT : resolvePath(chosen);
}

/** `--db` when given, otherwise the same rule the MCP server follows. */
function databasePath(flag: string | undefined): string {
  const explicit = firstNonEmpty(flag);
  return explicit === null ? resolveDatabasePath([]) : resolveDatabasePath(['--db', explicit]);
}

/**
 * Loads the store on first use, so `--help` and a bad argument never touch the
 * native SQLite module. The specifier is a literal, so the compiler checks the
 * call rather than trusting a name at runtime.
 *
 * The parent directory is created first. SQLite will make a missing database file
 * but not a missing directory, and the default path on every platform sits inside a
 * directory that does not exist until something makes it. Without this, `import`
 * failed on the one case it exists for: seeding a machine that has no store yet.
 * The MCP server has always done this; the CLI did not.
 */
async function openStore(dbPath: string) {
  await mkdir(dirname(dbPath), { recursive: true });
  const { createStore } = await import('../store/index.js');
  return createStore(dbPath);
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
