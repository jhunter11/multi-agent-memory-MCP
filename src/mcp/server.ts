/**
 * Wiring: database path, store, `McpServer`, stdio transport.
 *
 * The one rule that outranks everything else here is that stdout belongs to the
 * MCP frame channel. A single stray `console.log` anywhere in the process
 * interleaves with a JSON-RPC frame and the client drops the connection, which
 * on this server means whichever harness was mid-task loses its memory. So
 * every diagnostic in this file goes to stderr, and `redirectConsoleToStderr`
 * exists to catch the ones that other people write later.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { MemoryStore } from '../contracts.js';
import { defaultExportDirectory, resolveDatabasePath, type EnvLike } from '../db-path.js';
import { ORIGIN_ENV_VAR, SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from '../public-identity.js';
import {
  MEMORY_TOOLS,
  createToolContext,
  type MemoryToolDefinition,
  type ToolContext,
  type ToolResult
} from './tools.js';

export { SERVER_NAME, SERVER_TITLE, SERVER_VERSION };

/**
 * Where the database lives is decided in `src/db-path.ts`, which the portability
 * CLI imports as well. It is re-exported here so a caller that starts the server
 * can also ask which file the server is about to open.
 */
export {
  DATABASE_DIR_NAME,
  DATABASE_ENV_VAR,
  DATABASE_FILE_NAME,
  defaultDatabasePath,
  readDatabaseArgument,
  resolveDatabasePath,
  type EnvLike
} from '../db-path.js';

const SERVER_INSTRUCTIONS = [
  'Local-first memory for a trusted single-user coding environment. Any configured agent can mount the same store.',
  'Scopes organize and rank memory; they are not access-control boundaries.',
  'Start a task with memory_recall, not memory_search: it assembles context for what you are about to do, inside a byte budget.',
  'Write with memory_write when something will still be true after this conversation ends, and pick the narrowest scope that fits.',
  'Rate what you used with memory_feedback; trust moves the ranking, and nothing is ever deleted for being wrong.',
  'memory_reflect gathers a scope and records your synthesis, but this server has no model access and does no thinking of its own.'
].join(' ');

// --- Diagnostics ------------------------------------------------------------

export function logToStderr(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

/**
 * Points every console method at stderr.
 *
 * The transport writes frames with `process.stdout.write` directly, so it is
 * unaffected. Anything that reaches for `console.log` later, in this code or in
 * a dependency, lands on stderr instead of corrupting the protocol stream.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    const text = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    process.stderr.write(`${text}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  console.trace = toStderr;
}

// --- Store loading ----------------------------------------------------------

export async function ensureParentDirectory(filePath: string): Promise<string> {
  const target = resolvePath(filePath);
  await mkdir(dirname(target), { recursive: true });
  return target;
}

/**
 * Opens the SQLite-backed store, creating its parent directory first.
 *
 * The import is dynamic so that nothing loads `better-sqlite3` until a server
 * actually starts: the tool handlers stay testable with a fake store and no
 * native module in the process. The specifier is a literal, which is the part
 * that matters — the compiler follows it and checks `createStore`, so a change to
 * that signature fails the build instead of failing at startup.
 */
export async function openMemoryStore(dbPath: string): Promise<MemoryStore> {
  const target = await ensureParentDirectory(dbPath);
  const { createStore } = await import('../store/index.js');
  return createStore(target);
}

// --- Server -----------------------------------------------------------------

function toCallToolResult(result: ToolResult): {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  const content = result.content.map((block) => ({ type: 'text' as const, text: block.text }));
  const base =
    result.structuredContent === undefined
      ? { content }
      : { content, structuredContent: result.structuredContent };
  return result.isError === true ? { ...base, isError: true } : base;
}

function registerMemoryTool(
  server: McpServer,
  context: ToolContext,
  tool: MemoryToolDefinition
): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    },
    async (args: unknown) => toCallToolResult(await tool.run(context, args))
  );
}

/** Builds the server and registers all nine tools against the given store. */
export function createMemoryServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );
  for (const tool of MEMORY_TOOLS) {
    registerMemoryTool(server, context, tool);
  }
  return server;
}

export interface StartOptions {
  argv?: readonly string[];
  env?: EnvLike;
}

export interface StartedServer {
  store: MemoryStore;
  handle: StdioServerHandle;
  dbPath: string;
}

/** Resolves the database, opens the store, and serves MCP over stdio. */
export async function startStdioServer(options: StartOptions = {}): Promise<StartedServer> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;

  const dbPath = resolveDatabasePath(argv, env);
  logToStderr(`database ${dbPath}`);

  const store = await openMemoryStore(dbPath);
  const origin = env[ORIGIN_ENV_VAR];
  const context = createToolContext(store, {
    ...(origin !== undefined && origin.trim().length > 0 ? { origin } : {}),
    exportDirectory: defaultExportDirectory(env)
  });

  const handle = serveStdio(() => createMemoryServer(context), {
    onerror(error) {
      logToStderr(`stdio error: ${error.message}`);
    }
  });
  logToStderr(`ready on stdio with ${MEMORY_TOOLS.length} tools`);

  return { store, handle, dbPath };
}
