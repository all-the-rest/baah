/**
 * The storage operations, expressed once against a small engine interface.
 *
 * The worker binds this to SQLite-WASM, `createMemoryDatabase()` binds it to
 * `Map`s. That is what makes the two interchangeable: `seq` allocation,
 * upsert semantics, flush idempotency and the cascade all live here instead of
 * being written twice (and drifting apart).
 *
 * The engine contract is deliberately tiny:
 * - `all(sql, params)` → rows as objects
 * - `run(sql, params)` → affected row count
 * - `transaction(statements)` → atomic batch, and a way to read back the count
 *   of the last statement (that is how `flushDelta` detects a retry)
 *
 * The in-memory engine recognises the *same* SQL as the SQLite one, so this
 * file stays a single source of truth for the shapes.
 */

import type { z } from "zod";

import { StorageError } from "./errors.ts";
import {
  ABORT_TURN_PARTS,
  DELETE_SESSION,
  FLUSH_DELTA_LOG_SQL,
  FLUSH_DELTA_PART_SQL,
  INSERT_MESSAGE,
  INSERT_PART,
  INSERT_SESSION,
  INSERT_TOOL_INVOCATION_BEGUN,
  INSERT_TURN,
  INSERT_TURN_OUTCOME_MESSAGE,
  INSERT_WORKSPACE,
  SEARCH_SQL_ALL_SESSIONS,
  SEARCH_SQL_BY_SESSION,
  SELECT_DELTA_SEQ,
  SELECT_MESSAGE,
  SELECT_MESSAGES,
  SELECT_PARTS,
  SELECT_SESSION,
  SELECT_SESSIONS,
  SELECT_SESSIONS_BY_WORKSPACE,
  SELECT_TOOL_CALL,
  SELECT_TRANSCRIPT_MESSAGES,
  SELECT_TRANSCRIPT_MESSAGES_FOR_TURN,
  SELECT_TRANSCRIPT_PARTS,
  SELECT_TRANSCRIPT_PARTS_FOR_TURN,
  SELECT_TURN_IN_SESSION,
  SELECT_UNFINISHED_TURNS,
  SELECT_WORKSPACE,
  SELECT_WORKSPACES,
  UPDATE_PART_STATUS,
  UPDATE_SESSION_WORKSPACE,
  UPDATE_TURN_HEARTBEAT,
  UPDATE_TURN_OUTCOME,
  UPSERT_PART,
  UPSERT_TOOL_INVOCATION_DONE,
  messageParams,
  partParams,
  sessionParams,
  sessionWorkspaceParams,
  toolCallKeyParams,
  turnOutcomeMessageParams,
  turnOutcomeParams,
  turnParams,
  workspaceParams,
} from "./sql.ts";
import {
  messageRowSchema,
  partInputSchema,
  partRowSchema,
  searchHitSchema,
  sessionRowSchema,
  toolCallRowSchema,
  turnRowSchema,
  unfinishedTurnRowSchema,
  workspaceRowSchema,
} from "./protocol.ts";
import type {
  BeginToolCallInput,
  ClosePartInput,
  CloseTurnPartsInput,
  FinishTurnInput,
  FlushDeltaInput,
  FlushDeltaResult,
  Message,
  MessageInput,
  Part,
  PartInput,
  RecordToolCallInput,
  RenewHeartbeatInput,
  SearchHit,
  SearchInput,
  Session,
  SessionInput,
  SessionStatus,
  SqlParam,
  ToolCallKey,
  ToolCallRecord,
  TranscriptQuery,
  TranscriptRows,
  Turn,
  TurnInput,
  TurnOutcomeEntry,
  UnfinishedTurn,
  Workspace,
  WorkspaceInput,
  WorkspaceKind,
} from "./types.ts";

/** Outcome of one statement inside a transaction. */
export interface StatementOutcome {
  sql: string;
  changes: number;
  rows: unknown[];
}

