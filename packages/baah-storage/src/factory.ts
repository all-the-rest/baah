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
  DELETE_SESSION,
  FLUSH_DELTA_LOG_SQL,
  INSERT_MESSAGE,
  INSERT_PART,
  INSERT_SESSION,
  INSERT_TOOL_INVOCATION_BEGUN,
  INSERT_TURN,
  SELECT_MESSAGE,
  SELECT_MESSAGES,
  SELECT_PARTS,
  SELECT_SESSION,
  SELECT_SESSIONS,
  SELECT_DELTA_SEQ,
  SELECT_TOOL_CALL,
  SELECT_UNFINISHED_TURNS,
  UPSERT_PART,
  UPSERT_TOOL_INVOCATION_DONE,
  searchSql,
} from "./sql.ts";
import type {
  BeginToolCallInput,
  Message,
  MessageRole,
  Part,
  PartType,
  RecordToolCallInput,
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

  const insertMessage = (params: readonly SqlParam[]): ExecutionResult => {
    // The parameter order mirrors `messageParams()`: `seq` and the `session_id`
    // of the seq subquery are two separate placeholders.
    const [
      id, sessionId, turnId, parentId, seq, , role, status, model, outcome, error, usage,
      createdAt, updatedAt,
    ] = params;
    if (typeof id !== "string" || typeof sessionId !== "string") {
      throw new StorageError("sql_error", "messages.id and messages.session_id must be strings.");
    }
    requireSession(sessionId);
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
      createdAt: typeof createdAt === "string" ? createdAt : nowIso(),
      updatedAt: typeof updatedAt === "string" ? updatedAt : nowIso(),
    };
    store.messages.set(id, message);
    return { rows: [message], changes: 1 };
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

    if (statement === canonical(INSERT_SESSION)) return insertSession(params);
    if (statement === canonical(INSERT_MESSAGE)) return insertMessage(params);
    if (statement === canonical(INSERT_PART)) return insertPart(true, params);
    if (statement === canonical(UPSERT_PART)) return insertPart(false, params);
    if (statement === canonical(FLUSH_DELTA_LOG_SQL)) return appendDelta(params);
    if (statement === canonical(INSERT_TURN)) return insertTurn(params);
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

    appendTurn: (input: TurnInput) => operations.appendTurn(input),
    listUnfinishedTurns: (input: { sessionId: string }): Promise<UnfinishedTurn[]> =>
      operations.listUnfinishedTurns(input),
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
  };
}
