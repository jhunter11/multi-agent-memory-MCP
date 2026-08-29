import { z } from 'zod';

/**
 * The shared vocabulary. Every module in this project agrees here and nowhere
 * else, so the store, the MCP surface, and the portability layer can be built
 * and changed independently.
 */

export const SCHEMA_VERSION = 1;

/** What a memory entry is. Kept small on purpose: five kinds cover the work. */
export const EntryKindSchema = z.enum([
  /** Something true about the world that outlived the conversation. */
  'fact',
  /** A choice that was made, with its reason. */
  'decision',
  /** Something noticed during work, not yet generalized. */
  'observation',
  /** A conclusion drawn across several entries by `memory_reflect`. */
  'insight',
  /** A repeatable sequence of steps that worked. */
  'procedure'
]);
export type EntryKind = z.infer<typeof EntryKindSchema>;

/**
 * A path-like partition, for example `agency/engineering` or `personal/health`.
 *
 * This is the entry point concept: an agent reads the whole store but starts at
 * its own scope, so traversal order differs per agent while knowledge does not.
 * Slashes nest. A search at `agency` includes `agency/engineering`.
 */
export const ScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/u, {
    message: 'scope must be lowercase path segments, for example agency/engineering'
  });
export type Scope = z.infer<typeof ScopeSchema>;

export const EntryIdSchema = z.string().regex(/^mem_[0-9a-hjkmnp-tv-z]{26}$/u);
export const EdgeKindSchema = z.enum(['contains', 'refers_to', 'supersedes', 'contradicts']);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/**
 * Trust is a 0 to 1 score that starts at 0.5 and moves with feedback. It exists
 * so a memory that proved wrong stops outranking one that proved right. Ranking
 * multiplies the text-match score by trust, so a distrusted entry sinks rather
 * than disappears. Nothing is deleted for being wrong.
 */
export const DEFAULT_TRUST = 0.5;
export const TrustSchema = z.number().min(0).max(1);

export const EntrySchema = z.object({
  id: EntryIdSchema,
  kind: EntryKindSchema,
  scope: ScopeSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().min(1).max(64_000),
  /** Where this came from: a harness name, a file path, a URL, a person. */
  source: z.string().trim().min(1).max(500),
  trust: TrustSchema,
  /** Free tags for filtering. Lowercase, deduplicated by the store. */
  tags: z.array(z.string().trim().min(1).max(60)).max(24),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Set when a newer entry replaces this one. Superseded entries stay readable. */
  supersededBy: EntryIdSchema.nullable()
});
export type Entry = z.infer<typeof EntrySchema>;

export const EdgeSchema = z.object({
  fromId: EntryIdSchema,
  toId: EntryIdSchema,
  kind: EdgeKindSchema,
  createdAt: z.string().datetime()
});
export type Edge = z.infer<typeof EdgeSchema>;

export const FeedbackSchema = z.object({
  id: z.string().min(1).max(80),
  entryId: EntryIdSchema,
  verdict: z.enum(['helpful', 'unhelpful']),
  note: z.string().trim().max(500).nullable(),
  createdAt: z.string().datetime()
});
export type Feedback = z.infer<typeof FeedbackSchema>;

// --- Inputs -----------------------------------------------------------------

export const WriteEntryInputSchema = z.object({
  kind: EntryKindSchema,
  scope: ScopeSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().min(1).max(64_000),
  source: z.string().trim().min(1).max(500),
  tags: z.array(z.string().trim().min(1).max(60)).max(24).default([]),
  /** When set, the named entry is marked superseded by this new one. */
  supersedes: EntryIdSchema.nullable().default(null)
});
export type WriteEntryInput = z.input<typeof WriteEntryInputSchema>;

export const SearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  /** Restricts to this scope and everything nested beneath it. */
  scope: ScopeSchema.nullable().default(null),
  kinds: z.array(EntryKindSchema).max(5).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  limit: z.number().int().min(1).max(100).default(20),
  /** Superseded entries are hidden unless asked for. History stays reachable. */
  includeSuperseded: z.boolean().default(false)
});
export type SearchInput = z.input<typeof SearchInputSchema>;

/**
 * Reading a scope with no text query at all.
 *
 * `search` needs words, and a scope name is not text that appears in the entries
 * filed under it. Anything that wants "everything in this scope" — reflection, a
 * review, an inventory — needs this instead, or it silently finds nothing.
 */
