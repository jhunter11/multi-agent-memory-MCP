/**
 * The portability layer: the seam that lets one memory live on two machines.
 *
 * The database stays on the machine that owns it. A live SQLite file syncs
 * badly and corrupts quietly, so the artifact that travels is the JSONL
 * snapshot this module writes and reads. Everything here talks to the store
 * only through the `MemoryStore` interface in `src/contracts.ts`.
 *
 * The CLI in `./cli.js` is a separate entry point, kept out of this barrel so
 * that importing the library does not pull in argument parsing.
 */

export { exportLines, exportToFile, exportToJsonl } from './export.js';
export type { ExportOptions, ExportSummary } from './export.js';

export { importFromFile, importFromJsonl, SchemaVersionMismatchError } from './import.js';
