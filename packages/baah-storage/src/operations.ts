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
  DELETE_SESSION,
  FLUSH_DELTA_LOG_SQL,
  FLUSH_DELTA_PART_SQL,
  INSERT_MESSAGE,
  INSERT_PART,
  INSERT_SESSION,
  SEARCH_SQL_ALL_SESSIONS,
  SEARCH_SQL_BY_SESSION,
  SELECT_DELTA_SEQ,
  SELECT_MESSAGE,
  SELECT_MESSAGES,
  SELECT_PARTS,
  SELECT_SESSION,
  SELECT_SESSIONS,
  UPSERT_PART,
  messageParams,
  partParams,
  sessionParams,
} from "./sql.ts";
import {
  messageRowSchema,
  partInputSchema,
  partRowSchema,
  searchHitSchema,
  sessionRowSchema,
} from "./protocol.ts";
import type {
  FlushDeltaInput,
  FlushDeltaResult,
  Message,
  MessageInput,
  Part,
  PartInput,
  SearchHit,
  SearchInput,
  Session,
  SessionInput,
  SessionStatus,
  SqlParam,
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
  listSessions(): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
  appendMessage(input: MessageInput): Promise<Message>;
  getMessage(id: string): Promise<Message | null>;
  listMessages(sessionId: string): Promise<Message[]>;
  appendPart(input: PartInput): Promise<Part>;
  upsertPart(input: PartInput): Promise<Part>;
  listParts(messageId: string): Promise<Part[]>;
  flushDelta(input: FlushDeltaInput): Promise<FlushDeltaResult>;
  search(input: SearchInput): Promise<SearchHit[]>;
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

    async listSessions() {
      return many(engine, SELECT_SESSIONS, [], sessionRowSchema, "listSessions");
    },

    async deleteSession(id) {
      // Relies on `PRAGMA foreign_keys=ON`; the in-memory engine replicates the
      // same cascades explicitly (see factory.ts).
      await engine.run(DELETE_SESSION, [id]);
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
