import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the two commands a person actually types.
 *
 * The library round trip is covered in `portability.test.ts`. What is covered
 * here is the wiring around it, which is where a sync silently does nothing:
 * which database each command opens, which file it reads or writes when no path
 * is given, and what it reports back. An export that succeeds against the wrong
 * database prints the same cheerful summary as one that worked.
 *
 * Every case passes an explicit database path or points the environment variable
 * at a temporary file. None of them may touch the real default location.
 */

/** See `tests/store.test.ts`: maps the emitted `.js` specifiers back to sources. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { runCli } = await import('../src/portability/cli.ts');
const { createStore } = await import('../src/store/index.ts');
const { DATABASE_ENV_VAR } = await import('../src/db-path.ts');

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI with console captured, so a test can read what a user would see. */
async function run(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  try {
    const code = await runCli(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'jm-cli-'));
}

/** A database with three entries, an edge, and a feedback row. */
function seedDatabase(dbPath: string): { entries: number; edges: number; feedback: number } {
  const store = createStore(dbPath);
  try {
    const first = store.write({
      kind: 'decision',
      scope: 'agency/engineering',
      title: 'Sync the snapshot, not the database',
      body: 'A live SQLite file cannot be shared through a synced folder.',
      source: 'tests/cli.test.ts',
      tags: ['sync']
    });
    const second = store.write({
      kind: 'fact',
      scope: 'agency/engineering',
      title: 'File locking is unreliable on network shares',
      body: 'SQLite depends on locks that many network filesystems implement incorrectly.',
      source: 'tests/cli.test.ts',
      tags: []
    });
    store.write({
      kind: 'procedure',
      scope: 'personal/health',
      title: 'Sleep before optimising anything',
      body: 'Sleep first, then decide.',
      source: 'tests/cli.test.ts',
      tags: []
    });
    store.relate(first.id, second.id, 'refers_to');
    store.feedback(first.id, 'helpful', 'this held up');
    return { entries: 3, edges: 1, feedback: 1 };
  } finally {
    store.close();
  }
}

// --- Argument handling ------------------------------------------------------

test('--help and help both print the usage and succeed', async () => {
  for (const argv of [['--help'], ['-h'], ['help']]) {
    const result = await run(...argv);
    assert.equal(result.code, 0, argv.join(' '));
    assert.match(result.out, /export/u);
    assert.match(result.out, /import/u);
    assert.match(result.out, /Exit codes/u);
  }
});

test('a missing or unknown command fails with 2 and says why', async () => {
  const none = await run();
  assert.equal(none.code, 2);
  assert.match(none.err, /a command is required/u);

  const wrong = await run('sync');
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /unknown command "sync"/u);
  assert.match(wrong.err, /export/u, 'the usage comes with the refusal');
});

test('an unparseable flag fails with 2 rather than a stack trace', async () => {
  const result = await run('export', '--nonsense');
  assert.equal(result.code, 2);
  assert.match(result.err, /nonsense/u);
});

// --- Export -----------------------------------------------------------------

