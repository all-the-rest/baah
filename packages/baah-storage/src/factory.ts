/**
 * The in-memory database.
 *
 * Same public surface as the worker-backed one, backed by plain `Map`s. This is
 * what makes `@all-the.rest/baah-storage` testable in Node/vitest without
 * OPFS, a Worker or a WASM engine — the same reason `baah-core` has
 * `createMemoryWorkspace()`.
 *
 * It reuses `createStorageOperations()` verbatim. The engine below recognises
 * the *same* SQL strings as `sql.ts`, so the `seq` allocation, the upsert
 * semantics, the flush idempotency and the cascade rules are exercised once,
 * not reimplemented.
 *
 * Not supported: the raw SQL escape hatches. There is no SQL engine here, so
 * `query`/`run`/`transaction` reject with a typed `unsupported` error rather
 * than pretending to work.
 */

import { StorageError } from "./errors.ts";
import {
  clampSearchLimit,
  createStorageOperations,
  type StorageEngine,
  type StatementOutcome,
} from "./operations.ts";
import {
  ABORT_TURN_PARTS,
  DELETE_SESSION,
  FLUSH_DELTA_LOG_SQL,
  INSERT_MESSAGE,
  INSERT_PART,
  INSERT_SESSION,
  INSERT_TOOL_INVOCATION_BEGUN,
  INSERT_TURN,
  INSERT_TURN_OUTCOME_MESSAGE,
  SELECT_MESSAGE,
  SELECT_MESSAGES,
  SELECT_PARTS,
  SELECT_SESSION,
  SELECT_SESSIONS,
  SELECT_DELTA_SEQ,
  SELECT_TOOL_CALL,
  SELECT_UNFINISHED_TURNS,
  UPDATE_PART_STATUS,
  UPDATE_TURN_HEARTBEAT,
  UPDATE_TURN_OUTCOME,
  UPSERT_PART,
  UPSERT_TOOL_INVOCATION_DONE,
  searchSql,
} from "./sql.ts";
import type {
  BeginToolCallInput,
  ClosePartInput,
  CloseTurnPartsInput,
  FinishTurnInput,
  Message,
  MessageRole,
  Part,
  PartType,
  RecordToolCallInput,
  RenewHeartbeatInput,
  SearchHit,
  Session,
  SessionStatus,
  SqlParam,
  StorageDatabase,
  StreamStatus,
  ToolCallKey,
  ToolCallRecord,
  ToolInvocation,
  ToolInvocationStatus,
  Turn,
  TurnInput,
  TurnOutcome,
  TurnOutcomeEntry,
  TurnStatus,
  UnfinishedTurn,
} from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

interface PartDeltaRow {
  id: string;
  partId: string;
  sessionId: string;
  seq: number;
  contentText: string;
  createdAt: string;
}

type Table = "sessions" | "turns" | "messages" | "parts" | "partDeltas" | "toolInvocations";

interface MemoryStore {
  sessions: Map<string, Session>;
  turns: Map<string, Turn>;
  messages: Map<string, Message>;
  parts: Map<string, Part>;
  partDeltas: Map<string, PartDeltaRow>;
  toolInvocations: Map<string, ToolInvocation>;
}

/** What one statement produced: rows plus the `sqlite3_changes()` value. */
interface ExecutionResult {
  rows: unknown[];
  changes: number;
}

/**
 * Collapse a SQL template to a single-spaced form.
 *
 * The statements in `sql.ts` are written for reading; this lets the in-memory
 * engine recognise them by identity without depending on the exact
 * indentation. Comparing a canonical form is what keeps the two backends
 * pinned to the same SQL.
 */
function canonical(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Collapse whitespace the way FTS5's `unicode61` tokeniser does, then require
 * every term. A plain substring search would not model a tokeniser-backed
 * index, and matching shapes is the point of this backend.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
}

/**
 * The `CHECK (col IN (...))` lists of `schema.ts`, exported as the single
 * source of truth. The SQL keeps its own copy in the DDL — this is the
 * in-memory mirror, and both are asserted against each other in the tests.
 */
export const MESSAGE_ROLES = [
  "user",
  "assistant",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
  "idle",
  "agent-switched",
  "model-switched",
  "location-switched",
] as const satisfies readonly MessageRole[];

export const PART_TYPES = ["text", "reasoning", "tool"] as const satisfies readonly PartType[];

export const STREAM_STATUSES = [
  "pending",
  "running",
  "streaming",
  "completed",
  "failed",
  "aborted",
] as const satisfies readonly StreamStatus[];

export const TURN_OUTCOMES = [
  "succeeded",
  "failed",
  "interrupted",
] as const satisfies readonly TurnOutcome[];

export const SESSION_STATUSES = ["active", "archived"] as const satisfies readonly SessionStatus[];

/**
 * The `CHECK` lists of `turns.status` and `tool_invocations.status`, exported
 * as the single source of truth for the in-memory mirror. The SQL keeps its own
 * copy in the DDL — this is the engine-side half, and both are asserted against
 * each other in the tests.
 */
export const TURN_STATUSES = [
  "pending",
  "streaming",
  "succeeded",
  "failed",
  "interrupted",
] as const satisfies readonly TurnStatus[];

export const TOOL_INVOCATION_STATUSES = ["begun", "done"] as const satisfies readonly ToolInvocationStatus[];