export const ListScopeInputSchema = z.object({
  /** This scope and everything nested beneath it. */
  scope: ScopeSchema,
  limit: z.number().int().min(1).max(200).default(50),
  includeSuperseded: z.boolean().default(false)
});
export type ListScopeInput = z.input<typeof ListScopeInputSchema>;

export const RecallInputSchema = z.object({
  /** What the agent is about to do. Used as the query. */
  task: z.string().trim().min(1).max(2_000),
  /** Where this agent starts reading. Nested scopes rank above distant ones. */
  entryScope: ScopeSchema,
  /** Maximum graph expansion after lexical seeds. Public releases cap this at two. */
  maxHops: z.number().int().min(0).max(2).default(2),
  /** Score multiplier applied once per traversed edge. */
  graphDecay: z.number().min(0).max(1).default(0.3),
  /** Byte budget for the assembled context. The store never exceeds it. */
  budgetBytes: z.number().int().min(256).max(1_000_000).default(32_000)
});
export type RecallInput = z.input<typeof RecallInputSchema>;

export const SearchHitSchema = z.object({
  entry: EntrySchema,
  /** Text-match score multiplied by trust and scope proximity. Higher is better. */
  score: z.number(),
  origin: z.enum(['lexical', 'graph']),
  hop: z.number().int().min(0).max(2),
  path: z.array(EntryIdSchema).min(1).max(3),
  /** Stated so a reader can tell why this ranked where it did. */
  why: z.string()
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

// --- Portability ------------------------------------------------------------

/**
 * The export format is JSONL: one JSON object per line, first line a header.
 *
 * Text, not binary, and line-oriented on purpose. A live SQLite file cannot be
 * synced between two machines without risking corruption, so the database stays
 * local and this snapshot is the portable artifact. Git merges it line by line,
 * and it survives a trip through Google Drive or a USB stick unchanged.
 */
export const ExportHeaderSchema = z.object({
  type: z.literal('header'),
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: z.string().datetime(),
  /** Names the machine that wrote it, so a merge conflict is traceable. */
  origin: z.string().trim().min(1).max(120),
  counts: z.object({
    entries: z.number().int().min(0),
    edges: z.number().int().min(0),
    feedback: z.number().int().min(0)
  })
});
export type ExportHeader = z.infer<typeof ExportHeaderSchema>;

export const ExportRecordSchema = z.discriminatedUnion('type', [
  ExportHeaderSchema,
  z.object({ type: z.literal('entry'), data: EntrySchema }),
  z.object({ type: z.literal('edge'), data: EdgeSchema }),
  z.object({ type: z.literal('feedback'), data: FeedbackSchema })
]);
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

/**
 * Import is last-write-wins per record id, compared on `updatedAt`.
 *
 * This is what makes two machines safe to reconcile. Entries created on the
 * laptop and entries created on the desktop both land, because their ids differ.
 * The same entry edited in both places keeps the later edit. Nothing is dropped
 * silently: the result reports every decision it made.
 */
export const ImportResultSchema = z.object({
  inserted: z.number().int().min(0),
  updated: z.number().int().min(0),
  /** Incoming record was older than what is already stored, so it was ignored. */
  skippedOlder: z.number().int().min(0),
  /** Record failed schema validation. The line number is reported. */
  rejected: z.array(z.object({ line: z.number().int(), reason: z.string() })),
  origin: z.string()
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

// --- Store seam -------------------------------------------------------------

/** Implemented by `src/store`. The MCP layer talks only to this. */
export interface MemoryStore {
  write(input: WriteEntryInput): Entry;
  get(id: string): Entry | null;
  /** A scope's entries, most trusted first, with no text query involved. */
  list(input: ListScopeInput): Entry[];
  search(input: SearchInput): SearchHit[];
  recall(input: RecallInput): {
    hits: SearchHit[];
    usedBytes: number;
    maxHops: 0 | 1 | 2;
    graphDecay: number;
  };
  relate(fromId: string, toId: string, kind: EdgeKind): Edge;
  neighbors(id: string): { edge: Edge; entry: Entry }[];
  feedback(entryId: string, verdict: 'helpful' | 'unhelpful', note: string | null): Entry;
  stats(): { entries: number; edges: number; feedback: number; scopes: Record<string, number> };
  /** Raw readers used by the portability layer. */
  allEntries(): Entry[];
  allEdges(): Edge[];
  allFeedback(): Feedback[];
  upsertEntry(entry: Entry): 'inserted' | 'updated' | 'skipped_older';
  upsertEdge(edge: Edge): 'inserted' | 'skipped_older';
  upsertFeedback(row: Feedback): 'inserted' | 'skipped_older';
  close(): void;
}
