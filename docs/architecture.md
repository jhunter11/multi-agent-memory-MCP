# Architecture

## Boundaries

The package has four layers.

1. Contracts define records, edges, feedback, queries, and snapshots.
2. The SQLite store owns persistence, FTS5, trust, and graph traversal.
3. The MCP adapter exposes nine tools over stdio.
4. Client renderers create native Claude Code, Codex, and OpenCode configuration.

The storage API does not import the MCP SDK. A custom application can use the SQLite store directly.

## Retrieval

`memory_recall` starts with SQLite FTS5 seeds. It multiplies lexical relevance by trust and scope proximity.

The engine then follows `contains`, `refers_to`, and `contradicts` edges. It skips `supersedes` edges and superseded records. The public limit is two hops.

Each hop multiplies the score by the configured graph decay. The tested default is `0.3`. The engine keeps the best path to each record.

The byte budget includes complete UTF-8 records. The engine never cuts a record body.

## Storage

SQLite runs in WAL mode with foreign keys enabled. FTS5 triggers update the text index after record changes.

The schema uses `PRAGMA user_version`. The store rejects an unknown schema version. It does not stamp an unknown database as current.

## Protocol

The process reserves standard output for MCP frames. Diagnostics use standard error.

The server uses the MCP SDK dual-era stdio entry. It accepts the 2026-07-28 discovery flow and the 2025-11-25 initialize flow.

## Trust model

This release serves a trusted, single-user local environment. Scopes affect ranking and organization only.

Scopes do not provide tenant isolation. The export and statistics tools can read the full store.
