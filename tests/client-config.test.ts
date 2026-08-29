import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse as parseToml } from 'smol-toml';

import { renderClientConfig } from '../src/clients/render.ts';

const tuple = {
  nodeExecutable: process.execPath,
  serverEntrypoint: resolve('space and ünicode', 'dist', 'mcp', 'bin.js'),
  databasePath: resolve('space and ünicode', 'data', 'memory.sqlite')
};

test('Claude Code, Codex, and OpenCode render one absolute launch tuple', () => {
  const claude = JSON.parse(renderClientConfig('claude-code', tuple).text) as any;
  const codex = parseToml(renderClientConfig('codex', tuple).text) as any;
  const opencode = JSON.parse(renderClientConfig('opencode', tuple).text) as any;

  assert.equal(claude.mcpServers['multi-agent-memory'].type, 'stdio');
  assert.equal(claude.mcpServers['multi-agent-memory'].command, tuple.nodeExecutable);
  assert.deepEqual(claude.mcpServers['multi-agent-memory'].args, [tuple.serverEntrypoint]);
  assert.equal(
    claude.mcpServers['multi-agent-memory'].env.MULTI_AGENT_MEMORY_DB,
    tuple.databasePath
  );

  assert.equal(codex.mcp_servers['multi-agent-memory'].command, tuple.nodeExecutable);
  assert.deepEqual(codex.mcp_servers['multi-agent-memory'].args, [tuple.serverEntrypoint]);
  assert.equal(
    codex.mcp_servers['multi-agent-memory'].env.MULTI_AGENT_MEMORY_DB,
    tuple.databasePath
  );
  assert.equal(codex.mcp_servers['multi-agent-memory'].startup_timeout_sec, 20);

  assert.deepEqual(opencode.mcp['multi-agent-memory'].command, [
    tuple.nodeExecutable,
    tuple.serverEntrypoint
  ]);
  assert.equal(
    opencode.mcp['multi-agent-memory'].environment.MULTI_AGENT_MEMORY_DB,
    tuple.databasePath
  );
});

test('rendering rejects relative launch paths', () => {
  assert.throws(
    () =>
      renderClientConfig('codex', { ...tuple, databasePath: join('relative', 'memory.sqlite') }),
    /absolute path/u
  );
});
