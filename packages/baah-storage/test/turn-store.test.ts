/**
 * `TurnStore` over `StorageDatabase`: the contract, measured on both backends.
 *
 * ## What this file is
 *
 * The engine (`@all-the.rest/baah-core`, `agent/loop.ts`) talks to a
 * **thirteen**-method `TurnStore`. Five of those are already structurally
 * identical to `StorageDatabase`'s; `flushDelta`, `closePart`, `closeTurnParts`,
 * `finishTurn` and `heartbeat` are not, which is what `createTurnStore()`
 * (`src/turn-store.ts`) exists for. This file is the proof that the adapter
 * satisfies the engine's contract **exactly**, and that the properties the
 * engine depends on mean what the engine thinks they mean:
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
 * 6. The two **creates** are idempotent by `id`, and that is load-bearing twice
 *    over: the engine mints the prompt's id **once in `run`** and a retry re-sends
 *    the *same* id, so a per-attempt id — or a plain `INSERT` in place of
 *    `ON CONFLICT (id)` — appends a second prompt row to the same turn. And a
 *    replayed `appendTurn` must **not** renew `heartbeat_at`, or a dead turn looks
 *    alive to the 30 s rule forever. The duplicate is resolved by the *statement*
 *    (`Plan.md` §16.1), so both are pinned on the row and on both backends.
 * 7. `upsertPart` writes the tool part, and the row it writes says what the engine
 *    decided. A state that is wrong while a turn is live corrects itself on the
 *    next event; a state that is wrong in the **database** does not — which is why
 *    every assertion about the failed-tool rule is made on the row after it has
 *    been through JSON and a real column.
 *
 * ## A finding this file pins instead of papering over
 *
 * `parts` carries two *independent* foreign keys (`message_id`, `session_id`) and
 * nothing ties them to each other, so a write naming a message of one session and
 * a session of another **lands**. The engine cannot reach it — both ids come from
 * the same closure that wrote the rows — and the memory engine behaves
 * identically, so this is the schema's shape rather than a divergence between
 * backends. It is measured in section 3a with that reasoning attached, because the
 * obvious version of that test ("a cross-session part is refused") is **false**,
 * and a future reader would write it, find it green against a fake, and ship a
 * claim the database does not enforce.
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
import type { ToolPartEvent, TurnStore } from "@all-the.rest/baah-core";
import { isTurnStale, recoverStaleTurns, STALE_HEARTBEAT_MS } from "@all-the.rest/baah-core";

import { StorageError } from "../src/errors.ts";
import { createMemoryDatabase, type MemoryDatabase } from "../src/factory.ts";
import {
  ABORT_TURN_PARTS,
  INSERT_MESSAGE,
  INSERT_TURN,
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

/**
 * One fresh database per backend: three sessions, one message, two turns.
 *
 * `s-seq` is **empty**, and that is the point rather than an oversight: `seq` is
 * allocated per session (§6.2), so "the prompt's message took `seq` 0" is only
 * a statement about the rule if the session it was written to had nothing in
 * it. The tests that need a clean counter say so by using `s-seq`; the rest keep
 * using the populated `s1` so cross-session behaviour stays measurable.
 */
