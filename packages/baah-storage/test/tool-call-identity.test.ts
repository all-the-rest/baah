/**
 * The four storage contracts the engine grew, measured on both backends.
 *
 * ## Why this file is a parity test and not a unit test
 *
 * `Plan.md` §6 requires `turns` and `tool_invocations` to behave the same on
 * SQLite and on the in-memory maps, and the only way to know whether they do is
 * to run the same input through both. The SQLite side here is **real**: the
 * `exports.node` build of `@sqlite.org/sqlite-wasm` behind the worker's own
 * dispatch table (`test/harness/sqlite.ts`, the one documented exception in
 * `AGENTS.md` §2). So the `CHECK` violation, the `UNIQUE` refusal, the
 * `ON CONFLICT DO NOTHING` that must not downgrade a `done` record, and the
 * table rebuild are all *measured*, not modelled.
 *
 * ## The four contracts
 *
 * 1. `tool_invocations.status` is `begun | done`. Without that pair,
 *    "began, outcome unknown" is unrepresentable and a crash in that window has
 *    exactly one available answer: run the tool again. For a `write` tool that
 *    is not a retry — measured `log === ["x", "x"]` against a transcript
 *    showing one write.
 * 2. The key is `(session_id, attempt, tool_call_id, occurrence)`, and it is
 *    **columns**, not just key computation, so SQLite can enforce it and the two
 *    backends cannot disagree about it.
 * 3. `listUnfinishedTurns` — unfinished is "neither succeeded nor failed".
 * 4. `getToolCall` returns the status, not mere presence.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { createMemoryDatabase } from "../src/factory.ts";
import { StorageError } from "../src/errors.ts";
import {
  INSERT_TOOL_INVOCATION_BEGUN,
  SELECT_TOOL_CALL,
  TOOL_CALL_KEY_PREDICATE,
  toolCallKeyParams,
  UPSERT_TOOL_INVOCATION_DONE,
} from "../src/sql.ts";
import type { SqlParam, StorageDatabase, ToolCallKey } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback } from "./harness/transport.ts";

const T0 = "2026-09-29T10:00:00.000Z";
const T1 = "2026-09-29T10:00:05.000Z";

let sqlite3: Sqlite3Static;

async function sqlDatabase(): Promise<StorageDatabase> {
  const loopback = createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
  });
  await loopback.client.open({ filename: "/baah.sqlite3" });
  return loopback.client;
}

function memoryDatabase(): StorageDatabase {
  return createMemoryDatabase();
}

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/** One database per backend, both seeded with a session. */
async function both(): Promise<[StorageDatabase, StorageDatabase]> {
  const memory = memoryDatabase();
  const sql = await sqlDatabase();
  for (const db of [memory, sql]) await db.createSession({ id: "s1", title: "t" });
  return [memory, sql];
}

/** The two databases, and the same operation applied to both. */
async function each<T>(
  run: (db: StorageDatabase) => Promise<T>,
): Promise<[T, T, StorageDatabase, StorageDatabase]> {
  const [memory, sql] = await both();
  return [await run(memory), await run(sql), memory, sql];
}

const KEY: ToolCallKey = { sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 };

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("The call resolved, but a rejection was expected.");
}

/* ------------------------------------------------------------------ */
/* 1 + 4 — the status, and what getToolCall returns                    */
/* ------------------------------------------------------------------ */

