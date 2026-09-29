/**
 * Shared types for the persistence layer.
 *
 * Two families live here:
 *
 * 1. The SQL wire primitives (what crosses the `postMessage` boundary) — kept
 *    free of any engine types so they can be used from the worker, the main
 *    thread and plain Node tests alike.
 * 2. The domain rows of `Plan.md` §6.1, in camelCase. The SQL columns are
 *    snake_case; the queries alias them.
 *
 * `seq` is the sort key per parent, not `created_at` (`Plan.md` §6.2): two
 * messages can be created in the same millisecond.
 */

/** A value SQLite can hand back. Mirrors `SqlValue` of `@sqlite.org/sqlite-wasm`. */
export type SqlValue = string | number | null | bigint | Uint8Array | Int8Array | ArrayBuffer;

/**
 * A bind parameter on the wire.
 *
 * `boolean` is not a SQLite storage class; the worker normalises it to `0`/`1`
 * before binding. `Uint8Array` is passed through as a blob.
 */
export type SqlParam = string | number | boolean | null | Uint8Array;

/** The four execution modes `drizzle-orm/sqlite-proxy` uses. */
export type SqlMethod = "run" | "all" | "values" | "get";

/** What the worker reports back from a successful `open`. */
export interface OpenResult {
  filename: string;
  /** The VFS actually in use, which may differ from the requested name. */
  vfsName: string;
  sqliteVersion: string;
  /** The `schema_migrations` version after migrating. */
  schemaVersion: number;
}

export interface CloseResult {
  closed: boolean;
}

export interface SqlStatement {
  sql: string;
  params?: readonly SqlParam[];
}

/** Result of a single statement. `rows` holds objects, or arrays for `values`. */
export interface QueryResult {
  rows: unknown[];
  /** `sqlite3_changes()` after the statement. */
  changes: number;
}

export interface RunResult {
  changes: number;
}

export interface TxResult {
  /** Sum of the `changes` of every statement in the batch. */
  changes: number;
  /** Per-statement results, in execution order. */
  results: unknown[];
}

/* ------------------------------------------------------------------ */
/* Domain vocabulary                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parts are exactly three variants — `Plan.md` §14.3, item 1. File diffs live
 * in `data.metadata.files` of a `tool` part, they are not a fourth type.
 */
export type PartType = "text" | "reasoning" | "tool";

/** `Plan.md` §14.3, item 4. The turn outcome is an `idle` message. */
export type MessageRole =
  | "user"
  | "assistant"
  | "synthetic"
  | "system"
  | "skill"
  | "shell"
  | "compaction"
  | "idle"
  | "agent-switched"
  | "model-switched"
  | "location-switched";

export type SessionStatus = "active" | "archived";

/** The reload/interrupt anchor: `streaming` + stale `heartbeat_at` ⇒ interrupted. */
export type TurnStatus = "pending" | "streaming" | "succeeded" | "failed" | "interrupted";

/** `Plan.md` §6.2: the outcome of a turn is carried by an `idle` message. */
export type TurnOutcome = "succeeded" | "failed" | "interrupted";

/** Lifecycle of a message or a part while it is being produced. */
export type StreamStatus =
  | "pending"
  | "running"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted";

export type ToolInvocationStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

/** `Plan.md` §7.5 — deliberately only three values. */
export type ApprovalDecision = "once" | "always" | "reject";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** `opfs` = private sandbox, `directory` = File System Access project folder. */
export type WorkspaceKind = "opfs" | "directory";

export type FileHandleKind = "file" | "directory";

/** Mirrors `FileSystemPermissionState` without depending on its DOM type. */
export type HandlePermission = "unknown" | "prompt" | "granted" | "denied";