async function bothBackends(): Promise<{ memory: Backend; sql: Backend }> {
  const backends = { memory: memoryBackend(), sql: await sqlBackend() };
  for (const backend of [backends.memory, backends.sql] as Backend[]) {
    await backend.db.createSession({ id: "s1", title: "First session" });
    await backend.db.createSession({ id: "s2", title: "Other session" });
    await backend.db.createSession({ id: "s-seq", title: "Empty session" });
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

/**
 * The message rows of a session, as `[id, seq]`, on either backend.
 *
 * Through the **public read** and not a raw `SELECT`, because the memory backend
 * has no SQL engine at all (`Plan.md` §16.1: `query` is refused with
 * `unsupported`). `listMessages` orders by `seq ASC` on both sides, so the order
 * this returns *is* the order the transcript is read in — which is the property
 * under test, so reading it any other way would be reading a different thing.
 */
async function messageSeqs(backend: Backend, sessionId: string) {
  return (await backend.db.listMessages(sessionId)).map((message) => [message.id, message.seq] as const);
}

/** The turn ids of a session, in `seq` order, on either backend. */
async function turnIds(backend: Backend, sessionId: string) {
  return (await backend.db.listUnfinishedTurns({ sessionId })).map((turn) => turn.turnId);
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

/**
 * Whether a call resolved, and what it produced.
 *
 * The counterpart to {@link failure} for the tests that assert a call **succeeds**
 * where a reader would expect a refusal — a schema that does not enforce what the
 * call site's naming makes unreachable. Without it, such a test has to be written
 * as `await failure(...)`, which asserts the opposite of the finding.
 */
async function settled(
  promise: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    return { ok: false, error };
  }
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
/**
 * Every method `TurnStore` declares — **thirteen**, which is the number the
 * `Exclude` below checks, and the number the `it(...)` title states. Both are
 * here deliberately: the list is the single source of truth, the title is what a
 * reader checks first, and a title that drifts from the list is worse than no
 * title at all.
 */
const TURN_STORE_METHODS = [
  "appendTurn",
  "appendMessage",
  "upsertPart",
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

  it("exposes exactly the engine's thirteen methods, on both backends", async () => {
    await same([...TURN_STORE_METHODS].sort(), async (backend) =>
      Object.keys(storeOn(backend)).sort(),
    );
  });

  it("declares thirteen — the count is checked, not asserted in prose", () => {
    // The `Exclude` in the test above is the real check (it fails to compile if
    // the engine grows a method the list does not have). This one is the other
    // direction and the one that actually fails *loudly*: `TURN_STORE_METHODS`
    // growing without `TurnStore` does compile, so nothing else in this file
    // would notice a method that the adapter no longer implements — the runtime
    // comparison would, but only as a diff inside a bigger assertion.
    expect(TURN_STORE_METHODS).toHaveLength(13);
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
/* 1 — the two creates are idempotent by id, and they order             */
/* ------------------------------------------------------------------ */

/**
 * A turn written through the seam, as the engine writes it.
 *
 * The order is the engine's and not this file's: `AgentTurn.#persistPrompt`
 * awaits `appendTurn`, then `appendMessage`, then the part — the foreign keys'
 * order, before the first model call. Both creates are then repeated, because
 * the properties below are about what a **repeat** does and a single call
 * cannot show any of them.
 *
 * A session of its own (`s-seq`), because the shared fixture already holds a
 * message and a turn in `s1` and `seq` is per session: asserting "the prompt got
 * seq 0" against a session that starts at 1 would be asserting the fixture, not
 * the rule.
 */
const PROMPT = {
  turn: { id: "t9", sessionId: "s-seq", startedAt: T0 },
  message: {
    id: "m9",
    sessionId: "s-seq",
    role: "user" as const,
    turnId: "t9",
    createdAt: T0,
    updatedAt: T0,
  },
};

/**
 * The empty session the ordering tests count from.
 *
 * A no-op alias, kept so those tests read as what they are. `s-seq` is created
 * in {@link bothBackends}, because `onBoth` and `same` are the only two ways a
 * body gets both backends — and a third entry point that had to remember to
 * create the session is a third way to forget it.
 */
async function backendsWithEmptySession(): Promise<{ memory: Backend; sql: Backend }> {
  return bothBackends();
}

describe("appendTurn and appendMessage are idempotent by id", () => {
  it("a second appendTurn for one turnId writes no second row", async () =>
    same(
      ["t9"],
      async (backend) => {
        const store = storeOn(backend);
        await store.appendTurn(PROMPT.turn);
        // Twice more: a resumed approval re-enters the same turn, and a third
        // write must not be a different answer than the second.
        await store.appendTurn(PROMPT.turn);
        await store.appendTurn(PROMPT.turn);

        return turnIds(backend, "s-seq");
      },
    ));

  it("a replayed appendTurn is NOT a heartbeat — the 30 s rule keeps one writer", async () =>
    // The asymmetry `Plan.md` §16.1 records for `beginToolCall`'s `DO NOTHING`,
    // and it is load-bearing: `heartbeat_at` is the reload anchor, so a second
    // turn write that renewed it would keep a dead turn looking alive forever —
    // `recoverStaleTurns` would then never interrupt it and the transcript keeps
    // a half-written turn with no outcome, silently, on every reload.
    //
    // `heartbeatAt` reads `COALESCE(heartbeat_at, started_at)`, so the fallback
    // is asserted as the turn's own `startedAt` and **not** as `null` — see
    // `§16.1` for why an empty string there would read as "infinitely old" and
    // close a turn that was just created.
    same(
      { heartbeat: T0, startedAt: T0, unfinished: 1 },
      async (backend) => {
        const store = storeOn(backend);
        await store.appendTurn(PROMPT.turn);
        // A later `startedAt` on the replay, so a row that *did* overwrite reads
        // differently from one that kept the first write.
        await store.appendTurn({ ...PROMPT.turn, startedAt: T2 });

        const turns = await backend.db.listUnfinishedTurns({ sessionId: "s-seq" });
        return {
          heartbeat: turns[0]?.heartbeatAt,
          startedAt: turns[0]?.startedAt,
          unfinished: turns.length,
        };
      },
    ));

  it("a retried turn does not create a second prompt row — one question, one bubble", async () =>
    // The defect the prompt id being minted once in `run` exists to prevent: a
    // per-attempt id would make every retry append another `user` message to the
    // same turn. Two `user` rows in a session is an empty bubble in the
    // transcript, and it is the row that says what the user asked.
    same(
      { prompts: [["m9", 0]], userRows: 1 },
      async (backend) => {
        const store = storeOn(backend);
        await store.appendTurn(PROMPT.turn);
        await store.appendMessage(PROMPT.message);
        await store.appendMessage(PROMPT.message);
        await store.appendMessage(PROMPT.message);

        const rows = await messageSeqs(backend, "s-seq");
        return {
          prompts: rows.filter(([id]) => id === "m9"),
          userRows: (await backend.db.listMessages("s-seq")).filter(
            (message) => message.role === "user",
          ).length,
        };
      },
    ));

  it("the prompt keeps the FIRST write, not the last one that named it", async () =>
    // `SET id = excluded.id` is a deliberate no-op, so every other column keeps
    // the first write. A replay that arrived with different values must not
    // rewrite the row — the direction is the conservative one, and it is what
    // `sql.ts` states.
    same(
      { seq: 0, updatedAt: T0, role: "user", turnId: "t9" },
      async (backend) => {
        const store = storeOn(backend);
        await store.appendTurn(PROMPT.turn);
        await store.appendMessage(PROMPT.message);
        await store.appendMessage({ ...PROMPT.message, updatedAt: T2, role: "assistant" });

        const message = await backend.db.getMessage("m9");
        return {
          seq: message?.seq,
          updatedAt: message?.updatedAt,
          role: message?.role,
          turnId: message?.turnId,
        };
      },
    ));

  it("a duplicate id from ANOTHER session resolves to the original row", async () => {
    /**
     * Measured, and a property worth naming rather than discovering later: the
     * arbiter is the **primary key**, so a same-id write naming a different
     * session short-circuits before the foreign key is ever checked. The call
     * resolves, and the row it returns is the original.
     *
     * The engine cannot reach this — its `sessionId` is a field of
     * `AgentTurnOptions`, the same closure every other write on the seam uses —
     * so this is not a hole the product has. It is a fact about the statement,
     * and the statement is this layer's, so it is pinned here rather than left
     * to be found by whoever next adds a second writer. The next test is the one
     * that keeps it from reading like a permission bypass.
     */
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.appendTurn(PROMPT.turn);
      await store.appendTurn({ id: "t9", sessionId: "s1", startedAt: T2 });

      return {
        inOwn: await turnIds(backend, "s-seq"),
        // Nothing was written into the session the replay named.
        inOther: await turnIds(backend, "s1"),
      };
    });

    expect(results.memory.inOwn).toEqual(["t9"]);
    expect(results.sql.inOwn).toEqual(["t9"]);
    // `s1` still holds only the fixture's own turn. The duplicate did not move.
    expect(results.memory.inOther).toEqual(["t1"]);
    expect(results.sql.inOther).toEqual(["t1"]);
  });

  it("a NEW id in a session that does not exist is still refused, on both backends", async () => {
    // The other side of the same statement: the conflict clause only ever
    // resolves a duplicate *id*, and a first-time write has to satisfy the
    // foreign key. Without this test the previous one would look like a hole.
    const backends = await backendsWithEmptySession();

    for (const backend of [backends.memory, backends.sql] as Backend[]) {
      const turn = await failure(
        storeOn(backend).appendTurn({ id: "t-new", sessionId: "no-such-session", startedAt: T0 }),
      );
      const message = await failure(
        storeOn(backend).appendMessage({
          ...PROMPT.message,
          id: "m-new",
          sessionId: "no-such-session",
          turnId: null,
        }),
      );

      expect(turn.code, backend.name).toBe("sql_error");
      expect(message.code, backend.name).toBe("sql_error");
      expect(await turnIds(backend, "s-seq"), backend.name).toEqual([]);
      expect(await messageSeqs(backend, "s-seq"), backend.name).toEqual([]);
    }
  });

  it("the message insert names one arbiter, so UNIQUE (session_id, seq) stays loud", async () => {
    // `ON CONFLICT (id)` names **one** arbiter. A second message with a distinct
    // id whose computed `seq` collides still raises `UNIQUE (session_id, seq)` —
    // and that constraint is what turned a race between two writers into a
    // `FOREIGN KEY constraint failed` a user actually hit. `ON CONFLICT (id)` is
    // not a way to make that quieter, and the second half of the clause says so.
    expect(one(INSERT_MESSAGE)).toContain("ON CONFLICT (id) DO UPDATE SET id = excluded.id");
    expect(one(INSERT_TURN)).toContain("ON CONFLICT (id) DO UPDATE SET id = excluded.id");
    // Nothing else is in the `SET` list: a replay keeps every other column's
    // first write, and for the turn that includes *not* renewing the anchor.
    expect(one(INSERT_TURN)).not.toContain("heartbeat_at = excluded");
    expect(one(INSERT_MESSAGE)).not.toContain("updated_at = excluded");
  });

  it("a colliding seq with a different id is refused — the clause does not cover it", async () => {
    // The behaviour above, as an outcome rather than as a string. `seq` is
    // explicit here, so two distinct ids compete for position 0 and the second
    // one has to lose. A `ON CONFLICT` written without an arbiter (`DO NOTHING`
    // or `DO UPDATE` with none) would swallow this, which is the whole reason
    // the statement names `id` and not the constraint that is easiest to hit.
    const backends = await backendsWithEmptySession();

    for (const backend of [backends.memory, backends.sql] as Backend[]) {
      await backend.db.appendMessage({
        id: "m-a",
        sessionId: "s-seq",
        role: "user",
        createdAt: T0,
        updatedAt: T0,
        seq: 0,
      });
      const collision = await failure(
        backend.db.appendMessage({
          id: "m-b",
          sessionId: "s-seq",
          role: "user",
          createdAt: T0,
          updatedAt: T0,
          seq: 0,
        }),
      );

      expect(collision.code, backend.name).toBe("sql_error");
      expect(collision.message, backend.name).toMatch(/seq/i);
      // And the row that lost wrote nothing at all.
      expect(await backend.db.getMessage("m-b"), backend.name).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 1a — order: the prompt's seq is allocated before the answer's        */
/* ------------------------------------------------------------------ */

describe("a turn's rows land in a deterministic order", () => {
  it("prompt, answer and turn outcome take seq 0, 1, 2 — on both backends", async () => {
    /**
     * `Plan.md` §6.2 allocates `seq` per session and `UNIQUE (session_id, seq)`
     * is what turned a write race into a rejection. So the order is not a
     * rendering nicety: it is what makes the transcript read the way the turn
     * happened, and it is decided by **the order of the calls**, because
     * `MAX(seq) + 1` is evaluated inside the statement.
     *
     * Measured end to end, through the seam, in the order the engine writes:
     * `appendTurn` → `appendMessage` (the prompt) → the answer's own message row
     * → `finishTurn`'s `idle` outcome. All three are read back by `seq`.
     */
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.appendTurn(PROMPT.turn);
      await store.appendMessage(PROMPT.message);
      // The assistant's message. The engine does not currently write one through
      // this seam — its parts hang off the prompt's row and it mints an
      // `assistant` message id in the transcript it returns — so this is written
      // directly, and that is honest: the property under test is the *allocation
      // order of `seq`*, which is this layer's rule either way.
      await backend.db.appendMessage({
        id: "m9-answer",
        sessionId: "s-seq",
        role: "assistant",
        turnId: "t9",
        createdAt: T1,
        updatedAt: T1,
      });
      await store.finishTurn({
        turnId: "t9",
        sessionId: "s-seq",
        outcome: "succeeded",
        error: undefined,
      });

      const messages = await backend.db.listMessages("s-seq");
      return messages.map((message) => [message.seq, message.role, message.outcome]);
    });

    expect(results.memory).toEqual([
      [0, "user", null],
      [1, "assistant", null],
      [2, "idle", "succeeded"],
    ]);
    expect(results.sql).toEqual(results.memory);
  });

  it("turns and messages count `seq` independently — both start at 0", async () =>
    // `seq` is **per session and per table**, not global: `turns` and `messages`
    // each count from their own table, so a turn and the prompt that belongs to
    // it both take position 0. A reader that merged the two tables by `seq` would
    // interleave them wrongly, and the fix for that is to know they are
    // independent — which is only measurable if a test looks at both.
    //
    // The turn is written **first** (that is the engine's order, and the
    // foreign keys'), so this is also the ordering assertion in the direction
    // that a shared counter would break: with one counter, the prompt would take
    // 1.
    same(
      { turns: ["t9"], promptSeq: 0 },
      async (backend) => {
        const store = storeOn(backend);
        await store.appendTurn(PROMPT.turn);
        await store.appendMessage(PROMPT.message);

        const message = (await messageSeqs(backend, "s-seq")).find(([id]) => id === "m9");
        return { turns: await turnIds(backend, "s-seq"), promptSeq: message?.[1] };
      },
    ));

  it("a replay does not consume a seq — the duplicate resolves before the counter moves", async () =>
    // The consequence of idempotency for the ordering rule: a retried turn must
    // not push the next message one position down, or the same conversation
    // rendered differently depending on how many times it was retried.
    same(
      { answerSeq: 1, laterSeq: 2 },
      async (backend) => {
        const store = storeOn(backend);
        await store.appendTurn(PROMPT.turn);
        await store.appendMessage(PROMPT.message);
        await store.appendMessage(PROMPT.message);
        await backend.db.appendMessage({
          id: "m9-answer",
          sessionId: "s-seq",
          role: "assistant",
          turnId: "t9",
          createdAt: T1,
          updatedAt: T1,
        });

        const rows = await messageSeqs(backend, "s-seq");
        return {
          answerSeq: rows.find(([id]) => id === "m9-answer")?.[1],
          laterSeq: (
            await backend.db.appendMessage({
              id: "m9-later",
              sessionId: "s-seq",
              role: "user",
              createdAt: T2,
              updatedAt: T2,
            })
          ).seq,
        };
      },
    ));
});

/* ------------------------------------------------------------------ */
/* 1b — a rejected create is a failed turn, not a throw                 */
/* ------------------------------------------------------------------ */

describe("a rejected create is not an exception the engine has to catch twice", () => {
  it("a store that cannot create the prompt's message row leaves no half-row behind", async () => {
    /**
     * The engine's side of this is in core (`test/agent/loop.test.ts`: a
     * rejected create is a `failed` turn with `attempts: 0`). What is asserted
     * here is the *storage* half of the same event: when the message write is
     * refused, the row that did land — the turn — stays a plain unfinished
     * anchor, and the session's log is unchanged apart from it.
     *
     * The turn row surviving is the point, not an oversight: the engine
     * deliberately does **not** call `finishTurn` on this path, and the row is
     * what `recoverStaleTurns` finds on the next start-up (§6.1). A store that
     * rolled the turn back would leave the recovery with nothing to report.
     */
    const backends = await backendsWithEmptySession();

    for (const backend of [backends.memory, backends.sql] as Backend[]) {
      const store = storeOn(backend);
      // The turn lands; the message does not. That is the shape of the engine's
      // failure — `#persistPrompt` awaits the turn, then the message, then the
      // part, and any one of the three can be refused.
      await store.appendTurn(PROMPT.turn);
      const before = await idleOutcomes(backend, "s-seq");
      const outcome = await failure(
        store.appendMessage({ ...PROMPT.message, id: "m-refused", turnId: "no-such-turn" }),
      );

      expect(outcome.code, backend.name).toBe("sql_error");
      // No outcome message: `finishTurn` is not called, so `§6.2`'s "the outcome
      // is an idle message" has nothing to report, and a transcript claiming the
      // turn ended would be a claim nobody made.
      expect(await idleOutcomes(backend, "s-seq"), backend.name).toEqual(before);
      // The refused row is not there…
      expect(await backend.db.getMessage("m-refused"), backend.name).toBeNull();
      // …and the turn row **is**, which is what the next test measures.
      expect(await turnIds(backend, "s-seq"), backend.name).toEqual(["t9"]);
    }
  });

  it("the turn row the refused create left behind is exactly what recovery finds", async () => {
    // The other half of the same property, through the engine's own recovery
    // helper so the 30 s rule that ships is the one under test (as
    // `test/agent/turn-store-seam.test.ts` does on the engine side).
    //
    // The turn is written stale on purpose: `#persistPrompt` is the *first* write
    // of a turn, so a turn whose message row was refused is a turn that was
    // created and never finished — and on the next start-up that is exactly what
    // `recoverStaleTurns` has to find. A store that rolled the turn back on the
    // message's refusal would leave the recovery with nothing to report and the
    // user with a prompt that is in the log and a turn that says nothing.
    const backends = await backendsWithEmptySession();
    const stale = new Date(Date.parse("2026-09-29T12:00:00.000Z") - 120_000).toISOString();

    for (const backend of [backends.memory, backends.sql] as Backend[]) {
      const store = storeOn(backend);
      await store.appendTurn({ id: "t-orphan", sessionId: "s-seq", startedAt: stale });
      // The prompt's own message and part land; the turn then never finishes,
      // because the engine's failure path deliberately does not call
      // `finishTurn`. So the tab simply goes away mid-turn — the state
      // `recoverStaleTurns` exists for, reached the honest way rather than by
      // faking a refusal.
      await store.appendMessage({ ...PROMPT.message, id: "m-orphan", turnId: "t-orphan" });
      await store.flushDelta({
        deltaId: "d-orphan",
        partId: "p-orphan",
        messageId: "m-orphan",
        sessionId: "s-seq",
        partType: "text",
        contentText: "half a sen",
      });
    }

    const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
    const memory = await recoverStaleTurns({
      store: storeOn(backends.memory),
      sessionId: "s-seq",
      nowMs,
    });
    const sql = await recoverStaleTurns({ store: storeOn(backends.sql), sessionId: "s-seq", nowMs });

    expect(memory.map((turn) => turn.turnId)).toEqual(["t-orphan"]);
    expect(sql.map((turn) => turn.turnId)).toEqual(memory.map((turn) => turn.turnId));
    // Closed as `interrupted` — `§6.1`'s anchor, on both backends.
    expect(await idleOutcomes(backends.memory, "s-seq")).toEqual(["interrupted"]);
    expect(await idleOutcomes(backends.sql, "s-seq")).toEqual(["interrupted"]);
    // The prompt is **kept**, not discarded (§6.2: "Teilttext behalten"), and its
    // part is closed `aborted` rather than left looking like a live stream. A
    // recovery that dropped the message would leave the user with a turn that
    // ended and no record of the question that caused it.
    const kept = await backends.sql.db.listMessages("s-seq");
    expect(kept.filter((message) => message.role === "user").map((message) => message.id)).toEqual([
      "m-orphan",
    ]);
    expect((await backends.sql.db.listParts("m-orphan")).map((part) => part.status)).toEqual([
      "aborted",
    ]);
    expect((await backends.sql.db.listParts("m-orphan")).map((part) => part.contentText)).toEqual([
      "half a sen",
    ]);
    // And a second recovery adds nothing: the `listTurnOutcomes` guard, measured
    // through the same helper.
    expect(
      await recoverStaleTurns({ store: storeOn(backends.sql), sessionId: "s-seq", nowMs }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2 — flushDelta is idempotent over deltaId                            */
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
/* 3a — upsertPart: the tool part, on the row and not only in memory  */
/* ------------------------------------------------------------------ */

/** The `data` blob of a stored part, parsed, or `undefined` if it is not JSON. */
async function dataOf(part: Part): Promise<Record<string, unknown> | undefined> {
  if (typeof part.data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(part.data);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The four tool events, as the engine emits them.
 *
 * Every one carries `sessionId`, because every `AgentEvent` does — and these
 * fixtures feed `TurnStore.upsertPart`, whose input names the session **twice**
 * (once as `input.sessionId`, once as `input.event.sessionId`). The adapter
 * writes the event's, so the fixture's session has to be a session that exists:
 * `s1` is the one `bothBackends()` creates, and `m1` is its message.
 *
 * They are the *same* value here on purpose. The disagreement between the two is
 * a separate, deliberate case further down — a fixture that already disagreed
 * would make every other assertion in this file ambiguous, and `parts.session_id`
 * is `NOT NULL REFERENCES sessions(id)`, so a wrong session would surface as a
 * foreign-key error rather than as the misfiled row under test.
 */
const FIXTURE_SESSION = "s1";

const TOOL_EVENTS = {
  call: {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "read",
    input: { path: "src/app.ts" },
    sessionId: FIXTURE_SESSION,
  },
  failure: {
    type: "tool-result",
    toolCallId: "c1",
    toolName: "read",
    output: { ok: false, error: "ENOENT: no such file or directory" },
    sessionId: FIXTURE_SESSION,
  },
  unknown: {
    type: "tool-result",
    toolCallId: "c1",
    toolName: "write",
    output: {
      ok: false,
      outcome: "unknown",
      toolCallId: "c1",
      toolName: "write",
      error: "This call began but never reported a result.",
    },
    sessionId: FIXTURE_SESSION,
  },
  denied: {
    type: "tool-output-denied",
    toolCallId: "c1",
    toolName: "write",
    reason: undefined,
    sessionId: FIXTURE_SESSION,
  },
} as const satisfies Record<string, ToolPartEvent>;

describe("upsertPart writes the row the app's reader reads", () => {
  it("a failed tool lands in the DATABASE as output-error — not only in memory", async () => {
    /**
     * The rule, measured where it is persisted.
     *
     * The engine's own tests (`@all-the.rest/baah-core`,
     * `test/agent/tool-part.test.ts`) assert what `toolPartContent` *returns*,
     * because that is the engine's half. This asserts what the **row** says,
     * after JSON round-trips through a real SQLite column on one side and the
     * in-memory maps on the other — so a mapping that were right in memory and
     * lost in the serialisation, or a row the app cannot read back, is caught
     * here and nowhere else.
     *
     * `Plan.md` §3.1 makes `UIMessage[]` the storage truth, and this row is what
     * a reloaded card is drawn from. Right-while-live and wrong-after-reload is
     * the direction that hurts, so the assertion is on the row.
     */
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.call });
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.failure });

      const parts = await backend.db.listParts("m1");
      const part = parts.find((row) => row.id === "part-c1");
      return {
        rows: parts.length,
        type: part?.type,
        status: part?.status,
        state: (await dataOf(part as Part))?.["state"],
        errorText: (await dataOf(part as Part))?.["errorText"],
        discriminator: (await dataOf(part as Part))?.["type"],
      };
    });

    expect(results.memory).toEqual({
      // One row, not two: the upsert is keyed on the derived part id.
      rows: 1,
      type: "tool",
      // A tool part is never `streaming`. A card that stayed in flight across a
      // reload would be a lie about a call that finished.
      status: "completed",
      // **The whole point of the seam.** Not `output-available`.
      state: "output-error",
      errorText: "ENOENT: no such file or directory",
      // §6.1's discriminator carries the name; there is no `toolName` column.
      discriminator: "tool-read",
    });
    expect(results.sql).toEqual(results.memory);
  });

  it("the outcome-unknown envelope is NOT stored as a failure", async () => {
    /**
     * The second half, and the one with no runtime substitute: the envelope is
     * excluded by its own discriminator before `ok` is read. Filed as a failure
     * it would put "Fehlgeschlagen" on the one card whose state is a warning —
     * and unlike the plain failure case, that one is *wrong about the tool*,
     * because the tool never reported at all.
     */
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.unknown });
      const part = (await backend.db.listParts("m1")).find((row) => row.id === "part-c1");
      const data = await dataOf(part as Part);
      return { state: data?.["state"], errorText: data?.["errorText"] ?? null };
    });

    expect(results.memory).toEqual({ state: "output-available", errorText: null });
    expect(results.sql).toEqual(results.memory);
  });

  it("a denial is stored as a refusal, not a malfunction (§7.6)", async () =>
    same({ state: "output-denied", errorText: null }, async (backend) => {
      await storeOn(backend).upsertPart({
        sessionId: "s1",
        messageId: "m1",
        event: TOOL_EVENTS.denied,
      });
      const part = (await backend.db.listParts("m1")).find((row) => row.id === "part-c1");
      const data = await dataOf(part as Part);
      return { state: data?.["state"], errorText: data?.["errorText"] ?? null };
    }));

  it("the three events for one call land on ONE row, and the last one wins", async () =>
    // The ordering the engine's `await` on this method buys, seen from the
    // database: call, then a result that failed, then a denial for the same
    // `toolCallId`. Fired rather than awaited, the result could be overtaken and
    // the row left at `input-available` — persisted, and corrected by no reload.
    //
    // The denial is last and it wins, which is the point of the test's shape: it
    // is the *last* write, so a row reading anything else means the writes are
    // not landing in order.
    same({ rows: 1, state: "output-denied" }, async (backend) => {
      const store = storeOn(backend);
      for (const event of [TOOL_EVENTS.call, TOOL_EVENTS.failure, TOOL_EVENTS.denied]) {
        await store.upsertPart({ sessionId: "s1", messageId: "m1", event });
      }

      const parts = await backend.db.listParts("m1");
      const part = parts.find((row) => row.id === "part-c1");
      return { rows: parts.length, state: (await dataOf(part as Part))?.["state"] };
    }));

  it("the last write for an id wins, and that is the whole contract", async () =>
    // Stated rather than left implicit, because it is the decision a reader of
    // `UPSERT_PART` has to be able to predict: `ON CONFLICT (id) DO UPDATE SET
    // data = excluded.data` overwrites. So a *second* `tool-call` for a
    // `toolCallId` that already has a result does move the row back to
    // `input-available`.
    //
    // The engine does not emit that order — it emits the events as they arrive,
    // and a provider that reuses an id mid-turn has already lost the
    // correspondence between call and result (`Plan.md` §5.1 names `occurrence`
    // for exactly that, on the *invocation* record). The part row has no such key
    // and inventing one here would be a second definition of the same rule on a
    // different table. So the honest thing is to pin the behaviour the statement
    // has, and leave the correction to the engine that knows the ordering.
    same({ rows: 1, state: "input-available", errorText: null }, async (backend) => {
      const store = storeOn(backend);
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.failure });
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.call });

      const part = (await backend.db.listParts("m1")).find((row) => row.id === "part-c1");
      const data = await dataOf(part as Part);
      return {
        rows: (await backend.db.listParts("m1")).length,
        state: data?.["state"],
        errorText: data?.["errorText"] ?? null,
      };
    }));

  it("the upsert keeps the part's position, so a card updates instead of jumping", async () =>
    // `Plan.md` §16.1: the upsert keeps `seq` and `created_at`. Without that a
    // card that changes state once would move down the transcript, and the
    // reader would have to re-sort by something that is not the log order.
    same({ seqs: [0, 1], sameSeq: 0, createdAt: T1 }, async (backend) => {
      const store = storeOn(backend);
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.call });
      // A text part written after the tool part, so the tool's `seq` is 0 and
      // this second write has something to *not* move.
      await store.flushDelta({
        deltaId: "d1",
        partId: "p1",
        messageId: "m1",
        sessionId: "s1",
        partType: "text",
        contentText: "after",
      });
      const before = (await backend.db.listParts("m1")).find((row) => row.id === "part-c1");
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.failure });
      const after = (await backend.db.listParts("m1")).find((row) => row.id === "part-c1");

      return {
        seqs: (await backend.db.listParts("m1")).map((row) => row.seq),
        sameSeq: after?.seq === before?.seq ? 0 : -1,
        createdAt: after?.createdAt === T1 ? T1 : String(after?.createdAt),
      };
    }));

  it("`content_text` is the rendered input, so a search finds the call", async () =>
    // §6.1's denormalised projection, and the reason the tool part carries one at
    // all: it is what FTS5 indexes. A tool part with an empty `content_text`
    // would be invisible to search while its text sat right there in `data`.
    //
    // The query is a **bare token** on purpose. FTS5 treats `.` as query syntax
    // and a dotted term is a syntax error rather than a zero-hit result
    // (measured: `SQLITE_ERROR … fts5: syntax error near "."`), which is a
    // property of the engine this layer does not paper over — `§16.1` already
    // records that a malformed `MATCH` behaves differently from the memory
    // engine's matcher. So the test searches a token the stored text really
    // contains, which is what a caller would do.
    same(
      { contains: true, searchFinds: 1 },
      async (backend) => {
        const store = storeOn(backend);
        await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.call });
        const part = (await backend.db.listParts("m1")).find((row) => row.id === "part-c1");
        const hits = await backend.db.search({ query: "app" });
        return {
          contains: (part?.contentText ?? "").includes("src/app.ts"),
          searchFinds: hits.filter((hit) => hit.partId === "part-c1").length,
        };
      },
    ));

  it("a message of ANOTHER session is not refused — measured, and named", async () => {
    /**
     * **A finding about the schema, and it is still true — but the seam no longer
     * walks into it.**
     *
     * `parts` carries two *independent* foreign keys (`schema.ts`):
     * `message_id REFERENCES messages(id)` and
     * `session_id REFERENCES sessions(id)`. Nothing ties them to each other, so a
     * write naming a message of `s1` and a session of `s2` satisfies both and
     * lands. Measured below on both backends, and the memory engine behaves the
     * same way — so this is the schema's shape, not a divergence.
     *
     * **What changed is who can reach it.** This test used to drive it through
     * `upsertPart`, and the row landed under the argument's session. The adapter
     * now writes the *event's* session (`turn-store.ts`, `upsertPart`), and the
     * event is stamped at the engine's one emit sink from the same
     * `AgentLoopOptions.sessionId` closure that minted the message id — so
     * passing a foreign `input.sessionId` no longer moves anything. The case is
     * therefore driven here through `database.upsertPart`, the write underneath,
     * which is the honest place to show that the *database* has no such
     * constraint.
     *
     * It is kept rather than deleted because the obvious next test — "a
     * cross-session part is refused" — is **still false**, and a reader who writes
     * it will find it green on a fake and ship a claim the database does not
     * enforce. Closing it properly needs a composite `messages (id, session_id)`
     * reference, which is a migration and therefore a rebuild (`§16.1`'s
     * "Parkplatz-Tabelle" trap). Not done here, named instead.
     */
    const results = await onBoth(async (backend) => {
      const outcome = await settled(
        backend.db.upsertPart({
          id: "part-c1",
          messageId: "m1",
          // `m1` belongs to `s1`; `s2` is a different, real session.
          sessionId: "s2",
          type: "tool",
          contentText: "read src/app.ts",
          data: "{}",
          status: "completed",
          createdAt: T1,
          updatedAt: T1,
        }),
      );
      const parts = await backend.db.listParts("m1");
      return {
        // It **resolved** — no `sql_error` to catch.
        resolved: outcome.ok,
        // …and the row is filed under the message it named, carrying the *other*
        // session's id. This is the bleed, stated exactly.
        rows: parts.filter((row) => row.id === "part-c1").length,
        sessionIds: parts.filter((row) => row.id === "part-c1").map((row) => row.sessionId),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].resolved, backend).toBe(true);
      expect(results[backend].rows, backend).toBe(1);
      expect(results[backend].sessionIds, backend).toEqual(["s2"]);
    }
  });

  it("…but the store itself can no longer be walked into it", async () => {
    /**
     * The half that changed, and the reason the test above was re-pointed rather
     * than removed.
     *
     * Same disagreement as the finding — the argument says `s2`, the message
     * belongs to `s1` — but driven the way the engine drives it. The row lands
     * under `s1`, because the adapter writes the event's session and the event is
     * the engine's own. So the schema's missing constraint is still missing, and
     * the seam in front of it no longer depends on it.
     */
    const results = await onBoth(async (backend) => {
      await storeOn(backend).upsertPart({
        sessionId: "s2",
        messageId: "m1",
        event: TOOL_EVENTS.call,
      });
      const parts = await backend.db.listParts("m1");
      return {
        rows: parts.filter((row) => row.id === "part-c1").length,
        sessionIds: parts.filter((row) => row.id === "part-c1").map((row) => row.sessionId),
      };
    });

    for (const backend of ["memory", "sql"] as const) {
      expect(results[backend].rows, backend).toBe(1);
      expect(results[backend].sessionIds, backend).toEqual(["s1"]);
    }
  });

  it("a message that exists in NO session is refused, on both backends", async () => {
    // The constraint that *is* enforced, and the reason the test above is a
    // finding rather than the rule: `message_id` is a real foreign key, so a
    // message that is not there at all refuses. Only the *pairing* of a real
    // message with a different real session is unconstrained.
    const backends = await bothBackends();

    for (const backend of [backends.memory, backends.sql] as Backend[]) {
      const refused = await failure(
        storeOn(backend).upsertPart({
          sessionId: "s1",
          messageId: "m-nowhere",
          event: TOOL_EVENTS.call,
        }),
      );

      expect(refused.code, backend.name).toBe("sql_error");
      expect(await backend.db.listParts("m-nowhere"), backend.name).toEqual([]);
    }
  });

  it("writes one statement per call — no read, no transaction", async () => {
    // The one-statement discipline the two closes hold, and the reason a tool
    // part may be written per event: there is nothing to read, so nothing can be
    // overtaken between a read and the write that follows it. The upsert is one
    // statement and nothing else, on the SQL side and in the memory engine's own
    // log.
    const { memory, sql } = await bothBackends();
    const before = sql.statements().length;
    const memoryBefore = memory.statements().length;

    await storeOn(sql).upsertPart({
      sessionId: "s1",
      messageId: "m1",
      event: TOOL_EVENTS.failure,
    });
    await storeOn(memory).upsertPart({
      sessionId: "s1",
      messageId: "m1",
      event: TOOL_EVENTS.failure,
    });

    const ran = canonical(sql.statements().slice(before));
    const ranMemory = canonical(memory.statements().slice(memoryBefore));
    expect(ran).toHaveLength(1);
    expect(one(ran[0] ?? "")).toContain("INSERT INTO parts");
    expect(one(ran[0] ?? "")).toContain("ON CONFLICT (id) DO UPDATE");
    expect(ran.filter((statement) => statement.startsWith("BEGIN"))).toHaveLength(0);
    // The memory engine ran the same single statement, recognised by identity.
    expect(ranMemory).toHaveLength(1);
  });
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

