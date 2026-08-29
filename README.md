# Multi-Agent Memory MCP

[![CI](https://github.com/jhunter11/multi-agent-memory-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/jhunter11/multi-agent-memory-MCP/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-green.svg)](package.json)

Local-first, model-agnostic memory for coding agents and local LLM systems.

This repository provides persistent memory, Graph RAG, and bounded multi-hop retrieval through MCP. It uses SQLite FTS5 and a typed knowledge graph. It has no hosted service, telemetry, account, or model dependency.

Use the same memory store with Claude Code, Codex, OpenCode, or a custom MCP client. OpenCode examples connect Llama-family and other local models through Ollama, LM Studio, vLLM, and OpenAI-compatible APIs.

The setup and test matrix supports Windows, macOS, and Linux.

## Measured result

The committed benchmark uses 400 synthetic questions and 350 decoy records. It includes direct, one-hop, two-hop, and negative cases.

| Configuration       |   Recall@5 |        MRR |     Direct |    One hop |   Two hops | Negative abstention | Decoy contamination |
| ------------------- | ---------: | ---------: | ---------: | ---------: | ---------: | ------------------: | ------------------: |
| Lexical only        |     0.3333 |     0.3333 |     1.0000 |     0.0000 |     0.0000 |              1.0000 |              0.0000 |
| One hop, 0.3 decay  |     0.6667 |     0.5000 |     1.0000 |     1.0000 |     0.0000 |              1.0000 |              0.0000 |
| Two hops, 0.3 decay | **1.0000** | **0.6111** | **1.0000** | **1.0000** | **1.0000** |          **1.0000** |          **0.0000** |

This is the strongest memory configuration tested on this fixture family. It is not a universal optimum.

An earlier private pilot used a separate multi-agent tiered system. Direct Recall@5 stayed at `0.92`. Link-only Recall@5 rose from `0.00` to `0.27`. A 350-decoy run reached `0.19`. This repository contains no pilot records, names, prompts, or private data.

Run the public benchmark:

```text
npm run build
npm run benchmark
node scripts/check-benchmark.mjs
```

See [benchmark/results.json](benchmark/results.json) and [docs/benchmark.md](docs/benchmark.md).

## Install

Requirements:

- Node.js 22 or newer.
- Git.
- A local MCP client for agent use.

Clone the repository:

```text
git clone https://github.com/jhunter11/multi-agent-memory-MCP.git
cd multi-agent-memory-MCP
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

macOS or Linux:

```sh
chmod +x scripts/setup.sh
./scripts/setup.sh
```

The default setup verifies the package and changes no client configuration.

## Configure a coding agent

The renderer uses three absolute paths:

1. The current Node executable.
2. The built MCP server.
3. The SQLite database.

Print a client configuration on Windows:

```powershell
scripts/setup.ps1 -Client claude-code -SkipInstall
scripts/setup.ps1 -Client codex -SkipInstall
scripts/setup.ps1 -Client opencode -SkipInstall
```

Print a client configuration on macOS or Linux:

```sh
./scripts/setup.sh --client claude-code --skip-install
./scripts/setup.sh --client codex --skip-install
./scripts/setup.sh --client opencode --skip-install
```

Add `-Configure` or `--configure` to write a configuration. The script backs up an existing file. It preserves unrelated settings. It refuses a duplicate server unless you also pass the replacement option.

Checked examples:

- [Claude Code `.mcp.json`](examples/clients/claude-code/.mcp.json)
- [Codex `config.toml`](examples/clients/codex/config.toml)
- [OpenCode `opencode.json`](examples/clients/opencode/opencode.json)

See [docs/clients.md](docs/clients.md) for exact CLI commands and paths.

## Use Ollama, Llama, LM Studio, or vLLM

The MCP server does not call a model. Your coding agent or MCP host calls the model and the memory tools.

Full OpenCode examples:

- [Ollama and Llama](examples/local-models/opencode/ollama.json)
- [LM Studio](examples/local-models/opencode/lm-studio.json)
- [vLLM](examples/local-models/opencode/vllm.json)
- [Generic OpenAI-compatible API](examples/local-models/opencode/openai-compatible.json)

The selected model must support structured tool calls. A compatible HTTP endpoint alone does not give a model tool-use skills.

See [docs/local-models.md](docs/local-models.md).

## How retrieval works

The tested default combines lexical retrieval and a bounded graph walk:

```text
query
  -> SQLite FTS5 lexical seeds
  -> trust and scope ranking
  -> typed graph expansion, maximum two hops
  -> 0.3 score decay per hop
  -> deduplication and byte budget
```

Direct hits remain available. Linked records can add context when they do not repeat the query terms. Cycles terminate, and the engine keeps one best path per record.

Scopes are organization and ranking labels. They are not access-control boundaries. Use this release in a trusted, single-user local environment.

## MCP tools

| Tool               | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `memory_write`     | Store a fact, decision, observation, or procedure. |
| `memory_search`    | Run lexical search with filters.                   |
| `memory_recall`    | Build bounded task context with graph expansion.   |
| `memory_relate`    | Add a typed edge between records.                  |
| `memory_neighbors` | Inspect linked records and edge direction.         |
| `memory_feedback`  | Adjust trust without deleting history.             |
| `memory_reflect`   | Store a supplied synthesis and link its sources.   |
| `memory_export`    | Write a confined JSONL snapshot.                   |
| `memory_stats`     | Show record, edge, feedback, and scope counts.     |

Every tool returns short text and structured content. The stdio server supports the MCP 2026-07-28 and 2025-11-25 protocol eras.

## TypeScript API

The storage and retrieval core does not depend on MCP:

```ts
import { createStore } from 'multi-agent-memory-mcp';

const store = createStore('/absolute/path/to/memory.sqlite');
const entry = store.write({
  kind: 'decision',
  scope: 'team/engineering',
  title: 'Keep snapshots outside Git',
  body: 'Export plaintext JSONL to a private data directory.',
  source: 'architecture review'
});

const result = store.recall({
  task: 'prepare the next architecture review',
  entryScope: 'team/engineering',
  maxHops: 2,
  graphDecay: 0.3
});

store.close();
```

## Data safety

The live SQLite file stays on one local filesystem. Do not put it in Dropbox, Google Drive, OneDrive, iCloud, or a network share.

Use JSONL export and import to move data. Exports contain plaintext memory. Store them outside source control and protect them like the source material.

The repository ignores SQLite, database, JSONL, snapshot, backup, and generated client files by default.

See [docs/privacy.md](docs/privacy.md) and [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

```text
npm ci
npm run typecheck
npm test
npm run build
npm run probe
npm run benchmark
npm run verify
```

GitHub Actions runs the release gate on Windows, macOS, and Ubuntu.

## License

MIT. See [LICENSE](LICENSE).