/** `NOT IN (…)` in `SELECT_UNFINISHED_TURNS` — the two states that are done. */
export const FINISHED_TURN_STATUSES = ["succeeded", "failed"] as const satisfies readonly TurnStatus[];

/** The four-part key, as a comparable string. Mirrors the table's `UNIQUE`. */
function toolCallKeyOf(row: { sessionId: string; attempt: number; toolCallId: string; occurrence: number }): string {
  return JSON.stringify([row.sessionId, row.attempt, row.toolCallId, row.occurrence]);
}

/**
 * Mirrors a `CHECK (col IN (...))` over a `NOT NULL` column. A value outside
 * the list is a `sql_error`, exactly the constraint violation SQLite raises.
 */
function requireOneOf<T extends string>(
  column: string,
  value: SqlParam | undefined,
  allowed: readonly T[],
): T {
  if (typeof value === "string") {
    const found = allowed.find((candidate) => candidate === value);
    if (found !== undefined) return found;
  }
  throw new StorageError(
    "sql_error",
    `CHECK constraint failed: ${column} = ${JSON.stringify(value ?? null)} ` +
      `is not in (${allowed.map((entry) => `'${entry}'`).join(", ")})`,
    { column },
  );
}

/** Mirrors `CHECK (col IS NULL OR col IN (...))`. */
function nullableOneOf<T extends string>(
  column: string,
  value: SqlParam | undefined,
  allowed: readonly T[],
): T | null {
  if (value === null || value === undefined) return null;
  return requireOneOf(column, value, allowed);
}

/** FTS5 `MATCH` subset: bare terms are ANDed, quoted phrases stay together. */
function matchTerms(query: string): string[][] {
  const terms: string[][] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null = pattern.exec(query);
  while (match !== null) {
    const phrase = match[1];
    const bare = match[2];
    if (phrase !== undefined && phrase.length > 0) {
      terms.push(tokenize(phrase));
    } else if (bare !== undefined) {
      for (const token of tokenize(bare)) terms.push([token]);
    }
    match = pattern.exec(query);
  }
  return terms;
}

export interface MemoryDatabase extends StorageDatabase {
  readonly kind: "memory";
  /** Row counts per table, so a test can assert a cascade without SQL. */
  counts(): Record<Table, number>;
  /** The delta log, in insertion order. */
  deltas(): readonly PartDeltaRow[];
  /**
   * Every statement the engine ran, single-spaced, in order.
   *
   * The memory backend has no connection to log, so before this a claim like
   * "this operation is *one* statement" could only be measured on the SQL side
   * — which left the in-memory half of the parity untested for exactly the
   * property that matters most when the two implementations differ in shape. A
   * read-modify-write inside `operations.ts` is invisible to a spy on the
   * *database*, too: the read happens on the engine, below it. This is that
   * lower seam, and it exists because `execute()` is the single place a
   * statement is recognised.
   *
   * Test-facing, like {@link MemoryDatabase.counts}: a real application holds one
   * database for its whole lifetime and must not accumulate a log of every
   * statement it ever ran.
   */
  statements(): readonly string[];
}

