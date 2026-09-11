import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Entry } from '../contracts.js';
import { digest, type VectorInput } from './meta.js';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';
const SettingsSchema = z
  .object({
    modelRoot: z.string().min(1).optional(),
    strategy: z.enum(['meta', 'fusion', 'concept', 'lexical', 'information']).optional()
  })
  .strict();
export type MetaSettings = z.infer<typeof SettingsSchema>;
export async function readMetaSettings(dbPath: string): Promise<MetaSettings> {
  try {
    return SettingsSchema.parse(JSON.parse(await readFile(dbPath + '.meta.json', 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}
type Extract = (
  text: string[],
  options: { pooling: 'mean'; normalize: true }
) => Promise<{ tolist(): number[][] }>;
interface Cache {
  schema: 1;
  modelHash: string;
  records: Record<string, { hash: string; vector: number[] }>;
}
const validVector = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 384 && value.every(Number.isFinite);

/** Local inference only. Model download is an explicit setup operation. */
export class LocalVectors {
  private extract?: Extract;
  private cache?: Cache;
  private root?: string;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly dbPath: string) {}
  async recall(entries: Entry[], query: string): Promise<VectorInput> {
    const run = this.serial.then(() => this.load(entries, query));
    this.serial = run.catch(() => undefined);
    return run;
  }
  private async load(entries: Entry[], query: string): Promise<VectorInput> {
    const settings = await readMetaSettings(this.dbPath);
    const modelRoot = process.env.MULTI_AGENT_MEMORY_MODEL_ROOT ?? settings.modelRoot;
    if (!modelRoot)
      return { records: new Map(), query: [], status: 'disabled: configure local modelRoot' };
    const root = resolve(modelRoot);
    if (this.root !== root) {
      const files = [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'onnx/model_quantized.onnx'
      ];
      const hashes = await Promise.all(
        files.map(async (f) => digest((await readFile(join(root, MODEL, f))).toString('base64')))
      );
      const modelHash = digest(JSON.stringify([MODEL, 'mean-normalized-title-body-v1', hashes]));
      const { env, pipeline } = await import('@xenova/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = root + '/';
      env.cacheDir = root;
      env.backends.onnx.wasm.numThreads = 1;
      this.extract = (await pipeline('feature-extraction', MODEL, {
        quantized: true,
        local_files_only: true
      })) as unknown as Extract;
      let cache: Cache = { schema: 1, modelHash, records: {} };
      try {
        const saved = JSON.parse(await readFile(this.dbPath + '.vectors.json', 'utf8')) as Cache;
        if (saved.schema === 1 && saved.modelHash === modelHash && saved.records) cache = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
          throw error;
      }
      this.cache = cache;
      this.root = root;
    }
    const cache = this.cache!,
      changed: Entry[] = [];
    for (const e of entries) {
      const old = cache.records[e.id];
      if (!old || old.hash !== digest(e.title + '\n' + e.body) || !validVector(old.vector))
        changed.push(e);
    }
    for (let i = 0; i < changed.length; i += 16) {
      const batch = changed.slice(i, i + 16);
      const vectors = (
        await this.extract!(
          batch.map((e) => e.title + '\n' + e.body),
          { pooling: 'mean', normalize: true }
        )
      ).tolist();
      if (vectors.length !== batch.length || !vectors.every(validVector))
        throw new Error('Local model returned invalid record vectors');
      batch.forEach((e, j) => {
        cache.records[e.id] = { hash: digest(e.title + '\n' + e.body), vector: vectors[j]! };
      });
    }
    if (changed.length) await atomicJson(this.dbPath + '.vectors.json', cache);
    const qv = (await this.extract!([query], { pooling: 'mean', normalize: true })).tolist()[0]!;
    if (!validVector(qv)) throw new Error('Local model returned an invalid query vector');
    return {
      records: new Map(entries.map((e) => [e.id, cache.records[e.id]!.vector])),
      query: qv,
      status: 'local-minilm:384:quantized:title-body-truncated:' + cache.modelHash
    };
  }
}
