import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = join(root, 'dist', 'mcp', 'bin.js');

async function probe(mode) {
  const dir = await mkdtemp(join(tmpdir(), `multi-agent-memory-${mode}-`));
  const dbPath = join(dir, 'probe.sqlite');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: root,
    env: {
      ...getDefaultEnvironment(),
      MULTI_AGENT_MEMORY_DB: dbPath,
      MULTI_AGENT_MEMORY_ORIGIN: 'protocol-probe'
    },
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client(
    { name: `multi-agent-memory-${mode}-probe`, version: '0.1.0' },
    { versionNegotiation: { mode } }
  );

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'memory_export',
      'memory_feedback',
      'memory_neighbors',
      'memory_recall',
      'memory_reflect',
      'memory_relate',
      'memory_search',
      'memory_stats',
      'memory_write'
    ]);

    const written = await client.callTool({
      name: 'memory_write',
      arguments: {
        kind: 'decision',
        scope: 'probe/engineering',
        title: 'Use bounded graph recall',
        body: 'The public configuration expands at most two graph hops with a 0.3 decay.',
        source: 'scripts/mcp-probe.mjs'
      }
    });
    assert.notEqual(written.isError, true);

    const searched = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'bounded graph recall', scope: 'probe' }
    });
    assert.notEqual(searched.isError, true);

    const recalled = await client.callTool({
      name: 'memory_recall',
      arguments: { task: 'bounded graph recall', entryScope: 'probe/engineering' }
    });
    assert.notEqual(recalled.isError, true);

    const stats = await client.callTool({ name: 'memory_stats', arguments: {} });
    assert.notEqual(stats.isError, true);
    return {
      requestedMode: mode,
      era: client.getProtocolEra(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      tools: listed.tools.length,
      stderrReady: stderr.includes('ready on stdio')
    };
  } finally {
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

const results = [];
results.push(await probe('auto'));
results.push(await probe('legacy'));
process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