/** The minimal engine the storage operations need. */
export interface StorageEngine {
  all(sql: string, params: readonly SqlParam[]): Promise<unknown[]>;
  run(sql: string, params: readonly SqlParam[]): Promise<number>;
  /**
   * All-or-nothing batch. Must return one outcome per statement, in order, so
   * the caller can read the row count of a specific `ON CONFLICT DO NOTHING`.
   */
  transaction(
    statements: readonly { sql: string; params: readonly SqlParam[] }[],
  ): Promise<StatementOutcome[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Default number of hits a search returns, matching the protocol schema's
 * default so an omitted limit behaves the same over both backends.
 */
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Ceiling for a search limit. A caller asking for more than this is served the
 * ceiling rather than an error: the value reaches the FTS5 `LIMIT ?` of
 * `searchSql()` and a huge one would be a full-index scan per keystroke.
 */
export const MAX_SEARCH_LIMIT = 500;

/**
 * Clamp a caller-supplied `search` limit into `[0, MAX_SEARCH_LIMIT]`.
 *
 * Applied in the shared layer, so both backends see the identical value and
 * therefore return the identical rows. Without it, `limit: -1` returned every
 * row from SQLite (`LIMIT -1` means "no limit") and every row but the last from
 * the in-memory engine (`slice(0, -1)`) — a silent divergence on the same
 * query. `0` is a legitimate "give me nothing" and is not an error.
 *
 * `NaN` becomes `0`; a non-finite number is never a meaningful row count, and
 * handing it to either engine produces a nonsense slice.
 */
export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (typeof limit !== "number" || Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit)) return MAX_SEARCH_LIMIT;
  return Math.max(0, Math.min(Math.trunc(limit), MAX_SEARCH_LIMIT));
}

/**
 * How many messages a transcript read returns when the caller names no bound.
 *
 * A screenful of conversation, not a page of it: the read exists so a reloaded
 * tab can show what was said and the recovery can quote what a dead turn got
 * through, and neither wants a thousand-message session in memory to render the
 * last one.
 */
export const DEFAULT_TRANSCRIPT_MESSAGES = 50;

/**
 * Ceiling for a transcript bound.
 *
 * The read is two statements over an *indexed* window, so a huge bound is not a
 * correctness problem — but it is a memory one, and the whole reason the read
 * has a bound at all is that a caller cannot accidentally ask for everything. A
 * caller asking for more is served the ceiling rather than an error, exactly as
 * {@link clampSearchLimit} serves its ceiling: the value is a policy decision
 * about one read, and refusing it would push the decision onto every caller.
 */
export const MAX_TRANSCRIPT_MESSAGES = 200;

/**
 * Clamp a caller-supplied transcript bound into `[0, MAX_TRANSCRIPT_MESSAGES]`.
 *
 * Same four rules as {@link clampSearchLimit}, and for the same reason: the
 * clamp happens in the shared layer so the two backends see the identical value
 * and therefore return the identical rows. `0` is a legitimate "show me nothing"
 * and is not an error — a caller that has nothing to render can say so without
 * first fetching a page.
 */
export function clampTranscriptLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TRANSCRIPT_MESSAGES;
  if (typeof limit !== "number" || Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit)) return MAX_TRANSCRIPT_MESSAGES;
  return Math.max(0, Math.min(Math.trunc(limit), MAX_TRANSCRIPT_MESSAGES));
}

/**
 * `Plan.md` §6.1: `sessions.status` is `CHECK (status IN ('active', 'archived'))`.
 *
 * The write path validates here rather than in a backend, because the two
 * backends must not disagree: SQLite reports the CHECK violation as
 * `sql_error`, so that is what the in-memory one has to report too. Coercing
 * the value instead would write a status the caller never asked for.
 */
export function requireSessionStatus(status: SessionInput["status"]): SessionStatus {
  if (status === undefined) return "active";
  if (status === "active" || status === "archived") return status;
  throw new StorageError(
    "sql_error",
    `CHECK constraint failed: sessions.status = ${JSON.stringify(status)} ` +
      "is not in ('active', 'archived')",
    { status: String(status) },
  );
}

