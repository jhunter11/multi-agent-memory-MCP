# Meta memory in 0.2

The `memory_recall` tool now returns an `agent-evidence/v2` JSON packet. The server combines several retrieval methods before it packs source records.

## Candidate methods

| Strategy      | Methods                                                        | Use                                  |
| ------------- | -------------------------------------------------------------- | ------------------------------------ |
| `meta`        | FTS5, optional vectors, scope concepts, hashed features, graph | Default for broad task recall        |
| `fusion`      | FTS5 and optional vectors with reciprocal rank fusion, graph   | Compare a simpler combination        |
| `concept`     | Fusion plus scope concepts and hashed features, graph          | Explore high-level topic connections |
| `lexical`     | FTS5 and graph                                                 | Exact language and a useful baseline |
| `information` | Meta candidates with query novelty and size preference         | Experimental packing comparison      |
| `legacy`      | Original synchronous recall                                    | Compatibility and regression checks  |

`auto` selects the database setting, or `meta` when no setting exists. An explicit tool strategy overrides the database setting.

Scope paths and Markdown headings supply the concept vocabulary. Optional record vectors supply concept centroids. The hashed representation uses 4,096 dimensions and IDF weights. It is a token feature index, not a trained embedding model.

Meta combines three ranked lists: fusion, concept retrieval, and lexical concept retrieval. Their weights are 1.0, 0.65, and 0.35. Each fusion stream contributes at most 80 candidates. The final list has at most 200 candidates.

A single term with digits and at most eight lexical matches takes the exact-identifier route. This route uses lexical seeds and graph expansion. It prevents broad concepts from displacing a narrow identifier match.

This release has no trained XGBoost ranker. The information strategy uses query-term novelty and record size. It does not measure answer entropy or prove an information gain.

## Trust and graph paths

Each candidate stream uses the multiplier `0.25 + 0.75 * trust`. Trust ranges from zero to one. The nonzero floor keeps disputed evidence reachable. Scope proximity adds a small ranking preference and never excludes distant records.

Feedback changes the stored rating. The packet labels this rating as uncalibrated. A source name, high rating, or recent timestamp does not prove a statement.

Graph traversal starts with eight seeds and keeps at most twelve frontier records per step. It visits at most two hops. Ordinary links use a 0.3 decay plus a degree penalty. Contradiction and replacement links use a 0.9 decay to keep conflicts visible. A zero graph decay disables all expansion.

The least trusted record in a path limits the path weight. Cycles cannot repeat a record in one path. Superseded entries stay hidden unless `includeSuperseded` is true.

## Evidence and handoff

Each hit contains the full stored entry, source, timestamps, body hash, score, path, and reason. No record body is cut to fit. If a record is too large, the packer skips it and tries another record.

Hits include conflict links and links that explain their graph path. `otherEdgeCount` reports other adjacent links. Use `memory_neighbors` to inspect those links. An edge can reference a record whose body did not fit. That reference is not retrieved support.

The envelope sets these fields:

- `authority: retrieved-data-only`
- `answerStatus: unverified`
- `actionsAuthorized: false`
- `trustPolicy: uncalibrated-rating`
- `missingSupport: unknown`

These fields guide the receiving agent. They do not replace tool permissions or an application authorization check. The receiving agent must treat source text as data, preserve uncertainty, and verify support before answering or acting.

`usedBytes` counts the UTF-8 JSON packet, including metadata. MCP returns that packet as text and structured content for client compatibility. Transport framing and the duplicate representation add bytes outside this budget. Budgets below the envelope size return an error. Use at least 512 bytes.

An empty packet does not prove that an answer is absent from memory. A full packet does not prove that all required evidence is present.

## Optional local vectors

Setup can download the quantized `Xenova/all-MiniLM-L6-v2` model. Runtime recall disables remote model access. All record and query inference stays on the local machine.

The model produces 384-dimensional vectors from the title and body. It can truncate long input. Full-text search still indexes the body. The final evidence packet always uses the stored body.

The cache records content hashes and a model hash. The model hash covers the tokenizer, configuration, weights, and representation version. Changed records receive new vectors. Changed model files invalidate the cache after a server restart. Cache writes use a temporary file and an atomic rename.

The SQLite file remains the source of truth. The server reads entries, edges, and lexical matches from one transaction snapshot. External writes invalidate its derived concept index on the next recall.

The model and vector cache stay next to private application data. Do not commit them. A missing model or inference error causes an explicit lexical and concept fallback. Inspect `vectorStatus` and server stderr. Restart clients after setup or model changes.

## Evaluation limits

Run `npm run benchmark:meta` for all new strategies on the public synthetic fixture. Vectors are disabled in that test. It measures retrieval ranks, negative abstention, decoy contamination, and serialized packet budgets.

Keep real-memory questions, answer passages, snapshots, and per-question results outside this repository. Freeze source hashes before testing. Score whether each required passage appears in the packet. Use a separate holdout set before tuning a learned ranker.

No result in this release establishes universal superiority, calibrated trust, or end-to-end answer accuracy.