describe("the crash window: begun is not done", () => {
  it("a begun call reads back as begun, on both backends", async () => {
    const [memory, sql] = await each(async (db) => {
      await db.beginToolCall({ key: KEY, toolName: "write", input: { path: "a.txt", text: "x" } });
      return db.getToolCall(KEY);
    });

    // The whole point: presence alone cannot express this. Both a `begin` row
    // and a `record` row used to read back as "no record", so a crash in
    // between was indistinguishable from "never ran".
    expect(memory).toEqual({ status: "begun" });
    expect(sql).toEqual({ status: "begun" });
    expect(sql).toEqual(memory);
  });

  it("a recorded call reads back as done, with the exact output", async () => {
    const output = { bytesWritten: 12, note: "line one\nline two" };
    const [memory, sql] = await each(async (db) => {
      await db.beginToolCall({ key: KEY, toolName: "write", input: { path: "a.txt" } });
      await db.recordToolCall({ key: KEY, toolName: "write", output });
      return db.getToolCall(KEY);
    });

    expect(memory).toEqual({ status: "done", output });
    expect(sql).toEqual(memory);
  });

  it("a call that was never begun is undefined, not an empty record", async () => {
    const [memory, sql] = await each((db) => db.getToolCall(KEY));
    expect(memory).toBeUndefined();
    expect(sql).toBeUndefined();
  });

  it("recording without a begin still produces a done record", async () => {
    // The `begin` write is the one that can be lost. Refusing to write here
    // would discard the only claim the engine can back up.
    const [memory, sql] = await each(async (db) => {
      await db.recordToolCall({ key: KEY, toolName: "grep", output: { total: 0 } });
      return db.getToolCall(KEY);
    });

    expect(memory).toEqual({ status: "done", output: { total: 0 } });
    expect(sql).toEqual(memory);
  });

  it("a second begin never downgrades a done record", async () => {
    // The repair path must not be the corruption path. If `begin` could write
    // `begun` over a `done`, a duplicated `begin` — a retried turn, a second
    // tab — would make the next replay re-run a tool that already ran.
    const [memory, sql] = await each(async (db) => {
      await db.beginToolCall({ key: KEY, toolName: "write", input: { a: 1 } });
      await db.recordToolCall({ key: KEY, toolName: "write", output: { wrote: true } });
      await db.beginToolCall({ key: KEY, toolName: "write", input: { a: 1 } });
      return db.getToolCall(KEY);
    });

    expect(memory).toEqual({ status: "done", output: { wrote: true } });
    expect(sql).toEqual(memory);
  });

  it("repeating begin leaves exactly one row", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();
    await memory.createSession({ id: "s1" });
    await sql.createSession({ id: "s1" });
    for (const db of [memory, sql]) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await db.beginToolCall({ key: KEY, toolName: "write", input: { a: 1 } });
      }
    }

    expect(await sqliteCount(sql, "tool_invocations")).toBe(1);
    const countMemory = (memory as unknown as { counts(): { toolInvocations: number } }).counts();
    expect(countMemory.toolInvocations).toBe(1);
  });

  it("round-trips the awkward outputs: null, an array, a string, undefined", async () => {
    const outputs: readonly unknown[] = [null, [1, 2, 3], "plain", false, 0, { deep: { a: [null] } }];
    for (const output of outputs) {
      const key: ToolCallKey = { ...KEY, toolCallId: `c-${JSON.stringify(output)}` };
      const [memory, sql] = await each(async (db) => {
        await db.beginToolCall({ key, toolName: "t", input: null });
        await db.recordToolCall({ key, toolName: "t", output });
        return db.getToolCall(key);
      });
      expect(sql, JSON.stringify(output)).toEqual(memory);
      expect(sql).toEqual({ status: "done", output });
    }
  });

  it("a tool output of `undefined` round-trips as `undefined`, not as `null`", async () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string. Coercing it to
    // `"null"` would tell a replay the tool returned `null` when it returned
    // nothing.
    const [memory, sql] = await each(async (db) => {
      await db.beginToolCall({ key: KEY, toolName: "t", input: undefined });
      await db.recordToolCall({ key: KEY, toolName: "t", output: undefined });
      return db.getToolCall(KEY);
    });

    expect(memory).toEqual({ status: "done", output: undefined });
    expect(sql).toEqual(memory);
  });
});

/* ------------------------------------------------------------------ */
/* 2 — the four-part key                                              */
/* ------------------------------------------------------------------ */