/**
 * `workspaces.kind` is the same shape of rule as `sessions.status`, and it is
 * enforced here for the same measured reason: SQLite reports the `CHECK` violation
 * as `sql_error`, so the in-memory backend has to report exactly that rather than
 * write a kind the caller did not ask for.
 *
 * An unknown kind is an error and never a coercion — "coerce to `opfs`" would turn a
 * project folder into a claim that its data lives in the browser sandbox, which is
 * the one thing a user must never be told falsely.
 */
export function requireWorkspaceKind(kind: WorkspaceInput["kind"]): WorkspaceKind {
  if (kind === "opfs" || kind === "directory") return kind;
  throw new StorageError(
    "sql_error",
    `CHECK constraint failed: workspaces.kind = ${JSON.stringify(kind)} ` +
      "is not in ('opfs', 'directory')",
    { kind: String(kind) },
  );
}

/**
 * How much of a recorded tool output the `result_preview` column keeps.
 *
 * The preview exists for a UI row; `output` holds the exact value and is what a
 * replay hands back. A cap on the preview is therefore free — and it is a cap,
 * not a lossy re-encode: `output` is never derived from it.
 */
export const RESULT_PREVIEW_CHARS = 400;

/**
 * JSON-encode a tool output for the `output` column.
 *
 * `JSON.stringify` returns `undefined` — not a string — for `undefined` and for
 * a function or a symbol. Binding that would be a type error, and coercing it
 * to `"null"` would turn "the tool returned nothing" into "the tool returned
 * `null`", which a replay would then hand to the model as its answer. `NULL` in
 * the column is kept, and read back, as `undefined`, so the round trip is
 * exact in both directions.
 */
export function encodeToolOutput(value: unknown): string | null {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : encoded;
}

/**
 * The inverse of {@link encodeToolOutput}.
 *
 * A row whose `output` cannot be parsed is a `sql_error`, never a silent
 * `undefined`: a replay that answered `undefined` would tell the model the tool
 * produced nothing, which is the same lie the `status` column was added to stop.
 */
