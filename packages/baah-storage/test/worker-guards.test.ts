/**
 * The worker's guards, exercised for real.
 *
 * Every test here drives the shipped `createStorageWorker()` — the same
 * dispatch table, the same guards, the same statements — with the SQLite
 * module and the VFS installer replaced (see `test/harness/sqlite.ts`). The
 * connection underneath is a real SQLite, so a CHECK violation, a rollback and
 * a `changes()` count are SQLite's, not a stub's.
 *
 * These are the assertions that were missing. `isOwnershipFailure`, the zod
 * check on incoming messages, the nested-transaction refusal and the response
 * parsing on the client side had no test at all: all four could be deleted and
 * the suite stayed green.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { StorageError } from "../src/errors.ts";
import { createStorageWorker } from "../src/worker.ts";
import { INSERT_SESSION, SELECT_SESSIONS } from "../src/sql.ts";
import type { RpcRequest } from "../src/protocol.ts";
import type { SqlParam, SqlValue } from "../src/types.ts";
import { createWorkerHarness, type WorkerHarness } from "./harness/transport.ts";
import {
  installInMemoryPool,
  loadSqlite3,
  ownershipException,
  type InMemoryPool,
} from "./harness/sqlite.ts";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

function id(): string {
  return crypto.randomUUID();
}

/** A promise plus the function that resolves it, for parking an `open`. */
function createGate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A harness on a real in-memory SQLite, with a working `install`. */
async function openHarness(): Promise<WorkerHarness & { pool: InMemoryPool }> {
  const { pool, install } = installInMemoryPool(sqlite3);
  const harness = createWorkerHarness({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: install,
  });
  await harness.request({ id: id(), kind: "open", payload: { filename: "/baah.sqlite3" } });
  return Object.assign(harness, { pool });
}

const OPEN: RpcRequest = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "open",
  payload: { filename: "/baah.sqlite3" },
};

describe("the open path", () => {
  it("installs the VFS, applies the pragmas and migrates the schema", async () => {
    const { pool, install } = installInMemoryPool(sqlite3);
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: install,
    });
    const response = await harness.request(OPEN);

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      filename: "/baah.sqlite3",
      vfsName: "opfs-sahpool",
      schemaVersion: 3,
    });

    // The pragmas ran on the real connection, in the order `PRAGMAS` fixes.
    const connection = pool.opened[0];
    expect(connection?.executed.slice(0, 4)).toEqual([
      "PRAGMA foreign_keys=ON",
      "PRAGMA journal_mode=DELETE",
      "PRAGMA synchronous=NORMAL",
      "PRAGMA busy_timeout=5000",
    ]);
    // …and the schema the migrations created is really there.
    const tables = connection?.selectObjects(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = (tables ?? []).map((row) => row["name"]);
    expect(names).toContain("parts_fts");
    expect(names).toContain("schema_migrations");
  });

  it("answers a second open in the same worker with database_already_open", async () => {
    const harness = await openHarness();
    const second = await harness.request(OPEN);

    expect(second.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("database_already_open");
  });
});

