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

/**
 * `tool_invocations.status` (`Plan.md` §6.1 as refined).
 *
 * Exactly two values, and the pair is the whole point. The column used to hold
 * a six-value lifecycle vocabulary that neither of the two writers could use
 * honestly: `beginToolCall` runs *before* the tool and `recordToolCall`
 * *after*, so "began, outcome unknown" had no representation — and in a crash
 * window between the two, the only answer a store could give was "never ran",
 * which re-runs the tool. For a `write` tool that is not a retry but a second
 * append to the user's file (measured: `log === ["x", "x"]` against a
 * transcript showing one write).
 *
 * `done` is the only state that short-circuits a replay.
 */
export type ToolInvocationStatus = "begun" | "done";

/**
 * The four-part identity a recorded tool call is keyed by
 * (`Plan.md` §6.1, `agent/tools.ts#ToolCallKey`).
 *
 * Structurally identical to the engine's own type on purpose: `AGENTS.md` §4
 * forbids a pointer from core to storage, so the two cannot share a
 * declaration, and a *structural* match is what lets `StorageDatabase` be
 * handed to the engine as its `TurnStore` without an adapter that could drift.
 * Every component closes a measured failure:
 *
 * | part | failure without it |
 * |---|---|
 * | `sessionId` | two sessions that mint the same id share one record |
 * | `attempt` | a retry is a new turn; the old record silences a legitimate call |
 * | `toolCallId` | — the provider's own id, the only half that identifies anything |
 * | `occurrence` | a provider that reuses an id twice loses the second call, silently |
 */
export interface ToolCallKey {
  sessionId: string;
  /** 1-based attempt number, so a retry's records stay its own. */
  attempt: number;
  toolCallId: string;
  /** 0-based: how many calls with this id have already begun in this attempt. */
  occurrence: number;
}

/**
 * What is known about a recorded call — and the status is the type.
 *
 * A union rather than a field, so reading `output` off a `begun` record is a
 * compile error instead of a runtime `undefined` that a caller forwards to the
 * model as if it were the tool's answer.
 */
export type ToolCallRecord = { status: "begun" } | { status: "done"; output: unknown };

/** A turn a reload may have left open (`Plan.md` §6.1). */
export interface UnfinishedTurn {
  turnId: string;
  /**
   * The `heartbeat_at` the writer last renewed, ISO-8601 (`AGENTS.md` §5).
   * Falls back to `started_at` when the turn never got a heartbeat — a turn
   * that has not been touched is not *more* alive than one that has, and
   * `heartbeatAgeMs` reads an unparsable value as maximally stale, which is
   * the recoverable direction.
   */
  heartbeatAt: string;
  startedAt: string;
}

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
  /** Part of {@link ToolCallKey}, and part of the table's `UNIQUE`. */
  toolCallId: string;
  attempt: number;
  occurrence: number;
  args: string | null;
  /** `begun` = may have run. `done` = ran, and `output` is its answer. */
  status: ToolInvocationStatus;
  /** JSON text of the exact output, or NULL when there was none. */
  output: string | null;
  /** Display copy; may be shortened. Never replayed. */
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
 * A turn row.
 *
 * `status` is part of the input rather than being derived, so a turn can be
 * written as already finished — which is what `listUnfinishedTurns` has to be
 * able to exclude, and what a restart replay of a completed turn needs.
 */
export interface TurnInput {
  id: string;
  sessionId: string;
  startedAt: string;
  /** Assigned as `MAX(seq) + 1` within the session when omitted (`Plan.md` §6.2). */
  seq?: number;
  status?: TurnStatus;
  leaseOwner?: string | null;
  /** ISO-8601. `null` means "never renewed". */
  heartbeatAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
}

/**
 * "This call is about to run."
 *
 * Written **before** the tool executes. Afterwards would only record "ran
 * successfully", which leaves a crash in between indistinguishable from
 * "never ran" — and a tool that re-runs in that window writes twice, asks
 * twice, or overwrites a newer `todo` list with a stale one while reporting a
 * change that never happened.
 */
export interface BeginToolCallInput {
  key: ToolCallKey;
  toolName: string;
  input: unknown;
}

/** "This call ran, and here is what it returned." */
export interface RecordToolCallInput {
  key: ToolCallKey;
  toolName: string;
  output: unknown;
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

  /* ---------------------------------------------------------------- */
  /* The turn anchor and the replay key                              */
  /* ---------------------------------------------------------------- */

  /**
   * The write half of the reload anchor.
   *
   * `listUnfinishedTurns` is the read; without a way to write a turn there is
   * nothing to read, and no way to test the threshold the engine applies.
   * `seq` is allocated per session like every other table (§6.2), because the
   * turn order is `seq` and never `started_at`.
   */
  appendTurn(input: TurnInput): Promise<Turn>;
  /**
   * Every turn of a session that is neither `succeeded` nor `failed`
   * (Plan.md §6.1 — the reload/interrupt anchor).
   *
   * Ordered by `seq`. A caller measures `heartbeatAt` against its own clock
   * and decides what to do; this never closes a turn by itself, because a
   * fresh heartbeat means somebody *else* is still working on it.
   */
  listUnfinishedTurns(input: { sessionId: string }): Promise<UnfinishedTurn[]>;

  /**
   * Record "may have run", keyed on the full {@link ToolCallKey}.
   *
   * Idempotent: a second `begin` for a key that already exists leaves the row
   * alone, and in particular never downgrades a `done` record to `begun`.
   */
  beginToolCall(input: BeginToolCallInput): Promise<void>;
  /**
   * Record "ran, and here is the output" under the same key.
   *
   * Upserts: a call whose `begin` never landed is still recorded, because the
   * only claim being made is one the engine can back up — the tool returned
   * this.
   */
  recordToolCall(input: RecordToolCallInput): Promise<void>;
  /**
   * The record of a call, or `undefined` if it was never begun.
   *
   * **The status is the point.** Absent it, a row written by `beginToolCall`
   * and a row written by `recordToolCall` both read back as "no record", and
   * "began, outcome unknown" is *unrepresentable* — which is precisely the
   * case in which re-running corrupts the user's files. `status: "done"` is
   * the only state that short-circuits.
   */
  getToolCall(key: ToolCallKey): Promise<ToolCallRecord | undefined>;

  close(): Promise<void>;
}