export function decodeToolOutput(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StorageError(
      "sql_error",
      "tool_invocations.output is not valid JSON: the record cannot be replayed honestly.",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

/** The bounded display copy. Never replayed. */
export function toolOutputPreview(value: unknown): string {
  const encoded = encodeToolOutput(value) ?? "";
  return encoded.length <= RESULT_PREVIEW_CHARS
    ? encoded
    : `${encoded.slice(0, RESULT_PREVIEW_CHARS)}…`;
}

async function firstRow(engine: StorageEngine, sql: string, params: readonly SqlParam[]) {
  const rows = await engine.all(sql, params);
  return rows[0];
}

/** Narrows a parsed row or fails loudly — a short row is never a silent `null`. */
function narrow<S extends z.ZodType>(schema: S, value: unknown, context: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // `sql_error`, not `internal`: the bad value came out of the database, and
    // the same value reaches SQLite as a constraint failure. `internal` means
    // "our bug" and would send a constraint violation to the wrong telemetry
    // bucket, while the two backends disagreed on a published error code.
    throw new StorageError("sql_error", `${context}: malformed row — ${parsed.error.message}`, {
      issues: parsed.error.issues.length.toString(),
    });
  }
  return parsed.data;
}

async function single<S extends z.ZodType>(
  engine: StorageEngine,
  sql: string,
  params: readonly SqlParam[],
  schema: S,
  context: string,
): Promise<z.output<S>> {
  const row = await firstRow(engine, sql, params);
  if (row === undefined) {
    throw new StorageError("sql_error", `${context}: the statement returned no row.`);
  }
  return narrow(schema, row, context);
}

async function many<S extends z.ZodType>(
  engine: StorageEngine,
  sql: string,
  params: readonly SqlParam[],
  schema: S,
  context: string,
): Promise<z.output<S>[]> {
  const rows = await engine.all(sql, params);
  return rows.map((row, index) => narrow(schema, row, `${context}[${index}]`));
}

/**
 * The operations of the public {@link StorageDatabase} surface, minus the raw
 * SQL escape hatches (which only the worker backend offers).
 */
export interface StorageOperations {
  createSession(input: SessionInput): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(input?: { readonly workspaceId?: string | undefined }): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
  attachSessionToWorkspace(sessionId: string, workspaceId: string | null): Promise<void>;
  createWorkspace(input: WorkspaceInput): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  listWorkspaces(): Promise<Workspace[]>;
  appendMessage(input: MessageInput): Promise<Message>;
  getMessage(id: string): Promise<Message | null>;
  listMessages(sessionId: string): Promise<Message[]>;
  /** The newest `limit` messages of a session, or of one turn of it. */
  readTranscript(input: TranscriptQuery): Promise<TranscriptRows>;
  appendPart(input: PartInput): Promise<Part>;
  upsertPart(input: PartInput): Promise<Part>;
  listParts(messageId: string): Promise<Part[]>;
  flushDelta(input: FlushDeltaInput): Promise<FlushDeltaResult>;
  closePart(input: ClosePartInput): Promise<void>;
  closeTurnParts(input: CloseTurnPartsInput): Promise<void>;
  search(input: SearchInput): Promise<SearchHit[]>;
  appendTurn(input: TurnInput): Promise<Turn>;
  listUnfinishedTurns(input: { sessionId: string }): Promise<UnfinishedTurn[]>;
  listTurnOutcomes(input: { sessionId: string }): Promise<TurnOutcomeEntry[]>;
  finishTurn(input: FinishTurnInput): Promise<void>;
  renewHeartbeat(input: RenewHeartbeatInput): Promise<void>;
  beginToolCall(input: BeginToolCallInput): Promise<void>;
  recordToolCall(input: RecordToolCallInput): Promise<void>;
  getToolCall(key: ToolCallKey): Promise<ToolCallRecord | undefined>;
}

export function createStorageOperations(engine: StorageEngine): StorageOperations {
  return {
    async createSession(input) {
      // Validated *here*, in the shared layer, so both backends reject the same
      // input with the same code. The in-memory factory used to coerce an
      // unknown status to "active" and persist the coercion while SQLite raised
      // a CHECK violation — silent data corruption that only the worker backend
      // ever reported.
      const status = requireSessionStatus(input.status);
      return single(
        engine,
        INSERT_SESSION,
        sessionParams({ ...input, status }, nowIso()),
        sessionRowSchema,
        "createSession",
      );
    },

    async getSession(id) {
      const row = await firstRow(engine, SELECT_SESSION, [id]);
      if (row === undefined) return null;
      return narrow(sessionRowSchema, row, "getSession");
    },

    async listSessions(input = {}) {
      // Two statements rather than one with `? IS NULL`, because the project-scoped
      // read is the one with the index and it must be free to use it as written.
      return input.workspaceId === undefined
        ? many(engine, SELECT_SESSIONS, [], sessionRowSchema, "listSessions")
        : many(
            engine,
            SELECT_SESSIONS_BY_WORKSPACE,
            [input.workspaceId],
            sessionRowSchema,
            "listSessions[workspaceId]",
          );
    },

    async deleteSession(id) {
      // Relies on `PRAGMA foreign_keys=ON`; the in-memory engine replicates the
      // same cascades explicitly (see factory.ts).
      await engine.run(DELETE_SESSION, [id]);
    },

    async attachSessionToWorkspace(sessionId, workspaceId) {
      // `single`, not `run`: a zero-row `UPDATE … RETURNING` means the caller's
      // session id does not exist, and that is a fact the caller must be able to see
      // rather than a silent success. `getSession` first would be the read-then-write
      // this file avoids everywhere else.
      await single(
        engine,
        UPDATE_SESSION_WORKSPACE,
        sessionWorkspaceParams(sessionId, workspaceId),
        sessionRowSchema,
        "attachSessionToWorkspace",
      );
    },

    async createWorkspace(input) {
      const kind = requireWorkspaceKind(input.kind);
      return single(
        engine,
        INSERT_WORKSPACE,
        workspaceParams({ ...input, kind }, nowIso()),
        workspaceRowSchema,
        "createWorkspace",
      );
    },

    async getWorkspace(id) {
      const row = await firstRow(engine, SELECT_WORKSPACE, [id]);
      if (row === undefined) return null;
      return narrow(workspaceRowSchema, row, "getWorkspace");
    },

    async listWorkspaces() {
      return many(engine, SELECT_WORKSPACES, [], workspaceRowSchema, "listWorkspaces");
    },

    async appendMessage(input) {
      return single(
        engine,
        INSERT_MESSAGE,
        messageParams(input),
        messageRowSchema,
        "appendMessage",
      );
    },

    async getMessage(id) {
      const row = await firstRow(engine, SELECT_MESSAGE, [id]);
      if (row === undefined) return null;
      return narrow(messageRowSchema, row, "getMessage");
    },

    async listMessages(sessionId) {
      return many(engine, SELECT_MESSAGES, [sessionId], messageRowSchema, "listMessages");
    },

    /**
     * Read a transcript back, as a **window** over the log.
     *
     * Four statements in the general case and three in the session case, and
     * every one of them earns its place:
     *
     * 1. `SELECT_SESSION` — the session has to be **there**. This is the check
     *    that stops a caller being told "this conversation says nothing" about a
     *    session that does not exist, which is a different fact and the one a UI
     *    would render as an empty room.
     * 2. `SELECT_TURN_IN_SESSION`, when a turn is named — the same argument one
     *    level down, and the guard that keeps a read of another session's turn
     *    impossible rather than empty.
     * 3. `SELECT_TRANSCRIPT_MESSAGES[_FOR_TURN]` — the window, asked for one row
     *    more than the caller wanted. That extra row is how `truncated` is known
     *    without a second `COUNT`, and it is dropped before anything sees it.
     * 4. `SELECT_TRANSCRIPT_PARTS[_FOR_TURN]` — the parts of that same window, in
     *    one statement. Deliberately not a `listParts` per message: `N + 1` round
     *    trips over a worker boundary for one screen of transcript.
     *
     * **Rows come back newest first**, because that is the order the window is
     * taken in and it is the only order that needs no `MIN(seq)` to express the
     * bound. The read port reverses them.
     */
    async readTranscript(input) {
      const limit = clampTranscriptLimit(input.limit);
      const turnId = input.turnId;
      const sessionId = input.sessionId;

      const session = await firstRow(engine, SELECT_SESSION, [sessionId]);
      if (session === undefined) {
        throw new StorageError(
          "sql_error",
          `readTranscript: there is no session ${sessionId}.`,
          { sessionId },
        );
      }
      if (turnId !== undefined) {
        const turn = await firstRow(engine, SELECT_TURN_IN_SESSION, [turnId, sessionId]);
        if (turn === undefined) {
          throw new StorageError(
            "sql_error",
            `readTranscript: there is no turn ${turnId} in session ${sessionId}.`,
            { turnId, sessionId },
          );
        }
      }

      const byTurn = turnId !== undefined;
      const messageParams: SqlParam[] = byTurn
        ? [sessionId, turnId, limit + 1]
        : [sessionId, limit + 1];
      const newest = await many(
        engine,
        byTurn ? SELECT_TRANSCRIPT_MESSAGES_FOR_TURN : SELECT_TRANSCRIPT_MESSAGES,
        messageParams,
        messageRowSchema,
        "readTranscript[messages]",
      );
      const truncated = newest.length > limit;
      const messages = truncated ? newest.slice(0, limit) : newest;

      // `limit` and not `limit + 1`: the messages actually returned are the newest
      // `limit`, which is exactly what this subquery selects. The port attaches
      // parts by message id, so an extra part would be dropped rather than
      // misfiled — the agreement is an efficiency property, not a correctness
      // one, and it is stated here so nobody tightens the two together by accident.
      const parts = await many(
        engine,
        byTurn ? SELECT_TRANSCRIPT_PARTS_FOR_TURN : SELECT_TRANSCRIPT_PARTS,
        byTurn ? [sessionId, turnId, limit] : [sessionId, limit],
        partRowSchema,
        "readTranscript[parts]",
      );

      return { messages, parts, limit, truncated };
    },

    async appendPart(input) {
      return single(engine, INSERT_PART, partParams(input), partRowSchema, "appendPart");
    },

    async upsertPart(input) {
      return single(engine, UPSERT_PART, partParams(input), partRowSchema, "upsertPart");
    },

    async listParts(messageId) {
      return many(engine, SELECT_PARTS, [messageId], partRowSchema, "listParts");
    },

    /**
     * One short transaction: upsert the part, then append to the delta log.
     * The log's primary key is the client-supplied `deltaId`, so replaying the
     * same message inserts nothing and `applied` is `false`.
     */
    async flushDelta(input) {
      const outcomes = await engine.transaction([
        { sql: FLUSH_DELTA_PART_SQL, params: partParams(input.part) },
        {
          sql: FLUSH_DELTA_LOG_SQL,
          params: [
            input.deltaId,
            input.part.id,
            input.part.sessionId,
            input.part.id,
            input.part.contentText,
            input.flushedAt,
          ],
        },
      ]);

      const logOutcome = outcomes[1];
      if (logOutcome === undefined) {
        throw new StorageError("internal", "flushDelta: the transaction returned no delta outcome.");
      }
      // DO NOTHING on a known id means changes() is 0 — that is the retry.
      const applied = logOutcome.changes > 0;
      const rows = await engine.all(SELECT_DELTA_SEQ, [input.deltaId]);
      const deltaRow: unknown = rows[0];
      const rawSeq =
        typeof deltaRow === "object" && deltaRow !== null
          ? (deltaRow as Record<string, unknown>)["seq"]
          : undefined;

      return {
        partId: input.part.id,
        deltaId: input.deltaId,
        applied,
        deltaSeq: typeof rawSeq === "number" ? rawSeq : 0,
      };
    },

    /**
     * Close one part — **one statement**.
     *
     * `engine.run(UPDATE_PART_STATUS, …)`, and deliberately not
     * `listParts` + `upsertPart`: a flush can land between the read and the
     * write, and the upsert would then write back the older `content_text` and
     * the older `status` it read, which is the resurrection race `sql.ts`
     * documents on the statement. Naming the row in the `WHERE` clause is what
     * closes it; a read adds a window without adding anything.
     *
     * A part that is not in `sessionId` changes no row. Not an error, not a
     * zero-row report either: `TurnStore.closePart` is a `Promise<void>` the
     * engine awaits, and the honest outcome of "this part is not in this
     * session" is "nothing happened" — the same as for an unknown turn id on
     * {@link StorageOperations.renewHeartbeat}.
     */
    async closePart(input) {
      await engine.run(UPDATE_PART_STATUS, [
        input.status,
        input.updatedAt,
        input.partId,
        input.sessionId,
      ]);
    },

    /**
     * Close every still-`streaming` part of a turn as `aborted`.
     *
     * One statement, for the same reason as {@link StorageOperations.closePart}
     * and with more at stake: a turn can hold several parts, and a read-then-
     * write per part would be several statements racing several flushes. The
     * `status = 'streaming'` predicate is inside the statement, so a part the
     * provider already finished is not walked backwards.
     */
    async closeTurnParts(input) {
      await engine.run(ABORT_TURN_PARTS, [input.updatedAt, input.turnId, input.sessionId]);
    },

    async search(input) {
      // Clamped in the shared layer, not in the backend: the two engines
      // disagree about a negative limit (SQL reads `LIMIT -1` as "no limit",
      // `Array.slice(0, -1)` drops the last element), so an unclamped value
      // made the backends return different rows for the same query.
      const limit = clampSearchLimit(input.limit);
      const sql =
        input.sessionId === undefined ? SEARCH_SQL_ALL_SESSIONS : SEARCH_SQL_BY_SESSION;
      const params: SqlParam[] =
        input.sessionId === undefined ? [input.query, limit] : [input.query, input.sessionId, limit];
      const rows = await engine.all(sql, params);
      return rows.map((row, index) => narrow(searchHitSchema, row, `search[${index}]`));
    },

    async appendTurn(input) {
      return single(engine, INSERT_TURN, turnParams(input), turnRowSchema, "appendTurn");
    },

    async listUnfinishedTurns(input) {
      return many(
        engine,
        SELECT_UNFINISHED_TURNS,
        [input.sessionId],
        unfinishedTurnRowSchema,
        "listUnfinishedTurns",
      );
    },

    /**
     * The outcomes the log already carries: the `idle` messages of a session.
     *
     * **A read over `listMessages`, not a second projection.** `Plan.md` §6.2
     * says the outcome *is* the `idle` message, so "which outcomes does this
     * session carry" has exactly one definition, and it is the definition the
     * transcript and the export already use. A narrower statement of its own
     * would be a second place where that answer is computed — the kind of second
     * copy `AGENTS.md` §4's one-direction rule exists to prevent, and the kind
     * that eventually reports an outcome the transcript does not show.
     *
     * The cost is honest and bounded: it reads the session's messages rather
     * than two columns, once, at start-up, on the same connection that already
     * reads the anchor. The filtering is three predicates, and the two that
     * could disagree with the schema — `role` and `outcome` — are the columns
     * themselves rather than a projection of them.
     *
     * A message with no turn (`turn_id IS NULL`) or no outcome is skipped rather
     * than reported with a `null`: `TurnOutcomeEntry` says a turn ended, and an
     * entry whose turn is `null` would be a key nothing can look up.
     */
    async listTurnOutcomes(input) {
      const messages = await many(
        engine,
        SELECT_MESSAGES,
        [input.sessionId],
        messageRowSchema,
        "listTurnOutcomes",
      );
      const entries: TurnOutcomeEntry[] = [];
      for (const message of messages) {
        if (message.role !== "idle") continue;
        if (message.turnId === null || message.outcome === null) continue;
        entries.push({ turnId: message.turnId, outcome: message.outcome });
      }
      return entries;
    },

    /**
     * Close a turn: the outcome as an `idle` message **and** the anchor row,
     * in one transaction and in that order.
     *
     * Both statements or neither, and the transaction is what buys that — not
     * the order. The order is fixed anyway because `outcomes[1]` below *is* the
     * anchor write; and a refused `outcome` is refused by the first statement
     * (both statements CHECK it), so nothing is half-written either way.
     *
     * The message insert carries its own guard (`INSERT_TURN_OUTCOME_MESSAGE`
     * reads `session_id`/`turn_id` from the turn row and matches only the pair
     * the caller named), so a caller that pairs a turn with a foreign session
     * writes nothing at all — not even a message that would then have to be
     * rolled back. The zero-row update below is what turns that into a typed
     * error instead of a silent success.
     */
    async finishTurn(input) {
      const outcomes = await engine.transaction([
        { sql: INSERT_TURN_OUTCOME_MESSAGE, params: turnOutcomeMessageParams(input, newId()) },
        { sql: UPDATE_TURN_OUTCOME, params: turnOutcomeParams(input) },
      ]);

      const closed = outcomes[1];
      if (closed === undefined) {
        throw new StorageError("internal", "finishTurn: the transaction returned no turn outcome.");
      }
      if (closed.changes !== 1) {
        throw new StorageError(
          "sql_error",
          `finishTurn: there is no unfinished turn ${input.turnId} in session ${input.sessionId}.`,
          { turnId: input.turnId, sessionId: input.sessionId },
        );
      }
    },

    /**
     * Renew `heartbeat_at` and nothing else, in the session that asked.
     *
     * The engine measures the age of this value against its own clock
     * (`Plan.md` §6.1), so the timestamp that lands here is the caller's, not
     * this layer's. `sessionId` is bound into the `WHERE` clause rather than
     * checked afterwards: a turn that is not in that session changes no row, the
     * same as a turn that does not exist at all. A zero-row update is the
     * *only* silent outcome — a rejection is not: the engine fires this without
     * awaiting it (its call site is a synchronous SDK callback) and reports a
     * `storage-warning` on the turn.
     */
    async renewHeartbeat(input) {
      await engine.run(UPDATE_TURN_HEARTBEAT, [input.at, input.turnId, input.sessionId]);
    },

    async beginToolCall(input) {
      const now = nowIso();
      // `args` is JSON like every other JSON column, and the *input* is the
      // thing that is worth keeping: it is what a "verify, do not repeat"
      // instruction to the model needs to be about.
      const args = encodeToolOutput(input.input);
      // The order is the statement's column order: id, session_id, tool_name,
      // tool_call_id, attempt, occurrence, args, started_at, created_at,
      // updated_at. `finished_at` is NULL here — the call has not returned.
      await engine.run(INSERT_TOOL_INVOCATION_BEGUN, [
        newId(),
        input.key.sessionId,
        input.toolName,
        input.key.toolCallId,
        input.key.attempt,
        input.key.occurrence,
        args,
        now,
        now,
        now,
      ]);
    },

    async recordToolCall(input) {
      const now = nowIso();
      const output = encodeToolOutput(input.output);
      // The order is the statement's column order: id, session_id,
      // tool_name, tool_call_id, attempt, occurrence, output, result_preview,
      // then the four timestamps. All four are the write time — a call has one
      // start, one finish and one update, and they are the same instant here.
      await engine.run(UPSERT_TOOL_INVOCATION_DONE, [
        newId(),
        input.key.sessionId,
        input.toolName,
        input.key.toolCallId,
        input.key.attempt,
        input.key.occurrence,
        output,
        toolOutputPreview(input.output),
        now,
        now,
        now,
        now,
      ]);
    },

    async getToolCall(key) {
      const row = await firstRow(engine, SELECT_TOOL_CALL, toolCallKeyParams(key));
      if (row === undefined) return undefined;
      const parsed = narrow(toolCallRowSchema, row, "getToolCall");
      // The union, not a loose object: reading `output` off a `begun` record is
      // a compile error, which is the point of the status column.
      if (parsed.status === "begun") return { status: "begun" };
      return { status: "done", output: decodeToolOutput(parsed.output) };
    },
  };
}

/**
 * The part of a *validated wire* part that survived parsing.
 *
 * zod reports an absent optional key as `undefined`; `PartInput` uses
 * `exactOptionalPropertyTypes`, where that is a different thing from "not
 * present". This is the one place the two are reconciled.
 */
export type WirePartInput = z.infer<typeof partInputSchema>;

/** Wire part → domain input, dropping the keys that were not sent. */
export function toPartInput(part: WirePartInput): PartInput {
  return {
    id: part.id,
    messageId: part.messageId,
    sessionId: part.sessionId,
    type: part.type,
    contentText: part.contentText,
    updatedAt: part.updatedAt,
    ...(part.seq === undefined ? {} : { seq: part.seq }),
    ...(part.data === undefined ? {} : { data: part.data }),
    ...(part.status === undefined ? {} : { status: part.status }),
    ...(part.createdAt === undefined ? {} : { createdAt: part.createdAt }),
  };
}

/**
 * A part payload for a streaming chunk: the caller owns the text, the store
 * only allocates ids and timestamps.
 */
export function streamingPart(input: {
  messageId: string;
  sessionId: string;
  type: PartInput["type"];
  contentText: string;
  status?: PartInput["status"];
  data?: PartInput["data"];
  id?: string;
  seq?: number;
  now?: string;
}): PartInput {
  const now = input.now ?? nowIso();
  return {
    id: input.id ?? newId(),
    messageId: input.messageId,
    sessionId: input.sessionId,
    type: input.type,
    contentText: input.contentText,
    updatedAt: now,
    createdAt: now,
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}
