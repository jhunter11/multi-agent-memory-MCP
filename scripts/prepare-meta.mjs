import { resolve, join } from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { createStore } from '../dist/store/index.js';
import { atomicJson, LocalVectors, MODEL, readMetaSettings } from '../dist/store/vectors.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    'model-root': { type: 'string' },
    download: { type: 'boolean' },
    strategy: { type: 'string' },
    help: { type: 'boolean' }
  }
});
const usage =
  'Usage: node scripts/prepare-meta.mjs --db ABSOLUTE_PATH [--model-root DIRECTORY] [--download] [--strategy meta|fusion|concept|lexical|information]';
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const dbArg = values.db;
if (!dbArg)
  throw new Error(
    'Usage: node scripts/prepare-meta.mjs --db ABSOLUTE_PATH [--model-root DIRECTORY] [--download] [--strategy meta|fusion|concept|lexical|information]'
  );
const dbPath = resolve(dbArg);
await access(dbPath);
const strategy = values.strategy ?? 'meta';
if (!['meta', 'fusion', 'concept', 'lexical', 'information'].includes(strategy))
  throw new Error('Invalid strategy');
const settings = await readMetaSettings(dbPath);
const rootArg = values['model-root'] ?? settings.modelRoot;
if (values.download && !rootArg) throw new Error('--download requires --model-root');
const backup = dbPath + '.' + new Date().toISOString().replaceAll(':', '-') + '.backup';
const db = new Database(dbPath, { readonly: true });
try {
  await db.backup(backup);
  const check = new Database(backup, { readonly: true });
  try {
    if (check.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('Backup integrity check failed');
  } finally {
    check.close();
  }
} finally {
  db.close();
}
await atomicJson(backup + '.meta.json', settings);
if (rootArg && values.download) {
  const root = resolve(rootArg);
  await mkdir(join(root, MODEL), { recursive: true });
  const { env, pipeline } = await import('@xenova/transformers');
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  env.localModelPath = root + '/';
  env.cacheDir = root;
  const extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
  await extractor.dispose();
}
const updated = { ...settings, strategy, ...(rootArg ? { modelRoot: resolve(rootArg) } : {}) };
// Prepare through an explicit model root before publishing the new settings.
if (rootArg) {
  process.env.MULTI_AGENT_MEMORY_MODEL_ROOT = resolve(rootArg);
  const store = createStore(dbPath);
  try {
    await new LocalVectors(dbPath).recall(store.allEntries(), 'prepare local memory retrieval');
  } finally {
    store.close();
  }
}
await atomicJson(dbPath + '.meta.json', updated);
process.stdout.write(
  JSON.stringify({
    ok: true,
    backup,
    settings: dbPath + '.meta.json',
    vectors: Boolean(rootArg),
    strategy,
    reloadClients: true
  }) + '\n'
);
