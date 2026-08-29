import { readFileSync } from 'node:fs';

import { ExportRecordSchema, SCHEMA_VERSION } from '../contracts.js';
import type { ExportRecord, ImportResult, MemoryStore } from '../contracts.js';
import type { ZodError } from 'zod';

/**
 * Reads the portable snapshot back into a store.
 *
 * The job is reconciliation, not restoration. Both machines write memories, so
 * an import merges rather than replaces: last write wins per id on `updatedAt`,
 * and ids that only one machine has land untouched. Nothing is deleted here.
 *
 * A snapshot that travelled through git, a shared drive, or a hand-resolved
 * merge conflict can arrive damaged in the middle. One damaged line loses one
 * record. It must never lose the file, so parsing continues past every failure
 * and reports what it refused, with line numbers a person can go and look at.
 */

/** Everything in an export that carries data. The header carries none. */
type DataRecord = Exclude<ExportRecord, { type: 'header' }>;

/** Thrown before the store is touched when the file was written by another format. */
export class SchemaVersionMismatchError extends Error {
  readonly found: unknown;
  readonly expected: number;
  readonly line: number;

  constructor(found: unknown, line: number) {
    super(
      `line ${line}: export declares schemaVersion ${JSON.stringify(found)}, this build reads ${SCHEMA_VERSION}. ` +
        'Refusing to import. Upgrade multi-agent-memory-mcp on this machine, or re-export from the machine that wrote the file.'
    );
    this.name = 'SchemaVersionMismatchError';
    this.found = found;
    this.expected = SCHEMA_VERSION;
    this.line = line;
  }
}

export function importFromJsonl(store: MemoryStore, jsonl: string): ImportResult {
  const lines = splitLines(jsonl);

  // Version first, on the raw JSON, and across every header in the file. A
  // concatenated snapshot can carry more than one. This runs before a single
  // write, because half-importing a format we do not understand is worse than
  // refusing the whole file.
  assertSchemaVersion(lines);

  const rejected: { line: number; reason: string }[] = [];
  let inserted = 0;
  let updated = 0;
  let skippedOlder = 0;
  let origin: string | null = null;

  const tally = (outcome: 'inserted' | 'updated' | 'skipped_older'): void => {
    if (outcome === 'inserted') {
      inserted += 1;
    } else if (outcome === 'updated') {
      updated += 1;
    } else {
      skippedOlder += 1;
    }
  };

  // The header is read first so `origin` is known even if later lines fail.
  const headerLine = firstContentLine(lines);
  let headerConsumed: number | null = null;
  let headerRejected: number | null = null;
  if (headerLine === null) {
    rejected.push({ line: 1, reason: 'missing header: the file has no records' });
  } else {
    const parsed = parseRecord(headerLine.text);
    if (parsed.ok && parsed.record.type === 'header') {
      origin = parsed.record.origin;
      headerConsumed = headerLine.line;
    } else {
      headerRejected = headerLine.line;
      rejected.push({
        line: headerLine.line,
        reason: `malformed header: ${
          parsed.ok ? `found a record of type "${parsed.record.type}"` : parsed.reason
        }`
      });
    }
  }

  // Records whose upsert threw. A store with referential integrity refuses an
  // edge before its endpoints exist, and entries sorted by id can carry a
  // `supersededBy` that points further down the file. Those are ordering
  // problems, not data problems, so they get retried once the rest has landed.
  let deferred: { line: number; record: DataRecord; reason: string }[] = [];

  for (const { line, text } of lines) {
    if (line === headerConsumed) {
      continue;
    }
    const parsed = parseRecord(text);
    if (!parsed.ok) {
      // The malformed header was already reported. Do not report it twice.
      if (line !== headerRejected) {
        rejected.push({ line, reason: parsed.reason });
      }
      continue;
    }
    if (parsed.record.type === 'header') {
      if (origin === null) {
        origin = parsed.record.origin;
      }
      continue;
    }
    try {
      tally(applyRecord(store, parsed.record));
    } catch (error) {
      deferred.push({ line, record: parsed.record, reason: describeError(error) });
    }
  }

  while (deferred.length > 0) {
    const remaining: typeof deferred = [];
    for (const item of deferred) {
      try {
        tally(applyRecord(store, item.record));
      } catch (error) {
        remaining.push({ line: item.line, record: item.record, reason: describeError(error) });
      }
    }
    // No progress this round means the rest cannot be satisfied by more rounds.
    const stuck = remaining.length === deferred.length;
    deferred = remaining;
    if (stuck) {
      break;
    }
  }
  for (const item of deferred) {
    rejected.push({ line: item.line, reason: item.reason });
  }

  rejected.sort((a, b) => a.line - b.line);

  return { inserted, updated, skippedOlder, rejected, origin: origin ?? 'unknown' };
}

export function importFromFile(store: MemoryStore, filePath: string): ImportResult {
  return importFromJsonl(store, readFileSync(filePath, 'utf8'));
}

type ParsedLine = { ok: true; record: ExportRecord } | { ok: false; reason: string };

function parseRecord(text: string): ParsedLine {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${describeError(error)}` };
  }
  const result = ExportRecordSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, reason: describeZodError(result.error) };
  }
  return { ok: true, record: result.data };
}

function applyRecord(
  store: MemoryStore,
  record: DataRecord
): 'inserted' | 'updated' | 'skipped_older' {
  switch (record.type) {
    case 'entry':
      return store.upsertEntry(record.data);
    case 'edge':
      return store.upsertEdge(record.data);
    case 'feedback':
      return store.upsertFeedback(record.data);
  }
}

/**
 * Splits on either line ending and drops blank lines.
 *
 * CRLF happens: the file may have crossed a Windows checkout with autocrlf on.
 * Blank lines are separators, not records, so the trailing newline that every
 * export writes does not read back as a broken final line.
 */
function splitLines(jsonl: string): { line: number; text: string }[] {
  const text = jsonl.charCodeAt(0) === 0xfeff ? jsonl.slice(1) : jsonl;
  const out: { line: number; text: string }[] = [];
  const raw = text.split(/\r?\n/u);
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index] ?? '';
    if (value.trim().length > 0) {
      out.push({ line: index + 1, text: value });
    }
  }
  return out;
}

function firstContentLine(
  lines: readonly { line: number; text: string }[]
): { line: number; text: string } | null {
  return lines[0] ?? null;
}

function assertSchemaVersion(lines: readonly { line: number; text: string }[]): void {
  for (const { line, text } of lines) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue; // A damaged line is the main pass's problem, not the version gate's.
    }
    if (typeof json !== 'object' || json === null) {
      continue;
    }
    const record = json as { type?: unknown; schemaVersion?: unknown };
    if (record.type !== 'header') {
      continue;
    }
    if (record.schemaVersion !== SCHEMA_VERSION) {
      throw new SchemaVersionMismatchError(record.schemaVersion, line);
    }
  }
}

function describeZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return 'failed schema validation';
  }
  const path = issue.path.join('.');
  const head = path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  const rest = error.issues.length - 1;
  return truncate(rest > 0 ? `${head} (+${rest} more)` : head);
}

function describeError(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error));
}

function truncate(reason: string, limit = 300): string {
  const flat = reason.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