test('export writes a snapshot and reports both paths it touched', async () => {
  const dir = workspace();
  const db = join(dir, 'memory.sqlite');
  const out = join(dir, 'snapshot.jsonl');
  const counts = seedDatabase(db);

  try {
    const result = await run('export', '--db', db, '--out', out, '--origin', 'desktop');

    assert.equal(result.code, 0, result.err);
    // Singular where the count is one. This line is read far more often than any
    // other output this tool produces.
    assert.equal(counts.edges, 1);
    assert.match(
      result.out,
      new RegExp(`exported ${counts.entries} entries, 1 edge, 1 feedback row`, 'u')
    );
    // Both ends are printed, because an export against the wrong database looks
    // exactly like one against the right database.
    assert.ok(result.out.includes(db), 'the summary names the database it read');
    assert.ok(result.out.includes(out), 'and the file it wrote');
    assert.match(result.out, /origin\s+desktop/u);

    const lines = readFileSync(out, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1 + counts.entries + counts.edges + counts.feedback);
    const header = JSON.parse(lines[0] ?? '') as {
      type: string;
      origin: string;
      schemaVersion: number;
    };
    assert.equal(header.type, 'header');
    assert.equal(header.origin, 'desktop');
    assert.equal(header.schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export refuses a database that does not exist instead of creating an empty one', async () => {
  const dir = workspace();
  const missing = join(dir, 'typo.sqlite');
  const out = join(dir, 'snapshot.jsonl');

  try {
    const result = await run('export', '--db', missing, '--out', out);

    // Opening a database creates it. Without this guard a typo in --db produces a
    // new empty file and a cheerful "exported 0 entries", which reads exactly
    // like a successful export of a store that happens to be empty.
    assert.equal(result.code, 2);
    assert.match(result.err, /no database at/u);
    assert.ok(result.err.includes(missing), result.err);
    assert.ok(!existsSync(missing), 'and no database is left behind');
    assert.ok(!existsSync(out), 'and no snapshot either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty database still exports, because empty is not the same as absent', async () => {
  const dir = workspace();
  const db = join(dir, 'empty.sqlite');
  const out = join(dir, 'snapshot.jsonl');
  createStore(db).close();

  try {
    const result = await run('export', '--db', db, '--out', out);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /exported 0 entries/u);
    assert.equal(
      readFileSync(out, 'utf8').trimEnd().split('\n').length,
      1,
      'a header and nothing else'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the snapshot path can be a bare argument, the way the README writes it', async () => {
  const dir = workspace();
  const db = join(dir, 'memory.sqlite');
  const out = join(dir, 'positional.jsonl');
  seedDatabase(db);

  try {
    const result = await run('export', out, '--db', db);
    assert.equal(result.code, 0, result.err);
    assert.ok(existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --db, export opens the database the MCP server would open', async () => {
  const dir = workspace();
  const db = join(dir, 'from-env.sqlite');
  const out = join(dir, 'snapshot.jsonl');
  seedDatabase(db);

  const previous = process.env[DATABASE_ENV_VAR];
  process.env[DATABASE_ENV_VAR] = db;
  try {
    const result = await run('export', '--out', out);
    assert.equal(result.code, 0, result.err);
    assert.ok(result.out.includes(db), 'the same resolution rule the server follows');
    assert.match(result.out, /exported 3 entries/u);
  } finally {
    if (previous === undefined) delete process.env[DATABASE_ENV_VAR];
    else process.env[DATABASE_ENV_VAR] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Import -----------------------------------------------------------------

test('a snapshot exported on one machine imports on another, and re-exports identically', async () => {
  const dir = workspace();
  const laptop = join(dir, 'laptop.sqlite');
  const desktop = join(dir, 'desktop.sqlite');
  const first = join(dir, 'from-laptop.jsonl');
  const second = join(dir, 'from-desktop.jsonl');
  seedDatabase(laptop);

  try {
    assert.equal(
      (await run('export', '--db', laptop, '--out', first, '--origin', 'laptop')).code,
      0
    );

    const imported = await run('import', '--db', desktop, '--in', first);
    assert.equal(imported.code, 0, imported.err);
    assert.match(imported.out, /origin\s+laptop/u, 'the machine that wrote the file is named');
    assert.match(imported.out, /inserted\s+5/u, 'three entries, one edge, one feedback row');
    assert.match(imported.out, /updated\s+0/u);
    assert.match(imported.out, /rejected\s+0/u);
    assert.ok(imported.out.includes(desktop), 'the summary names the database it wrote into');

    // Importing the same file again changes nothing. This is what makes a sync
    // safe to run twice, which is what people actually do.
    const again = await run('import', '--db', desktop, '--in', first);
    assert.equal(again.code, 0);
    assert.match(again.out, /inserted\s+0/u);
    assert.match(again.out, /skippedOlder\s+5/u);

    // The two machines now hold the same memory, so they write the same bytes.
    // Only the origin in the header differs, which is the point of recording it.
    assert.equal(
      (await run('export', '--db', desktop, '--out', second, '--origin', 'laptop')).code,
      0
    );
    assert.ok(
      readFileSync(first).equals(readFileSync(second)),
      'the round trip is lossless to the byte'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged line exits 1, reports its own line number, and reports what it took with it', async () => {
  const dir = workspace();
  const laptop = join(dir, 'laptop.sqlite');
  const desktop = join(dir, 'desktop.sqlite');
  const snapshot = join(dir, 'snapshot.jsonl');
  seedDatabase(laptop);

  try {
    await run('export', '--db', laptop, '--out', snapshot, '--origin', 'laptop');
    const lines = readFileSync(snapshot, 'utf8').trimEnd().split('\n');
    // A header, three entries, one edge, one feedback row. Line 3 is the second
    // entry, and the edge on line 5 points at it.
    assert.equal(lines.length, 6);
    lines[2] = '{"type":"entry","data":{ this is not json';
    writeFileSync(snapshot, `${lines.join('\n')}\n`, 'utf8');

    const result = await run('import', '--db', desktop, '--in', snapshot);

    // 1, not 2: the file was read and most of it landed. A partial import that
    // reported success would be the dangerous outcome here.
    assert.equal(result.code, 1);
    assert.match(result.out, /inserted\s+3/u, 'two entries and the feedback row still landed');

    // Two rejections from one damaged line, and both are named. Losing an entry
    // loses the edges that point at it, and an import that mentioned only the
    // line it could not parse would understate the damage.
    assert.match(result.out, /rejected\s+2/u);
    assert.match(result.out, /line 3: invalid JSON/u, 'the unreadable line, by number');
    assert.match(result.out, /line 5: FOREIGN KEY/u, 'and the edge that needed it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot from a future schema is refused with 2 before anything is written', async () => {
  const dir = workspace();
  const db = join(dir, 'memory.sqlite');
  const snapshot = join(dir, 'future.jsonl');

  writeFileSync(
    snapshot,
    `${JSON.stringify({
      type: 'header',
      schemaVersion: 2,
      exportedAt: '2030-01-01T00:00:00.000Z',
      origin: 'the-future',
      counts: { entries: 0, edges: 0, feedback: 0 }
    })}\n`,
    'utf8'
  );

  try {
    const result = await run('import', '--db', db, '--in', snapshot);
    assert.equal(result.code, 2);
    assert.match(result.err, /schemaVersion 2/u);
    assert.match(result.err, /Refusing to import/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import creates the database directory, because a fresh machine has none', async () => {
  const dir = workspace();
  const laptop = join(dir, 'laptop.sqlite');
  const snapshot = join(dir, 'snapshot.jsonl');
  // Two levels deep and neither exists. This is the real default path on every
  // platform: SQLite creates a missing file but never a missing directory, so an
  // import that did not make the directory failed on the one case it exists for.
  const fresh = join(dir, 'not-created-yet', 'nested', 'memory.sqlite');
  seedDatabase(laptop);

  try {
    await run('export', '--db', laptop, '--out', snapshot, '--origin', 'laptop');
    assert.ok(!existsSync(dirname(fresh)), 'the target directory must not exist yet');

    const result = await run('import', '--db', fresh, '--in', snapshot);

    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /inserted\s+5/u);
    assert.ok(existsSync(fresh), 'the database was created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing snapshot file exits 2 with the path in the message', async () => {
  const dir = workspace();
  const db = join(dir, 'memory.sqlite');
  const missing = join(dir, 'not-here.jsonl');

  try {
    const result = await run('import', '--db', db, '--in', missing);
    assert.equal(result.code, 2);
    assert.ok(result.err.includes('not-here.jsonl'), result.err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
