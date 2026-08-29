import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { configureClient } from '../src/clients/configure.ts';

const tuple = {
  nodeExecutable: process.execPath,
  serverEntrypoint: resolve('dist', 'mcp', 'bin.js'),
  databasePath: resolve('test data', 'memory.sqlite')
};

test('configuration preserves unrelated JSON, backs up, and requires explicit replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-config-'));
  const path = join(dir, 'opencode.json');
  const original = `${JSON.stringify({ theme: 'dark', mcp: { existing: { type: 'remote' } } }, null, 2)}\n`;
  try {
    await writeFile(path, original, 'utf8');
    const first = await configureClient({ client: 'opencode', tuple, configPath: path });
    assert.ok(first.backupPath !== null);
    assert.equal(await readFile(first.backupPath, 'utf8'), original);
    const merged = JSON.parse(await readFile(path, 'utf8')) as any;
    assert.equal(merged.theme, 'dark');
    assert.deepEqual(merged.mcp.existing, { type: 'remote' });
    assert.deepEqual(merged.mcp['multi-agent-memory'].command, [
      tuple.nodeExecutable,
      tuple.serverEntrypoint
    ]);

    await assert.rejects(
      configureClient({ client: 'opencode', tuple, configPath: path }),
      /explicit replacement/u
    );
    const replaced = await configureClient({
      client: 'opencode',
      tuple: { ...tuple, databasePath: resolve('other', 'memory.sqlite') },
      configPath: path,
      replace: true
    });
    assert.equal(replaced.replaced, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('new Claude Code and Codex files use their native formats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-native-config-'));
  try {
    const claudePath = join(dir, '.mcp.json');
    const codexPath = join(dir, 'config.toml');
    await configureClient({ client: 'claude-code', tuple, configPath: claudePath });
    await configureClient({ client: 'codex', tuple, configPath: codexPath });
    assert.match(await readFile(claudePath, 'utf8'), /"mcpServers"/u);
    assert.match(await readFile(codexPath, 'utf8'), /\[mcp_servers\.multi-agent-memory\]/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
