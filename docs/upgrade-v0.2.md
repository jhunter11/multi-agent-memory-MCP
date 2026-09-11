# Upgrade to 0.2

Version 0.2 adds meta retrieval and an agent-readable evidence packet. It also accepts existing `queue_` record IDs. The SQLite schema remains version 1.

## Existing checkout

Use the checkout that your MCP clients already launch. Save your own code changes before updating. These commands require a clean checkout on `main`.

```text
git pull --ff-only
npm ci
npm run build
npm run verify
```

If you install into another directory, update the client server path with the configuration renderer. Existing database paths must still point to your private database.

## Prepare the database

The preparation command requires an existing database. It creates an online SQLite backup and checks that backup before it changes settings. It preserves the database records, graph, feedback, and schema.

On Windows, replace these paths with your private database and model directory:

```powershell
node scripts/prepare-meta.mjs --db "C:/private-memory/memory.sqlite" --model-root "C:/private-memory/models" --download --strategy meta
```

On macOS or Linux:

```sh
node scripts/prepare-meta.mjs --db "$HOME/.local/share/private-memory/memory.sqlite" --model-root "$HOME/.local/share/private-memory/models" --download --strategy meta
```

`--download` permits a model download during setup. The command never uploads memories. Omit `--download` when that model directory already contains the model files.

To use FTS5, concepts, and graph retrieval without vectors, omit the model directory and download flag. On an installation that already enables vectors, remove `modelRoot` from the settings file to disable them.

Preparation writes these private files:

- `memory.sqlite.<timestamp>.backup`: consistent database backup, including committed WAL content.
- `memory.sqlite.<timestamp>.backup.meta.json`: previous retrieval settings.
- `memory.sqlite.meta.json`: strategy and optional model directory.
- `memory.sqlite.vectors.json`: derived vectors, when enabled.

Keep these files outside source repositories. The vector cache is disposable. The SQLite database is not.

## Client settings

If the executable path and database path stay the same, existing registrations can stay in place. Restart each affected MCP client to load the new server.

To render a replacement configuration:

```text
node scripts/render-client-config.mjs --client codex --db <absolute-database-path>
```

Supported clients are `claude-code`, `codex`, and `opencode`. Add `--write --replace --config <absolute-config-path>` to update an existing registration. The renderer backs up the file and preserves unrelated settings. New configurations allow 120 seconds for recall. Prepare vectors before normal agent use.

## Verify the upgrade

Call `memory_stats` and compare record counts with your earlier counts. Call `memory_recall` with a familiar question. Check that the packet has schema `agent-evidence/v2` and the expected source records.

When vectors are enabled, `vectorStatus` starts with `local-minilm:384`. A fallback status means the vector model did not run. Inspect server stderr for the cause.

The TypeScript API adds `await store.recallMeta(input)`. The synchronous `store.recall(input)` method retains legacy behavior. Custom consumers must parse the new MCP packet instead of the old prose summary. The tool accepts `strategy: legacy` for an explicit compatibility call.

## Rollback

Keep the previous application build until verification passes. To roll back, stop affected MCP servers and restore their previous executable path or build. Restore the previous retrieval settings if needed. Then restart the clients.

The code upgrade does not require a database restore. Restore the database backup only to reverse database changes. Stop all writers before a database restore. A restore discards records written after the backup.
