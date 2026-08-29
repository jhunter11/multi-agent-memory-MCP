import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { renderClientConfig, type ClientId, type ClientLaunchTuple } from './render.js';

export interface ConfigureClientInput {
  client: ClientId;
  tuple: ClientLaunchTuple;
  configPath: string;
  replace?: boolean;
}

export interface ConfigureResult {
  path: string;
  backupPath: string | null;
  replaced: boolean;
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
}

export async function configureClient(input: ConfigureClientInput): Promise<ConfigureResult> {
  const rendered = renderClientConfig(input.client, input.tuple);
  await mkdir(dirname(input.configPath), { recursive: true });
  let existingText: string | null = null;
  try {
    existingText = await readFile(input.configPath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  let backupPath: string | null = null;
  let output = rendered.text;
  let replaced = false;
  if (existingText !== null) {
    const root =
      input.client === 'codex'
        ? (parseToml(existingText) as Record<string, unknown>)
        : (JSON.parse(existingText) as Record<string, unknown>);
    const sectionName =
      input.client === 'claude-code'
        ? 'mcpServers'
        : input.client === 'codex'
          ? 'mcp_servers'
          : 'mcp';
    const section = (root[sectionName] ?? {}) as Record<string, unknown>;
    if (section['multi-agent-memory'] !== undefined && input.replace !== true) {
      throw new Error('multi-agent-memory already exists; pass the explicit replacement option');
    }
    replaced = section['multi-agent-memory'] !== undefined;
    section['multi-agent-memory'] = rendered.server;
    root[sectionName] = section;
    if (input.client === 'opencode' && root['$schema'] === undefined) {
      root['$schema'] = 'https://opencode.ai/config.json';
    }
    output = input.client === 'codex' ? stringifyToml(root) : `${JSON.stringify(root, null, 2)}\n`;
    backupPath = `${input.configPath}.bak-${timestamp()}`;
    await copyFile(input.configPath, backupPath);
  }

  const temporary = `${input.configPath}.tmp-${process.pid}`;
  await writeFile(temporary, output, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, input.configPath);
  return { path: input.configPath, backupPath, replaced };
}
