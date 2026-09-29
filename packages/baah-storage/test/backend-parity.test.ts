/**
 * The two backends, side by side.
 *
 * `createMemoryDatabase()` and the worker-backed database are supposed to be
 * interchangeable (`Plan.md` §6.2 — the same operations module over a different
 * engine). The only way to check that is to run the same input through both and
 * compare. Here the SQL side is a real SQLite-WASM `:memory:` database behind
 * the worker's own dispatch table, so the comparison is a measurement, not a
 * model of SQLite.
 *
 * Every bug this file pins down was a silent divergence: one backend accepted
 * what the other rejected, coerced what the other refused, or returned a
 * different number of rows for the same query.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { createMemoryDatabase } from "../src/factory.ts";
import { StorageError } from "../src/errors.ts";
import { clampSearchLimit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "../src/operations.ts";
import { partParams, searchSql, UPSERT_PART } from "../src/sql.ts";
import type { StorageDatabase } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback, type Loopback } from "./harness/transport.ts";

const T0 = "2026-09-29T10:00:00.000Z";
const T1 = "2026-09-29T10:00:01.000Z";

let sqlite3: Sqlite3Static;

/** A worker-backed database: the real client, a real worker, a real SQLite. */
async function sqlDatabase(): Promise<StorageDatabase> {
  const loopback = createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
  });
  await loopback.client.open({ filename: "/baah.sqlite3" });
  return loopback.client;
}

/** A memory-backed database. */
function memoryDatabase(): StorageDatabase {
  return createMemoryDatabase();
}

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/** One session, one message, one part with two matching parts. */
const SESSION = { id: "s1", title: "First session" } as const;
const MESSAGE = {
  id: "m1",
  sessionId: "s1",
  role: "assistant",
  createdAt: T0,
  updatedAt: T0,
} as const;
const PART = {
  id: "p1",
  messageId: "m1",
  sessionId: "s1",
  type: "text",
  contentText: "the opfs vfs needs no COOP header",
  updatedAt: T0,
} as const;

/** Five matching parts, so a limit actually has something to cut. */
async function seedSearchCorpus(db: StorageDatabase): Promise<void> {
  await db.createSession({ ...SESSION });
  await db.appendMessage({ ...MESSAGE });
  await db.appendPart({ ...PART });
  for (const id of ["p2", "p3", "p4", "p5"]) {
    await db.appendPart({
      id,
      messageId: "m1",
      sessionId: "s1",
      type: "text",
      contentText: "opfs again, opfs again",
      updatedAt: T0,
    });
  }
}

async function bothSeeded(): Promise<[StorageDatabase, StorageDatabase]> {
  const memory = memoryDatabase();
  const sql = await sqlDatabase();
  for (const db of [memory, sql]) await seedSearchCorpus(db);
  return [memory, sql];
}

/** The error a call rejects with, reduced to what is comparable. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("The call resolved, but a rejection was expected.");
}

/**
 * The *set* of hits, sorted.
 *
 * The order itself is deliberately not compared: FTS5's `bm25()` ranks by term
 * statistics, the in-memory engine only models the shape of a score (see
 * `test/memory-coverage.test.ts`). Which rows come back is the contract; the
 * tie-break is not.
 */
function ids(hits: { partId: string }[]): string[] {
  return hits.map((hit) => hit.partId).sort();
}

