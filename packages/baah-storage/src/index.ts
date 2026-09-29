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
  decodeToolOutput,
  DEFAULT_SEARCH_LIMIT,
  encodeToolOutput,
  MAX_SEARCH_LIMIT,
  requireSessionStatus,
  RESULT_PREVIEW_CHARS,
  streamingPart,
  toPartInput,
  toolOutputPreview,
  type StorageEngine,
  type StorageOperations,
  type StatementOutcome,
  type WirePartInput,
} from "./operations.ts";

export {
  closeRequestSchema,
  flushDeltaRequestSchema,
  openRequestSchema,
  partRowSchema,
  messageRowSchema,
  queryRequestSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  runRequestSchema,
  searchHitSchema,
  searchRequestSchema,
  sessionRowSchema,
  storageErrorPayloadSchema,
  toolCallRowSchema,
  toolInvocationRowSchema,
  turnRowSchema,
  txRequestSchema,
  unfinishedTurnRowSchema,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.ts";

export {
  APPROVALS_INVOCATION_PARK_TABLE,
  INDEX_NAMES,
  PRAGMAS,
  SCHEMA_MIGRATIONS_TABLE,
  SCHEMA_STATEMENTS,
  STEP_CORE_TABLES,
  STEP_FULL_TEXT_INDEX,
  STEP_INDEXES,
  STEP_TOOL_CALL_IDENTITY,
  TABLE_NAMES,
  TOOL_INVOCATIONS_TABLE,
} from "./schema.ts";

export {
  ABORT_TURN_PARTS,
  INSERT_TOOL_INVOCATION_BEGUN,
  INSERT_TURN,
  INSERT_TURN_OUTCOME_MESSAGE,
  SELECT_TOOL_CALL,
  SELECT_UNFINISHED_TURNS,
  TOOL_CALL_KEY_PREDICATE,
  toolCallKeyParams,
  turnOutcomeMessageParams,
  turnOutcomeParams,
  turnParams,
  UPDATE_PART_STATUS,
  UPDATE_TURN_HEARTBEAT,
  UPDATE_TURN_OUTCOME,
  UPSERT_TOOL_INVOCATION_DONE,
} from "./sql.ts";

export { createTurnStore, type TurnStoreOptions } from "./turn-store.ts";

export type * from "./types.ts";
