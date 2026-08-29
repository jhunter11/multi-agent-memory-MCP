#!/usr/bin/env node
/**
 * The entry point every harness launches: `node dist/mcp/bin.js`.
 *
 * It does almost nothing, and the order it does it in is the whole point.
 * `redirectConsoleToStderr` runs before any other module is imported for its side
 * effects, because stdout is the MCP frame channel from the first byte. A single
 * `console.log` from anywhere in the process, including a dependency, interleaves
 * with a JSON-RPC frame and the client drops the connection. On this server that
 * means whichever harness was mid-task loses its memory.
 */

import {
  DATABASE_ENV_VAR,
  SERVER_NAME,
  SERVER_VERSION,
  defaultDatabasePath,
  logToStderr,
  redirectConsoleToStderr,
  startStdioServer,
  type StartedServer
} from './server.js';

redirectConsoleToStderr();

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server that speaks JSON-RPC over stdio. It is started by a client, not by
hand, so there is nothing to see when it runs correctly: it waits on stdin.

  node dist/mcp/bin.js [--db <path>]

  --db <path>   Which SQLite file to open.
  --help        This text.

Without --db, the ${DATABASE_ENV_VAR} environment variable is used. Without that,
the default for this machine is:

  ${defaultDatabasePath()}

Point all configured agents at one path. A shared path is what makes the memory
shared. Never put it in a folder that Dropbox, Google Drive, OneDrive, iCloud, or
a network share syncs: a synced folder corrupts a live SQLite database. Move the
JSONL snapshot between machines instead.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    // Nothing is serving yet, so stdout is still free to write to.
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const started = await startStdioServer({ argv });
  installShutdown(started);
}

/**
 * Closes the database once, whichever way the process is asked to stop.
 *
 * A client shutting down closes stdin, which ends the transport. A user pressing
 * Ctrl+C sends a signal. Both have to release the SQLite file, or a WAL is left
 * behind for the next process to recover.
 */
function installShutdown(started: StartedServer): void {
  let closed = false;
  const shutdown = (reason: string): void => {
    if (closed) return;
    closed = true;
    logToStderr(`shutting down: ${reason}`);
    try {
      started.store.close();
    } catch (error) {
      logToStderr(`failed to close the database: ${describe(error)}`);
    }
  };

  process.stdin.on('end', () => {
    shutdown('the client closed the connection');
    void started.handle.close().finally(() => process.exit(0));
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(signal);
      void started.handle.close().finally(() => process.exit(0));
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack !== undefined && error.stack.length > 0 ? error.stack : error.message;
  }
  return String(error);
}

process.on('unhandledRejection', (reason: unknown) => {
  logToStderr(`unhandled rejection: ${describe(reason)}`);
  process.exit(1);
});

try {
  await main();
} catch (error) {
  logToStderr(`failed to start: ${describe(error)}`);
  process.exit(1);
}
