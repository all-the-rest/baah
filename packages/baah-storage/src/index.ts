/**
 * `@all-the.rest/baah-storage` — persistence for the agent loop.
 *
 * The agent loop must survive a reload (`AGENTS.md` §1), so sessions, messages
 * and parts live in SQLite. `Plan.md` §6 fixes the choices:
 *
 * - Engine: `@sqlite.org/sqlite-wasm`, **in one dedicated Web Worker**
 * - VFS: `opfs-sahpool` — no `SharedArrayBuffer`, so no COOP/COEP headers,
 *   which a static SPA cannot set
 * - Access: typed `postMessage` RPC, exposed to `drizzle-orm` through
 *   `drizzle-orm/sqlite-proxy`
 *
 * Two entry points:
 * - `openDatabase()` — the real thing. Browser only.
 * - `createMemoryDatabase()` — same surface, plain `Map`s. Node/vitest, no OPFS.
 */

export {
  createMemoryDatabase,
  type MemoryDatabase,
} from "./factory.ts";

export {
  closeDatabase,
  createDrizzleCallback,
  normaliseDrizzleParam,
  normaliseDrizzleParams,
  openDatabase,
  WorkerStorageDatabase,
  type OpenDatabaseOptions,
  type WorkerLike,
} from "./client.ts";

export {
  isOwnershipFailure,
  ownershipError,
  StorageError,
  toStorageError,
  type StorageErrorCode,
  type StorageErrorPayload,
} from "./errors.ts";

export {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
  type AppliedMigration,
  type Migration,
  type MigrationHost,
  type MigrationResult,
} from "./migrations.ts";

export {
  clampSearchLimit,
  createStorageOperations,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  requireSessionStatus,
  streamingPart,
  toPartInput,
  type StorageEngine,
  type StorageOperations,
  type StatementOutcome,
  type WirePartInput,
} from "./operations.ts";

export {
  flushDeltaRequestSchema,
  openRequestSchema,
  queryRequestSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  runRequestSchema,
  searchRequestSchema,
  txRequestSchema,
  closeRequestSchema,
  storageErrorPayloadSchema,
  partRowSchema,
  messageRowSchema,
  sessionRowSchema,
  searchHitSchema,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.ts";

export {
  INDEX_NAMES,
  PRAGMAS,
  SCHEMA_MIGRATIONS_TABLE,
  SCHEMA_STATEMENTS,
  STEP_CORE_TABLES,
  STEP_FULL_TEXT_INDEX,
  STEP_INDEXES,
  TABLE_NAMES,
} from "./schema.ts";

export type * from "./types.ts";