/* ------------------------------------------------------------------ */
/* 7 — the store follows the event, not the instruction                 */
/* ------------------------------------------------------------------ */

/**
 * `TurnStore.upsertPart` is the **only** seam where an event value becomes a store
 * write, and therefore the only place where "which session does this belong to?"
 * can be answered from two sources that are allowed to disagree.
 *
 * ## The shape of the divergence
 *
 * The engine emits every tool event twice over to the adapter today: once as
 * `input.event` (stamped with the session at the engine's single emit sink) and
 * once as `input.sessionId` (the seam's argument, threaded from the same
 * `AgentLoopOptions.sessionId`). They are the same string by construction, so
 * **every other test in this file passes with either one being written** — which
 * is exactly why the choice has to be pinned rather than left to reading.
 *
 * The test builds the disagreement deliberately: the argument names `s1`, the
 * event names `s2`. Both sessions exist (`bothBackends()` creates them), and the
 * part's message belongs to `s1` — so the *only* thing that decides where the row
 * is filed is which of the two strings the adapter writes.
 *
 * ## Why the event wins
 *
 * `input.sessionId` is an instruction: whoever calls `upsertPart` writes it, and
 * nothing verifies it. `input.event.sessionId` is what the event **says**, and the
 * same string went to the subscriber in `runtime/index.ts` — the fold that is
 * drawing the card right now. A part filed under the instruction's session while
 * the event names another is a tool card in the wrong conversation, and no later
 * read would report the disagreement: the row exists, its `message_id` resolves,
 * and the transcript renders it confidently.
 *
 * So the direction is the conservative one for the *reader*: the row lands where
 * the event said, and the instruction that disagrees is the thing that is wrong.
 */
