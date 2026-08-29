import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ExportHeaderSchema, SCHEMA_VERSION } from '../contracts.js';
import type { Edge, Entry, ExportHeader, Feedback, MemoryStore } from '../contracts.js';

/**
 * Writes the portable snapshot: JSONL, header first, then entries, edges, feedback.
 *
 * Two rules drive everything here.
 *
 * 1. The bytes are deterministic. The same store content produces the same file,
 *    on either machine, in any insertion order. Records are sorted by key and
 *    every field is written in a fixed order, so a re-export of unchanged memory
 *    is a zero-line git diff instead of a whole-file churn.
 * 2. The line ending is LF and the file ends with a newline, whatever the host
 *    platform. The artifact has to survive git, Google Drive, and a USB stick
 *    between a Windows desktop and a laptop without changing shape.
 */

export interface ExportOptions {
  /** Names the machine that wrote the file, so a merge conflict is traceable. */
  origin: string;
  /**
   * Pins the header timestamp. Left out, it is the newest `createdAt` or
   * `updatedAt` in the store, which is what keeps two exports of an unchanged
   * store byte-identical. A wall clock here would rewrite the header on every
   * run and produce a diff that means nothing.
   */
  exportedAt?: string;
}

export interface ExportSummary {
  path: string;
  origin: string;
  exportedAt: string;
  schemaVersion: number;
  entries: number;
  edges: number;
  feedback: number;
  bytes: number;
}

/** Timestamp used for a store that holds nothing to date-stamp. */
const EPOCH = new Date(0).toISOString();

export function exportToJsonl(store: MemoryStore, options: ExportOptions): string {
  let out = '';
  for (const line of exportLines(store, options)) {
    out += line;
  }
  return out;
}

/**
 * Streams the snapshot to disk, then renames it into place.
 *
 * The write goes to a sibling temporary file first. A snapshot half-written by a
 * killed process is worse than no snapshot, because the next sync would treat it
 * as the truth. Rename on the same filesystem is atomic, so the destination is
 * either the old file or the whole new one.
 */
export async function exportToFile(
  store: MemoryStore,
  filePath: string,
  options: ExportOptions
): Promise<ExportSummary> {
  const entries = sortedEntries(store);
  const edges = sortedEdges(store);
  const feedback = sortedFeedback(store);
  const header = buildHeader(entries, edges, feedback, options);

  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;

  let bytes = 0;
  const lines = function* (): Generator<string> {
    for (const line of composeLines(header, entries, edges, feedback)) {
      bytes += Buffer.byteLength(line, 'utf8');
      yield line;
    }
  };

  try {
    await pipeline(Readable.from(lines()), createWriteStream(tempPath, { encoding: 'utf8' }));
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return {
    path: filePath,
    origin: header.origin,
    exportedAt: header.exportedAt,
    schemaVersion: header.schemaVersion,
    entries: entries.length,
    edges: edges.length,
    feedback: feedback.length,
    bytes
  };
}

/** The line sequence, shared by the string and the streaming variant. */
export function* exportLines(store: MemoryStore, options: ExportOptions): Generator<string> {
  const entries = sortedEntries(store);
  const edges = sortedEdges(store);
  const feedback = sortedFeedback(store);
  yield* composeLines(buildHeader(entries, edges, feedback, options), entries, edges, feedback);
}

function* composeLines(
  header: ExportHeader,
  entries: readonly Entry[],
  edges: readonly Edge[],
  feedback: readonly Feedback[]
): Generator<string> {
  yield headerLine(header);
  for (const entry of entries) {
    yield entryLine(entry);
  }
  for (const edge of edges) {
    yield edgeLine(edge);
  }
  for (const row of feedback) {
    yield feedbackLine(row);
  }
}

function buildHeader(
  entries: readonly Entry[],
  edges: readonly Edge[],
  feedback: readonly Feedback[],
  options: ExportOptions
): ExportHeader {
  // Parsed, not hand-built: an origin the header schema would refuse must fail
  // here rather than produce a file that no machine can import.
  return ExportHeaderSchema.parse({
    type: 'header',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: options.exportedAt ?? newestTimestamp(entries, edges, feedback),
    origin: options.origin,
    counts: {
      entries: entries.length,
      edges: edges.length,
      feedback: feedback.length
    }
  });
}

/**
 * The newest instant the store knows about.
 *
 * Compared as parsed milliseconds, not as text: `...:00Z` and `...:00.500Z` are
 * both legal in the contract and sort the wrong way as strings. Ties break on
 * the text so the answer stays deterministic.
 */
function newestTimestamp(
  entries: readonly Entry[],
  edges: readonly Edge[],
  feedback: readonly Feedback[]
): string {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  const consider = (value: string): void => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      return;
    }
    if (ms > bestMs || (ms === bestMs && best !== null && value > best)) {
      best = value;
      bestMs = ms;
    }
  };

  for (const entry of entries) {
    consider(entry.createdAt);
    consider(entry.updatedAt);
  }
  for (const edge of edges) {
    consider(edge.createdAt);
  }
  for (const row of feedback) {
    consider(row.createdAt);
  }

  return best ?? EPOCH;
}

function sortedEntries(store: MemoryStore): Entry[] {
  return [...store.allEntries()].sort((a, b) => compareText(a.id, b.id));
}

function sortedEdges(store: MemoryStore): Edge[] {
  return [...store.allEdges()].sort(
    (a, b) =>
      compareText(a.fromId, b.fromId) ||
      compareText(a.toId, b.toId) ||
      compareText(a.kind, b.kind) ||
      compareText(a.createdAt, b.createdAt)
  );
}

function sortedFeedback(store: MemoryStore): Feedback[] {
  return [...store.allFeedback()].sort(
    (a, b) => compareText(a.id, b.id) || compareText(a.entryId, b.entryId)
  );
}

/** Code-unit order. Never `localeCompare`: that answer changes with the locale. */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

// Every field is named explicitly so the byte order of a record never depends on
// how the store happened to build the object it handed back.

function headerLine(header: ExportHeader): string {
  return `${JSON.stringify({
    type: 'header',
    schemaVersion: header.schemaVersion,
    exportedAt: header.exportedAt,
    origin: header.origin,
    counts: {
      entries: header.counts.entries,
      edges: header.counts.edges,
      feedback: header.counts.feedback
    }
  })}\n`;
}

function entryLine(entry: Entry): string {
  return `${JSON.stringify({
    type: 'entry',
    data: {
      id: entry.id,
      kind: entry.kind,
      scope: entry.scope,
      title: entry.title,
      body: entry.body,
      source: entry.source,
      trust: entry.trust,
      tags: entry.tags,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      supersededBy: entry.supersededBy
    }
  })}\n`;
}

function edgeLine(edge: Edge): string {
  return `${JSON.stringify({
    type: 'edge',
    data: {
      fromId: edge.fromId,
      toId: edge.toId,
      kind: edge.kind,
      createdAt: edge.createdAt
    }
  })}\n`;
}

function feedbackLine(row: Feedback): string {
  return `${JSON.stringify({
    type: 'feedback',
    data: {
      id: row.id,
      entryId: row.entryId,
      verdict: row.verdict,
      note: row.note,
      createdAt: row.createdAt
    }
  })}\n`;
}
