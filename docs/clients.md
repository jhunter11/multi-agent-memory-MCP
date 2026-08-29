# Client configuration

## Common launch tuple

All clients use the same values:

- An absolute Node executable path.
- An absolute `dist/mcp/bin.js` path.
- An absolute SQLite database path.

Do not use a relative server path. The client working directory can change.

## Claude Code

Use a project `.mcp.json` file. The checked example is at `examples/clients/claude-code/.mcp.json`.

CLI registration:

```text
claude mcp add --transport stdio --scope project --env MULTI_AGENT_MEMORY_DB=<absolute-db> multi-agent-memory -- <absolute-node> <absolute-server>
```

Claude Code asks for approval before it starts a project MCP server.

## Codex

Use `.codex/config.toml` for a trusted project. Use `$CODEX_HOME/config.toml` for a user configuration.

Do not add a `transport` field. A `command` value selects stdio.

CLI registration:

```text
codex mcp add multi-agent-memory --env MULTI_AGENT_MEMORY_DB=<absolute-db> -- <absolute-node> <absolute-server>
```

The example sets a 20-second startup timeout and a 60-second tool timeout.

## OpenCode

Use stable OpenCode 1.x syntax:

- The root key is `mcp`.
- The server type is `local`.
- The command is one argument array.
- Environment values use `environment`.
- The timeout uses milliseconds.

The checked example is at `examples/clients/opencode/opencode.json`.

## Safe renderer

The setup scripts print a configuration by default. They do not edit a client file.

Use the configuration option to write a file. The renderer backs up an existing file and preserves unrelated settings.

The renderer refuses an existing `multi-agent-memory` entry. Use the replacement option only when you intend to replace that entry.
