# Client schema verification

The checked examples use the configuration shapes accepted by these client releases:

- Claude Code 2.1.251
- Codex CLI 0.150.1
- OpenCode 1.18.25

Tests parse every JSON and TOML example, assert the native client shape, and verify the same absolute MCP launch tuple. The release gate also starts the built server through both current and legacy MCP transports. Exact client versions live in `tests/fixtures/client-cli-versions.json` so a compatibility update is reviewable.
