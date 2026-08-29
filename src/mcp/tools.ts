/**
 * The nine memory tools, defined once and reused twice.
 *
 * Each definition carries its own zod schema and its own handler, and the
 * handler validates its arguments itself. That is deliberate: `server.ts`
 * registers these on an `McpServer`, and `tests/mcp.test.ts` calls the same
 * handlers with no protocol connection at all. One code path, two callers.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. Nothing throws. Every handler returns a `ToolResult`, and a failure is a
 *    result with `isError: true`. An exception escaping to the transport would
 *    take the process down and take the memory of whichever harness was
 *    mid-task with it.
 * 2. Nothing writes to stdout. Stdout is the MCP frame channel. Diagnostics go
 *    to stderr through `server.ts`, or nowhere.
 */

import { z } from 'zod';
import { defaultExportDirectory, resolveMcpExportTarget } from '../db-path.js';
import { ORIGIN_ENV_VAR } from '../public-identity.js';
import {
  DEFAULT_TRUST,
  EdgeKindSchema,
  EntryIdSchema,
  RecallInputSchema,
  SCHEMA_VERSION,
  ScopeSchema,
  SearchInputSchema,
  WriteEntryInputSchema,
  type Edge,
  type Entry,
  type MemoryStore,
  type SearchHit
} from '../contracts.js';
// A type-only import, erased at compile time, so this does not pull the
// portability layer into the process before an export is actually asked for.
import type { ExportOptions, ExportSummary } from '../portability/export.js';

// --- Result shapes ----------------------------------------------------------

export interface ToolTextContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Structurally a `CallToolResult` from the MCP SDK, without importing it.
 * Keeping this file free of SDK types lets the tests run the handlers with no
 * protocol machinery in the way.
 */
export interface ToolResult {
  readonly content: ToolTextContent[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * Builds a result that serves both readers of the transcript.
 *
 * The first block is prose for a person. The second block, when there is data,
 * is the same answer as raw JSON so a model can parse it without scraping the
 * prose. Two blocks, one truth.
 */
export function toolResult(summary: string, data?: unknown): ToolResult {
  const content: ToolTextContent[] = [{ type: 'text', text: summary }];
  if (data === undefined) return { content };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { content, structuredContent: { value: data } };
  }
  return { content, structuredContent: data as Record<string, unknown> };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}

// --- Context ----------------------------------------------------------------

/**
 * Writes the portable snapshot. One implementation, injectable for tests.
 *
 * There is deliberately no fallback writer. An earlier version probed the
 * portability layer for a function by name and, on any failure, wrote the file
 * itself with a wall-clock header. That silently traded away the one property the
 * snapshot exists for: two exports of unchanged memory must be byte identical, or
 * a git sync produces a whole-file diff that means nothing. A failed export has to
 * read as a failure.
 */
export type ExportSnapshot = (
  store: MemoryStore,
  filePath: string,
  options: ExportOptions
) => Promise<ExportSummary>;

/**
 * Loaded on the first export rather than at module load, so a server that never
 * exports never pays for the portability layer. The specifier is a literal, so
 * the compiler checks the call.
 */
const defaultExportSnapshot: ExportSnapshot = async (store, filePath, options) => {
  const { exportToFile } = await import('../portability/index.js');
  return exportToFile(store, filePath, options);
};

export interface ToolContext {
  readonly store: MemoryStore;
  /** Names the machine in an export header, so a merge conflict is traceable. */
  readonly origin: string;
  readonly exportDirectory: string;
  readonly exportSnapshot: ExportSnapshot;
}

export interface ToolContextOptions {
  origin?: string;
  exportDirectory?: string;
  exportSnapshot?: ExportSnapshot;
}

export function defaultOrigin(env: Record<string, string | undefined> = process.env): string {
  const configured = env[ORIGIN_ENV_VAR];
  if (configured !== undefined && configured.trim().length > 0) return configured.trim();
  return 'local';
}

export function createToolContext(
  store: MemoryStore,
  options: ToolContextOptions = {}
): ToolContext {
  return {
    store,
    origin: options.origin ?? defaultOrigin(),
    exportDirectory: options.exportDirectory ?? defaultExportDirectory(),
    exportSnapshot: options.exportSnapshot ?? defaultExportSnapshot
  };
}

// --- Definition plumbing ----------------------------------------------------

export interface ToolAnnotationHints {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface MemoryToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The complete zod object handed to modern `registerTool`. */
  readonly inputSchema: z.ZodObject;
  readonly annotations: ToolAnnotationHints;
  /** Validates, runs, and never throws. */
  run(context: ToolContext, args: unknown): Promise<ToolResult>;
}

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotationHints;
  execute(
    context: ToolContext,
    input: z.infer<z.ZodObject<Shape>>
  ): Promise<ToolResult> | ToolResult;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): MemoryToolDefinition {
  const parser = z.object(spec.inputSchema);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: parser,
    annotations: spec.annotations,
    async run(context: ToolContext, args: unknown): Promise<ToolResult> {
      const raw = args === undefined || args === null ? {} : args;
      const parsed = parser.safeParse(raw);
      if (!parsed.success) {
        return toolError(`Invalid arguments for ${spec.name}: ${formatZodError(parsed.error)}`);
      }
      try {
        return await spec.execute(context, parsed.data as z.infer<z.ZodObject<Shape>>);
      } catch (error) {
        return toolError(`${spec.name} failed: ${describeError(error)}`);
      }
    }
  };
}

