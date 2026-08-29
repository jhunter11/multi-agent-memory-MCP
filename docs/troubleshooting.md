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