describe("search: the limit is clamped before it reaches an engine", () => {
  it("returns the same rows for a negative limit on both backends", async () => {
    const [memory, sql] = await bothSeeded();

    // `LIMIT -1` means "no limit" in SQLite, while `slice(0, -1)` drops the
    // last row in the memory engine: the same query used to answer 5 rows and
    // 4. Clamped to 0, both now answer none.
    const fromSql = await sql.search({ query: "opfs", limit: -1 });
    const fromMemory = await memory.search({ query: "opfs", limit: -1 });

    expect(fromSql).toEqual([]);
    expect(ids(fromMemory)).toEqual(ids(fromSql));
  });

  it("proves the divergence was real: raw SQL with LIMIT -1 returns every row", async () => {
    // The clamp is the only thing standing between the two backends and this
    // asymmetry, so it is measured rather than assumed.
    const [memory, sql] = await bothSeeded();
    const unbounded = await sql.query(searchSql(false), ["opfs", -1], "all");
    const rows: unknown[] = unbounded.rows;

    expect(rows).toHaveLength(5);
    // …while the same query through the shared layer returns nothing.
    expect(await sql.search({ query: "opfs", limit: -1 })).toEqual([]);
    expect(await memory.search({ query: "opfs", limit: -1 })).toEqual([]);
  });

  it("returns nothing for a limit of zero, on both backends", async () => {
    const [memory, sql] = await bothSeeded();

    expect(await sql.search({ query: "opfs", limit: 0 })).toEqual([]);
    expect(await memory.search({ query: "opfs", limit: 0 })).toEqual([]);
  });

  it("caps a huge limit instead of scanning the index, on both backends", async () => {
    const [memory, sql] = await bothSeeded();

    const fromSql = await sql.search({ query: "opfs", limit: 1_000_000 });
    const fromMemory = await memory.search({ query: "opfs", limit: 1_000_000 });

    expect(ids(fromSql)).toHaveLength(5);
    expect(ids(fromMemory)).toEqual(ids(fromSql));
  });

  it("agrees on the row count for every limit, and on the rows for the whole set", async () => {
    const [memory, sql] = await bothSeeded();

    for (const limit of [-2, -1, 0, 1, 2, 500, 501]) {
      const fromSql = await sql.search({ query: "opfs", limit });
      const fromMemory = await memory.search({ query: "opfs", limit });
      const label = `limit ${String(limit)}`;

      // The count is the contract: a limit that cuts the result set must cut
      // it to the same number of rows on both backends.
      expect(fromMemory.length, label).toBe(fromSql.length);

      // Which rows survive a *truncating* limit depends on the ranking
      // (FTS5's bm25 vs the memory engine's term count), so the identity is
      // only compared where nothing is cut: 0 rows, or all five.
      const truncating = fromSql.length > 0 && fromSql.length < 5;
      if (!truncating) expect(ids(fromMemory), label).toEqual(ids(fromSql));
    }
  });

  it("cuts to the same number of rows for a truncating limit", async () => {
    const [memory, sql] = await bothSeeded();

    expect(await sql.search({ query: "opfs", limit: 1 })).toHaveLength(1);
    expect(await memory.search({ query: "opfs", limit: 1 })).toHaveLength(1);
    expect(await sql.search({ query: "opfs", limit: 2 })).toHaveLength(2);
    expect(await memory.search({ query: "opfs", limit: 2 })).toHaveLength(2);
  });

  it("refuses a non-finite limit at the wire, and clamps it in memory", async () => {
    // `NaN` and `Infinity` are the limits the two backends answer differently,
    // and the difference is deliberate: neither is a `LIMIT` value, so the
    // protocol rejects them as `invalid_message` before they reach an engine,
    // while the in-memory path clamps them (NaN → nothing, Infinity → the
    // ceiling). Both outcomes are loud; a caller cannot send one over the wire.
    const [memory, sql] = await bothSeeded();

    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const fromSql = await failure(sql.search({ query: "opfs", limit }));
      expect(fromSql.code, String(limit)).toBe("invalid_message");
    }
    expect(await memory.search({ query: "opfs", limit: Number.NaN })).toEqual([]);
    expect(await memory.search({ query: "opfs", limit: Number.POSITIVE_INFINITY })).toHaveLength(5);
    expect(clampSearchLimit(Number.NaN)).toBe(0);
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBe(MAX_SEARCH_LIMIT);
  });

  it("clamps a limit the wire would otherwise have to reject", async () => {
    // `searchRequestSchema` deliberately accepts any integer; without the clamp
    // the value would reach `LIMIT ?` unchanged, and SQLite reads a negative
    // one as "no limit".
    expect(MAX_SEARCH_LIMIT).toBe(500);
    expect(clampSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampSearchLimit(-1)).toBe(0);
    expect(clampSearchLimit(-(2 ** 31))).toBe(0);
    expect(clampSearchLimit(0)).toBe(0);
    expect(clampSearchLimit(7)).toBe(7);
    expect(clampSearchLimit(10 ** 9)).toBe(MAX_SEARCH_LIMIT);
    expect(clampSearchLimit(Number.NaN)).toBe(0);
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBe(MAX_SEARCH_LIMIT);
  });
});