/**
 * Copies a shape and attaches model-facing field docs.
 *
 * The schemas stay owned by `contracts.ts`; only the prose is added here, so a
 * contract change cannot drift away from what the tool advertises.
 */
function describeShape<Shape extends z.ZodRawShape>(
  shape: Shape,
  docs: Partial<Record<keyof Shape & string, string>>
): Shape {
  const described: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape) as [string, z.ZodType][]) {
    const doc = docs[key as keyof Shape & string];
    described[key] = doc === undefined ? schema : schema.describe(doc);
  }
  return described as unknown as Shape;
}

// --- Rendering --------------------------------------------------------------

const EXCERPT_LIMIT = 400;
const REFLECT_BODY_LIMIT = 2_000;

function excerpt(body: string, limit = EXCERPT_LIMIT): string {
  const collapsed = body.trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}... [${collapsed.length - limit} more characters]`;
}

function formatEntryHeader(entry: Entry): string {
  const tags = entry.tags.length > 0 ? ` tags:${entry.tags.join(',')}` : '';
  const superseded = entry.supersededBy === null ? '' : ` superseded-by:${entry.supersededBy}`;
  return `${entry.kind} ${entry.id} (scope ${entry.scope}, trust ${entry.trust.toFixed(2)}${tags}${superseded})`;
}

function formatEntry(entry: Entry, index: number, bodyLimit = EXCERPT_LIMIT): string {
  return [
    `[${index}] ${formatEntryHeader(entry)}`,
    entry.title,
    excerpt(entry.body, bodyLimit)
  ].join('\n');
}

function formatHit(hit: SearchHit, index: number, bodyLimit = EXCERPT_LIMIT): string {
  return [
    `[${index}] ${formatEntryHeader(hit.entry)} score ${hit.score.toFixed(3)}`,
    `why: ${hit.why}`,
    hit.entry.title,
    excerpt(hit.entry.body, bodyLimit)
  ].join('\n');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

// --- 1. memory_write --------------------------------------------------------

const writeTool = defineTool({
  name: 'memory_write',
  title: 'Write a memory entry',
  description: [
    'Store one durable memory entry that outlives this conversation.',
    'Write a `fact` for something true about the world, a `decision` for a choice plus its reason,',
    'an `observation` for something noticed but not yet generalized, or a `procedure` for steps that worked.',
    '(`insight` entries are written by memory_reflect, not here.)',
    'Choose the narrowest scope that fits, for example agency/engineering rather than agency.',
    'Set `supersedes` to the id of an entry this one replaces: the old entry stays readable and stays in history,',
    'it just drops out of default search results.',
    'The store can be shared by multiple configured agents, so write `source` as something another reader can trace.'
  ].join(' '),
  inputSchema: describeShape(WriteEntryInputSchema.shape, {
    kind: 'One of fact, decision, observation, insight, procedure.',
    scope:
      'Path-like partition, lowercase segments separated by slashes, for example agency/engineering.',
    title: 'One line a reader can scan. Say the conclusion, not the topic.',
    body: 'The full memory. Include the reasoning, not only the outcome.',
    source: 'Where this came from: a harness name, a file path, a URL, or a person.',
    tags: 'Optional lowercase tags for filtering.',
    supersedes: 'Optional id of the entry this one replaces, or null.'
  }),
  annotations: {
    title: 'Write a memory entry',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  execute(context, input) {
    const entry = context.store.write(input);
    const replaced = input.supersedes === null ? '' : ` It supersedes ${input.supersedes}.`;
    return toolResult(
      `Stored ${entry.kind} ${entry.id} in scope ${entry.scope} with trust ${entry.trust.toFixed(2)}: ${entry.title}.${replaced}`,
      { entry }
    );
  }
});

// --- 2. memory_search -------------------------------------------------------

const searchTool = defineTool({
  name: 'memory_search',
  title: 'Search memory',
  description: [
    'Full-text search across every entry in the shared store.',
    'A scope filter includes everything nested beneath it, so scope "agency" also searches "agency/engineering".',
    'Ranking multiplies the text match by the trust score, so an entry that proved wrong sinks rather than disappears.',
    'Superseded entries are hidden unless `includeSuperseded` is true.',
    'Use this when you know what you are looking for. Use memory_recall when you want context for a task you are starting.'
  ].join(' '),
  inputSchema: describeShape(SearchInputSchema.shape, {
    query: 'The words to match. Plain text, not a SQL or FTS expression.',
    scope: 'Restrict to this scope and everything nested under it, or null for the whole store.',
    kinds: 'Optional filter, for example ["decision"] to see only decisions.',
    tags: 'Optional tag filter. All listed tags must be present.',
    limit: 'Maximum hits to return, 1 to 100.',
    includeSuperseded: 'Set true to see replaced entries as well. History stays reachable.'
  }),
  annotations: {
    title: 'Search memory',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  execute(context, input) {
    const hits = context.store.search(input);
    const where = input.scope === null ? 'the whole store' : `scope ${input.scope}`;
    if (hits.length === 0) {
      return toolResult(`No entries in ${where} matched "${input.query}".`, {
        query: input.query,
        scope: input.scope,
        count: 0,
        hits: []
      });
    }
    const body = hits.map((hit, index) => formatHit(hit, index + 1)).join('\n\n');
    return toolResult(
      `${plural(hits.length, 'entry', 'entries')} in ${where} matched "${input.query}".\n\n${body}`,
      {
        query: input.query,
        scope: input.scope,
        count: hits.length,
        hits
      }
    );
  }
});

// --- 3. memory_recall -------------------------------------------------------

const recallTool = defineTool({
  name: 'memory_recall',
  title: 'Recall context for a task',
  description: [
    'Assemble the memory that matters for a task you are about to start, inside a byte budget.',
    'Say what you are about to do in `task` and where you work from in `entryScope`.',
    'Entries nested in or near that scope rank above distant ones, so the same store reads differently for each agent.',
    'Returns whole entries, highest value first, never exceeding `budgetBytes`.',
    'Call this at the start of a task rather than guessing what is already known.'
  ].join(' '),
  inputSchema: describeShape(RecallInputSchema.shape, {
    task: 'What you are about to do, in a sentence or two. Used as the query.',
    entryScope: 'The scope you read from first, for example agency/engineering.',
    maxHops: 'Graph depth after lexical seeds. Default 2; allowed range 0 to 2.',
    graphDecay: 'Score multiplier per traversed edge. Default 0.3.',
    budgetBytes: 'Hard ceiling on the assembled context. Default 32000.'
  }),
  annotations: {
    title: 'Recall context for a task',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  execute(context, input) {
    const { hits, usedBytes, maxHops, graphDecay } = context.store.recall(input);
    if (hits.length === 0) {
      return toolResult(
        `Nothing recalled for scope ${input.entryScope}. The store has no entry that matches this task yet.`,
        {
          task: input.task,
          entryScope: input.entryScope,
          budgetBytes: input.budgetBytes,
          maxHops,
          graphDecay,
          usedBytes,
          count: 0,
          hits: []
        }
      );
    }
    const body = hits
      .map((hit, index) => formatHit(hit, index + 1, REFLECT_BODY_LIMIT))
      .join('\n\n');
    const summary = `Recalled ${plural(hits.length, 'entry', 'entries')} for scope ${input.entryScope}, using ${usedBytes} of ${input.budgetBytes} bytes.\n\n${body}`;
    return toolResult(summary, {
      task: input.task,
      entryScope: input.entryScope,
      budgetBytes: input.budgetBytes,
      maxHops,
      graphDecay,
      usedBytes,
      count: hits.length,
      hits
    });
  }
});

// --- 4. memory_relate -------------------------------------------------------

const relateTool = defineTool({
  name: 'memory_relate',
  title: 'Link two entries',
  description: [
    'Link two entries with a typed edge, which turns the store from a list into a graph.',
    'Edge kinds: `contains` for a parent that holds a part, `refers_to` for a mention or a dependency,',
    '`supersedes` for a replacement, `contradicts` for a conflict you want kept visible rather than resolved.',
    'The edge runs from `fromId` to `toId`; direction carries meaning, so put the newer or containing entry first.',
    'After linking, memory_neighbors can walk from any entry to the rest of its context.'
  ].join(' '),
  inputSchema: {
    fromId: EntryIdSchema.describe('Id of the entry the edge starts at.'),
    toId: EntryIdSchema.describe('Id of the entry the edge points to.'),
    kind: EdgeKindSchema.describe('One of contains, refers_to, supersedes, contradicts.')
  },
  annotations: {
    title: 'Link two entries',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  execute(context, input) {
    const edge = context.store.relate(input.fromId, input.toId, input.kind);
    return toolResult(`Linked ${edge.fromId} -[${edge.kind}]-> ${edge.toId}.`, { edge });
  }
});

// --- 5. memory_neighbors ----------------------------------------------------

const neighborsTool = defineTool({
  name: 'memory_neighbors',
  title: 'List linked entries',
  description: [
    'List every entry linked to one entry, with the edge kind and its direction.',
    '`out` means the edge starts at the entry you asked about; `in` means it points at it.',
    'Use this straight after memory_search or memory_recall to pull in the context around a hit,',
    'in particular the entries that contradict or supersede it.'
  ].join(' '),
  inputSchema: {
    id: EntryIdSchema.describe('Id of the entry whose links you want.')
  },
  annotations: {
    title: 'List linked entries',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  execute(context, input) {
    const rows = context.store.neighbors(input.id);
    if (rows.length === 0) {
      return toolResult(`Entry ${input.id} has no links yet.`, {
        id: input.id,
        count: 0,
        neighbors: []
      });
    }
    const neighbors = rows.map((row) => ({
      direction: row.edge.fromId === input.id ? ('out' as const) : ('in' as const),
      kind: row.edge.kind,
      edge: row.edge,
      entry: row.entry
    }));
    const body = neighbors
      .map(
        (row, index) =>
          `[${index + 1}] ${row.direction} [${row.kind}] ${formatEntryHeader(row.entry)}\n${row.entry.title}`
      )
      .join('\n\n');
    return toolResult(`Entry ${input.id} has ${plural(rows.length, 'link', 'links')}.\n\n${body}`, {
      id: input.id,
      count: neighbors.length,
      neighbors
    });
  }
});

// --- 6. memory_feedback -----------------------------------------------------

const feedbackTool = defineTool({
  name: 'memory_feedback',
  title: 'Rate an entry',
  description: [
    'Rate an entry helpful or unhelpful after you acted on it, which moves its trust score.',
    `Trust starts at ${DEFAULT_TRUST}, stays between 0 and 1, and multiplies the search ranking.`,
    'Helpful raises it, unhelpful lowers it. Nothing is ever deleted for being wrong; a distrusted entry sinks and stays readable.',
    'Record feedback whenever a recalled memory turned out to be right or wrong. This is what keeps the shared store honest',
    'across three harnesses that cannot see each other work.'
  ].join(' '),
  inputSchema: {
    entryId: EntryIdSchema.describe('Id of the entry you are rating.'),
    verdict: z
      .enum(['helpful', 'unhelpful'])
      .describe('helpful raises trust, unhelpful lowers it.'),
    note: z
      .string()
      .trim()
      .max(500)
      .nullable()
      .default(null)
      .describe('Optional short reason, so a later reader knows why trust moved.')
  },
  annotations: {
    title: 'Rate an entry',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  execute(context, input) {
    const entry = context.store.feedback(input.entryId, input.verdict, input.note);
    return toolResult(
      `Recorded ${input.verdict} for ${entry.id}. Trust is now ${entry.trust.toFixed(2)} (default ${DEFAULT_TRUST}).`,
      { entry, verdict: input.verdict, note: input.note }
    );
  }
});

// --- 7. memory_reflect ------------------------------------------------------

const REFLECT_DEFAULT_LIMIT = 12;
const REFLECT_LINK_LIMIT = 8;

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? text.trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

function dedupeEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

const reflectTool = defineTool({
  name: 'memory_reflect',
  title: 'Reflect across a scope',
  description: [
    'Read across a scope and record one insight that synthesizes what is there. Two steps, on purpose.',
    'Step one: call with only a `scope`. You get back the top entries in that scope plus a synthesis prompt.',
    'Step two: read them, do the thinking yourself, then call again with the same `scope` and your conclusion in `insight`.',
    'That writes an `insight` entry and links it back to the entries it came from, so the reasoning stays traceable.',
    'This server has no model access and never calls one. It gathers and it records; the thinking is yours.',
    'Reflect when a scope has accumulated entries that clearly point at something none of them says on its own.'
  ].join(' '),
  inputSchema: {
    scope: ScopeSchema.describe('The scope to read across, for example agency/engineering.'),
    insight: z
      .string()
      .trim()
      .min(1)
      .max(64_000)
      .nullable()
      .default(null)
      .describe(
        'Your synthesis. Omit or null to gather material first; supply it to write the insight entry.'
      ),
    sources: z
      .array(EntryIdSchema)
      .max(50)
      .default([])
      .describe('Ids the insight is drawn from. The written insight is linked to each of these.'),
    title: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .nullable()
      .default(null)
      .describe('One-line title for the insight entry. Defaults to the first line of `insight`.'),
    focus: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullable()
      .default(null)
      .describe(
        'Optional query to narrow what is gathered. Defaults to a broad sweep of the scope.'
      ),
    source: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .default('memory_reflect')
      .describe('Provenance for the written insight, for example the harness you are running in.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(REFLECT_DEFAULT_LIMIT)
      .describe('How many entries to gather from the scope.')
  },
  annotations: {
    title: 'Reflect across a scope',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  execute(context, input) {
    /*
     * With a `focus` this is a search. Without one it is a read of the scope, not
     * a search for the scope's name: a scope is a filing decision, so searching
     * for the words "agency engineering" finds the rare entry that mentions them
     * and misses everything else filed there. An earlier version did exactly that
     * and reported an empty scope as having nothing to reflect on.
     */
    const candidates =
      input.focus === null
        ? context.store.list({ scope: input.scope, limit: input.limit, includeSuperseded: false })
        : context.store
            .search({
              query: input.focus,
              scope: input.scope,
              kinds: [],
              tags: [],
              limit: input.limit,
              includeSuperseded: false
            })
            .map((hit) => hit.entry);

    const namedSources: Entry[] = [];
    const missingSources: string[] = [];
    for (const id of input.sources) {
      const entry = context.store.get(id);
      if (entry === null) missingSources.push(id);
      else namedSources.push(entry);
    }
    const gathered = dedupeEntries([...namedSources, ...candidates]);
    const gatheredBy = input.focus === null ? 'scope' : 'focus';

    if (input.insight === null) {
      if (gathered.length === 0) {
        return toolResult(
          `Scope ${input.scope} has nothing to reflect on yet. Write entries there first, then reflect.`,
          {
            mode: 'gather',
            scope: input.scope,
            gatheredBy,
            focus: input.focus,
            count: 0,
            entries: [],
            missingSources
          }
        );
      }
      const material = gathered
        .map((entry, index) => formatEntry(entry, index + 1, REFLECT_BODY_LIMIT))
        .join('\n\n');
      const prompt = [
        `Reflection material for scope ${input.scope}: ${plural(gathered.length, 'entry', 'entries')}. No insight written yet.`,
        '',
        material,
        '',
        'Now do the synthesis yourself. This server has no model access and will not do it for you.',
        'Read the entries above and write ONE conclusion that holds across several of them and that none of them states alone.',
        'Prefer a claim that would change what someone does next. Skip it entirely if the entries do not support one.',
        'Then call memory_reflect again with:',
        JSON.stringify(
          {
            scope: input.scope,
            insight: '<your synthesis>',
            sources: gathered.slice(0, REFLECT_LINK_LIMIT).map((entry) => entry.id)
          },
          null,
          2
        )
      ].join('\n');
      return toolResult(prompt, {
        mode: 'gather',
        scope: input.scope,
        gatheredBy,
        focus: input.focus,
        count: gathered.length,
        entries: gathered,
        missingSources
      });
    }

    const entry = context.store.write({
      kind: 'insight',
      scope: input.scope,
      title: input.title ?? firstLine(input.insight),
      body: input.insight,
      source: input.source,
      tags: [],
      supersedes: null
    });

    const linkTargets = (
      namedSources.length > 0 ? namedSources : gathered.slice(0, REFLECT_LINK_LIMIT)
    ).filter((candidate) => candidate.id !== entry.id);
    const edges: Edge[] = [];
    const linkErrors: { toId: string; reason: string }[] = [];
    for (const target of linkTargets) {
      try {
        edges.push(context.store.relate(entry.id, target.id, 'refers_to'));
      } catch (error) {
        linkErrors.push({ toId: target.id, reason: describeError(error) });
      }
    }

    const failed =
      linkErrors.length === 0
        ? ''
        : ` ${plural(linkErrors.length, 'link', 'links')} could not be created.`;
    return toolResult(
      `Wrote insight ${entry.id} in scope ${entry.scope}, linked to ${plural(edges.length, 'entry', 'entries')}: ${entry.title}.${failed}`,
      { mode: 'write', scope: input.scope, entry, edges, linkErrors, missingSources }
    );
  }
});

// --- 8. memory_export -------------------------------------------------------

const exportTool = defineTool({
  name: 'memory_export',
  title: 'Export a JSONL snapshot',
  description: [
    'Write the whole store to a JSONL snapshot in the configured export directory: one JSON object per line, a header line first.',
    'This is the portable artifact. The live SQLite file must never be synced between machines, because two machines',
    'writing one database file corrupts it. This snapshot is text, so git merges it line by line and it survives a trip',
    'through a sync folder or a USB stick unchanged. Import is last-write-wins per record, compared on updatedAt.',
    'An existing file with the same name is overwritten. Directory traversal is rejected.'
  ].join(' '),
  inputSchema: {
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default('memory.jsonl')
      .describe('One JSONL file name inside MULTI_AGENT_MEMORY_EXPORT_DIR.'),
    origin: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .nullable()
      .default(null)
      .describe('Pseudonymous origin recorded in the header. Defaults to local.')
  },
  annotations: {
    title: 'Export a JSONL snapshot',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  async execute(context, input) {
    const target = resolveMcpExportTarget(input.fileName, context.exportDirectory);
    const origin = input.origin ?? context.origin;
    const summary = await context.exportSnapshot(context.store, target, { origin });
    return toolResult(
      [
        `Exported ${summary.entries} entries, ${summary.edges} edges, and ${summary.feedback} feedback rows`,
        `to ${summary.path} (${summary.bytes} bytes), stamped ${summary.exportedAt} from origin ${summary.origin}.`,
        'Copy that file to the other machine and run memory import there.'
      ].join(' '),
      {
        path: summary.path,
        origin: summary.origin,
        exportedAt: summary.exportedAt,
        schemaVersion: summary.schemaVersion,
        counts: { entries: summary.entries, edges: summary.edges, feedback: summary.feedback },
        bytes: summary.bytes
      }
    );
  }
});

// --- 9. memory_stats --------------------------------------------------------

const statsTool = defineTool({
  name: 'memory_stats',
  title: 'Memory statistics',
  description: [
    'Count what is in the shared store and break it down by scope.',
    'Read it to see where memory is thick and where it is empty before you write, so entries land in a scope that is already used',
    'instead of starting a near-duplicate one. Takes no arguments.'
  ].join(' '),
  inputSchema: {},
  annotations: {
    title: 'Memory statistics',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  execute(context) {
    const stats = context.store.stats();
    const scopes = Object.entries(stats.scopes).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    const width = scopes.reduce((longest, [scope]) => Math.max(longest, scope.length), 0);
    const table =
      scopes.length === 0
        ? '  (no scopes yet)'
        : scopes.map(([scope, count]) => `  ${scope.padEnd(width)}  ${count}`).join('\n');
    const summary = [
      `${stats.entries} entries, ${stats.edges} edges, ${stats.feedback} feedback rows (schema version ${SCHEMA_VERSION}).`,
      `Origin ${context.origin}.`,
      'Scopes:',
      table
    ].join('\n');
    return toolResult(summary, { schemaVersion: SCHEMA_VERSION, origin: context.origin, ...stats });
  }
});

// --- Registry ---------------------------------------------------------------

export const MEMORY_TOOLS: readonly MemoryToolDefinition[] = Object.freeze([
  writeTool,
  searchTool,
  recallTool,
  relateTool,
  neighborsTool,
  feedbackTool,
  reflectTool,
  exportTool,
  statsTool
]);

export function getTool(name: string): MemoryToolDefinition | undefined {
  return MEMORY_TOOLS.find((tool) => tool.name === name);
}

/** Dispatch by name. Unknown names come back as an error result, not a throw. */
export async function callTool(
  name: string,
  context: ToolContext,
  args: unknown
): Promise<ToolResult> {
  const tool = getTool(name);
  if (tool === undefined) {
    const known = MEMORY_TOOLS.map((candidate) => candidate.name).join(', ');
    return toolError(`Unknown tool ${name}. This server exposes: ${known}.`);
  }
  try {
    return await tool.run(context, args);
  } catch (error) {
    return toolError(`${name} failed: ${describeError(error)}`);
  }
}