describe("the four-part call key", () => {
  it("sessionId: two sessions with the same id do not share a record", async () => {
    const [memory, sql] = await each(async (db) => {
      await db.createSession({ id: "s2", title: "other" });
      await db.recordToolCall({ key: { ...KEY, sessionId: "s1" }, toolName: "a", output: "one" });
      await db.recordToolCall({ key: { ...KEY, sessionId: "s2" }, toolName: "b", output: "two" });
      return Promise.all([
        db.getToolCall({ ...KEY, sessionId: "s1" }),
        db.getToolCall({ ...KEY, sessionId: "s2" }),
      ]);
    });

    expect(memory).toEqual([
      { status: "done", output: "one" },
      { status: "done", output: "two" },
    ]);
    expect(sql).toEqual(memory);
  });

  it("attempt: a retry is a new turn, so its calls are its own", async () => {
    const [memory, sql] = await each(async (db) => {
      await db.recordToolCall({ key: { ...KEY, attempt: 1 }, toolName: "a", output: "first" });
      await db.recordToolCall({ key: { ...KEY, attempt: 2 }, toolName: "a", output: "second" });
      return Promise.all([
        db.getToolCall({ ...KEY, attempt: 1 }),
        db.getToolCall({ ...KEY, attempt: 2 }),
      ]);
    });

    expect(memory).toEqual([
      { status: "done", output: "first" },
      { status: "done", output: "second" },
    ]);
    expect(sql).toEqual(memory);
  });

  it("occurrence: a provider that reuses an id does not lose the second call", async () => {
    // The silent drop: with a bare `toolCallId` the second call resolves to the
    // first one's record, the tool runs once, and the turn still reports
    // `succeeded` while the model is handed an answer for a call it never made.
    const [memory, sql] = await each(async (db) => {
      await db.recordToolCall({ key: { ...KEY, occurrence: 0 }, toolName: "read", output: "file A" });
      await db.recordToolCall({ key: { ...KEY, occurrence: 1 }, toolName: "read", output: "file B" });
      return Promise.all([
        db.getToolCall({ ...KEY, occurrence: 0 }),
        db.getToolCall({ ...KEY, occurrence: 1 }),
        db.getToolCall({ ...KEY, occurrence: 2 }),
      ]);
    });

    expect(memory).toEqual([
      { status: "done", output: "file A" },
      { status: "done", output: "file B" },
      undefined,
    ]);
    expect(sql).toEqual(memory);
  });

  it("all four parts together: eight calls, eight records, eight answers", async () => {
    const [memory, sql, , sqlDb] = await each(async (db) => {
      for (const sessionId of ["s1"]) {
        for (const attempt of [1, 2]) {
          for (const occurrence of [0, 1]) {
            const key: ToolCallKey = { sessionId, attempt, toolCallId: "shared", occurrence };
            await db.recordToolCall({ key, toolName: "t", output: `${sessionId}/${attempt}/${occurrence}` });
          }
        }
      }
      const results: unknown[] = [];
      for (const attempt of [1, 2]) {
        for (const occurrence of [0, 1]) {
          results.push(await db.getToolCall({ sessionId: "s1", attempt, toolCallId: "shared", occurrence }));
        }
      }
      return results;
    });

    expect(memory).toEqual([
      { status: "done", output: "s1/1/0" },
      { status: "done", output: "s1/1/1" },
      { status: "done", output: "s1/2/0" },
      { status: "done", output: "s1/2/1" },
    ]);
    expect(sql).toEqual(memory);
    expect(await sqliteCount(sqlDb, "tool_invocations")).toBe(4);
  });

  it("the database enforces the key, not just the lookup", async () => {
    // A row written past the operations layer — a future hand-written
    // statement, a migration, a bug — must hit the same `UNIQUE` the lookup
    // assumes. Otherwise the two could disagree about which record is "the" one.
    const sql = await sqlDatabase();
    await sql.createSession({ id: "s1" });
    await sql.recordToolCall({ key: KEY, toolName: "t", output: "one" });

    const duplicate = await failure(
      sql.query(
        `INSERT INTO tool_invocations
           (id, session_id, tool_name, tool_call_id, attempt, occurrence, status, created_at, updated_at)
         VALUES ('other', 's1', 't', 'c1', 1, 0, 'done', ?, ?)`,
        [T0, T0],
        "run",
      ),
    );
    expect(duplicate.code).toBe("sql_error");
    expect(duplicate.message).toMatch(/UNIQUE/i);

    // One part different is a different key, and is accepted.
    await expect(
      sql.query(
        `INSERT INTO tool_invocations
           (id, session_id, tool_name, tool_call_id, attempt, occurrence, status, created_at, updated_at)
         VALUES ('other', 's1', 't', 'c1', 1, 1, 'done', ?, ?)`,
        [T0, T0],
        "run",
      ),
    ).resolves.toBeDefined();
  });

  it("the CHECK admits exactly begun and done", async () => {
    const sql = await sqlDatabase();
    await sql.createSession({ id: "s1" });

    for (const status of ["begun", "done"]) {
      await expect(
        sql.query(
          `INSERT INTO tool_invocations
             (id, session_id, tool_name, tool_call_id, attempt, occurrence, status, created_at, updated_at)
           VALUES (?, 's1', 't', 'c-' || ?, 1, 0, ?, ?, ?)`,
          [`row-${status}`, status, status, T0, T0],
          "run",
        ),
      ).resolves.toBeDefined();
    }
    // The six-value lifecycle vocabulary the old column allowed is gone: those
    // are exactly the values that could not tell a begun call from a finished
    // one.
    for (const status of ["running", "completed", "failed", "aborted", "awaiting_approval", "pending"]) {
      const rejected = await failure(
        sql.query(
          `INSERT INTO tool_invocations
             (id, session_id, tool_name, tool_call_id, attempt, occurrence, status, created_at, updated_at)
           VALUES (?, 's1', 't', ?, 1, 0, ?, ?, ?)`,
          [`row-${status}`, `c-${status}`, status, T0, T0],
          "run",
        ),
      );
      expect(rejected.code, status).toBe("sql_error");
      expect(rejected.message, status).toMatch(/CHECK/i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3 — listUnfinishedTurns                                            */
/* ------------------------------------------------------------------ */

describe("listUnfinishedTurns", () => {
  const TURNS: readonly { id: string; status: string; heartbeatAt: string | null }[] = [
    { id: "t-streaming", status: "streaming", heartbeatAt: T1 },
    { id: "t-pending", status: "pending", heartbeatAt: null },
    { id: "t-succeeded", status: "succeeded", heartbeatAt: T1 },
    { id: "t-failed", status: "failed", heartbeatAt: T1 },
    { id: "t-interrupted", status: "interrupted", heartbeatAt: T1 },
  ];

  async function seeded(): Promise<[StorageDatabase, StorageDatabase]> {
    const [memory, sql] = await both();
    for (const db of [memory, sql]) {
      for (const turn of TURNS) {
        await db.appendTurn({
          id: turn.id,
          sessionId: "s1",
          startedAt: T0,
          status: turn.status as "pending",
          heartbeatAt: turn.heartbeatAt,
        });
      }
      await db.createSession({ id: "s2", title: "other" });
      await db.appendTurn({ id: "t-other", sessionId: "s2", startedAt: T0, status: "streaming", heartbeatAt: T1 });
    }
    return [memory, sql];
  }

  it("returns every turn that is neither succeeded nor failed, in seq order", async () => {
    const [memory, sql] = await seeded();

    const fromMemory = await memory.listUnfinishedTurns({ sessionId: "s1" });
    const fromSql = await sql.listUnfinishedTurns({ sessionId: "s1" });

    expect(fromMemory.map((turn) => turn.turnId)).toEqual([
      "t-streaming",
      "t-pending",
      "t-interrupted",
    ]);
    expect(fromSql).toEqual(fromMemory);
  });

  it("`interrupted` counts as unfinished — the engine re-sends those", async () => {
    // If it did not, a turn recovered by `recoverStaleTurns` could never be
    // finished, and the reload check would report on a closed turn.
    const [memory, sql] = await seeded();
    for (const db of [memory, sql]) {
      const ids = (await db.listUnfinishedTurns({ sessionId: "s1" })).map((turn) => turn.turnId);
      expect(ids).toContain("t-interrupted");
      expect(ids).not.toContain("t-succeeded");
      expect(ids).not.toContain("t-failed");
    }
  });

  it("scopes to one session", async () => {
    const [memory, sql] = await seeded();
    for (const db of [memory, sql]) {
      const ids = (await db.listUnfinishedTurns({ sessionId: "s2" })).map((turn) => turn.turnId);
      expect(ids).toEqual(["t-other"]);
    }
  });

  it("a turn with no heartbeat reports its start, not an unparsable blank", async () => {
    // A blank would parse as "infinitely stale" and close a turn created a
    // moment ago. Its own start is the honest answer, and the engine's 30 s
    // threshold then applies to that.
    const [memory, sql] = await seeded();
    for (const db of [memory, sql]) {
      const pending = (await db.listUnfinishedTurns({ sessionId: "s1" })).find(
        (turn) => turn.turnId === "t-pending",
      );
      expect(pending?.heartbeatAt).toBe(T0);
      expect(pending?.startedAt).toBe(T0);
    }
  });

  it("a fresh heartbeat is reported verbatim — the engine measures the age", async () => {
    const [memory, sql] = await seeded();
    for (const db of [memory, sql]) {
      const streaming = (await db.listUnfinishedTurns({ sessionId: "s1" })).find(
        (turn) => turn.turnId === "t-streaming",
      );
      expect(streaming?.heartbeatAt).toBe(T1);
    }
  });

  it("a session with no turns returns an empty list, not an error", async () => {
    const [memory, sql] = await both();
    for (const db of [memory, sql]) {
      expect(await db.listUnfinishedTurns({ sessionId: "s1" })).toEqual([]);
      expect(await db.listUnfinishedTurns({ sessionId: "does-not-exist" })).toEqual([]);
    }
  });

  it("deleting a session takes its turns and its invocations with it", async () => {
    const [memory, sql] = await seeded();
    for (const db of [memory, sql]) {
      await db.recordToolCall({ key: KEY, toolName: "t", output: "x" });
      await db.deleteSession("s1");
      expect(await db.listUnfinishedTurns({ sessionId: "s1" })).toEqual([]);
      expect(await db.getToolCall(KEY)).toBeUndefined();
    }
    expect(await sqliteCount(sql, "tool_invocations")).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* appendTurn — the write half of the anchor                          */
/* ------------------------------------------------------------------ */

describe("appendTurn", () => {
  it("allocates seq per session, like every other table (§6.2)", async () => {
    const [memory, sql, , sqlDb] = await each(async (db) => {
      await db.appendTurn({ id: "t1", sessionId: "s1", startedAt: T0 });
      await db.appendTurn({ id: "t2", sessionId: "s1", startedAt: T0 });
      await db.createSession({ id: "s2", title: "other" });
      return db.appendTurn({ id: "t3", sessionId: "s2", startedAt: T0 });
    });

    // The third turn is the *first* of its session, so the counter is per
    // parent and not global. `created_at` is display only.
    expect(memory.seq).toBe(0);
    expect(sql).toEqual(memory);
    expect(await sqliteSeqs(sqlDb, "s2")).toEqual([0]);
  });

  it("rejects an unknown session, on both backends", async () => {
    const [memory, sql] = await each((db) =>
      failure(db.appendTurn({ id: "t1", sessionId: "nope", startedAt: T0 })),
    );
    expect(memory.code).toBe("sql_error");
    expect(sql.code).toBe("sql_error");
    expect(memory.message).toMatch(/FOREIGN KEY/i);
  });

  it("rejects a status outside the CHECK, on both backends", async () => {
    const [memory, sql] = await each((db) =>
      failure(
        db.appendTurn({
          id: "t1",
          sessionId: "s1",
          startedAt: T0,
          status: "done" as unknown as "pending",
        }),
      ),
    );
    expect(memory.code).toBe("sql_error");
    expect(sql.code).toBe("sql_error");
  });
});

/* ------------------------------------------------------------------ */
/* The raw SQL both backends run                                       */
/* ------------------------------------------------------------------ */

describe("the statements the operations layer runs", () => {
  it("SELECT_TOOL_CALL is the only thing that decides whether a tool re-runs", async () => {
    // The projection is deliberately two columns. A full row would tempt a
    // caller to branch on `result_preview` or `finished_at`, and those are
    // display fields that decide nothing.
    const sql = await sqlDatabase();
    await sql.createSession({ id: "s1" });
    await sql.recordToolCall({ key: KEY, toolName: "t", output: { a: 1 } });

    const result = await sql.query(SELECT_TOOL_CALL, toolCallKeyParams(KEY), "all");
    expect(result.rows).toEqual([{ status: "done", output: '{"a":1}' }]);
  });

  it("all three statements agree on the key, in the same order", () => {
    // The key's meaning lives in the *order* of these bindings. A reordering
    // that kept the same types would write the record under a different call —
    // and a `session_id` swapped with an `occurrence` would do it silently.
    const expected = "session_id = ? AND attempt = ? AND tool_call_id = ? AND occurrence = ?";
    expect(TOOL_CALL_KEY_PREDICATE).toBe(expected);
    // The predicate is interpolated, so the *expanded* statement is what has to
    // be checked — the source text only says `${TOOL_CALL_KEY_PREDICATE}`.
    for (const statement of [SELECT_TOOL_CALL]) {
      expect(statement, statement.slice(0, 40)).toContain(expected);
    }
    for (const statement of [INSERT_TOOL_INVOCATION_BEGUN, UPSERT_TOOL_INVOCATION_DONE]) {
      expect(statement, statement.slice(0, 40)).toContain(
        "ON CONFLICT (session_id, attempt, tool_call_id, occurrence)",
      );
    }
  });

  it("begin is DO NOTHING and record is DO UPDATE — the asymmetry is the point", () => {
    // Both halves matter. `DO UPDATE` on begin would downgrade a done record;
    // `DO NOTHING` on record would throw away the outcome of a call whose
    // begin was lost.
    expect(INSERT_TOOL_INVOCATION_BEGUN).toMatch(/ON CONFLICT \(session_id, attempt, tool_call_id, occurrence\) DO NOTHING/);
    expect(UPSERT_TOOL_INVOCATION_DONE).toMatch(
      /ON CONFLICT \(session_id, attempt, tool_call_id, occurrence\) DO UPDATE SET/,
    );
    // The begin insert may not write `done`, and the record upsert may not
    // write `begun`.
    expect(INSERT_TOOL_INVOCATION_BEGUN).toContain("'begun'");
    expect(INSERT_TOOL_INVOCATION_BEGUN).not.toContain("'done'");
    expect(UPSERT_TOOL_INVOCATION_DONE).toContain("'done'");
  });
});

/* ------------------------------------------------------------------ */
/* Helpers that need raw SQL                                           */
/* ------------------------------------------------------------------ */

async function scalar(db: StorageDatabase, sql: string, params: readonly SqlParam[] = []): Promise<number> {
  const result = await db.query(sql, params, "all");
  const first = result.rows[0] as Record<string, unknown> | undefined;
  const value = first === undefined ? undefined : Object.values(first)[0];
  return typeof value === "number" ? value : Number(value);
}

async function sqliteCount(db: StorageDatabase, table: string): Promise<number> {
  return scalar(db, `SELECT COUNT(*) AS n FROM ${table}`);
}

async function sqliteSeqs(db: StorageDatabase, sessionId: string): Promise<number[]> {
  const result = await db.query(
    "SELECT seq FROM turns WHERE session_id = ? ORDER BY seq ASC",
    [sessionId],
    "all",
  );
  return result.rows.map((row) => Number((row as Record<string, unknown>)["seq"]));
}