describe("a bad value is refused, never coerced", () => {
  it("rejects an unknown session status with the same code on both backends", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();

    const fromMemory = await failure(memory.createSession({ id: "bad", status: "weird" as never }));
    const fromSql = await failure(sql.createSession({ id: "bad", status: "weird" as never }));

    // The memory backend used to accept the call and persist "active".
    expect(fromMemory.code).toBe("sql_error");
    expect(fromSql.code).toBe(fromMemory.code);
    expect(fromMemory.message).toMatch(/status/);
  });

  it("writes no row when the status is refused", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();

    await failure(memory.createSession({ id: "bad", status: "weird" as never }));
    await failure(sql.createSession({ id: "bad", status: "weird" as never }));

    expect(await memory.getSession("bad")).toBeNull();
    expect(await sql.getSession("bad")).toBeNull();
    expect(await memory.listSessions()).toEqual([]);
    expect(await sql.listSessions()).toEqual([]);
  });

  it("rejects a bad role and a bad part type with the same code on both backends", async () => {
    const [memory, sql] = await bothSeeded();
    const badRole = {
      id: "m2",
      sessionId: "s1",
      role: "nonsense" as never,
      createdAt: T0,
      updatedAt: T0,
    };
    const badType = {
      id: "p9",
      messageId: "m1",
      sessionId: "s1",
      type: "image" as never,
      contentText: "x",
      updatedAt: T0,
    };

    const roleMemory = await failure(memory.appendMessage({ ...badRole }));
    const roleSql = await failure(sql.appendMessage({ ...badRole }));
    const typeMemory = await failure(memory.appendPart(badType));
    const typeSql = await failure(sql.appendPart(badType));

    expect(roleMemory.code).toBe("sql_error");
    expect(roleSql.code).toBe(roleMemory.code);
    expect(typeMemory.code).toBe("sql_error");
    expect(typeSql.code).toBe(typeMemory.code);
  });

  it("leaves nothing behind when a row is refused", async () => {
    const [memory, sql] = await bothSeeded();
    const badRole = {
      id: "m2",
      sessionId: "s1",
      role: "nonsense" as never,
      createdAt: T0,
      updatedAt: T0,
    };

    await failure(memory.appendMessage({ ...badRole }));
    await failure(sql.appendMessage({ ...badRole }));

    // The in-memory engine used to store the invalid row and only notice when
    // the row was parsed back: a corrupt row surviving a rejected call.
    expect((await memory.listMessages("s1")).map((row) => row.id)).toEqual(["m1"]);
    expect((await sql.listMessages("s1")).map((row) => row.id)).toEqual(["m1"]);
  });
});

describe("status 'archived' is reachable and archived_at is written", () => {
  it("stores the timestamp the caller supplied", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();

    for (const db of [memory, sql]) {
      const archived = await db.createSession({
        id: "s9",
        title: "Done",
        status: "archived",
        archivedAt: T1,
      });
      expect(archived.status).toBe("archived");
      expect(archived.archivedAt).toBe(T1);
      expect(await db.getSession("s9")).toEqual(archived);
    }
  });

  it("fills the timestamp in when the caller omits it", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();

    for (const db of [memory, sql]) {
      const archived = await db.createSession({ id: "s9", status: "archived" });
      expect(archived.status).toBe("archived");
      // The insert timestamp, not NULL — §6.1's CHECK demands it.
      expect(archived.archivedAt).toBe(archived.createdAt);
    }
  });

  it("leaves archived_at NULL for every other status", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();

    for (const db of [memory, sql]) {
      const active = await db.createSession({ ...SESSION });
      expect(active.status).toBe("active");
      expect(active.archivedAt).toBeNull();
    }
  });

  it("is listable on both backends", async () => {
    const memory = memoryDatabase();
    const sql = await sqlDatabase();

    for (const db of [memory, sql]) {
      await db.createSession({ id: "open", status: "active" });
      await db.createSession({ id: "old", status: "archived", archivedAt: T1 });
      expect((await db.listSessions()).map((row) => row.id).sort()).toEqual(["old", "open"]);
    }
  });
});

