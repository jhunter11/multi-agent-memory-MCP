import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runBenchmark } from '../benchmark/run.js';

const output = resolve(process.argv[2] ?? 'benchmark/results.json');
const report = runBenchmark();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${output}\n`);
