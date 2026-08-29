import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureClient } from '../dist/clients/configure.js';
import { renderClientConfig } from '../dist/clients/render.js';
import { defaultDatabasePath } from '../dist/db-path.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const values = new Map();
const flags = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === '--write' || token === '--replace') {
    flags.add(token);
    continue;
  }
  if (token?.startsWith('--')) {
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    values.set(token, value);
    index += 1;
  }
}

const client = values.get('--client');
if (!['claude-code', 'codex', 'opencode'].includes(client)) {
  throw new Error('--client must be claude-code, codex, or opencode');
}
const defaults = {
  'claude-code': resolve(root, '.mcp.json'),
  codex: resolve(root, '.codex', 'config.toml'),
  opencode: resolve(root, 'opencode.json')
};
const tuple = {
  nodeExecutable: process.execPath,
  serverEntrypoint: resolve(root, 'dist', 'mcp', 'bin.js'),
  databasePath: resolve(values.get('--db') ?? defaultDatabasePath())
};

if (!flags.has('--write')) {
  process.stdout.write(renderClientConfig(client, tuple).text);
} else {
  const result = await configureClient({
    client,
    tuple,
    configPath: resolve(values.get('--config') ?? defaults[client]),
    replace: flags.has('--replace')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
