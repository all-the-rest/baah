/**
 * `TurnStore` over `StorageDatabase`: the contract, measured on both backends.
 *
 * ## What this file is
 *
 * The engine (`@all-the.rest/baah-core`, `agent/loop.ts`) talks to a seven-method
 * `TurnStore`. Four of those methods were already structurally identical to
 * `StorageDatabase`'s; `flushDelta`, `finishTurn` and `heartbeat` were not, which
 * is what `createTurnStore()` (`src/turn-store.ts`) exists for. This file is the
 * proof that the adapter satisfies the engine's contract **exactly**, and that
 * the four properties the engine depends on mean what the engine thinks they
 * mean:
 *
 * 1. `flushDelta` is idempotent over `deltaId` — a retry after a network failure
 *    is a no-op, which is the whole reason the engine may re-send one.
 * 2. `finishTurn` writes the outcome as an `idle` message (`Plan.md` §6.2): the
 *    turn outcome is a message with an outcome, not a row in a turns table.
 * 3. `heartbeat` renews `heartbeat_at`, and a heartbeat written *now* reads back
 *    as **fresh** to the engine's own 30 s rule — measured here rather than in a
 *    browser, because a unit or clock mistake would otherwise only surface when
 *    a reload killed a live turn.
 * 4. Every method survives a crash between calls. The engine persists `begun`
 *    *before* a tool runs, so these writes are separate calls on purpose and must
 *    not be reordered, batched or deferred.
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
import { INSERT_TURN_OUTCOME_MESSAGE, UPDATE_TURN_HEARTBEAT, UPDATE_TURN_OUTCOME } from "../src/sql.ts";
import { createTurnStore } from "../src/turn-store.ts";
import type { SqlParam, StorageDatabase } from "../src/types.ts";
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

let sqlite3: Sqlite3Static;

/* ------------------------------------------------------------------ */
/* Backends                                                             */
/* ------------------------------------------------------------------ */

interface MemoryBackend {
  readonly name: "memory";
  readonly db: MemoryDatabase;
  /** Always empty: the maps are not a SQL engine, so there is nothing to log. */
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
  return { name: "memory", db: createMemoryDatabase(), statements: () => [] };
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
 * if the engine ever adds an eighth method, the exhaustive check fails to compile
 * *and* the runtime key comparison fails — so a new method cannot arrive without
 * this file noticing that the adapter has none.
 */
const TURN_STORE_METHODS = [
  "flushDelta",
  "finishTurn",
  "heartbeat",
  "listUnfinishedTurns",
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

  it("exposes exactly the engine's seven methods, on both backends", async () => {
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
  const DELTA = {
    deltaId: "d1",
    partId: "p1",
    messageId: "m1",
    sessionId: "s1",
    contentText: "par",
  };

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

  it("a flushed delta is a `streaming` text part by default — the contract cannot say otherwise", async () =>
    same([{ type: "text", status: "streaming" }], async (backend) => {
      await storeOn(backend).flushDelta(DELTA);
      return (await backend.db.listParts("m1")).map((part) => ({
        type: part.type,
        status: part.status,
      }));
    }));

  it("`partType` is the escape hatch for the one thing the contract cannot carry", async () =>
    // `TurnStore.flushDelta` names no part type, so a *reasoning* delta would be
    // filed as text by the default. `Plan.md` §6.1 allows three types, and the
    // loop emits reasoning deltas — so the gap is measured here rather than left
    // as a comment. The fix belongs in the engine's interface, not here.
    same(["reasoning"], async (backend) => {
      const store = createTurnStore(backend.db, { now: () => T1, partType: "reasoning" });
      await store.flushDelta(DELTA);
      return (await backend.db.listParts("m1")).map((part) => part.type);
    }));
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
        await storeOn(backend).heartbeat({ turnId: "t1", at: T2 });
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
      await storeOn(backend).heartbeat({ turnId: "t1", at: T2 });
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
      await store.heartbeat({ turnId: "t1", at: stamp });

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

    await store.heartbeat({ turnId: "t1", at: T1 });
    const afterFirst = canonical(sql.statements().slice(before));
    await store.heartbeat({ turnId: "t1", at: T2 });
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
      storeOn(backend).heartbeat({ turnId: "t-does-not-exist", at: T1 }),
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
      await store.heartbeat({ turnId: "t1", at: T2 });
      return backend.db.listUnfinishedTurns({ sessionId: "s1" });
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
        at: new Date(nowMs - (STALE_HEARTBEAT_MS - 1)).toISOString(),
      });
      await store.heartbeat({
        turnId: "t-edge-dead",
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

  it("MEASURED GAP: a second recovery of the same turn appends a second outcome", async () => {
    // Not a requirement — a fact, pinned so nobody rediscovers it in a browser.
    //
    // `SELECT_UNFINISHED_TURNS` counts `interrupted` as unfinished (deliberately,
    // see `test/tool-call-identity.test.ts`), so a turn this recovery just closed
    // is still reported by `listUnfinishedTurns`. Its heartbeat stays stale, so a
    // second start-up — or a second tab — calls `finishTurn` again and appends a
    // *second* `interrupted` outcome message for the same turn.
    //
    // The storage layer cannot settle this alone: any status that `NOT IN
    // ('succeeded','failed')` excludes is a status §6.1 says is re-sendable. The
    // decision belongs to `recoverStaleTurns` (skip a turn that is already
    // interrupted) or to `finishTurn` (one outcome per turn). Reported, not
    // smoothed over here.
    const results = await onBoth(async (backend) => {
      const options = {
        store: storeOn(backend),
        sessionId: "s1",
        nowMs: Date.parse(T2),
      };
      await recoverStaleTurns(options);
      await recoverStaleTurns(options);
      return idleOutcomes(backend, "s1");
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend], backend).toEqual(["interrupted", "interrupted"]);
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
    await store.heartbeat({ turnId: "t1", at: T1 });
    await store.flushDelta({
      deltaId: "d9",
      partId: "p1",
      messageId: "m1",
      sessionId: "s1",
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
        contentText: "hello",
      });
      await store.heartbeat({ turnId: "t1", at: T2 });
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

  it("the three new statements are the ones both engines run", () => {
    // Not a tautology: these are the exact strings the operations layer sends,
    // and the memory backend recognises each one by identity — see
    // `test/memory-coverage.test.ts`, which fails if a statement has no driver.
    expect(one(UPDATE_TURN_HEARTBEAT)).toBe("UPDATE turns SET heartbeat_at = ? WHERE id = ?");
    expect(one(UPDATE_TURN_OUTCOME)).toBe(
      "UPDATE turns SET status = ?, finished_at = ?, error = ? WHERE id = ? AND session_id = ?",
    );
    expect(one(INSERT_TURN_OUTCOME_MESSAGE)).toContain("'idle', NULL, NULL, ?, ?, NULL, ?, ?");
    // The guard: the session is part of the write's key, not a lookup that
    // happens afterwards.
    expect(one(INSERT_TURN_OUTCOME_MESSAGE)).toContain("WHERE t.id = ? AND t.session_id = ?");
  });
});
