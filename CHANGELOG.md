# Changelog

## 0.2.0 - 2026-09-11

- Added meta recall with FTS5, optional local MiniLM vectors, scope concepts, and bounded graph traversal.
- Added five selectable strategies: meta, fusion, concept, lexical, and information.
- Applied trust ratings to retrieval streams and the weakest node on each graph path.
- Added `agent-evidence/v2` packets with whole records, source hashes, typed paths, conflicts, and exact UTF-8 byte limits.
- Kept evidence separate from action authorization. Trust ratings remain uncalibrated.
- Fixed existing queue record IDs in search, recall, feedback, and graph operations.
- Added an upgrade command with verified SQLite backups, settings backups, and optional model preparation.
- Added upgrade instructions and 120-second Codex and OpenCode tool timeouts.
- Kept the SQLite schema and synchronous recall API compatible. MCP consumers can request `strategy: legacy`.
- Added meta fixture regression checks, no-network preparation checks, and modern and legacy MCP packet checks.

See [the upgrade guide](docs/upgrade-v0.2.md) for installation and rollback steps.

## 0.1.0 - 2026-08-29

- Added local SQLite memory with FTS5 and WAL mode.
- Added bounded two-hop graph recall with a tested `0.3` decay.
- Added nine MCP tools with modern and legacy stdio support.
- Added Claude Code, Codex, and OpenCode configuration.
- Added Ollama, Llama, LM Studio, vLLM, and generic OpenAI-compatible examples.
- Added Windows, macOS, and Linux setup and CI.
- Added deterministic snapshots, a synthetic benchmark, and disclosure checks.