describe("upsertPart files the row under the EVENT's session, not the argument's", () => {
  it("an argument naming another session does not move the part", async () => {
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      // The disagreement: the instruction says `s1`, the evidence says `s2`.
      const event: ToolPartEvent = { ...TOOL_EVENTS.call, sessionId: "s2" };
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event });

      const parts = await backend.db.listParts("m1");
      const part = parts.find((row) => row.id === "part-c1");
      return { rows: parts.length, sessionId: part?.sessionId ?? null };
    });

    expect(results.memory).toEqual({ rows: 1, sessionId: "s2" });
    expect(results.sql).toEqual(results.memory);
  });

  it("and the row is invisible to the session the instruction named", async () => {
    /**
     * The consequence, measured through the **public read** rather than the
     * column: the point is not that `session_id` says `s2`, it is that a
     * transcript read of `s1` — which owns `m1` — does not show the tool part.
     *
     * A column assertion would pass against a row that is filed correctly *and*
     * still somehow listed in both places; `listParts(messageId)` is scoped by
     * the message, so this is the read an app actually performs, and it is the
     * read that must not leak across the boundary.
     */
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      const event: ToolPartEvent = { ...TOOL_EVENTS.call, sessionId: "s2" };
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event });

      const parts = await backend.db.listParts("m1");
      const sessions = parts.map((row) => row.sessionId);
      return {
        // Every part of `m1` names `s2`, so nothing here is filed under `s1`.
        distinctSessions: [...new Set(sessions)].toSorted(),
        hasS1: sessions.includes("s1"),
        state: (await dataOf(parts.find((row) => row.id === "part-c1") as Part))?.["state"],
      };
    });

    expect(results.memory).toEqual({ distinctSessions: ["s2"], hasS1: false, state: "input-available" });
    expect(results.sql).toEqual(results.memory);
  });

  it("when the two agree, the behaviour is the plain one — this is not a special case", async () => {
    /**
     * The control, and it is what makes the two tests above meaningful: an
     * adapter that ignored the event entirely and always wrote some hard-coded
     * session would also pass them, if that session happened to be `s2`. So the
     * agreeing case is asserted too — same call, `sessionId` on both sides, and
     * the row lands where both of them say.
     */
    const results = await onBoth(async (backend) => {
      const store = storeOn(backend);
      await store.upsertPart({ sessionId: "s1", messageId: "m1", event: TOOL_EVENTS.call });
      const parts = await backend.db.listParts("m1");
      return { sessionId: parts.find((row) => row.id === "part-c1")?.sessionId ?? null };
    });

    expect(results.memory).toEqual({ sessionId: "s1" });
    expect(results.sql).toEqual(results.memory);
  });
});