describe("a second VFS acquire is reported as an ownership failure", () => {
  it("answers database_owned_by_another_context, not a raw DOM exception", async () => {
    // `Plan.md` §6: opfs-sahpool permits exactly one connection per origin and
    // directory. A second tab fails in `installOpfsSAHPoolVfs` with a
    // DOMException; the worker has to turn that into a typed error the client
    // can branch on. This is a spec requirement and no test asserted it.
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        throw ownershipException();
      },
    });

    const response = await harness.request(OPEN);

    expect(response.ok).toBe(false);
    const error = harness.lastError();
    expect(error?.code).toBe("database_owned_by_another_context");
    expect(error?.message).toMatch(/exactly one connection/i);
    // The browser's own name survives, so the report can say which one it was.
    expect(JSON.stringify(response)).toContain("NoModificationAllowedError");
  });

  it("keeps the raw name and message in the details", async () => {
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        throw ownershipException("The requested file is already locked.");
      },
    });

    const response = await harness.request(OPEN);
    const error: unknown = response.error;
    expect(typeof error).toBe("object");
    if (typeof error !== "object" || error === null) return;
    const details: unknown = (error as { details: unknown }).details;
    expect(details).toMatchObject({ name: "NoModificationAllowedError" });
  });

  it("does not claim ownership for an unrelated VFS failure", async () => {
    // A broken VFS is our problem, not another tab's. Mislabelling it would
    // show a "close the other tab" banner for something no tab can fix.
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        throw new Error("The VFS could not be registered: unsupported flag combination.");
      },
    });

    await harness.request(OPEN);
    expect(harness.lastError()?.code).toBe("internal");
  });

  it("classifies by message too, since browsers differ on the name", async () => {
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        // A different browser's shape: no DOMException name, but a message
        // that says the handle is held elsewhere.
        const error = new Error("Failed to acquire: the file is in use by another context");
        error.name = "TypeError";
        throw error;
      },
    });

    await harness.request(OPEN);
    expect(harness.lastError()?.code).toBe("database_owned_by_another_context");
  });
});

describe("an invalid message is refused, not executed", () => {
  it("answers invalid_message for a message that fails zod", async () => {
    const harness = await openHarness();
    const connection = harness.pool.opened[0];
    const before = connection?.executed.length ?? 0;

    const response = await harness.request({
      id: "00000000-0000-4000-8000-0000000000ff",
      kind: "run",
      // `params` is an array of objects: no SQLite storage class, so this can
      // never be bound. Without the zod check it would reach `db.exec`.
      payload: { sql: "DELETE FROM sessions", params: [{ nested: true }] as never },
    });

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("invalid_message");
    // Not executed: the connection ran nothing new.
    expect(connection?.executed.length).toBe(before);
  });

  it.each([
    ["an unknown kind", { id: "x", kind: "drop-everything", payload: {} }],
    ["a missing id", { kind: "query", payload: { sql: "SELECT 1", method: "all" } }],
    ["an empty id", { id: "", kind: "query", payload: { sql: "SELECT 1", method: "all" } }],
    ["a missing payload", { id: "x", kind: "run" }],
    ["an unknown method", { id: "x", kind: "query", payload: { sql: "SELECT 1", method: "drop" } }],
    ["an empty tx batch", { id: "x", kind: "tx", payload: { statements: [] } }],
    [
      "an unexpected top-level key",
      { id: "x", kind: "close", payload: {}, extra: true } as unknown,
    ],
    [
      "params beside the payload instead of inside it",
      { id: "x", kind: "query", payload: { sql: "SELECT 1", method: "all" }, params: [] },
    ],
  ])("refuses %s", async (_label, message) => {
    const harness = await openHarness();
    const connection = harness.pool.opened[0];
    const before = connection?.executed.length ?? 0;

    const response = await harness.request(message as unknown as RpcRequest);

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("invalid_message");
    expect(connection?.executed.length).toBe(before);
  });

  it("still answers, even without a usable correlation id", async () => {
    // The client's pending map is keyed by id. A message without one can never
    // settle a promise, but answering keeps the stream drainable instead of
    // leaving a caller waiting forever.
    const harness = await openHarness();
    harness.recorded.drain();

    await harness.send({ kind: "nonsense" });

    const response = harness.recorded.last();
    expect(response.ok).toBe(false);
    expect(response.id).toBe("");
    expect(response.kind).toBe("invalid");
    expect(harness.lastError()?.code).toBe("invalid_message");
  });

  it("recovers the id from a malformed message, so the caller is not orphaned", async () => {
    const harness = await openHarness();
    const correlationId = id();
    harness.recorded.drain();

    // The payload is wrong, but the id is usable: the response must carry it,
    // or the caller's pending entry never settles.
    await harness.send({
      id: correlationId,
      kind: "query",
      payload: { sql: "SELECT 1", method: "not-a-method" },
    });

    const response = harness.recorded.last();
    expect(response.id).toBe(correlationId);
    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("invalid_message");
  });

  it("echoes the kind on a success and on a failure", async () => {
    const harness = await openHarness();

    const ok = await harness.request({
      id: id(),
      kind: "run",
      payload: { sql: "DELETE FROM settings WHERE key = ?", params: ["nothing"] },
    });
    expect(ok).toMatchObject({ kind: "run", ok: true });

    const failed = await harness.request({
      id: id(),
      kind: "run",
      payload: { sql: "SELECT * FROM no_such_table" },
    });
    expect(failed).toMatchObject({ kind: "run", ok: false });
    expect(harness.lastError()?.code).toBe("sql_error");
  });
});

