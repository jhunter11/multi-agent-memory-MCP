import { isAbsolute } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';

export const CLIENT_IDS = ['claude-code', 'codex', 'opencode'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export interface ClientLaunchTuple {
  nodeExecutable: string;
  serverEntrypoint: string;
  databasePath: string;
}

export interface RenderedClientConfig {
  client: ClientId;
  format: 'json' | 'toml';
  text: string;
  server: Record<string, unknown>;
}

function validateTuple(input: ClientLaunchTuple): void {
  for (const [name, value] of Object.entries(input)) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
}

export function serverObject(input: ClientLaunchTuple): Record<string, unknown> {
  validateTuple(input);
  return {
    type: 'stdio',
    command: input.nodeExecutable,
    args: [input.serverEntrypoint],
    env: { MULTI_AGENT_MEMORY_DB: input.databasePath }
  };
}

export function renderClientConfig(
  client: ClientId,
  input: ClientLaunchTuple
): RenderedClientConfig {
  validateTuple(input);
  if (client === 'claude-code') {
    const server = serverObject(input);
    return {
      client,
      format: 'json',
      server,
      text: `${JSON.stringify({ mcpServers: { 'multi-agent-memory': server } }, null, 2)}\n`
    };
  }
  if (client === 'codex') {
    const server = {
      command: input.nodeExecutable,
      args: [input.serverEntrypoint],
      enabled: true,
      startup_timeout_sec: 20,
      tool_timeout_sec: 60,
      env: { MULTI_AGENT_MEMORY_DB: input.databasePath }
    };
    return {
      client,
      format: 'toml',
      server,
      text: stringifyToml({ mcp_servers: { 'multi-agent-memory': server } })
    };
  }
  const server = {
    type: 'local',
    command: [input.nodeExecutable, input.serverEntrypoint],
    environment: { MULTI_AGENT_MEMORY_DB: input.databasePath },
    enabled: true,
    timeout: 10_000
  };
  return {
    client,
    format: 'json',
    server,
    text: `${JSON.stringify(
      { $schema: 'https://opencode.ai/config.json', mcp: { 'multi-agent-memory': server } },
      null,
      2
    )}\n`
  };
}
