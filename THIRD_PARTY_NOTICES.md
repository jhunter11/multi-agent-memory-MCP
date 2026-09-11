# Third-party notices

This project uses open-source packages under the licenses listed below. Optional embedding dependencies include LGPL components.

| Package                        | Version | License                                  | Use                                                  |
| ------------------------------ | ------- | ---------------------------------------- | ---------------------------------------------------- |
| `@modelcontextprotocol/server` | 2.0.0   | MIT                                      | MCP server and stdio transport                       |
| `better-sqlite3`               | 12.11.1 | MIT                                      | SQLite storage                                       |
| `smol-toml`                    | 1.8.0   | MIT                                      | Codex configuration serialization                    |
| `zod`                          | 4.5.2   | MIT                                      | Runtime schemas                                      |
| `@xenova/transformers`         | 2.17.2  | Apache-2.0                               | Optional local text embeddings                       |
| `flatbuffers`                  | 1.12.0  | Apache-2.0                               | Optional ONNX serialization dependency               |
| `protobufjs`                   | 7.6.6   | BSD-3-Clause                             | Optional ONNX dependency, pinned override            |
| `sharp`                        | 0.35.4  | Apache-2.0                               | Optional Transformers.js dependency, pinned override |
| `@img/sharp-libvips-*`         | 1.3.3   | LGPL-3.0-or-later                        | Platform libraries for Sharp                         |
| `@img/sharp-win32-*`           | 0.35.4  | Apache-2.0 AND LGPL-3.0-or-later         | Windows Sharp binaries and libraries                 |
| `@img/sharp-wasm32`            | 0.35.4  | Apache-2.0 AND LGPL-3.0-or-later AND MIT | WebAssembly Sharp binary and libraries               |

Sharp copyright: Lovell Fuller and others, 2013 onward. Its platform packages include libvips and other libraries with their own notices.
See the installed platform package README and the [Sharp source and license](https://github.com/lovell/sharp/tree/v0.35.4).
The [Sharp libvips build sources](https://github.com/lovell/sharp-libvips/tree/v1.3.3) identify the bundled libraries and source archives.
This project's package does not bundle dependency binaries. The dependency installer selects the platform packages from the lockfile.

The optional setup downloads `Xenova/all-MiniLM-L6-v2` model files. The [model repository](https://huggingface.co/Xenova/all-MiniLM-L6-v2) declares the Apache-2.0 license. The package does not contain model weights.

Development checks also use the MCP client SDK, Codex CLI, OpenCode CLI, TypeScript, tsx, Prettier, and type packages. See `package-lock.json` for exact versions.

Claude Code is external compatibility tooling under its own terms. This package does not lock, bundle, or distribute Claude Code.