describe("a nested transaction is named, not left to SQLite", () => {
  it("answers nested_transaction when a batch re-enters itself", async () => {
    // `runBatch` refuses a second BEGIN instead of letting SQLite report
    // "cannot start a transaction within a transaction" as a bare `sql_error`:
    // a caller can act on `nested_transaction` and not on `sql_error`.
    //
    // The guard only fires on re-entrancy, because `runBatch` never awaits
    // between BEGIN and COMMIT. So the test *is* the re-entrancy: the injected
    // connection calls back into the worker from inside a statement, which is
    // what a driver callback or a nested RPC would do.
    const { pool, install } = installInMemoryPool(sqlite3);
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        const base = await install({ name: "opfs-sahpool" });
        return {
          OpfsSAHPoolDb: class {
            readonly #inner = new base.OpfsSAHPoolDb("/baah.sqlite3");
            #reentered = false;
            exec(sqlOrOptions: string | { sql: string; bind: readonly SqlParam[] }): void {
              if (typeof sqlOrOptions === "string") this.#inner.exec(sqlOrOptions);
              else this.#inner.exec(sqlOrOptions);
            }
            selectObjects(sql: string, bind?: readonly SqlParam[]): Record<string, SqlValue>[] {
              if (sql.includes("REENTER") && !this.#reentered) {
                this.#reentered = true;
                // Synchronous re-entry: `handleMessage` parses and dispatches
                // before its first `await`, so this lands inside the batch.
                void harness.worker.handleMessage({
                  id: "nested",
                  kind: "tx",
                  payload: { statements: [{ sql: "SELECT 1", params: [] }] },
                });
              }
              return bind === undefined
                ? this.#inner.selectObjects(sql)
                : this.#inner.selectObjects(sql, bind);
            }
            selectArrays(sql: string, bind?: readonly SqlParam[]): SqlValue[][] {
              return bind === undefined
                ? this.#inner.selectArrays(sql)
                : this.#inner.selectArrays(sql, bind);
            }
            changes(): number {
              return this.#inner.changes();
            }
            isOpen(): boolean {
              return this.#inner.isOpen();
            }
            close(): void {
              this.#inner.close();
            }
          },
        };
      },
    });
    expect(pool.opened).toEqual([]);

    await harness.request({ id: "open", kind: "open", payload: { filename: "/baah.sqlite3" } });
    harness.recorded.drain();

    const outer = await harness.request({
      id: "outer",
      kind: "tx",
      payload: {
        statements: [
          { sql: "SELECT 1 AS REENTER", params: [] },
          {
            sql: "INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 't')",
            params: [],
          },
        ],
      },
    });
    // The outer batch survives the re-entrant refusal and commits.
    expect(outer.ok).toBe(true);

    const nested = harness.recorded.outbox.find((response) => response.id === "nested");
    expect(nested).toBeDefined();
    expect(nested?.ok).toBe(false);
    expect(nested?.error).toMatchObject({ code: "nested_transaction" });
    expect(nested?.error).toMatchObject({
      message: expect.stringContaining("cannot overlap"),
    });
  });

  it("does not confuse a nested transaction with a plain SQL failure", async () => {
    // The control case: the same connection, the same statement, but with no
    // batch in flight — the answer must be `sql_error`, not `nested_transaction`.
    const harness = await openHarness();
    const response = await harness.request({
      id: id(),
      kind: "tx",
      payload: { statements: [{ sql: "SELECT * FROM no_such_table", params: [] }] },
    });

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("sql_error");
  });

  it("refuses a second open while one is in flight", async () => {
    // `state.opening` is claimed before the first `await`, so a second `open`
    // arriving while the first is still inside the SQLite loader is refused
    // rather than racing it into `installOpfsSAHPoolVfs`.
    const gate = createGate();
    const { install } = installInMemoryPool(sqlite3);
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => {
        await gate.promise;
        return sqlite3;
      },
      installOpfsSAHPoolVfs: install,
    });

    const first = harness.send({ id: "first", kind: "open", payload: { filename: "/baah.sqlite3" } });
    // The first open is parked inside the SQLite loader.
    const second = await harness.request({
      id: "second",
      kind: "open",
      payload: { filename: "/baah.sqlite3" },
    });

    expect(second.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("database_already_open");

    gate.open();
    await first;
    const firstResponse = harness.recorded.outbox.find((response) => response.id === "first");
    expect(firstResponse?.ok).toBe(true);
  });
});

