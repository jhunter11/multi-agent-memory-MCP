# Contributing

## Before a change

1. Open an issue for a contract or schema change.
2. Add a focused failing test.
3. Make the smallest change that passes the test.
4. Run `npm run verify`.

## Data rules

Use synthetic fixtures only. Do not commit a SQLite file, JSONL snapshot, credential, hostname, personal path, or private record.

## Commit rules

Use a clear commit subject. Do not add generated attribution trailers.

## Pull requests

Describe the behavior change and the commands that you ran. Include benchmark changes when retrieval behavior changes.
