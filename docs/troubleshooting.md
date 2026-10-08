# Troubleshooting

## The client cannot start the server

Make sure the command and server entrypoint are absolute paths. Run `npm run build` before you configure a client.

Run `node dist/mcp/bin.js --help` to check the executable.

## The client reports invalid JSON

The MCP process writes frames to standard output. Send all diagnostics to standard error.

Run `npm run probe`. The probe starts the compiled process and checks both protocol eras.

## Native SQLite does not load

Use Node.js 22 or newer. Run `npm ci` on the current operating system.

Do not copy `node_modules` from another operating system or CPU architecture.

## OpenCode installation fails on Windows

If `npm ci` fails in the `opencode-ai` postinstall step, its development CLI might not start on your host.
The October 8, 2026 Windows check reproduced an `EPERM` root-directory error in that CLI with Node 25.5.0.

Use this path to verify the memory package. Check each command's exit code before the next command.

```powershell
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run verify
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Client none -SkipInstall
```

This path skips dependency install scripts, then rebuilds SQLite explicitly.
It still runs the client configuration tests and both MCP protocol checks.
Use a separately installed, working MCP host for agent connections.
Host CLI execution and real-model embedding remain unverified by this workaround.

## Recall returns no linked record

Check the edge with `memory_neighbors`. Make sure `maxHops` is at least the required path length.

The public maximum is two hops. The engine skips `supersedes` edges and superseded records.

## OpenCode connects but the model does not call tools

Check that the selected model supports structured tool calls. Check the model server flags and parser.

The HTTP API can work while the model lacks tool-use skills.

## Windows path errors

Use the generated JSON or TOML. Do not hand-escape backslashes.

The renderer uses a serializer and supports spaces and Unicode paths.

## A duplicate configuration fails

The renderer refuses to replace an existing `multi-agent-memory` entry by default.

Inspect the existing entry. Then pass the replacement option if the change is intentional.
