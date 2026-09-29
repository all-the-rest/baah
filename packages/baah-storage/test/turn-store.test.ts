/**
 * `TurnStore` over `StorageDatabase`: the contract, measured on both backends.
 *
 * ## What this file is
 *
 * The engine (`@all-the.rest/baah-core`, `agent/loop.ts`) talks to a ten-method
 * `TurnStore`. Five of those methods are already structurally identical to
 * `StorageDatabase`'s; `flushDelta`, `closePart`, `closeTurnParts`, `finishTurn`
 * and `heartbeat` are not, which is what `createTurnStore()` (`src/turn-store.ts`)
 * exists for. This file is the proof that the adapter satisfies the engine's
 * contract **exactly**, and that the properties the engine depends on mean what
 * the engine thinks they mean:
 *
 * 1. `flushDelta` is idempotent over `deltaId` — a retry after a network failure
 *    is a no-op, which is the whole reason the engine may re-send one. And it
 *    writes the **kind** the engine named: a reasoning delta lands as
 *    `reasoning`, not as text the model is supposed to have said.
 * 2. `finishTurn` writes the outcome as an `idle` message (`Plan.md` §6.2): the
 *    turn outcome is a message with an outcome, not a row in a turns table.
 * 3. `heartbeat` renews `heartbeat_at`, and a heartbeat written *now* reads back
 *    as **fresh** to the engine's own 30 s rule — measured here rather than in a
 *    browser, because a unit or clock mistake would otherwise only surface when
 *    a reload killed a live turn. It renews **only** its own session's turn.
 * 4. Every method survives a crash between calls. The engine persists `begun`
 *    *before* a tool runs, so these writes are separate calls on purpose and must
 *    not be reordered, batched or deferred.
 * 5. A part can be **closed**, and the close is one statement: the engine flushes
 *    a part's text before closing it and keeps flushing on a timer, so a
 *    read-modify-write close would lose the newer text to the older one. That is
 *    measured here, with the flush deliberately interleaved into the middle of
 *    the close rather than argued about in a comment.
 *
 * ## Why it is a parity test and not a unit test
 *
 * The two backends have to be interchangeable (`Plan.md` §6.2), and the only way
 * to know whether they are is to run the same input through both. The SQLite side
 * is **real**: the `exports.node` build of `@sqlite.org/sqlite-wasm` behind the
 * worker's own dispatch table (`test/harness/sqlite.ts` — the one documented
 * exception in `AGENTS.md` §2). So the `CHECK` violations, the foreign keys, the
 * `INSERT … SELECT` that matches nothing, the `changes()` accounting and the
 * `BEGIN`/`COMMIT` bracketing are all *measured*, not modelled.
 *
 * The engine's own helpers (`isTurnStale`, `recoverStaleTurns`,
 * `STALE_HEARTBEAT_MS`) are imported from `@all-the.rest/baah-core` rather than
 * restated, so the 30 s boundary that ships is the one under test.
 *
 * ## The shape of every test here
 *
 * `onBoth` runs the body against the in-memory maps **and** against real SQLite,
 * and the assertions come *after* both have run. A `for` loop with `expect`
 * inside stops at the first failure, which would leave the second backend
 * unmeasured — and "one test died" is not the same evidence as "both backends
 * were pinned down".
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { TurnStore } from "@all-the.rest/baah-core";
import { isTurnStale, recoverStaleTurns, STALE_HEARTBEAT_MS } from "@all-the.rest/baah-core";

import { StorageError } from "../src/errors.ts";
import { createMemoryDatabase, type MemoryDatabase } from "../src/factory.ts";
import {
  ABORT_TURN_PARTS,
  INSERT_TURN_OUTCOME_MESSAGE,
  UPDATE_PART_STATUS,
  UPDATE_TURN_HEARTBEAT,
  UPDATE_TURN_OUTCOME,
} from "../src/sql.ts";
import { createTurnStore } from "../src/turn-store.ts";
import type { Part, PartInput, SqlParam, StorageDatabase } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback } from "./harness/transport.ts";

const T0 = "2026-09-29T10:00:00.000Z";
/** Five seconds in: the ordinary "renewed a moment ago" stamp. */
const T1 = "2026-09-29T10:00:05.000Z";
/**
 * Forty seconds in — **past** the engine's 30 s threshold relative to `T0`.
 *
 * Heartbeat assertions use a stamp on this side of the boundary, so a heartbeat
 * that stored the turn's *start* instead of the engine's reading reads as stale
 * by the engine's own rule and not merely as a different string.
 */
const T2 = "2026-09-29T10:00:40.000Z";

/**
 * One text delta, the shape most of these tests flush.
 *
 * Module scope, not local to the `flushDelta` describe: the close tests flush
 * through it too, and a shared fixture is the thing that keeps "the same delta
 * everywhere" true. `partType` carries `as const` because `DELTA` is a `const`,
 * so a bare `"text"` would widen to `string` and stop being a `PartKind`; the
 * reasoning deltas override it at the call site.
 */
const DELTA = {
  deltaId: "d1",
  partId: "p1",
  messageId: "m1",
  sessionId: "s1",
  partType: "text" as const,
  contentText: "par",
};

let sqlite3: Sqlite3Static;

/* ------------------------------------------------------------------ */
/* Backends                                                             */
/* ------------------------------------------------------------------ */

interface MemoryBackend {
  readonly name: "memory";
  readonly db: MemoryDatabase;
  /**
   * Every statement the in-memory engine ran.
   *
   * Not a mirror of the SQL side by courtesy: the maps are not a SQL engine,
   * but `execute()` recognises the same statement strings, so the log is the
   * real thing. It is what lets a claim like "this call is *one* statement" be
   * measured on both backends instead of only where a connection exists to log.
   */
  statements(): readonly string[];
}

interface SqlBackend {
  readonly name: "sql";
  readonly db: StorageDatabase;
  /**
   * Every statement the SQLite connection ran, in order.
   *
   * This is how "one transaction per call, nothing deferred to a later one" is
   * *measured* rather than assumed: the worker's own `BEGIN IMMEDIATE` /
   * `COMMIT` are in this list.
   */
  statements(): readonly string[];
}

type Backend = MemoryBackend | SqlBackend;

function memoryBackend(): MemoryBackend {
  const db = createMemoryDatabase();
  return { name: "memory", db, statements: () => db.statements() };
}

async function sqlBackend(): Promise<SqlBackend> {
  const { pool, install } = installInMemoryPool(sqlite3);
  const loopback = createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: install,
  });
  await loopback.client.open({ filename: "/baah.sqlite3" });
  return {
    name: "sql",
    db: loopback.client,
    statements: () => pool.opened[0]?.executed ?? [],
  };
}

/** One fresh database per backend: two sessions, one message, two turns. */
async function bothBackends(): Promise<{ memory: Backend; sql: Backend }> {
  const backends = { memory: memoryBackend(), sql: await sqlBackend() };
  for (const backend of [backends.memory, backends.sql] as Backend[]) {
    await backend.db.createSession({ id: "s1", title: "First session" });
    await backend.db.createSession({ id: "s2", title: "Other session" });
    await backend.db.appendMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      createdAt: T0,
      updatedAt: T0,
    });
    await backend.db.appendTurn({
      id: "t1",
      sessionId: "s1",
      startedAt: T0,
      status: "streaming",
      heartbeatAt: T0,
    });
    // A turn of the *other* session, so cross-session behaviour is measurable.
    await backend.db.appendTurn({
      id: "t-other",
      sessionId: "s2",
      startedAt: T0,
      status: "streaming",
      heartbeatAt: T0,
    });
  }
  return backends;
}

/**
 * Run `body` on both backends and return both results.
 *
 * The body must not assert: assertions come after, so a failure on one backend
 * cannot leave the other unmeasured.
 */
async function onBoth<R>(body: (backend: Backend) => Promise<R>): Promise<{ memory: R; sql: R }> {
  const backends = await bothBackends();
  const memory = await body(backends.memory);
  const sql = await body(backends.sql);
  return { memory, sql };
}

/** {@link onBoth} for a body whose result must be the same on both backends. */
async function same<R>(
  expected: R,
  body: (backend: Backend) => Promise<R>,
): Promise<{ memory: R; sql: R }> {
  const results = await onBoth(body);
  expect(results.memory, "memory").toEqual(expected);
  expect(results.sql, "sql").toEqual(expected);
  return results;
}