export function createMemoryDatabase(filename = "memory://baah"): MemoryDatabase {
  const store: MemoryStore = {
    sessions: new Map(),
    turns: new Map(),
    messages: new Map(),
    parts: new Map(),
    partDeltas: new Map(),
    toolInvocations: new Map(),
  };
  /** Every statement `execute()` was asked to run — see {@link MemoryDatabase.statements}. */
  const log: string[] = [];

  /** `COALESCE(?, MAX(seq) + 1)` over the rows of one parent. */
  const nextSeq = (rows: Iterable<{ seq: number }>, explicit: number | null): number => {
    if (explicit !== null) return explicit;
    let highest = -1;
    for (const row of rows) highest = Math.max(highest, row.seq);
    return highest + 1;
  };

  const requireSession = (id: string): void => {
    if (!store.sessions.has(id)) {
      throw new StorageError("sql_error", `FOREIGN KEY constraint failed: sessions.id = ${id}`);
    }
  };

  const requireMessage = (id: string): void => {
    if (!store.messages.has(id)) {
      throw new StorageError("sql_error", `FOREIGN KEY constraint failed: messages.id = ${id}`);
    }
  };

  /**
   * Mirrors `messages.turn_id`'s foreign key.
   *
   * Added because the memory backend accepted a message pointing at a turn that
   * does not exist, while SQLite — with `PRAGMA foreign_keys=ON` — refuses it.
   * A row the two backends disagree about is exactly what `Plan.md` §16.1 lists
   * as the thing that must not happen, and `finishTurn`'s outcome message leans
   * on this constraint being real.
   */
  const requireTurn = (id: string): void => {
    if (!store.turns.has(id)) {
      throw new StorageError("sql_error", `FOREIGN KEY constraint failed: turns.id = ${id}`);
    }
  };

  /** Mirrors `ON DELETE CASCADE` from the schema, for the tables it holds. */
  const cascadeDelete = (sessionId: string): void => {
    store.sessions.delete(sessionId);
    for (const [id, turn] of [...store.turns]) {
      if (turn.sessionId === sessionId) store.turns.delete(id);
    }
    for (const [id, message] of [...store.messages]) {
      if (message.sessionId === sessionId) store.messages.delete(id);
    }
    for (const [id, part] of [...store.parts]) {
      if (part.sessionId === sessionId) store.parts.delete(id);
    }
    for (const [id, delta] of [...store.partDeltas]) {
      if (delta.sessionId === sessionId) store.partDeltas.delete(id);
    }
    for (const [id, invocation] of [...store.toolInvocations]) {
      if (invocation.sessionId === sessionId) store.toolInvocations.delete(id);
    }
  };

  const insertSession = (params: readonly SqlParam[]): ExecutionResult => {
    const [id, title, status, model, systemPrompt, metadata, createdAt, updatedAt, archivedAt] =
      params;
    if (typeof id !== "string") throw new StorageError("sql_error", "sessions.id must be a string.");
    if (store.sessions.has(id)) {
      throw new StorageError("sql_error", `UNIQUE constraint failed: sessions.id = ${id}`);
    }
    // The same two checks the schema states: `status IN (...)` and
    // `archived_at IS NOT NULL` whenever the status is `archived`. The shared
    // operations layer already refuses an unknown status, so this is the
    // engine-side half — it keeps the engine honest if a caller ever reaches
    // it directly, and it is what makes the memory backend reject exactly what
    // SQLite rejects. It is an error, never a coercion: writing "active" for a
    // status the caller did not ask for is silent data corruption.
    if (status !== "active" && status !== "archived") {
      throw new StorageError(
        "sql_error",
        `CHECK constraint failed: sessions.status = ${JSON.stringify(status)} ` +
          "is not in ('active', 'archived')",
      );
    }
    const archivedTimestamp = typeof archivedAt === "string" ? archivedAt : null;
    if (status === "archived" && archivedTimestamp === null) {
      throw new StorageError(
        "sql_error",
        "CHECK constraint failed: status <> 'archived' OR archived_at IS NOT NULL",
      );
    }
    const session: Session = {
      id,
      title: typeof title === "string" ? title : "",
      status,
      model: typeof model === "string" ? model : null,
      systemPrompt: typeof systemPrompt === "string" ? systemPrompt : null,
      metadata: typeof metadata === "string" ? metadata : null,
      createdAt: typeof createdAt === "string" ? createdAt : nowIso(),
      updatedAt: typeof updatedAt === "string" ? updatedAt : nowIso(),
      archivedAt: status === "archived" ? archivedTimestamp : null,
    };
    store.sessions.set(id, session);
    return { rows: [session], changes: 1 };
  };

  /**
   * The one place a message row is written, shared by `INSERT_MESSAGE` and the
   * guarded `INSERT_TURN_OUTCOME_MESSAGE`.
   *
   * Two callers, one implementation: a second copy of the `seq` allocation and
   * the `CHECK` lists is a second set of rules to keep in step.
   */
  const storeMessage = (params: {
    id: SqlParam | undefined;
    sessionId: SqlParam | undefined;
    turnId: SqlParam | undefined;
    parentId: SqlParam | undefined;
    seq: SqlParam | undefined;
    role: SqlParam | undefined;
    status: SqlParam | undefined;
    model: SqlParam | undefined;
    outcome: SqlParam | undefined;
    error: SqlParam | undefined;
    usage: SqlParam | undefined;
    createdAt: SqlParam | undefined;
    updatedAt: SqlParam | undefined;
  }): ExecutionResult => {
    const { id, sessionId, turnId, parentId, seq, role, status, model, outcome, error, usage } = params;
    if (typeof id !== "string" || typeof sessionId !== "string") {
      throw new StorageError("sql_error", "messages.id and messages.session_id must be strings.");
    }
    requireSession(sessionId);
    if (typeof turnId === "string") requireTurn(turnId);
    if (store.messages.has(id)) {
      throw new StorageError("sql_error", `UNIQUE constraint failed: messages.id = ${id}`);
    }
    const siblings = [...store.messages.values()].filter((row) => row.sessionId === sessionId);
    const assigned = nextSeq(siblings, typeof seq === "number" ? seq : null);
    if (siblings.some((row) => row.seq === assigned)) {
      throw new StorageError(
        "sql_error",
        `UNIQUE constraint failed: messages (session_id, seq) = (${sessionId}, ${assigned})`,
      );
    }
    const message: Message = {
      id,
      sessionId,
      turnId: typeof turnId === "string" ? turnId : null,
      parentId: typeof parentId === "string" ? parentId : null,
      seq: assigned,
      // Checked against the schema's CHECK lists, so an invalid role/status/
      // outcome fails here exactly as it would in SQLite instead of being
      // coerced into a row that no SELECT would ever accept.
      role: requireOneOf("messages.role", role, MESSAGE_ROLES),
      status: nullableOneOf("messages.status", status, STREAM_STATUSES),
      model: typeof model === "string" ? model : null,
      outcome: nullableOneOf("messages.outcome", outcome, TURN_OUTCOMES),
      error: typeof error === "string" ? error : null,
      usage: typeof usage === "string" ? usage : null,
      createdAt: typeof params.createdAt === "string" ? params.createdAt : nowIso(),
      updatedAt: typeof params.updatedAt === "string" ? params.updatedAt : nowIso(),
    };
    store.messages.set(id, message);
    return { rows: [message], changes: 1 };
  };

  const insertMessage = (params: readonly SqlParam[]): ExecutionResult => {
    // The parameter order mirrors `messageParams()`: `seq` and the `session_id`
    // of the seq subquery are two separate placeholders.
    return storeMessage({
      id: params[0],
      sessionId: params[1],
      turnId: params[2],
      parentId: params[3],
      seq: params[4],
      // params[5] is the `session_id` of the seq subquery, not a column.
      role: params[6],
      status: params[7],
      model: params[8],
      outcome: params[9],
      error: params[10],
      usage: params[11],
      createdAt: params[12],
      updatedAt: params[13],
    });
  };

  /**
   * `INSERT_TURN_OUTCOME_MESSAGE`.
   *
   * The guard comes first and it is the whole point: a turn that does not exist,
   * or that belongs to another session, writes **no row at all** and reports the
   * zero changes SQLite reports for an `INSERT … SELECT` that matched nothing.
   * Only after it passes is a message written — the very same
   * {@link storeMessage} that `INSERT_MESSAGE` uses, so the `seq` allocation and
   * the `CHECK` lists cannot drift between the two statements.
   */
  const insertTurnOutcomeMessage = (params: readonly SqlParam[]): ExecutionResult => {
    const [id, outcome, error, createdAt, updatedAt, turnId, sessionId] = params;
    const turn = typeof turnId === "string" ? store.turns.get(turnId) : undefined;
    if (turn === undefined || turn.sessionId !== sessionId) return { rows: [], changes: 0 };
    return storeMessage({
      id,
      // Read from the turn row, exactly as the SQL does.
      sessionId: turn.sessionId,
      turnId: turn.id,
      parentId: null,
      seq: null,
      role: "idle",
      status: null,
      model: null,
      outcome,
      error,
      usage: null,
      createdAt,
      updatedAt,
    });
  };

  const insertPart = (isInsert: boolean, params: readonly SqlParam[]): ExecutionResult => {
    // Mirrors `partParams()`: `seq` and the `message_id` of the seq subquery
    // are two separate placeholders.
    const [id, messageId, sessionId, seq, , type, data, contentText, status, createdAt, updatedAt] =
      params;
    if (typeof id !== "string" || typeof messageId !== "string" || typeof sessionId !== "string") {
      throw new StorageError("sql_error", "parts.id, message_id and session_id must be strings.");
    }
    requireSession(sessionId);
    requireMessage(messageId);

    const existing = store.parts.get(id);
    if (existing !== undefined && isInsert) {
      throw new StorageError("sql_error", `UNIQUE constraint failed: parts.id = ${id}`);
    }

    const siblings = [...store.parts.values()].filter((row) => row.messageId === messageId);
    // An upsert keeps the original seq, so a retry cannot collide with the
    // UNIQUE (message_id, seq) constraint.
    const assigned = existing?.seq ?? nextSeq(siblings, typeof seq === "number" ? seq : null);
    if (siblings.some((row) => row.seq === assigned && row.id !== id)) {
      throw new StorageError(
        "sql_error",
        `UNIQUE constraint failed: parts (message_id, seq) = (${messageId}, ${assigned})`,
      );
    }

    const part: Part = {
      id,
      messageId,
      sessionId,
      seq: assigned,
      type: requireOneOf("parts.type", type, PART_TYPES),
      data: typeof data === "string" ? data : null,
      contentText: typeof contentText === "string" ? contentText : "",
      status: nullableOneOf("parts.status", status, STREAM_STATUSES),
      createdAt: existing?.createdAt ?? (typeof createdAt === "string" ? createdAt : nowIso()),
      updatedAt: typeof updatedAt === "string" ? updatedAt : nowIso(),
    };
    store.parts.set(id, part);
    // `sqlite3_changes()` after `INSERT … ON CONFLICT DO UPDATE` counts the row
    // the upsert *touched*, not the columns it changed: on SQLite 3.53.4 two
    // byte-identical runs measure 1, 1. An INSERT always reports 1. So the
    // in-memory engine reports 1 in both cases, and the raw-SQL `changes`
    // channel means the same thing on both backends.
    //
    // The retry idempotency of `flushDelta` does *not* depend on this: it is
    // the `part_deltas` INSERT's `ON CONFLICT (id) DO NOTHING` that reports 0
    // on a replay, which is what `operations.flushDelta` reads.
    return { rows: [part], changes: 1 };
  };

  const appendDelta = (params: readonly SqlParam[]): ExecutionResult => {
    const [deltaId, partId, sessionId, , contentText, createdAt] = params;
    if (typeof deltaId !== "string") {
      throw new StorageError("sql_error", "part_deltas.id must be a string.");
    }
    // ON CONFLICT (id) DO NOTHING — this is the retry case.
    if (store.partDeltas.has(deltaId)) return { rows: [], changes: 0 };
    if (typeof partId !== "string" || !store.parts.has(partId)) {
      throw new StorageError("sql_error", `FOREIGN KEY constraint failed: parts.id = ${String(partId)}`);
    }
    const siblings = [...store.partDeltas.values()].filter((row) => row.partId === partId);
    store.partDeltas.set(deltaId, {
      id: deltaId,
      partId,
      sessionId: typeof sessionId === "string" ? sessionId : "",
      seq: nextSeq(siblings, null),
      contentText: typeof contentText === "string" ? contentText : "",
      createdAt: typeof createdAt === "string" ? createdAt : nowIso(),
    });
    return { rows: [], changes: 1 };
  };

  const insertTurn = (params: readonly SqlParam[]): ExecutionResult => {
    // The parameter order mirrors `turnParams()`: `seq` and the `session_id` of
    // the seq subquery are two separate placeholders.
    const [id, sessionId, seq, , status, leaseOwner, heartbeatAt, startedAt, finishedAt, error] = params;
    if (typeof id !== "string" || typeof sessionId !== "string") {
      throw new StorageError("sql_error", "turns.id and turns.session_id must be strings.");
    }
    requireSession(sessionId);
    if (store.turns.has(id)) {
      throw new StorageError("sql_error", `UNIQUE constraint failed: turns.id = ${id}`);
    }
    const siblings = [...store.turns.values()].filter((row) => row.sessionId === sessionId);
    const assigned = nextSeq(siblings, typeof seq === "number" ? seq : null);
    if (siblings.some((row) => row.seq === assigned)) {
      throw new StorageError(
        "sql_error",
        `UNIQUE constraint failed: turns (session_id, seq) = (${sessionId}, ${assigned})`,
      );
    }
    const turn: Turn = {
      id,
      sessionId,
      seq: assigned,
      status: requireOneOf("turns.status", status, TURN_STATUSES),
      leaseOwner: typeof leaseOwner === "string" ? leaseOwner : null,
      heartbeatAt: typeof heartbeatAt === "string" ? heartbeatAt : null,
      startedAt: typeof startedAt === "string" ? startedAt : nowIso(),
      finishedAt: typeof finishedAt === "string" ? finishedAt : null,
      error: typeof error === "string" ? error : null,
    };
    store.turns.set(id, turn);
    return { rows: [turn], changes: 1 };
  };

  /**
   * `UPDATE_TURN_OUTCOME`: close the anchor row.
   *
   * Scoped by id **and** session, and a turn that is not in that session is a
   * zero-row update rather than an error — which is what SQLite reports, and
   * what `operations.finishTurn` turns into a typed rejection.
   */
  const updateTurnOutcome = (params: readonly SqlParam[]): ExecutionResult => {
    const [status, finishedAt, error, turnId, sessionId] = params;
    if (typeof turnId !== "string") return { rows: [], changes: 0 };
    const turn = store.turns.get(turnId);
    if (turn === undefined || turn.sessionId !== sessionId) return { rows: [], changes: 0 };
    if (finishedAt !== null && typeof finishedAt !== "string") {
      throw new StorageError("sql_error", "turns.finished_at must be a string or NULL.");
    }
    store.turns.set(turnId, {
      ...turn,
      // The schema's CHECK, applied where the schema would apply it — a rejected
      // outcome has to fail *inside* the transaction, or "nothing was written"
      // would be a claim instead of a measurement.
      status: requireOneOf("turns.status", status, TURN_STATUSES),
      finishedAt: typeof finishedAt === "string" ? finishedAt : null,
      error: typeof error === "string" ? error : null,
    });
    return { rows: [], changes: 1 };
  };

  /**
   * `UPDATE_TURN_HEARTBEAT`: one column, one statement, one session.
   *
   * `heartbeat_at` and nothing else — a heartbeat that also wrote a status would
   * be a second way to decide whether a turn is alive, and only the engine's
   * 30 s threshold may do that (`Plan.md` §6.1).
   *
   * The `session_id` guard is the statement's, so it is checked here before the
   * row is written: a heartbeat that named another session's turn changes
   * nothing, which is what SQLite reports for a zero-row `UPDATE` and what
   * `operations.renewHeartbeat` passes on.
   */
  const updateTurnHeartbeat = (params: readonly SqlParam[]): ExecutionResult => {
    const [at, turnId, sessionId] = params;
    if (typeof turnId !== "string") return { rows: [], changes: 0 };
    const turn = store.turns.get(turnId);
    if (turn === undefined || turn.sessionId !== sessionId) return { rows: [], changes: 0 };
    if (typeof at !== "string") {
      throw new StorageError("sql_error", "turns.heartbeat_at must be an ISO-8601 string.");
    }
    store.turns.set(turnId, { ...turn, heartbeatAt: at });
    return { rows: [], changes: 1 };
  };

  /**
   * `UPDATE_PART_STATUS`: the close, as one write on one row.
   *
   * No read first, and that is the whole point — see `sql.ts`. A read here would
   * have to be turned back into a full `PartInput` for an upsert, and the
   * `content_text` it read could be a flush behind the one the user is looking
   * at.
   *
   * The `parts.status` CHECK is applied before anything is written, so a status
   * outside the list fails here exactly as SQLite's `CHECK` would — a rejected
   * close has to leave the row as it was, and it has to fail the same way on
   * both backends.
   */
  const updatePartStatus = (params: readonly SqlParam[]): ExecutionResult => {
    const [status, updatedAt, partId, sessionId] = params;
    if (typeof partId !== "string") return { rows: [], changes: 0 };
    const part = store.parts.get(partId);
    if (part === undefined || part.sessionId !== sessionId) return { rows: [], changes: 0 };
    const checked = requireOneOf("parts.status", status, STREAM_STATUSES);
    if (typeof updatedAt !== "string") {
      throw new StorageError("sql_error", "parts.updated_at must be an ISO-8601 string.");
    }
    store.parts.set(partId, { ...part, status: checked, updatedAt });
    return { rows: [], changes: 1 };
  };

  /**
   * `ABORT_TURN_PARTS`: the crash case, and the two lookups it takes.
   *
   * Message ids first, then the parts that hang off them — the same
   * `message_id IN (SELECT id FROM messages WHERE turn_id = ? AND session_id = ?)`
   * the statement runs, in the same order, so a turn of another session finds
   * nothing here exactly as it finds nothing there.
   *
   * The `status === 'streaming'` test is the one that matters: a part the
   * provider finished before the crash is `completed`, and this leaves it alone.
   * Nothing else about the part is touched, and `updated_at` is only written on
   * the rows that really change — a completed part keeps the timestamp of its
   * own close.
   */
  const abortTurnParts = (params: readonly SqlParam[]): ExecutionResult => {
    const [updatedAt, turnId, sessionId] = params;
    if (typeof turnId !== "string") return { rows: [], changes: 0 };
    if (typeof updatedAt !== "string") {
      throw new StorageError("sql_error", "parts.updated_at must be an ISO-8601 string.");
    }
    const messageIds = new Set(
      [...store.messages.values()]
        .filter((message) => message.turnId === turnId && message.sessionId === sessionId)
        .map((message) => message.id),
    );
    let changes = 0;
    for (const part of store.parts.values()) {
      if (part.status !== "streaming") continue;
      if (!messageIds.has(part.messageId)) continue;
      store.parts.set(part.id, { ...part, status: "aborted", updatedAt });
      changes += 1;
    }
    return { rows: [], changes };
  };

  /**
   * `beginToolCall`.
   *
   * `ON CONFLICT (session_id, attempt, tool_call_id, occurrence) DO NOTHING` —
   * and the *nothing* is the load-bearing half. An `INSERT OR REPLACE`, or a
   * `DO UPDATE` that wrote `status`, would turn a `done` record back into
   * `begun`, and the next replay would then re-run a tool that already ran.
   * Only an insert may write `begun`.
   */
  const beginToolCall = (params: readonly SqlParam[]): ExecutionResult => {
    const [id, sessionId, toolName, toolCallId, attempt, occurrence, args, startedAt, , updatedAt] = params;
    if (
      typeof id !== "string" ||
      typeof sessionId !== "string" ||
      typeof toolName !== "string" ||
      typeof toolCallId !== "string" ||
      typeof attempt !== "number" ||
      typeof occurrence !== "number"
    ) {
      throw new StorageError(
        "sql_error",
        "tool_invocations.id, session_id, tool_name, tool_call_id, attempt and occurrence must have their types.",
      );
    }
    requireSession(sessionId);
    if (findByCallKey({ sessionId, attempt, toolCallId, occurrence }) !== undefined) {
      return { rows: [], changes: 0 };
    }
    const row: ToolInvocation = {
      id,
      sessionId,
      messageId: null,
      callPartId: null,
      resultPartId: null,
      toolName,
      toolCallId,
      attempt,
      occurrence,
      args: typeof args === "string" ? args : null,
      status: "begun",
      output: null,
      resultPreview: null,
      error: null,
      startedAt: typeof startedAt === "string" ? startedAt : null,
      finishedAt: null,
      createdAt: typeof updatedAt === "string" ? updatedAt : nowIso(),
      updatedAt: typeof updatedAt === "string" ? updatedAt : nowIso(),
    };
    store.toolInvocations.set(id, row);
    return { rows: [], changes: 1 };
  };

  /**
   * `recordToolCall`: an upsert, because the `begin` write is the one that can
   * be lost. Refusing to write would discard the only claim the engine can back
   * up — that the tool really did return this.
   */
  const recordToolCall = (params: readonly SqlParam[]): ExecutionResult => {
    const [
      id, sessionId, toolName, toolCallId, attempt, occurrence, output, preview,
      startedAt, finishedAt, createdAt, updatedAt,
    ] = params;
    if (
      typeof id !== "string" ||
      typeof sessionId !== "string" ||
      typeof toolName !== "string" ||
      typeof toolCallId !== "string" ||
      typeof attempt !== "number" ||
      typeof occurrence !== "number"
    ) {
      throw new StorageError(
        "sql_error",
        "tool_invocations.id, session_id, tool_name, tool_call_id, attempt and occurrence must have their types.",
      );
    }
    requireSession(sessionId);
    const existing = findByCallKey({ sessionId, attempt, toolCallId, occurrence });
    const stamp = typeof updatedAt === "string" ? updatedAt : nowIso();
    const row: ToolInvocation = {
      id: existing?.id ?? id,
      sessionId,
      messageId: existing?.messageId ?? null,
      callPartId: existing?.callPartId ?? null,
      resultPartId: existing?.resultPartId ?? null,
      toolName,
      toolCallId,
      attempt,
      occurrence,
      args: existing?.args ?? null,
      status: "done",
      output: typeof output === "string" ? output : null,
      resultPreview: typeof preview === "string" ? preview : null,
      error: null,
      startedAt: existing?.startedAt ?? (typeof startedAt === "string" ? startedAt : null),
      finishedAt: typeof finishedAt === "string" ? finishedAt : null,
      createdAt: existing?.createdAt ?? (typeof createdAt === "string" ? createdAt : stamp),
      updatedAt: typeof updatedAt === "string" ? updatedAt : stamp,
    };
    store.toolInvocations.set(row.id, row);
    return { rows: [row], changes: 1 };
  };

  const findByCallKey = (key: ToolCallKey): ToolInvocation | undefined => {
    const wanted = toolCallKeyOf(key);
    for (const row of store.toolInvocations.values()) {
      if (toolCallKeyOf(row) === wanted) return row;
    }
    return undefined;
  };

  const runSearch = (params: readonly SqlParam[]): ExecutionResult => {
    const [query, second, third] = params;
    // Whether the session filter is present is decided by the parameter count,
    // which `operations.search()` guarantees (query[, sessionId], limit).
    const bySession = params.length === 3;
    const sessionId = bySession ? (typeof second === "string" ? second : null) : null;
    // Re-clamped here so a direct call into the engine cannot reproduce the
    // `slice(0, -1)` bug; `operations.search()` clamps before it gets here.
    const rawLimit = bySession ? third : second;
    const limit = clampSearchLimit(typeof rawLimit === "number" ? rawLimit : undefined);
    if (typeof query !== "string") {
      throw new StorageError("sql_error", "search: the MATCH expression must be a string.");
    }
    const terms = matchTerms(query);
    if (terms.length === 0) return { rows: [], changes: 0 };

    const hits: SearchHit[] = [];
    for (const part of store.parts.values()) {
      if (sessionId !== null && part.sessionId !== sessionId) continue;
      const tokens = new Set(tokenize(part.contentText));
      if (!terms.every((term) => term.every((token) => tokens.has(token)))) continue;
      hits.push({
        partId: part.id,
        messageId: part.messageId,
        sessionId: part.sessionId,
        seq: part.seq,
        type: part.type,
        createdAt: part.createdAt,
        // Stand-in for bm25(): more matched terms score lower (better), which
        // keeps the ordering shape identical to the real engine.
        score: -terms.length,
        excerpt: part.contentText.slice(0, 240),
      });
    }
    hits.sort(
      (a, b) =>
        a.score - b.score ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.messageId.localeCompare(b.messageId) ||
        a.seq - b.seq,
    );
    return { rows: hits.slice(0, limit), changes: 0 };
  };

  /** The in-memory counterpart of exactly one statement of `sql.ts`. */
  const execute = (sql: string, params: readonly SqlParam[]): ExecutionResult => {
    const statement = canonical(sql);
    // Logged *before* the dispatch, and once per call, so a statement that
    // throws is still in the log — a test that says "this call ran exactly one
    // statement" must not be able to miss one by failing on it.
    log.push(statement);

    if (statement === canonical(INSERT_SESSION)) return insertSession(params);
    if (statement === canonical(INSERT_MESSAGE)) return insertMessage(params);
    if (statement === canonical(INSERT_PART)) return insertPart(true, params);
    if (statement === canonical(UPSERT_PART)) return insertPart(false, params);
    if (statement === canonical(FLUSH_DELTA_LOG_SQL)) return appendDelta(params);
    if (statement === canonical(INSERT_TURN)) return insertTurn(params);
    if (statement === canonical(INSERT_TURN_OUTCOME_MESSAGE)) return insertTurnOutcomeMessage(params);
    if (statement === canonical(UPDATE_TURN_OUTCOME)) return updateTurnOutcome(params);
    if (statement === canonical(UPDATE_TURN_HEARTBEAT)) return updateTurnHeartbeat(params);
    if (statement === canonical(UPDATE_PART_STATUS)) return updatePartStatus(params);
    if (statement === canonical(ABORT_TURN_PARTS)) return abortTurnParts(params);
    if (statement === canonical(INSERT_TOOL_INVOCATION_BEGUN)) return beginToolCall(params);
    if (statement === canonical(UPSERT_TOOL_INVOCATION_DONE)) return recordToolCall(params);

    if (statement === canonical(SELECT_SESSION)) {
      const id = params[0];
      const session = typeof id === "string" ? store.sessions.get(id) : undefined;
      return { rows: session === undefined ? [] : [session], changes: 0 };
    }

    if (statement === canonical(SELECT_SESSIONS)) {
      const rows = [...store.sessions.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
      );
      return { rows, changes: 0 };
    }

    if (statement === canonical(DELETE_SESSION)) {
      const id = params[0];
      if (typeof id !== "string") return { rows: [], changes: 0 };
      const existed = store.sessions.delete(id);
      if (existed) cascadeDelete(id);
      return { rows: [], changes: existed ? 1 : 0 };
    }

    if (statement === canonical(SELECT_MESSAGE)) {
      const id = params[0];
      const message = typeof id === "string" ? store.messages.get(id) : undefined;
      return { rows: message === undefined ? [] : [message], changes: 0 };
    }

    if (statement === canonical(SELECT_MESSAGES)) {
      const sessionId = params[0];
      const rows = [...store.messages.values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq);
      return { rows, changes: 0 };
    }

    if (statement === canonical(SELECT_PARTS)) {
      const messageId = params[0];
      const rows = [...store.parts.values()]
        .filter((row) => row.messageId === messageId)
        .sort((a, b) => a.seq - b.seq);
      return { rows, changes: 0 };
    }

    if (statement === canonical(SELECT_DELTA_SEQ)) {
      const deltaId = params[0];
      const row = typeof deltaId === "string" ? store.partDeltas.get(deltaId) : undefined;
      return { rows: row === undefined ? [] : [{ seq: row.seq }], changes: 0 };
    }

    if (statement === canonical(SELECT_UNFINISHED_TURNS)) {
      const sessionId = params[0];
      const rows = [...store.turns.values()]
        .filter(
          (row) =>
            row.sessionId === sessionId &&
            !(FINISHED_TURN_STATUSES as readonly string[]).includes(row.status),
        )
        .sort((a, b) => a.seq - b.seq)
        .map((row) => ({
          turnId: row.id,
          // `COALESCE(heartbeat_at, started_at)`: a turn that was created and
          // never started has no heartbeat, and its own start is the honest
          // answer. Blank would read as "infinitely stale" and close a turn
          // created a moment ago.
          heartbeatAt: row.heartbeatAt ?? row.startedAt,
          startedAt: row.startedAt,
        }));
      return { rows, changes: 0 };
    }

    if (statement === canonical(SELECT_TOOL_CALL)) {
      const [sessionId, attempt, toolCallId, occurrence] = params;
      if (
        typeof sessionId !== "string" ||
        typeof attempt !== "number" ||
        typeof toolCallId !== "string" ||
        typeof occurrence !== "number"
      ) {
        return { rows: [], changes: 0 };
      }
      const row = findByCallKey({ sessionId, attempt, toolCallId, occurrence });
      if (row === undefined) return { rows: [], changes: 0 };
      return { rows: [{ status: row.status, output: row.output }], changes: 0 };
    }

    if (statement === canonical(searchSql(false)) || statement === canonical(searchSql(true))) {
      return runSearch(params);
    }

    throw new StorageError(
      "unsupported",
      `The in-memory database does not implement this statement: ${statement.slice(0, 80)}`,
    );
  };

  const snapshot = (): MemoryStore => ({
    sessions: new Map(store.sessions),
    turns: new Map(store.turns),
    messages: new Map(store.messages),
    parts: new Map(store.parts),
    partDeltas: new Map(store.partDeltas),
    toolInvocations: new Map(store.toolInvocations),
  });

  const restore = (from: MemoryStore): void => {
    store.sessions = from.sessions;
    store.turns = from.turns;
    store.messages = from.messages;
    store.parts = from.parts;
    store.partDeltas = from.partDeltas;
    store.toolInvocations = from.toolInvocations;
  };

  const engine: StorageEngine = {
    async all(sql, params) {
      return execute(sql, params).rows;
    },
    async run(sql, params) {
      return execute(sql, params).changes;
    },
    async transaction(statements) {
      const before = snapshot();
      const outcomes: StatementOutcome[] = [];
      try {
        for (const statement of statements) {
          const result = execute(statement.sql, statement.params);
          outcomes.push({ sql: statement.sql, changes: result.changes, rows: result.rows });
        }
      } catch (error) {
        restore(before);
        throw error;
      }
      return outcomes;
    },
  };

  const operations = createStorageOperations(engine);

  const unsupported = (operation: string): Promise<never> =>
    Promise.reject(
      new StorageError(
        "unsupported",
        `The in-memory database has no SQL engine, so '${operation}' is not available. ` +
          "Use openDatabase() for raw SQL.",
      ),
    );

  return {
    kind: "memory",
    filename,

    query: () => unsupported("query"),
    run: () => unsupported("run"),
    transaction: () => unsupported("transaction"),

    search: (input) =>
      operations.search({
        query: input.query,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),

    createSession: (input) => operations.createSession(input),
    getSession: (id) => operations.getSession(id),
    listSessions: () => operations.listSessions(),
    deleteSession: (id) => operations.deleteSession(id),

    appendMessage: (input) => operations.appendMessage(input),
    getMessage: (id) => operations.getMessage(id),
    listMessages: (sessionId) => operations.listMessages(sessionId),

    appendPart: (input) => operations.appendPart(input),
    upsertPart: (input) => operations.upsertPart(input),
    listParts: (messageId) => operations.listParts(messageId),

    flushDelta: (input) => operations.flushDelta(input),
    closePart: (input: ClosePartInput): Promise<void> => operations.closePart(input),
    closeTurnParts: (input: CloseTurnPartsInput): Promise<void> =>
      operations.closeTurnParts(input),

    appendTurn: (input: TurnInput) => operations.appendTurn(input),
    listUnfinishedTurns: (input: { sessionId: string }): Promise<UnfinishedTurn[]> =>
      operations.listUnfinishedTurns(input),
    listTurnOutcomes: (input: { sessionId: string }): Promise<TurnOutcomeEntry[]> =>
      operations.listTurnOutcomes(input),
    finishTurn: (input: FinishTurnInput): Promise<void> => operations.finishTurn(input),
    renewHeartbeat: (input: RenewHeartbeatInput): Promise<void> => operations.renewHeartbeat(input),
    beginToolCall: (input: BeginToolCallInput): Promise<void> => operations.beginToolCall(input),
    recordToolCall: (input: RecordToolCallInput): Promise<void> => operations.recordToolCall(input),
    getToolCall: (key: ToolCallKey): Promise<ToolCallRecord | undefined> => operations.getToolCall(key),

    close: () => Promise.resolve(),

    counts: () => ({
      sessions: store.sessions.size,
      turns: store.turns.size,
      messages: store.messages.size,
      parts: store.parts.size,
      partDeltas: store.partDeltas.size,
      toolInvocations: store.toolInvocations.size,
    }),

    deltas: () => [...store.partDeltas.values()],

    statements: () => [...log],
  };
}