/* ------------------------------------------------------------------ */
/* Rows                                                                 */
/* ------------------------------------------------------------------ */

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  model: string | null;
  systemPrompt: string | null;
  /** JSON text, or `null`. Not parsed here: only the owning layer knows the shape. */
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Turn {
  id: string;
  sessionId: string;
  seq: number;
  status: TurnStatus;
  leaseOwner: string | null;
  heartbeatAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  turnId: string | null;
  parentId: string | null;
  seq: number;
  role: MessageRole;
  status: StreamStatus | null;
  model: string | null;
  outcome: TurnOutcome | null;
  error: string | null;
  usage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Part {
  id: string;
  messageId: string;
  sessionId: string;
  seq: number;
  type: PartType;
  /** JSON text for the type-specific payload (e.g. `metadata.files` for `tool`). */
  data: string | null;
  /** Denormalised, searchable projection of the part text. */
  contentText: string;
  status: StreamStatus | null;
  createdAt: string;
  updatedAt: string;
}

/** Append-only log entry behind `flushDelta`; the idempotency anchor. */
export interface PartDelta {
  id: string;
  partId: string;
  sessionId: string;
  seq: number;
  /** Cumulative text of the part at the moment this delta was flushed. */
  contentText: string;
  createdAt: string;
}

export interface ToolInvocation {
  id: string;
  sessionId: string;
  messageId: string | null;
  callPartId: string | null;
  resultPartId: string | null;
  toolName: string;
  args: string | null;
  status: ToolInvocationStatus;
  resultPreview: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  toolInvocationId: string | null;
  request: string;
  decision: ApprovalDecision | null;
  /** The pattern a `always` decision writes as a durable allow rule. */
  scope: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface Todo {
  id: string;
  sessionId: string;
  seq: number;
  content: string;
  status: TodoStatus;
  priority: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /** Reference into the sidecar IndexedDB — the handle itself is not storable in SQLite. */
  rootHandleId: string | null;
  metadata: string | null;
  createdAt: string;
  lastOpenedAt: string | null;
}

export interface FileHandleRow {
  id: string;
  workspaceId: string;
  kind: FileHandleKind;
  name: string;
  relativePath: string;
  handleId: string | null;
  permission: HandlePermission;
  lastCheckedAt: string | null;
}

export interface Setting {
  key: string;
  value: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

export interface SessionInput {
  id: string;
  title?: string;
  /**
   * `Plan.md` §6.1 allows exactly `active` and `archived`; anything else is
   * rejected as a `sql_error` (the CHECK violation SQLite would raise) rather
   * than coerced.
   */
  status?: SessionStatus;
  model?: string | null;
  systemPrompt?: string | null;
  metadata?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /**
   * ISO-8601, optional. Only read when `status` is `archived`: §6.1's CHECK
   * makes an archived session carry the timestamp, and leaves `archived_at`
   * NULL for every other status. Omitted on an archived session, the write
   * path fills it with the insert timestamp.
   */
  archivedAt?: string;
}

export interface MessageInput {
  id: string;
  sessionId: string;
  role: MessageRole;
  createdAt: string;
  updatedAt: string;
  /** Assigned as `MAX(seq) + 1` within the session when omitted. */
  seq?: number;
  turnId?: string | null;
  parentId?: string | null;
  status?: StreamStatus | null;
  model?: string | null;
  outcome?: TurnOutcome | null;
  error?: string | null;
  usage?: string | null;
}

export interface PartInput {
  id: string;
  messageId: string;
  sessionId: string;
  type: PartType;
  contentText: string;
  updatedAt: string;
  /** Assigned as `MAX(seq) + 1` within the message when omitted. */
  seq?: number;
  data?: string | null;
  status?: StreamStatus | null;
  createdAt?: string;
}

/**
 * One buffered streaming flush (`Plan.md` §6.2): a short transaction that
 * upserts the part and appends to the delta log.
 */
export interface FlushDeltaInput {
  /**
   * Idempotency key. The caller generates it **once** per delta and reuses it
   * for every retry, so replaying the message cannot duplicate the log entry.
   */
  deltaId: string;
  part: PartInput;
  /** ISO-8601. */
  flushedAt: string;
}

export interface FlushDeltaResult {
  partId: string;
  deltaId: string;
  /** `false` when the delta id was already known — the retry case. */
  applied: boolean;
  /** `seq` of the delta inside the part's delta log. */
  deltaSeq: number;
}

export interface SearchInput {
  /** FTS5 `MATCH` expression. */
  query: string;
  sessionId?: string;
  limit?: number;
}

export interface SearchHit {
  partId: string;
  messageId: string;
  sessionId: string;
  seq: number;
  type: PartType;
  createdAt: string;
  /** `bm25()` — lower (more negative) is a better match. */
  score: number;
  excerpt: string;
}

/* ------------------------------------------------------------------ */
/* Public database surface                                              */
/* ------------------------------------------------------------------ */

export type StorageBackend = "worker" | "memory";

/**
 * The single persistence surface of the harness.
 *
 * Two implementations share it: `openDatabase()` (SQLite-WASM in a dedicated
 * worker, `opfs-sahpool` VFS) and `createMemoryDatabase()` (plain `Map`s, for
 * Node/vitest without OPFS). The typed helpers are the portable core; the raw
 * SQL escape hatches only exist on the worker-backed one.
 */
export interface StorageDatabase {
  readonly kind: StorageBackend;
  readonly filename: string;

  /** Run a single statement. `method` mirrors `drizzle-orm/sqlite-proxy`. */
  query(sql: string, params?: readonly SqlParam[], method?: SqlMethod): Promise<QueryResult>;
  /** Run a single statement, discarding any rows. */
  run(sql: string, params?: readonly SqlParam[]): Promise<RunResult>;
  /** One `BEGIN IMMEDIATE … COMMIT` batch. All-or-nothing. */
  transaction(statements: readonly SqlStatement[]): Promise<TxResult>;
  /** Full-text search over `parts.content_text` (FTS5). */
  search(input: SearchInput): Promise<SearchHit[]>;

  createSession(input: SessionInput): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  /** Cascades to turns, messages, parts, deltas, invocations, approvals, todos. */
  deleteSession(id: string): Promise<void>;

  appendMessage(input: MessageInput): Promise<Message>;
  getMessage(id: string): Promise<Message | null>;
  listMessages(sessionId: string): Promise<Message[]>;

  appendPart(input: PartInput): Promise<Part>;
  /** Insert-or-update by `id`; retrying the same payload changes nothing. */
  upsertPart(input: PartInput): Promise<Part>;
  listParts(messageId: string): Promise<Part[]>;

  flushDelta(input: FlushDeltaInput): Promise<FlushDeltaResult>;

  close(): Promise<void>;
}
