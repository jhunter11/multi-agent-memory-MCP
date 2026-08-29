# Local models

OpenCode can combine this MCP server with a local OpenAI-compatible model endpoint.

The memory server remains model-neutral. It stores data and serves tools. OpenCode handles the model loop.

## Ollama

The example uses `http://127.0.0.1:11434/v1` and the model reference `ollama/llama3.2`.

Install the model before use. Choose a model that supports structured tool calls.

## LM Studio

The example uses `http://127.0.0.1:1234/v1`.

Replace `__LM_STUDIO_MODEL_ID__` with an ID from `GET /v1/models`. LM Studio disables authentication by default.

If you enable tokens, use an environment reference. Do not put a key in the JSON file.

## vLLM

The example uses `http://127.0.0.1:8000/v1`.

The model ID must match the served model. Automatic tool choice also needs the correct vLLM parser and chat template for that model.

## Generic OpenAI-compatible endpoint

Replace `__MODEL_ID__` and `baseURL` in the generic example.

The examples use `@ai-sdk/openai-compatible` for Chat Completions. Use an endpoint that supports streaming and structured tool calls.

## Network location

`127.0.0.1` works only when OpenCode and the model server share a network namespace.

Use a reachable address for WSL, containers, remote development, or another machine. Protect any non-local endpoint with network controls and authentication.

## Required capability

An OpenAI-compatible API does not guarantee tool use. The selected model must read tool definitions, emit structured calls, and accept tool results.