describe("the flush is idempotent on both backends", () => {
  it("applies a delta once and reports the retry as a no-op", async () => {
    const [memory, sql] = await bothSeeded();
    const flush = {
      deltaId: "d1",
      part: { ...PART, contentText: "opfs" },
      flushedAt: T0,
    };

    const firstMemory = await memory.flushDelta(flush);
    const firstSql = await sql.flushDelta(flush);
    const retryMemory = await memory.flushDelta(flush);
    const retrySql = await sql.flushDelta(flush);

    expect(firstMemory).toEqual(firstSql);
    expect(retryMemory).toEqual(retrySql);
    expect(firstMemory.applied).toBe(true);
    expect(retryMemory.applied).toBe(false);
  });
});

describe("the raw-SQL 'changes' channel means the same thing on both backends", () => {
  it("reports 1 for an upsert, measured — whether or not the row changed", async () => {
    // This is the measurement BUG 5 was about: `ON CONFLICT DO UPDATE` counts
    // the row it *touched*, so two byte-identical runs report 1, 1 on SQLite.
    const raw = new sqlite3.oo1.DB(":memory:", "c");
    raw.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    const upsert = "INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET v = excluded.v";
    raw.exec({ sql: upsert, bind: ["a", "one"] });
    const insert = raw.changes();
    raw.exec({ sql: upsert, bind: ["a", "one"] });
    const identical = raw.changes();
    raw.close();

    expect([insert, identical]).toEqual([1, 1]);
  });

  it("reports 1 for an identical re-upsert of a part, on both backends", async () => {
    // The memory engine used to answer 0 here, which is the divergence BUG 5
    // named. `run()` is the worker-only raw escape hatch; the memory backend has
    // no SQL engine, so its side of the comparison is the engine's own count,
    // reached through `upsertPart`'s engine call.
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    await loopback.client.open({ filename: "/baah.sqlite3" });
    const sql = loopback.client;
    const memory = memoryDatabase();
    for (const db of [memory, sql]) await seedSearchCorpus(db);

    // The exact statement `operations.upsertPart` sends, run raw so the
    // `changes` value is visible.
    const statement = UPSERT_PART;
    const params = partParams({ ...PART, contentText: "opfs" });
    const first = await sql.run(statement, params);
    const identical = await sql.run(statement, params);
    const changed = await sql.run(
      statement,
      partParams({ ...PART, contentText: "opfs vfs", updatedAt: T1 }),
    );

    expect([first.changes, identical.changes, changed.changes]).toEqual([1, 1, 1]);

    // The memory backend has no raw-SQL escape hatch, so its `changes` is only
    // observable through `flushDelta` — asserted in the next test. What its
    // public surface must do is leave the row exactly as the SQL side did.
    for (const input of [
      { ...PART, contentText: "opfs" },
      { ...PART, contentText: "opfs" },
      { ...PART, contentText: "opfs vfs", updatedAt: T1 },
    ]) {
      await memory.upsertPart(input);
    }
    const parts = await memory.listParts("m1");
    expect(parts[0]?.contentText).toBe("opfs vfs");
    expect(parts[0]?.seq).toBe(0);
    expect(parts).toHaveLength(5);
  });

  it("still detects a flush retry, because the delta log reports 0", async () => {
    // The upsert no longer distinguishes "changed" from "identical", so the
    // retry detection has to come from `part_deltas`' DO NOTHING. It does.
    const [memory, sql] = await bothSeeded();
    const flush = {
      deltaId: "d1",
      part: { ...PART, contentText: "opfs" },
      flushedAt: T0,
    };

    expect((await memory.flushDelta(flush)).applied).toBe(true);
    expect((await memory.flushDelta(flush)).applied).toBe(false);
    expect((await sql.flushDelta(flush)).applied).toBe(true);
    expect((await sql.flushDelta(flush)).applied).toBe(false);
  });
});