describe("a statement before open is refused", () => {
  it("answers database_not_open rather than crashing", async () => {
    const harness = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });

    for (const request of [
      { id: "q", kind: "query", payload: { sql: "SELECT 1", method: "all", params: [] } },
      { id: "r", kind: "run", payload: { sql: "DELETE FROM settings", params: [] } },
      { id: "t", kind: "tx", payload: { statements: [{ sql: "SELECT 1", params: [] }] } },
      { id: "s", kind: "search", payload: { query: "x", limit: 10 } },
      {
        id: "f",
        kind: "flushDelta",
        payload: {
          deltaId: "d",
          part: { id: "p", messageId: "m", sessionId: "s", type: "text", contentText: "", updatedAt: "t" },
          flushedAt: "t",
        },
      },
    ] satisfies RpcRequest[]) {
      const response = await harness.request(request);
      expect(response.ok, request.kind).toBe(false);
      expect(harness.lastError()?.code, request.kind).toBe("database_not_open");
    }
  });
});

describe("a statement after close is refused", () => {
  it("answers database_not_open and drops the handle", async () => {
    const harness = await openHarness();
    const connection = harness.pool.opened[0];

    const closed = await harness.request({ id: "c", kind: "close", payload: {} });
    expect(closed).toMatchObject({ ok: true, result: { closed: true } });
    expect(connection?.isOpen()).toBe(false);
    // The state is cleared, not just the connection: a second `open` must work.
    expect(harness.worker.state.handle).toBeNull();

    const afterClose = await harness.request({
      id: "after",
      kind: "query",
      payload: { sql: "SELECT 1", method: "all", params: [] },
    });
    expect(afterClose.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("database_not_open");

    const reopened = await harness.request({ id: "again", kind: "open", payload: { filename: "/b.sqlite3" } });
    expect(reopened.ok).toBe(true);
  });
});

describe("a bad statement is a sql_error on the worker too", () => {
  it("reports a CHECK violation as sql_error, never internal", async () => {
    const harness = await openHarness();
    const response = await harness.request({
      id: id(),
      kind: "query",
      payload: {
        sql: INSERT_SESSION,
        // `status` outside the CHECK list. SQLite rejects it; the code that
        // crosses the boundary must say so, because the in-memory backend
        // answers `sql_error` for the same input and callers branch on it.
        params: ["s1", "t", "weird", null, null, null, "t", "t", null],
        method: "all",
      },
    });

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("sql_error");
  });

  it("reports a missing table as sql_error", async () => {
    const harness = await openHarness();
    const response = await harness.request({
      id: id(),
      kind: "query",
      payload: { sql: "SELECT * FROM no_such_table", method: "all", params: [] },
    });

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("sql_error");
  });

  it("reports a foreign key violation as sql_error", async () => {
    const harness = await openHarness();
    const response = await harness.request({
      id: id(),
      kind: "query",
      payload: {
        sql: `INSERT INTO messages (id, session_id, turn_id, parent_id, seq, role, status, model, outcome, error, usage, created_at, updated_at) VALUES ('m', 'nope', NULL, NULL, 0, 'user', NULL, NULL, NULL, NULL, NULL, 't', 't')`,
        method: "all",
        params: [],
      },
    });

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("sql_error");
  });
});

describe("the transaction path", () => {
  it("commits a batch and reports the per-statement changes", async () => {
    const harness = await openHarness();

    const response = await harness.request({
      id: id(),
      kind: "tx",
      payload: {
        statements: [
          { sql: INSERT_SESSION, params: ["s1", "t", "active", null, null, null, "t", "t", null] },
        ],
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ changes: 1 });
  });

  it("counts a read as the write before it — sqlite3_changes() is not reset by a SELECT", async () => {
    // Measured, and worth stating: `sqlite3_changes()` is *not* cleared by a
    // SELECT, so a batch that reads after a write reports the write's count
    // twice once the worker sums the per-statement values. The per-statement
    // `results` are the honest channel; `changes` on a mixed batch is a sum of
    // the last write per statement, not a count of rows written.
    const harness = await openHarness();

    const response = await harness.request({
      id: id(),
      kind: "tx",
      payload: {
        statements: [
          { sql: INSERT_SESSION, params: ["s1", "t", "active", null, null, null, "t", "t", null] },
          { sql: SELECT_SESSIONS, params: [] },
        ],
      },
    });

    expect(response.ok).toBe(true);
    const result: unknown = response.result;
    if (typeof result !== "object" || result === null) throw new Error("no result");
    const { changes, results } = result as { changes: number; results: unknown[] };
    expect(changes).toBe(2);
    expect(results).toHaveLength(2);
  });

  it("rolls the whole batch back when one statement fails", async () => {
    const harness = await openHarness();

    const response = await harness.request({
      id: id(),
      kind: "tx",
      payload: {
        statements: [
          { sql: INSERT_SESSION, params: ["s1", "t", "active", null, null, null, "t", "t", null] },
          // Violates the CHECK: the whole batch must roll back, including the
          // insert that already succeeded.
          { sql: INSERT_SESSION, params: ["s2", "t", "nope", null, null, null, "t", "t", null] },
        ],
      },
    });

    expect(response.ok).toBe(false);
    expect(harness.lastError()?.code).toBe("sql_error");

    const rows = await harness.request({
      id: id(),
      kind: "query",
      payload: { sql: SELECT_SESSIONS, params: [], method: "all" },
    });
    expect(rows.result).toMatchObject({ rows: [] });
  });

  it("leaves the connection usable after a rollback", async () => {
    const harness = await openHarness();

    await harness.request({
      id: "bad",
      kind: "tx",
      payload: { statements: [{ sql: "INSERT INTO no_such_table VALUES (1)", params: [] }] },
    });
    // `inBatch` has to be cleared, or every later batch is refused forever.
    const after = await harness.request({
      id: "after",
      kind: "tx",
      payload: { statements: [{ sql: "SELECT 1", params: [] }] },
    });

    expect(after.ok).toBe(true);
  });
});

describe("the raw SQL escape hatches", () => {
  it("returns column-keyed rows for all and get", async () => {
    const harness = await openHarness();
    await harness.request({
      id: id(),
      kind: "query",
      payload: {
        sql: INSERT_SESSION,
        params: ["s1", "t", "active", null, null, null, "t", "t", null],
        method: "all",
      },
    });

    const all = await harness.request({
      id: id(),
      kind: "query",
      payload: { sql: SELECT_SESSIONS, params: [], method: "all" },
    });
    expect(all.result).toMatchObject({ rows: [{ id: "s1", status: "active" }] });

    const values = await harness.request({
      id: id(),
      kind: "query",
      payload: { sql: "SELECT id FROM sessions", params: [], method: "values" },
    });
    expect(values.result).toMatchObject({ rows: [["s1"]] });
  });

  it("binds a boolean as 0/1, since SQLite has no boolean class", async () => {
    const harness = await openHarness();
    await harness.request({
      id: id(),
      kind: "query",
      payload: {
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
        params: ["flag", "1", "t"],
        method: "all",
      },
    });

    const response = await harness.request({
      id: id(),
      kind: "query",
      payload: {
        sql: "SELECT ? AS bound",
        params: [true],
        method: "all",
      },
    });
    expect(response.result).toMatchObject({ rows: [{ bound: 1 }] });
  });

  it("reports changes for a run", async () => {
    const harness = await openHarness();
    const response = await harness.request({
      id: id(),
      kind: "run",
      payload: {
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
        params: ["k", "v", "t"],
      },
    });
    expect(response.result).toEqual({ changes: 1 });
  });
});

describe("a worker instance holds its own state", () => {
  it("does not share the connection with another instance", async () => {
    // The reason the state is an object and not a module-level `let`: two
    // instances must be independent, and a test can build a second one.
    const first = await openHarness();
    const second = createWorkerHarness({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });

    expect(first.worker.state.handle).not.toBeNull();
    expect(second.worker.state.handle).toBeNull();

    await second.request({ id: "o", kind: "open", payload: { filename: "/other.sqlite3" } });
    expect(second.worker.state.handle).not.toBeNull();
    // Two independent connections, two independent databases.
    expect(second.worker.state.handle).not.toBe(first.worker.state.handle);
  });

  it("is created by the factory, with the SQLite seams defaulted", async () => {
    // No options at all: the defaults point at the real package. Only the
    // guard is exercised — nothing opens, so the WASM never loads.
    const worker = createStorageWorker();
    expect(worker.state.handle).toBeNull();
    expect(worker.state.opening).toBeNull();
    expect(worker.state.inBatch).toBe(false);
    worker.closeDatabase();
    expect(worker.state.handle).toBeNull();
  });
});

describe("handleMessage never rejects", () => {
  it("resolves even when dispatch throws", async () => {
    // The client relies on this: an unhandled rejection here would take the
    // worker down and every pending call would hang instead of failing.
    const harness = await openHarness();
    const response = await harness
      .request({
        id: id(),
        kind: "query",
        payload: { sql: "SELECT * FROM no_such_table", method: "all", params: [] },
      })
      .then((value) => ({ resolved: true, value }));

    expect(response.resolved).toBe(true);
    expect(response.value.ok).toBe(false);
  });

  it("names the error it reports, not the transport", async () => {
    const harness = await openHarness();
    await harness.request({
      id: id(),
      kind: "query",
      payload: { sql: "SELECT * FROM no_such_table", method: "all", params: [] },
    });

    const error = harness.lastError();
    expect(error?.code).toBe("sql_error");
    expect(error?.message).toContain("no_such_table");
    expect(harness.lastError()).toBeInstanceOf(Object);
    // The payload is flat, so it survives `postMessage` unchanged.
    const response = harness.recorded.last();
    expect(JSON.parse(JSON.stringify(response.error))).toEqual(response.error);
  });
});

describe("the StorageError the client rebuilds", () => {
  it("carries the code and the details across the boundary", () => {
    const error = StorageError.fromPayload({
      code: "database_owned_by_another_context",
      message: "owned",
      details: { name: "NoModificationAllowedError" },
    });
    expect(error.code).toBe("database_owned_by_another_context");
    expect(error.details["name"]).toBe("NoModificationAllowedError");
  });
});