/** The `part_deltas` log, in order, on either backend. */
async function deltaLog(backend: Backend): Promise<{ id: string; seq: number; contentText: string }[]> {
  if (backend.name === "memory") {
    return backend.db.deltas().map((delta) => ({
      id: delta.id,
      seq: delta.seq,
      contentText: delta.contentText,
    }));
  }
  const result = await backend.db.query(
    "SELECT id, seq, content_text AS contentText FROM part_deltas ORDER BY seq ASC",
  );
  return result.rows as { id: string; seq: number; contentText: string }[];
}

/** The `idle` messages of a session, as the engine's reload check reads them. */
async function idleOutcomes(backend: Backend, sessionId: string): Promise<(string | null)[]> {
  const messages = await backend.db.listMessages(sessionId);
  return messages.filter((message) => message.role === "idle").map((message) => message.outcome);
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("The call resolved, but a rejection was expected.");
}

async function scalar(
  db: StorageDatabase,
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<number> {
  const result = await db.query(sql, params, "all");
  const first = result.rows[0] as Record<string, unknown> | undefined;
  const value = first === undefined ? undefined : Object.values(first)[0];
  return typeof value === "number" ? value : Number(value);
}

/**
 * The statements the connection ran, single-spaced.
 *
 * `sql.ts` writes its statements across lines for reading and the worker sends
 * them verbatim, so every comparison here goes through this — the same
 * canonicalisation the in-memory engine uses to recognise a statement by
 * identity (`src/factory.ts`).
 */
function canonical(statements: readonly string[]): string[] {
  return statements.map((statement) => statement.replace(/\s+/g, " ").trim());
}

function one(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

/** The adapter under test, on one backend, with an injectable clock. */
function storeOn(backend: Backend): TurnStore {
  return createTurnStore(backend.db, { now: () => T1 });
}

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/* ------------------------------------------------------------------ */
/* 0 — the type-level conformance                                       */
/* ------------------------------------------------------------------ */

/**
 * Every method `TurnStore` declares.
 *
 * `MissingMethods` below is the reason this is a list and not an inline literal:
 * if the engine ever adds an eleventh method, the exhaustive check fails to
 * compile *and* the runtime key comparison fails — so a new method cannot arrive
 * without this file noticing that the adapter has none.
 */
const TURN_STORE_METHODS = [
  "flushDelta",
  "closePart",
  "closeTurnParts",
  "finishTurn",
  "heartbeat",
  "listUnfinishedTurns",
  "listTurnOutcomes",
  "recordToolCall",
  "getToolCall",
  "beginToolCall",
] as const satisfies readonly (keyof TurnStore)[];

describe("the adapter satisfies TurnStore", () => {
  it("is assignable to the engine's interface — a signature drift is a compile error", () => {
    const database = createMemoryDatabase();

    /**
     * The assignment this file exists for.
     *
     * Not "it typechecks somewhere": a rename, a reordered argument, an added
     * required field or a *missing* method is an error on this line — and the
     * declared return type of `createTurnStore` says the same thing from the
     * other side. `void _check` is the read that keeps `noUnusedLocals` honest
     * about a declaration whose only job is to be checked.
     */
    const _check: TurnStore = createTurnStore(database);
    void _check;

    type MissingMethods = Exclude<keyof TurnStore, (typeof TURN_STORE_METHODS)[number]>;
    const _exhaustive: MissingMethods extends never ? true : false = true;
    void _exhaustive;
  });

  it("exposes exactly the engine's ten methods, on both backends", async () => {
    await same([...TURN_STORE_METHODS].sort(), async (backend) =>
      Object.keys(storeOn(backend)).sort(),
    );
  });

  it("is a factory, not a singleton: two adapters over two databases stay apart", async () => {
    const backends = await bothBackends();

    await storeOn(backends.memory).finishTurn({
      turnId: "t1",
      sessionId: "s1",
      outcome: "succeeded",
      error: undefined,
    });

    expect(await idleOutcomes(backends.memory, "s1")).toEqual(["succeeded"]);
    expect(await idleOutcomes(backends.sql, "s1")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 1 — flushDelta is idempotent over deltaId                            */
/* ------------------------------------------------------------------ */

describe("flushDelta is idempotent over deltaId", () => {
  it("a replay applies nothing and leaves the part text alone", async () =>
    same(
      {
        texts: ["par"],
        deltas: [{ id: "d1", seq: 0, contentText: "par" }],
      },
      async (backend) => {
        const store = storeOn(backend);
        await store.flushDelta(DELTA);
        await store.flushDelta(DELTA);

        return {
          texts: (await backend.db.listParts("m1")).map((part) => part.contentText),
          deltas: await deltaLog(backend),
        };
      },
    ));

  it("the storage call reports applied: false on the replay — measured, not assumed", async () => {
    const { memory } = await bothBackends();
    const payload = {
      deltaId: "d1",
      part: {
        id: "p1",
        messageId: "m1",
        sessionId: "s1",
        type: "text" as const,
        contentText: "par",
        updatedAt: T1,
      },
      flushedAt: T1,
    };

    // `TurnStore.flushDelta` returns `void`, so the property it names has to be
    // asserted where it is produced. This is the measurement the adapter relies
    // on, and it is the same one `test/flush-delta.test.ts` pins per backend.
    expect((await memory.db.flushDelta(payload)).applied).toBe(true);
    expect((await memory.db.flushDelta(payload)).applied).toBe(false);
  });

  it("a different delta id is a different delta, and both land", async () =>
    same(
      {
        deltas: [
          { id: "d1", seq: 0, contentText: "par" },
          { id: "d2", seq: 1, contentText: "partial" },
        ],
        texts: ["partial"],
      },
      async (backend) => {
        const store = storeOn(backend);
        await store.flushDelta(DELTA);
        // A retry of the first, out of order, after the second has landed.
        await store.flushDelta(DELTA);
        await store.flushDelta({ ...DELTA, deltaId: "d2", contentText: "partial" });

        return {
          deltas: await deltaLog(backend),
          texts: (await backend.db.listParts("m1")).map((part) => part.contentText),
        };
      },
    ));

  it("a flush for a message that does not exist leaves neither part nor delta", async () => {
    const results = await onBoth(async (backend) => {
      const rejected = await failure(
        storeOn(backend).flushDelta({
          deltaId: "d1",
          partId: "p-nowhere",
          messageId: "m-nowhere",
          sessionId: "s1",
          partType: "text",
          contentText: "x",
        }),
      );
      return {
        code: rejected.code,
        deltas: await deltaLog(backend),
        parts: await backend.db.listParts("m-nowhere"),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].code, backend).toBe("sql_error");
      expect(results[backend].deltas, backend).toEqual([]);
      expect(results[backend].parts, backend).toEqual([]);
    }
  });

  it("a delta without a session is refused by both — each in its own documented way", async () => {
    // The `sessionId` is part of the part row, not decoration: dropping it is a
    // foreign-key violation in memory and a rejected message on the wire (the
    // protocol's `partInputSchema` wants a non-empty id, so it never reaches an
    // engine). Two different codes, both loud — the same split `Plan.md` §16.1
    // records for `NaN`/`Infinity` limits, and the one thing that must not
    // happen is a write into whichever session happens to fit.
    const results = await onBoth(async (backend) =>
      failure(storeOn(backend).flushDelta({ ...DELTA, sessionId: "" })),
    );

    expect(results.memory.code).toBe("sql_error");
    expect(results.sql.code).toBe("invalid_message");
  });

  it("a flushed delta is a `streaming` part of the kind it was named", async () =>
    // The two halves of "what a delta writes": the *kind* the engine named, and
    // the *status* a delta implies. Both are now the contract's — the first
    // because `flushDelta` carries `partType`, the second because a delta is
    // mid-stream by definition and `closePart` is what says otherwise.
    same([{ type: "text", status: "streaming" }], async (backend) => {
      await storeOn(backend).flushDelta(DELTA);
      return (await backend.db.listParts("m1")).map((part) => ({
        type: part.type,
        status: part.status,
      }));
    }));

  it("a reasoning delta lands as `reasoning` — the gap this contract change closed", async () =>
    // This test used to measure the *absence*: `TurnStore.flushDelta` named no
    // part type, so a reasoning delta was filed as text by the adapter's
    // `partType` option, and the transcript showed the model's thinking as
    // something it said. It is inverted rather than deleted, because the
    // property it can no longer prove — "the contract cannot say otherwise" — is
    // exactly the thing a future widening could take away again. What it pins
    // now is the fix: §6.1's `reasoning` is a part type of its own.
    same([{ type: "reasoning", status: "streaming" }], async (backend) => {
      await storeOn(backend).flushDelta({ ...DELTA, partType: "reasoning" });
      return (await backend.db.listParts("m1")).map((part) => ({
        type: part.type,
        status: part.status,
      }));
    }));

  it("the kind is per delta, not a setting: one text part and one reasoning part stay apart", async () =>
    // The second path for the same property. A `partType` that leaked — a
    // mutable field on the adapter, a variable the first call left behind —
    // would pass the test above, which only ever writes one kind, and would
    // fail here. Two parts, one message, two kinds, in both orders.
    same(
      [
        { id: "p-then-text", type: "text" },
        { id: "p-then-reasoning", type: "reasoning" },
      ],
      async (backend) => {
        const store = storeOn(backend);
        await store.flushDelta({ ...DELTA, partId: "p-then-text" });
        await store.flushDelta({
          ...DELTA,
          deltaId: "d2",
          partId: "p-then-reasoning",
          partType: "reasoning",
        });
        const parts = await backend.db.listParts("m1");
        return parts.map((part) => ({ id: part.id, type: part.type }));
      },
    ));
});

/* ------------------------------------------------------------------ */
/* 2 — finishTurn writes an idle message                                */
/* ------------------------------------------------------------------ */

describe("finishTurn writes the outcome as an idle message (Plan.md §6.2)", () => {
  it("carries all three outcomes, the error, and the turn it belongs to", async () =>
    same(
      {
        outcomes: ["succeeded", "failed", "interrupted"],
        errors: [null, "no-response", "interrupted: no heartbeat for 42s"],
        turns: ["t-succeeded", "t-failed", "t-interrupted"],
        inSession: ["s1", "s1", "s1"],
        otherSession: [],
      },
      async (backend) => {
        const store = storeOn(backend);
        const cases = [
          { turnId: "t-succeeded", outcome: "succeeded", error: undefined },
          { turnId: "t-failed", outcome: "failed", error: "no-response" },
          {
            turnId: "t-interrupted",
            outcome: "interrupted",
            error: "interrupted: no heartbeat for 42s",
          },
        ] as const;

        for (const entry of cases) {
          await backend.db.appendTurn({
            id: entry.turnId,
            sessionId: "s1",
            startedAt: T0,
            status: "streaming",
          });
          await store.finishTurn({
            turnId: entry.turnId,
            sessionId: "s1",
            outcome: entry.outcome,
            error: entry.error,
          });
        }

        const idle = (await backend.db.listMessages("s1")).filter(
          (message) => message.role === "idle",
        );
        return {
          outcomes: idle.map((message) => message.outcome),
          errors: idle.map((message) => message.error),
          turns: idle.map((message) => message.turnId),
          inSession: idle.map((message) => message.sessionId),
          otherSession: await idleOutcomes(backend, "s2"),
        };
      },
    ));

  it("closes the anchor row too, so the reload check stops reporting the turn", async () => {
    const results = await onBoth(async (backend) => {
      const before = (await backend.db.listUnfinishedTurns({ sessionId: "s1" })).map(
        (turn) => turn.turnId,
      );
      await storeOn(backend).finishTurn({
        turnId: "t1",
        sessionId: "s1",
        outcome: "succeeded",
        error: undefined,
      });
      return {
        before,
        after: (await backend.db.listUnfinishedTurns({ sessionId: "s1" })).map(
          (turn) => turn.turnId,
        ),
        // A finished turn in *this* session must not close the other session's.
        other: (await backend.db.listUnfinishedTurns({ sessionId: "s2" })).map(
          (turn) => turn.turnId,
        ),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].before, backend).toEqual(["t1"]);
      expect(results[backend].after, backend).toEqual([]);
      expect(results[backend].other, backend).toEqual(["t-other"]);
    }
  });

  it("the outcome is queryable the way the plan describes it — role = 'idle'", async () => {
    // `Plan.md` §6.2: "der Reload-Check ist eine Query auf message.type = 'idle'".
    // Measured against real SQLite, because the claim is about the schema.
    const { sql } = await bothBackends();
    await storeOn(sql).finishTurn({
      turnId: "t1",
      sessionId: "s1",
      outcome: "interrupted",
      error: "reload",
    });

    const outcome = await sql.db.query("SELECT outcome, error FROM messages WHERE role = 'idle'", [
    ], "all");
    expect(outcome.rows).toEqual([{ outcome: "interrupted", error: "reload" }]);
    // …and nothing else claims to carry an outcome.
    expect(
      await scalar(
        sql.db,
        "SELECT COUNT(*) FROM messages WHERE outcome IS NOT NULL AND role <> 'idle'",
      ),
    ).toBe(0);
  });

  it("one call, one transaction: the log write lands before the row it closes", async () => {
    const { sql } = await bothBackends();
    const before = sql.statements().length;

    await storeOn(sql).finishTurn({
      turnId: "t1",
      sessionId: "s1",
      outcome: "succeeded",
      error: undefined,
    });

    const ran = canonical(sql.statements().slice(before));
    // Measured on the connection: BEGIN, log write, anchor write, COMMIT. The
    // *single* pair of BEGIN/COMMIT is what makes a crash between the two writes
    // impossible — and it is measured, not inferred from the fact that the
    // operation asks for a transaction.
    expect(ran.filter((statement) => statement.startsWith("BEGIN"))).toHaveLength(1);
    expect(ran.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(ran.filter((statement) => statement.startsWith("INSERT INTO messages"))).toHaveLength(1);
    expect(ran.filter((statement) => statement.startsWith("UPDATE turns"))).toHaveLength(1);
    expect(ran[0]).toBe("BEGIN IMMEDIATE");
    expect(ran.at(-1)).toBe("COMMIT");
    // …and they are the statements `sql.ts` declares, not hand-written variants.
    const log = one(INSERT_TURN_OUTCOME_MESSAGE);
    const row = one(UPDATE_TURN_OUTCOME);
    expect(ran).toContain(log);
    expect(ran).toContain(row);
    // The order, asserted rather than stated. It is a narrow invariant and this
    // is the only kind of test that can see it: a batch's order is a property of
    // the statement stream, and the operation reads `outcomes[1]` for the
    // zero-row check, so the index and the order are coupled. (Both statements
    // are asserted present above, so these indices are real.)
    expect(ran.indexOf(log)).toBeLessThan(ran.indexOf(row));
  });

  it("a refused outcome writes nothing at all", async () => {
    // No input can drive a *mid-batch* rollback here, and this test says which
    // one: `outcome` is CHECKed by both statements, and the message write runs
    // first, so the refusal happens on the first statement and the second never
    // runs. What this therefore proves is that nothing is written — which is the
    // property that matters — and the atomicity claim rests on the single
    // BEGIN/COMMIT pair measured above plus the guard measured below.
    const results = await onBoth(async (backend) => {
      const rejected = await failure(
        storeOn(backend).finishTurn({
          turnId: "t1",
          sessionId: "s1",
          outcome: "cancelled" as never,
          error: undefined,
        }),
      );
      return {
        code: rejected.code,
        mentionsCheck: /CHECK/i.test(rejected.message),
        idle: await idleOutcomes(backend, "s1"),
        // The turn is still open: a refused finish is not a finish.
        unfinished: (await backend.db.listUnfinishedTurns({ sessionId: "s1" })).map(
          (turn) => turn.turnId,
        ),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].code, backend).toBe("sql_error");
      expect(results[backend].mentionsCheck, backend).toBe(true);
      expect(results[backend].idle, backend).toEqual([]);
      expect(results[backend].unfinished, backend).toEqual(["t1"]);
    }
  });

  it("refuses a turn that belongs to another session", async () => {
    // Observable 1: the *promise*. The call must reject rather than report a
    // success it did not have — the engine awaits `finishTurn`, so a silent
    // resolve would be a turn the UI believes is closed and is not.
    const results = await onBoth(async (backend) =>
      failure(
        storeOn(backend).finishTurn({
          turnId: "t-other",
          sessionId: "s1",
          outcome: "interrupted",
          error: undefined,
        }),
      ),
    );

    expect(results.memory.code).toBe("sql_error");
    expect(results.sql.code).toBe("sql_error");
  });

  it("a refused finish leaves the database exactly as it was", async () => {
    // Observable 2: the *rows*, which is what a rejection cannot undo. A guard
    // that validated after the write would pass the test above and still leave
    // an outcome message in the wrong session's log.
    const results = await onBoth(async (backend) => {
      await failure(
        storeOn(backend).finishTurn({
          turnId: "t-other",
          sessionId: "s1",
          outcome: "interrupted",
          error: undefined,
        }),
      );
      return {
        named: await idleOutcomes(backend, "s1"),
        owning: await idleOutcomes(backend, "s2"),
        owningTurns: (await backend.db.listUnfinishedTurns({ sessionId: "s2" })).map(
          (turn) => turn.turnId,
        ),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].named, backend).toEqual([]);
      expect(results[backend].owning, backend).toEqual([]);
      expect(results[backend].owningTurns, backend).toEqual(["t-other"]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3 — heartbeat renews the anchor                                      */
/* ------------------------------------------------------------------ */

describe("heartbeat renews the reload anchor (Plan.md §6.1)", () => {
  it("stores the engine's own reading, not the turn's start", async () =>
    same(
      { heartbeatAt: T2, startedAt: T0, staleByEngineRule: false },
      async (backend) => {
        await storeOn(backend).heartbeat({ turnId: "t1", sessionId: "s1", at: T2 });
        const [turn] = await backend.db.listUnfinishedTurns({ sessionId: "s1" });
        return {
          heartbeatAt: turn?.heartbeatAt ?? "",
          startedAt: turn?.startedAt ?? "",
          staleByEngineRule: isTurnStale(turn?.heartbeatAt ?? "", Date.parse(T2)),
        };
      },
    ));

  it("the start would read as stale — so the two cannot be confused", async () =>
    // The same read, from the other side: `T2` is 40 s after the start, and a
    // heartbeat that stored the start would close a live turn (`age >= 30_000`).
    same({ startIsStale: true }, async (backend) => {
      await storeOn(backend).heartbeat({ turnId: "t1", sessionId: "s1", at: T2 });
      const [turn] = await backend.db.listUnfinishedTurns({ sessionId: "s1" });
      return { startIsStale: isTurnStale(turn?.startedAt ?? "", Date.parse(T2)) };
    }));

  it("a heartbeat written now is fresh: the value is ISO-8601, not epoch millis", async () => {
    // The unit mistake this catches is the silent one — a value that does not
    // parse reads as "infinitely stale" (`heartbeatAgeMs`), which would close a
    // turn that is working.
    const results = await onBoth(async (backend) => {
      const nowMs = Date.now();
      const stamp = new Date(nowMs).toISOString();
      const store = createTurnStore(backend.db, { now: () => stamp });
      await store.heartbeat({ turnId: "t1", sessionId: "s1", at: stamp });

      const [turn] = await backend.db.listUnfinishedTurns({ sessionId: "s1" });
      return {
        verbatim: turn?.heartbeatAt === stamp,
        parsable: !Number.isNaN(Date.parse(turn?.heartbeatAt ?? "")),
        fresh: !isTurnStale(turn?.heartbeatAt ?? "", nowMs),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].verbatim, backend).toBe(true);
      expect(results[backend].parsable, backend).toBe(true);
      expect(results[backend].fresh, backend).toBe(true);
    }
  });

  it("writes exactly one statement per call, and touches nothing else", async () => {
    // Property 4: the calls are separate on purpose. A heartbeat that batched,
    // deferred or coalesced would make a turn's anchor depend on a later call.
    const { sql } = await bothBackends();
    const store = storeOn(sql);
    const before = sql.statements().length;

    await store.heartbeat({ turnId: "t1", sessionId: "s1", at: T1 });
    const afterFirst = canonical(sql.statements().slice(before));
    await store.heartbeat({ turnId: "t1", sessionId: "s1", at: T2 });
    const afterSecond = canonical(sql.statements().slice(before + afterFirst.length));

    expect(afterFirst, "the first heartbeat").toEqual([one(UPDATE_TURN_HEARTBEAT)]);
    expect(afterSecond, "the second heartbeat").toEqual([one(UPDATE_TURN_HEARTBEAT)]);
    expect(
      afterFirst.some((statement) => statement.startsWith("BEGIN")),
      "no deferred batch",
    ).toBe(false);

    // And the column is the only one that changed: the status is still the
    // streaming one, not one a heartbeat invented.
    const status = await sql.db.query("SELECT status, finished_at FROM turns WHERE id = 't1'", [
    ], "all");
    expect(status.rows).toEqual([{ status: "streaming", finished_at: null }]);
  });

  it("an unknown turn id is not an error", async () =>
    // The engine fires this as `void store.heartbeat(…)` (`loop.ts`), so a
    // rejection here would be an unhandled promise rejection rather than a
    // reported failure — the opposite of what a caller could act on.
    same(undefined, async (backend) =>
      storeOn(backend).heartbeat({ turnId: "t-does-not-exist", sessionId: "s1", at: T1 }),
    ));

  it("leaves the anchor of a *finished* turn untouched, so it is not resurrected", async () =>
    same([], async (backend) => {
      const store = storeOn(backend);
      await store.finishTurn({
        turnId: "t1",
        sessionId: "s1",
        outcome: "succeeded",
        error: undefined,
      });
      // A heartbeat that arrived late (a queued write, a second tab) renews the
      // timestamp but must not make the turn unfinished again.
      await store.heartbeat({ turnId: "t1", sessionId: "s1", at: T2 });
      return backend.db.listUnfinishedTurns({ sessionId: "s1" });
    }));

  it("a heartbeat for a turn of *another* session renews nothing", async () =>
    // The whole point of the `sessionId` the engine now supplies. On the storage
    // side there is nothing else that can catch a store which accepts the
    // session and ignores it: every other heartbeat test names a turn that
    // belongs to the session it claims, so an unscoped update passes all of them
    // — and the damage it does is invisible from inside `s1`, because `s1` is
    // not where the wrong write lands.
    //
    // `t-other` is a live turn of `s2` (`bothBackends`), so a heartbeat that
    // ignored the session would make it look alive to a recovery in `s2` — and,
    // worse, hide a turn that has in fact been dead for a minute.
    same(
      {
        // Step 1, measured on its own: the foreign write changed neither turn.
        otherAfterForeign: T0,
        mineAfterForeign: T0,
        // Step 2: each turn named by the session that owns it, both renewed. So
        // the guard is a guard and not a blanket refusal — a "fix" that made
        // every heartbeat a no-op would pass step 1 and fail here.
        otherAfterOwn: T2,
        mineAfterOwn: T2,
      },
      async (backend) => {
        const store = storeOn(backend);
        const read = async (): Promise<{ mine: string; other: string }> => {
          const [mine] = await backend.db.listUnfinishedTurns({ sessionId: "s1" });
          const [other] = await backend.db.listUnfinishedTurns({ sessionId: "s2" });
          return { mine: mine?.heartbeatAt ?? "", other: other?.heartbeatAt ?? "" };
        };

        // `s1`'s engine heartbeat, naming the other session's turn. Resolves;
        // writes nothing.
        await store.heartbeat({ turnId: "t-other", sessionId: "s1", at: T2 });
        const afterForeign = await read();

        await store.heartbeat({ turnId: "t-other", sessionId: "s2", at: T2 });
        await store.heartbeat({ turnId: "t1", sessionId: "s1", at: T2 });
        const afterOwn = await read();

        return {
          otherAfterForeign: afterForeign.other,
          mineAfterForeign: afterForeign.mine,
          otherAfterOwn: afterOwn.other,
          mineAfterOwn: afterOwn.mine,
        };
      },
    ));

  it("the second session's turn stays stale for *its own* recovery after a foreign heartbeat", async () =>
    // The second path for the property above, and the one that states the
    // consequence rather than the mechanism: `recoverStaleTurns` is what the
    // cross-session write would corrupt, so it is what this drives. Without the
    // guard, `s2`'s dead turn would read as fresh and would not be closed —
    // a half-written turn left open forever, which is the failure the anchor
    // exists to prevent. With it, the foreign write is a no-op and the turn is
    // still recovered on the other side of the 30 s boundary.
    same({ recovered: ["t-other"], outcomes: ["interrupted"] }, async (backend) => {
      const store = storeOn(backend);
      // `s1`'s engine heartbeat, naming the other session's turn, stamped at the
      // probe time itself: with the guard dropped it would make a 40 s old turn
      // read as 0 s old, and `s2` would never recover it.
      await store.heartbeat({ turnId: "t-other", sessionId: "s1", at: T2 });

      const recovered = await recoverStaleTurns({
        store,
        sessionId: "s2",
        nowMs: Date.parse(T2),
      });
      return {
        recovered: recovered.map((turn) => turn.turnId),
        outcomes: await idleOutcomes(backend, "s2"),
      };
    }));
});

/* ------------------------------------------------------------------ */
/* 3b — closing a part, and reading the outcomes back                  */
/* ------------------------------------------------------------------ */

/** How often a part was read and re-written, as a close would have to. */
interface PartReads {
  listParts: number;
  upsertPart: number;
}

/**
 * The same database, with the two part-level calls a read-modify-write close
 * needs counted.
 *
 * This is the seam the resurrection trap has to be killed through. The engine's
 * close races the delayed flush of the same part, and a read-modify-write loses
 * that race — but the race cannot be *reproduced* through the public surface,
 * because the correct close reads nothing and therefore offers no seam to
 * inject a flush into. So the property is measured where it lives: the close
 * reads no part and re-writes no part. The proxy is transparent otherwise, and
 * the assertions read the rows through the *raw* database so that a test's own
 * read is never counted as the implementation's.
 */
function countingParts(db: StorageDatabase, counts: PartReads): StorageDatabase {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      if (property === "listParts") {
        return async (messageId: string): Promise<Part[]> => {
          counts.listParts += 1;
          return target.listParts(messageId);
        };
      }
      if (property === "upsertPart") {
        return async (input: PartInput): Promise<Part> => {
          counts.upsertPart += 1;
          return target.upsertPart(input);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("closing a part (Plan.md §6.1 — streaming vs. not)", () => {
  it("a closed part is no longer streaming, and says which ending it had", async () =>
    same(
      [
        { id: "p-done", status: "completed" },
        { id: "p-cut", status: "aborted" },
      ],
      async (backend) => {
        const store = storeOn(backend);
        for (const [partId, kind] of [
          ["p-done", "text"],
          ["p-cut", "reasoning"],
        ] as const) {
          await store.flushDelta({ ...DELTA, partId, partType: kind, contentText: "…" });
        }
        await store.closePart({
          sessionId: "s1",
          messageId: "m1",
          partId: "p-done",
          status: "completed",
        });
        await store.closePart({
          sessionId: "s1",
          messageId: "m1",
          partId: "p-cut",
          status: "aborted",
        });

        const parts = await backend.db.listParts("m1");
        return parts.map((part) => ({ id: part.id, status: part.status }));
      },
    ));

  it("the close is ONE statement — no read, no transaction, nothing else", async () =>
    // Measured on the *statement stream* of both backends, not inferred from the
    // code. A close that read the part first would show a `SELECT`; one that went
    // through the upsert would show a `BEGIN`/`COMMIT` pair and an `INSERT INTO
    // parts` — the same shape `flushDelta` has, which is exactly the point: the
    // two must not look alike, because only one of them may write a part's text.
    //
    // Both backends, because the two implementations of this operation could
    // differ in shape and the SQL half alone would not notice. The memory engine
    // logs the same statements it recognises (`MemoryDatabase.statements()`).
    same([one(UPDATE_PART_STATUS)], async (backend) => {
      const store = storeOn(backend);
      await store.flushDelta(DELTA);
      const before = backend.statements().length;

      await store.closePart({
        sessionId: "s1",
        messageId: "m1",
        partId: "p1",
        status: "completed",
      });

      return canonical(backend.statements().slice(before));
    }));

  it("the close reads nothing, so there is no window for a late flush to slip into", async () =>
    // The resurrection trap, and the honest way to kill it.
    //
    // The engine flushes a part's text, *awaits* that flush, and only then closes
    // the part — and a flush that arrives after a close writes back the
    // `streaming` status a delta implies. So the close and a delayed flush are in
    // a race by construction, and a `listParts` + `upsertPart` close loses it
    // deterministically: the read takes the `content_text` of *this* moment, the
    // delayed flush writes a newer one, and the upsert writes the older one back
    // over it. The sentence the user is reading disappears, and the status still
    // says `completed`, because a close that always wins looks perfectly correct
    // from the outside.
    //
    // That race cannot be *reproduced* through the public surface, and the reason
    // is the fix itself: the correct close reads nothing, so there is no seam
    // between its read and its write to inject a flush into. So the property is
    // measured where it lives, in two parts, and neither is a stand-in for the
    // other:
    //
    // - the *row* assertions below catch a read-modify-write that re-wrote a
    //   field it should not have (a re-guessed `type`, a re-stamped `created_at`,
    //   text that came from the row rather than from the delta);
    // - the *counters* catch the same mistake one layer up — a close that reads
    //   the part through the database it was handed. They cannot see a read
    //   inside `operations.ts`, because that read runs on the engine below the
    //   database; the statement test above is what catches that one, on both
    //   backends.
    //
    // Between them: both places the mistake can be made, measured.
    same(
      {
        reads: { listParts: 0, upsertPart: 0 },
        contentText: "the half sentence",
        type: "reasoning",
        createdAt: T1,
        onlyStatusMoved: true,
      },
      async (backend) => {
        const counts: PartReads = { listParts: 0, upsertPart: 0 };
        // `storeOn`'s clock, so the part's `created_at` is the one every other
        // test in this file writes.
        const store = createTurnStore(countingParts(backend.db, counts), { now: () => T1 });

        // A `reasoning` part on purpose: a read-modify-write has to re-state the
        // type it read, so a re-write that guessed `text` — or that lost the row's
        // kind — is caught by the same assertion as one that lost its text.
        await store.flushDelta({
          ...DELTA,
          partType: "reasoning",
          contentText: "the half sentence",
        });
        const before = (await backend.db.listParts("m1"))[0];
        await store.closePart({
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          status: "completed",
        });
        const after = (await backend.db.listParts("m1"))[0];

        return {
          reads: counts,
          contentText: after?.contentText ?? "",
          type: after?.type ?? "",
          createdAt: after?.createdAt ?? "",
          // Every column but `status` and `updated_at` is bit-identical, and the
          // status moved from `streaming` to `completed` — a relation rather
          // than a literal, because `updated_at` is the clock's business.
          onlyStatusMoved:
            before !== undefined &&
            after !== undefined &&
            before.contentText === after.contentText &&
            before.type === after.type &&
            before.createdAt === after.createdAt &&
            before.seq === after.seq &&
            before.data === after.data &&
            before.messageId === after.messageId &&
            before.sessionId === after.sessionId &&
            before.status === "streaming" &&
            after.status === "completed",
        };
      },
    ));

  it("a part of another session is not closed, and the close resolves anyway", async () =>
    // The guard. A `closePart` that ignored `sessionId` would write here, and the
    // damage lands in a log the caller never looks at — which is why this needs
    // its own test rather than being folded into the happy path.
    same({ other: "streaming", otherText: "not yours" }, async (backend) => {
      await backend.db.appendMessage({
        id: "m-other",
        sessionId: "s2",
        role: "assistant",
        createdAt: T0,
        updatedAt: T0,
      });
      await backend.db.flushDelta({
        deltaId: "d-other",
        part: {
          id: "p-other",
          messageId: "m-other",
          sessionId: "s2",
          type: "text",
          contentText: "not yours",
          status: "streaming",
          updatedAt: T0,
        },
        flushedAt: T0,
      });

      // Named with *our* session, and with the foreign message id as well: the
      // statement's guard is `id` + `session_id`, and `messageId` must not be
      // mistaken for a second key that would make this succeed.
      await storeOn(backend).closePart({
        sessionId: "s1",
        messageId: "m-other",
        partId: "p-other",
        status: "aborted",
      });

      const [part] = await backend.db.listParts("m-other");
      return { other: part?.status ?? "", otherText: part?.contentText ?? "" };
    }));

  it("an unknown part id is not an error — the close is a no-op", async () =>
    // The engine awaits `closePart`, and a rejection for a part it is sure it
    // wrote would turn a finished answer into a failed turn. The recoverable
    // direction is silence, like `renewHeartbeat`'s.
    same(undefined, async (backend) =>
      storeOn(backend).closePart({
        sessionId: "s1",
        messageId: "m1",
        partId: "p-never-existed",
        status: "completed",
      }),
    ));

  it("a status outside the CHECK list is refused by both, and the part survives", async () => {
    // The adapter's own type cannot produce this, so it is written with a cast:
    // the claim under test is the *backends'* agreement, and only a row both
    // reject proves the in-memory engine applies the same `CHECK` SQLite does. A
    // memory backend that wrote the status would leave a `parts.status` no
    // `SELECT` in the schema could ever hand back.
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.flushDelta(DELTA);
      const rejected = await failure(
        store.closePart({
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          status: "finished" as never,
        }),
      );
      const [part] = await backend.db.listParts("m1");
      return { code: rejected.code, status: part?.status ?? "", text: part?.contentText ?? "" };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].code, backend).toBe("sql_error");
      expect(results[backend].status, backend).toBe("streaming");
      expect(results[backend].text, backend).toBe("par");
    }
  });
});

describe("closeTurnParts is the crash path: the turn, not the part ids", () => {
  /**
   * One turn with three parts in three states: still streaming, already
   * completed, and never streamed at all (`pending`).
   */
  async function threeStates(backend: Backend): Promise<void> {
    await backend.db.appendMessage({
      id: "m-turn",
      sessionId: "s1",
      turnId: "t1",
      role: "assistant",
      createdAt: T0,
      updatedAt: T0,
    });
    await storeOn(backend).flushDelta({
      ...DELTA,
      partId: "p-open",
      messageId: "m-turn",
      contentText: "cut off here",
    });
    await storeOn(backend).flushDelta({
      ...DELTA,
      deltaId: "d2",
      partId: "p-closed",
      messageId: "m-turn",
      contentText: "a finished sentence",
    });
    await storeOn(backend).closePart({
      sessionId: "s1",
      messageId: "m-turn",
      partId: "p-closed",
      status: "completed",
    });
    await backend.db.appendPart({
      id: "p-pending",
      messageId: "m-turn",
      sessionId: "s1",
      type: "text",
      contentText: "queued",
      status: "pending",
      updatedAt: T0,
    });
  }

  it("aborts the open parts of the turn and nothing else", async () =>
    // In `seq` order, which is the order the parts were written in and the order
    // a transcript reads them in.
    same(
      [
        { id: "p-open", status: "aborted" },
        { id: "p-closed", status: "completed" },
        { id: "p-pending", status: "pending" },
      ],
      async (backend) => {
        await threeStates(backend);
        // A different clock, so "was this row touched?" is answerable from
        // `updated_at` and not only from the status.
        await createTurnStore(backend.db, { now: () => T2 }).closeTurnParts({
          sessionId: "s1",
          turnId: "t1",
        });
        const parts = await backend.db.listParts("m-turn");
        return parts.map((part) => ({ id: part.id, status: part.status }));
      },
    ));

  it("a part that was already completed keeps its own `updated_at`", async () =>
    // The second, independent signal for the same property. A status check alone
    // would be satisfied by an implementation that rewrites every part and
    // happens to write the right status — or by one that rewrites the row and
    // leaves the status alone. The timestamp is what says the row was not
    // touched: it is still the one `closePart` wrote at `T1`, not the abort's
    // `T2`.
    same(
      { closed: T1, open: T2, text: "a finished sentence" },
      async (backend) => {
        await threeStates(backend);
        await createTurnStore(backend.db, { now: () => T2 }).closeTurnParts({
          sessionId: "s1",
          turnId: "t1",
        });
        const parts = new Map(
          (await backend.db.listParts("m-turn")).map((part) => [part.id, part]),
        );
        return {
          closed: parts.get("p-closed")?.updatedAt ?? "",
          open: parts.get("p-open")?.updatedAt ?? "",
          text: parts.get("p-closed")?.contentText ?? "",
        };
      },
    ));

  it("leaves the other session's open parts alone", async () =>
    // The guard, again, on the crash path: a `closeTurnParts` that dropped
    // `session_id` would abort the parts of a turn in `s2` that is merely alive
    // in another tab. `bothBackends` gives `s2` a turn; this gives it a part.
    same({ other: "streaming" }, async (backend) => {
      await backend.db.appendMessage({
        id: "m-other",
        sessionId: "s2",
        turnId: "t-other",
        role: "assistant",
        createdAt: T0,
        updatedAt: T0,
      });
      await backend.db.flushDelta({
        deltaId: "d-other",
        part: {
          id: "p-other",
          messageId: "m-other",
          sessionId: "s2",
          type: "text",
          contentText: "a live turn in another tab",
          status: "streaming",
          updatedAt: T0,
        },
        flushedAt: T0,
      });

      // The turn id is real, the session is not the one that owns it.
      await createTurnStore(backend.db, { now: () => T2 }).closeTurnParts({
        sessionId: "s1",
        turnId: "t-other",
      });

      const [part] = await backend.db.listParts("m-other");
      return { other: part?.status ?? "" };
    }));

  it("is one statement for the whole turn, and resolves for an unknown turn", async () =>
    // The shape and the silence. A per-part read-then-write would show one
    // statement *per part* plus a `SELECT` each; this shows one statement and
    // nothing else, on both backends. Then the recoverable direction: a turn that
    // is not there matches no messages, changes no row, and must not reject — the
    // engine awaits this inside its recovery, and a rejection there would abort
    // the recovery of every *other* stale turn.
    same([one(ABORT_TURN_PARTS)], async (backend) => {
      const before = backend.statements().length;
      await storeOn(backend).closeTurnParts({ sessionId: "s1", turnId: "t-does-not-exist" });
      return canonical(backend.statements().slice(before));
    }));
});

describe("listTurnOutcomes reads the idle messages (Plan.md §6.2)", () => {
  it("reports exactly the outcomes the log carries, as turn/outcome pairs", async () =>
    same(
      [
        { turnId: "t-out-interrupted", outcome: "interrupted" },
        { turnId: "t-out-succeeded", outcome: "succeeded" },
      ],
      async (backend) => {
        const store = storeOn(backend);
        for (const [turnId, outcome] of [
          ["t-out-interrupted", "interrupted"],
          ["t-out-succeeded", "succeeded"],
        ] as const) {
          await backend.db.appendTurn({ id: turnId, sessionId: "s1", startedAt: T0 });
          await store.finishTurn({ turnId, sessionId: "s1", outcome, error: undefined });
        }
        return [...(await store.listTurnOutcomes({ sessionId: "s1" }))];
      },
    ));

  it("reports nothing for a session whose messages are all ordinary", async () =>
    // The property that matters, stated as the absence it is. `m1` is an
    // `assistant` message of `s1` — a real message, in the real session, with no
    // turn and no outcome. A read that returned "every message" would answer
    // with it, and the recovery would then treat turn `null` as already closed
    // and skip a live turn: the "already closed" map would have a key nothing
    // looks up, and the *real* turns of the session would be judged on entries
    // that do not exist. The other direction matters just as much: returning the
    // non-idle messages would make every turn look un-recoverable.
    same([], async (backend) =>
      [...(await storeOn(backend).listTurnOutcomes({ sessionId: "s1" }))],
    ));

  it("ignores an idle message that carries no turn and no outcome", async () =>
    // Not reachable through `finishTurn`, which writes both columns, so this one
    // is written through the storage API on purpose. The filter is the schema's
    // own: an `idle` message with a NULL `turn_id` or a NULL `outcome` must not
    // come back as an entry with a `null` turn — a key nothing can look up, in a
    // map whose whole job is to answer "has this turn already ended?".
    //
    // The two halves are separate assertions on purpose, because the two
    // predicates are separate: the turn-less row catches the `turn_id` test, and
    // the turn-but-no-outcome row catches the `outcome` one.
    //
    // The third row is the one that pins the *type* rather than a decision: an
    // `idle` message with an outcome and no `turn_id` cannot be reported at all,
    // because `TurnOutcomeEntry.turnId` is a `string` and this row has nothing to
    // put there. A filter dropped for that would not make the recovery skip a
    // live turn — it would hand the engine an entry outside its own declared
    // return type, with a `null` key no `Map` lookup can ever reach. Pinned as a
    // fact, not as a requirement: it is the cheapest of the three and the easiest
    // to lose to a tidy-up.
    same({ neither: [], turnOnly: [], orphanOutcome: [] }, async (backend) => {
      await backend.db.appendMessage({
        id: "m-idle",
        sessionId: "s1",
        role: "idle",
        createdAt: T0,
        updatedAt: T0,
      });
      const neither = [...(await storeOn(backend).listTurnOutcomes({ sessionId: "s1" }))];

      await backend.db.appendMessage({
        id: "m-idle-turn",
        sessionId: "s1",
        turnId: "t1",
        role: "idle",
        createdAt: T0,
        updatedAt: T0,
      });
      const turnOnly = [...(await storeOn(backend).listTurnOutcomes({ sessionId: "s1" }))];

      await backend.db.appendMessage({
        id: "m-idle-orphan",
        sessionId: "s1",
        role: "idle",
        outcome: "interrupted",
        createdAt: T0,
        updatedAt: T0,
      });
      const orphanOutcome = [
        ...(await storeOn(backend).listTurnOutcomes({ sessionId: "s1" })),
      ];
      return { neither, turnOnly, orphanOutcome };
    }));

  it("reads the ROLE, not the `outcome` column — a stray outcome is not an answer", async () =>
    // The one that had to be written, because nothing else here caught it:
    // dropping the `role = 'idle'` predicate from the filter changed nothing
    // observable, because every other test's non-idle message has a NULL
    // `outcome` and the third predicate caught it. The schema allows exactly
    // that — `messages.outcome` is nullable and *no CHECK couples it to the
    // role* — so a row can carry an outcome value without being an outcome
    // message: a transcript import that copies the column onto an assistant
    // message, or a writer that fills `outcome` on a live turn's own message to
    // say "running". `role = 'idle'` is the only thing in the row that says
    // "this message *is* a turn outcome", so it is the only thing the read may
    // key on.
    //
    // The consequence if it keyed on the column: the recovery finds the turn
    // already closed and skips it, and a stale, half-written turn stays open
    // forever — the one failure §6.1's anchor exists to prevent.
    same([], async (backend) => {
      await backend.db.appendMessage({
        id: "m-stray",
        sessionId: "s1",
        turnId: "t1",
        role: "assistant",
        outcome: "succeeded",
        createdAt: T0,
        updatedAt: T0,
      });
      return [...(await storeOn(backend).listTurnOutcomes({ sessionId: "s1" }))];
    }));

  it("a live turn with a stray outcome is still recovered by the engine", async () =>
    // The second path for the property above, and the one that states the
    // consequence instead of the mechanism: it drives `recoverStaleTurns`, which
    // is the only thing that reads this. With the role predicate dropped, the
    // stray row would satisfy the "already closed" test and the turn would be
    // left open — recovered `[]`, and the stray `succeeded` the only "outcome" the
    // log carries.
    same({ recovered: ["t1"], outcomes: ["interrupted"] }, async (backend) => {
      await backend.db.appendMessage({
        id: "m-stray",
        sessionId: "s1",
        turnId: "t1",
        role: "assistant",
        outcome: "succeeded",
        createdAt: T0,
        updatedAt: T0,
      });

      const recovered = await recoverStaleTurns({
        store: storeOn(backend),
        sessionId: "s1",
        // `t1`'s heartbeat is `T0`, and `T2` is 40 s later: past the boundary.
        nowMs: Date.parse(T2),
      });
      return {
        recovered: recovered.map((turn) => turn.turnId),
        // The one outcome on the log is the one the *recovery* wrote, and it
        // says `interrupted` — not the stray `succeeded`.
        outcomes: await idleOutcomes(backend, "s1"),
      };
    }));

  it("is scoped to its session: another session's outcome is not an answer", async () =>
    // Without the session filter this would answer with `s2`'s turn, and a
    // recovery in `s1` would look up turn ids that cannot collide — but the
    // failure mode is the same one as the unfiltered read, and this is the
    // cheapest place to see it.
    same({ mine: [], theirs: [{ turnId: "t-other", outcome: "succeeded" }] }, async (backend) => {
      await storeOn(backend).finishTurn({
        turnId: "t-other",
        sessionId: "s2",
        outcome: "succeeded",
        error: undefined,
      });
      return {
        mine: [...(await storeOn(backend).listTurnOutcomes({ sessionId: "s1" }))],
        theirs: [...(await storeOn(backend).listTurnOutcomes({ sessionId: "s2" }))],
      };
    }));
});

/* ------------------------------------------------------------------ */
/* 4 — the engine's own recovery, over this adapter                     */
/* ------------------------------------------------------------------ */

describe("the engine's reload recovery, run against this adapter", () => {
  /**
   * Four turns with heartbeats written by `appendTurn`: one long dead, one
   * alive, and the two sides of the 29.999 s / 30.000 s boundary.
   */
  async function withAges(backend: Backend): Promise<void> {
    const nowMs = Date.parse(T0);
    const ages: { id: string; ageMs: number }[] = [
      { id: "t-dead", ageMs: 60_000 },
      { id: "t-alive", ageMs: 1_000 },
      { id: "t-edge", ageMs: STALE_HEARTBEAT_MS - 1 },
      { id: "t-edge-dead", ageMs: STALE_HEARTBEAT_MS },
    ];
    for (const { id, ageMs } of ages) {
      await backend.db.appendTurn({
        id,
        sessionId: "s1",
        startedAt: T0,
        status: "streaming",
        heartbeatAt: new Date(nowMs - ageMs).toISOString(),
      });
    }
  }

  it("closes the dead ones and leaves the live ones alone", async () => {
    const results = await onBoth(async (backend) => {
      await withAges(backend);
      const recovered = await recoverStaleTurns({
        store: storeOn(backend),
        sessionId: "s1",
        nowMs: Date.parse(T0),
      });
      // "Left alone" is measured on the log, not on a status nobody reads: a
      // live turn gets no outcome message at all.
      const idle = (await backend.db.listMessages("s1")).filter(
        (message) => message.role === "idle",
      );
      return {
        recovered: recovered.map((turn) => turn.turnId),
        written: idle.map((message) => message.turnId).sort(),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      // `t1`'s own heartbeat is `T0`, so its age is 0 and it is alive — the
      // reload check must never close a turn that is this fresh.
      expect(results[backend].recovered, backend).toEqual(["t-dead", "t-edge-dead"]);
      expect(results[backend].written, backend).toEqual(["t-dead", "t-edge-dead"]);
    }
  });

  it("a heartbeat moves a turn across the boundary — the write path the engine uses", async () => {
    // `Plan.md` §6.1 fixes the boundary at `age >= 30 s`, so 29.999 s must stay
    // alive and 30.000 s must die. One millisecond, both directions, and both
    // decided by a heartbeat *this adapter* wrote.
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      const nowMs = Date.parse(T0);
      // Never renewed, so both report their own start and read as fresh.
      await backend.db.appendTurn({ id: "t-edge", sessionId: "s1", startedAt: T0, status: "streaming" });
      await backend.db.appendTurn({
        id: "t-edge-dead",
        sessionId: "s1",
        startedAt: T0,
        status: "streaming",
      });
      const beforeRenewal = (
        await recoverStaleTurns({ store, sessionId: "s1", nowMs })
      ).map((turn) => turn.turnId);

      await store.heartbeat({
        turnId: "t-edge",
        sessionId: "s1",
        at: new Date(nowMs - (STALE_HEARTBEAT_MS - 1)).toISOString(),
      });
      await store.heartbeat({
        turnId: "t-edge-dead",
        sessionId: "s1",
        at: new Date(nowMs - STALE_HEARTBEAT_MS).toISOString(),
      });
      const afterRenewal = await recoverStaleTurns({ store, sessionId: "s1", nowMs });

      return { beforeRenewal, afterRenewal: afterRenewal.map((turn) => turn.turnId) };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].beforeRenewal, backend).toEqual([]);
      expect(results[backend].afterRenewal, backend).toEqual(["t-edge-dead"]);
    }
  });

  it("a recovered turn's outcome is on the log, as `interrupted`, with a reason", async () => {
    const results = await onBoth(async (backend) => {
      await recoverStaleTurns({
        store: storeOn(backend),
        sessionId: "s1",
        nowMs: Date.parse(T2),
      });
      const idle = (await backend.db.listMessages("s1")).filter(
        (message) => message.role === "idle",
      );
      return {
        outcomes: idle.map((message) => message.outcome),
        // "interrupted" with no reason reads as a crash; the engine says why.
        reasons: idle.map((message) => /^interrupted: no heartbeat for \d+s$/.test(message.error ?? "")),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].outcomes, backend).toEqual(["interrupted"]);
      expect(results[backend].reasons, backend).toEqual([true]);
    }
  });

  it("a second recovery of the same turn appends nothing — one turn, one outcome", async () => {
    // The expectation here used to be `["interrupted", "interrupted"]`, and that
    // expectation *was* the bug: the test's name said "MEASURED GAP" and its body
    // pinned a transcript that claims a turn ended twice. It passed because the
    // storage layer genuinely could not do better — `SELECT_UNFINISHED_TURNS`
    // counts `interrupted` as unfinished (deliberately, see
    // `test/tool-call-identity.test.ts`), so a turn the recovery just closed is
    // still reported, its heartbeat stays stale, and a second start-up or second
    // tab called `finishTurn` again.
    //
    // The decision belonged to the engine and has now been taken there:
    // `recoverStaleTurns` reads `listTurnOutcomes` first and skips a turn that
    // already has an outcome, so the second pass finds nothing to close. The
    // anchor still reports the turn as unfinished — that is what keeps it
    // re-sendable — and the *log* is what says it has already been closed. Two
    // reads, and only the second one decides.
    //
    // Both assertions are load-bearing: the outcomes say "closed once", and the
    // unfinished list says the turn is still offered for a `regenerate`.
    const results = await onBoth(async (backend) => {
      const options = {
        store: storeOn(backend),
        sessionId: "s1",
        nowMs: Date.parse(T2),
      };
      const first = await recoverStaleTurns(options);
      const second = await recoverStaleTurns(options);
      return {
        recoveredFirst: first.map((turn) => turn.turnId),
        recoveredSecond: second.map((turn) => turn.turnId),
        outcomes: await idleOutcomes(backend, "s1"),
        // The anchor is unchanged by the recovery: `interrupted` stays
        // unfinished, which is §6.1's re-sendable state.
        stillOffered: (await backend.db.listUnfinishedTurns({ sessionId: "s1" })).map(
          (turn) => turn.turnId,
        ),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].recoveredFirst, backend).toEqual(["t1"]);
      expect(results[backend].recoveredSecond, backend).toEqual([]);
      expect(results[backend].outcomes, backend).toEqual(["interrupted"]);
      expect(results[backend].stillOffered, backend).toEqual(["t1"]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5 — the crash window: every method stands on its own                  */
/* ------------------------------------------------------------------ */

describe("every method survives a crash between calls", () => {
  const KEY = { sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 } as const;

  it("a begun call reads back as begun — never as absent", async () =>
    // The property `tool_invocations.status` exists for (`Plan.md` §6.1): the
    // engine writes `begun` *before* the tool runs, so a crash in that window
    // must be distinguishable from "never ran". Re-running a `write` there is a
    // second append to the user's file.
    same({ status: "begun" }, async (backend) => {
      const store = storeOn(backend);
      // "Crash" here: no recordToolCall, no finishTurn — the tab is gone.
      await store.beginToolCall({ key: KEY, toolName: "write", input: { path: "a.txt" } });
      const record = await store.getToolCall(KEY);
      return { status: record?.status };
    }));

  it("a recorded call reads back its output, and only `done` short-circuits", async () =>
    same({ sameKey: { status: "done", output: { written: 1 } }, nextAttempt: undefined }, async (backend) => {
      const store = storeOn(backend);
      await store.beginToolCall({ key: KEY, toolName: "write", input: { path: "a.txt" } });
      await store.recordToolCall({ key: KEY, toolName: "write", output: { written: 1 } });
      return {
        sameKey: await store.getToolCall(KEY),
        // A retry is a new attempt, and it is not silenced by the first one's
        // record — the fourth component of the key.
        nextAttempt: await store.getToolCall({ ...KEY, attempt: 2 }),
      };
    }));

  it("three calls in a row are three statements and one transaction — nothing is coalesced", async () => {
    const { sql } = await bothBackends();
    const store = storeOn(sql);
    const before = sql.statements().length;

    await store.beginToolCall({
      key: { sessionId: "s1", attempt: 1, toolCallId: "c9", occurrence: 0 },
      toolName: "read",
      input: {},
    });
    await store.heartbeat({ turnId: "t1", sessionId: "s1", at: T1 });
    await store.flushDelta({
      deltaId: "d9",
      partId: "p1",
      messageId: "m1",
      sessionId: "s1",
      partType: "text",
      contentText: "x",
    });

    const ran = canonical(sql.statements().slice(before));
    // One statement, one statement, one transaction. A deferring or batching
    // implementation would show up here as a single batch or as a `timer`.
    expect(ran.filter((statement) => statement.startsWith("BEGIN"))).toHaveLength(1);
    expect(ran.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(ran.filter((statement) => statement.startsWith("INSERT INTO tool_invocations"))).toHaveLength(
      1,
    );
    expect(ran.filter((statement) => statement.startsWith("UPDATE turns"))).toHaveLength(1);
    expect(ran.filter((statement) => statement.includes("INSERT INTO part_deltas"))).toHaveLength(1);
    // And the delta is readable the instant the call resolved — not after some
    // later flush.
    expect(await deltaLog(sql)).toEqual([{ id: "d9", seq: 0, contentText: "x" }]);
  });
});

/* ------------------------------------------------------------------ */
/* 6 — the two backends answer identically                             */
/* ------------------------------------------------------------------ */

describe("the two backends answer identically", () => {
  it("the same turn sequence produces the same rows on both", async () => {
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.flushDelta({
        deltaId: "d1",
        partId: "p1",
        messageId: "m1",
        sessionId: "s1",
        partType: "text",
        contentText: "hello",
      });
      await store.heartbeat({ turnId: "t1", sessionId: "s1", at: T2 });
      await store.finishTurn({
        turnId: "t1",
        sessionId: "s1",
        outcome: "failed",
        error: "boom",
      });
      return {
        deltas: await deltaLog(backend),
        parts: (await backend.db.listParts("m1")).map((part) => [
          part.seq,
          part.type,
          part.contentText,
          part.status,
        ]),
        idle: await idleOutcomes(backend, "s1"),
        unfinished: await backend.db.listUnfinishedTurns({ sessionId: "s1" }),
      };
    });

    expect(results.memory).toEqual(results.sql);
  });

  it("a message pointing at a turn that does not exist is refused by both", async () => {
    // Found while wiring `finishTurn`: the memory backend used to accept it while
    // SQLite — with `PRAGMA foreign_keys=ON` — refused it. The outcome message
    // leans on this constraint being real, so the divergence had to go.
    const backends = await bothBackends();
    const bad = {
      id: "m-orphan",
      sessionId: "s1",
      role: "user" as const,
      createdAt: T0,
      updatedAt: T0,
      turnId: "t-does-not-exist",
    };

    const fromMemory = await failure(backends.memory.db.appendMessage({ ...bad }));
    const fromSql = await failure(backends.sql.db.appendMessage({ ...bad }));

    expect(fromMemory.code).toBe("sql_error");
    expect(fromMemory.code).toBe(fromSql.code);
    expect(fromMemory.message).toMatch(/turns\.id/);
    expect(fromSql.message).toMatch(/FOREIGN KEY/i);
    // …and no row survived the refusal on either side.
    expect((await backends.memory.db.listMessages("s1")).map((message) => message.id)).toEqual(["m1"]);
    expect((await backends.sql.db.listMessages("s1")).map((message) => message.id)).toEqual(["m1"]);
  });

  it("the statements both engines run are the ones sql.ts declares", () => {
    // Not a tautology: these are the exact strings the operations layer sends,
    // and the memory backend recognises each one by identity — see
    // `test/memory-coverage.test.ts`, which fails if a statement has no driver.
    //
    // The two `session_id` guards below are the second path for the
    // cross-session property: a store that *checked* the session after the write
    // would pass every behavioural test above and still send this SQL, and the
    // guard is the thing that has to be in the statement.
    expect(one(UPDATE_TURN_HEARTBEAT)).toBe(
      "UPDATE turns SET heartbeat_at = ? WHERE id = ? AND session_id = ?",
    );
    expect(one(UPDATE_PART_STATUS)).toBe(
      "UPDATE parts SET status = ?, updated_at = ? WHERE id = ? AND session_id = ?",
    );
    expect(one(ABORT_TURN_PARTS)).toBe(
      "UPDATE parts SET status = 'aborted', updated_at = ? WHERE status = 'streaming' " +
        "AND message_id IN (SELECT id FROM messages WHERE turn_id = ? AND session_id = ?)",
    );
    expect(one(UPDATE_TURN_OUTCOME)).toBe(
      "UPDATE turns SET status = ?, finished_at = ?, error = ? WHERE id = ? AND session_id = ?",
    );
    expect(one(INSERT_TURN_OUTCOME_MESSAGE)).toContain("'idle', NULL, NULL, ?, ?, NULL, ?, ?");
    // The guard: the session is part of the write's key, not a lookup that
    // happens afterwards.
    expect(one(INSERT_TURN_OUTCOME_MESSAGE)).toContain("WHERE t.id = ? AND t.session_id = ?");
  });
});
