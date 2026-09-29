/**
 * The client's half of the boundary.
 *
 * `client.ts` was untested: the verify pass showed 763 lines of `worker.ts` and
 * `client.ts` with no test importing either module. The four things asserted
 * here are the ones a caller is actually protected by — a malformed response
 * must not be trusted, a second `openDatabase()` must not spawn a second worker,
 * and the drizzle callback must not hand the worker a value its protocol
 * rejects.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import {
  closeDatabase,
  createDrizzleCallback,
  normaliseDrizzleParam,
  normaliseDrizzleParams,
  openDatabase,
  WorkerStorageDatabase,
} from "../src/client.ts";
import { StorageError } from "../src/errors.ts";
import type { StorageErrorCode } from "../src/errors.ts";
import type { SqlParam } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { FakeWorker, createLoopback, type Loopback } from "./harness/transport.ts";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

afterEach(async () => {
  // `active` is module state; a test that leaves a database open would make
  // every later `openDatabase()` fail for the wrong reason.
  await closeDatabase();
});

/** The error a call rejects with, as `{ code, message }`. */
async function failure(promise: Promise<unknown>): Promise<{ code: StorageErrorCode; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("The call resolved, but a rejection was expected.");
}

describe("a malformed worker response is rejected, not trusted", () => {
  /** A client whose worker answers a `run` with whatever the test posts. */
  function clientAnswering(answer: (requestId: string, kind: string) => unknown): {
    client: WorkerStorageDatabase;
    transport: FakeWorker;
  } {
    const transport = new FakeWorker({
      onMessage: (data) => {
        const { id, kind } = data as { id: string; kind: string };
        transport.emit(answer(id, kind));
      },
    });
    return { client: new WorkerStorageDatabase(transport, "/baah.sqlite3"), transport };
  }

  it("rejects a response that is not an envelope at all", async () => {
    const { client } = clientAnswering(() => "totally not a response");

    const result = await failure(client.run("DELETE FROM settings"));

    expect(result.code).toBe("internal");
    expect(result.message).toMatch(/Malformed worker response/i);
  });

  it("rejects a response whose envelope is missing its correlation id", async () => {
    const { client } = clientAnswering(() => ({ kind: "run", ok: true, result: { changes: 1 } }));

    const result = await failure(client.run("DELETE FROM settings"));
    expect(result.code).toBe("internal");
    expect(result.message).toMatch(/Malformed worker response/i);
  });

  it("rejects a response whose result does not match the request kind", async () => {
    // The envelope is well-formed and correlated; the *payload* lies. A `run`
    // must answer with `{ changes: number }`, so a rows-array is a lie the
    // client must not pass on to its caller.
    const { client } = clientAnswering((requestId) => ({
      id: requestId,
      kind: "run",
      ok: true,
      result: { rows: [{ id: "s1" }] },
    }));

    const result = await failure(client.run("DELETE FROM settings"));

    expect(result.code).toBe("internal");
    expect(result.message).toMatch(/Malformed 'run' result/i);
  });

  it("rejects a query result whose rows are not an array", async () => {
    const { client } = clientAnswering((requestId) => ({
      id: requestId,
      kind: "query",
      ok: true,
      result: { rows: "everything", changes: 0 },
    }));

    const result = await failure(client.query("SELECT 1"));
    expect(result.code).toBe("internal");
    expect(result.message).toMatch(/Malformed 'query' result/i);
  });

  it("rejects a search result whose hits do not match the schema", async () => {
    const { client } = clientAnswering((requestId) => ({
      id: requestId,
      kind: "search",
      ok: true,
      result: { hits: [{ partId: "p1" }] },
    }));

    const result = await failure(client.search({ query: "opfs" }));
    expect(result.code).toBe("internal");
  });

  it("fails every pending call when one malformed response arrives", async () => {
    // Two calls in flight, one bad envelope. The client cannot tell which
    // promise the bad response belonged to, so both must fail rather than one
    // hanging forever.
    const transport = new FakeWorker();
    const client = new WorkerStorageDatabase(transport, "/baah.sqlite3");
    const first = failure(client.run("DELETE FROM settings"));
    const second = failure(client.query("SELECT 1"));
    // Neither has been answered; a single garbage message must drain both.
    transport.emit({ nonsense: true });

    expect((await first).message).toMatch(/Malformed worker response/i);
    expect((await second).message).toMatch(/Malformed worker response/i);
  });

  it("ignores a response for an id it is not waiting for", async () => {
    const { client, transport } = clientAnswering((requestId) => ({
      id: requestId,
      kind: "run",
      ok: true,
      result: { changes: 1 },
    }));

    transport.emit({ id: "someone-elses-id", kind: "run", ok: true, result: { changes: 99 } });

    // A stale answer must not settle the pending call, and must not throw.
    expect(await client.run("DELETE FROM settings")).toEqual({ changes: 1 });
  });

  it("rebuilds a typed error from the payload, keeping the code", async () => {
    const { client } = clientAnswering((requestId) => ({
      id: requestId,
      kind: "open",
      ok: false,
      error: {
        code: "database_owned_by_another_context",
        message: "another tab owns it",
        details: { name: "NoModificationAllowedError" },
      },
    }));

    const result = await failure(client.open({ filename: "/baah.sqlite3" }));

    expect(result.code).toBe("database_owned_by_another_context");
    expect(result.message).toBe("another tab owns it");
  });

  it("rejects a failure that carries no error payload", async () => {
    const { client } = clientAnswering((requestId) => ({
      id: requestId,
      kind: "run",
      ok: false,
    }));

    const result = await failure(client.run("DELETE FROM settings"));
    expect(result.code).toBe("internal");
    expect(result.message).toMatch(/without an error payload/i);
  });

  it("fails every pending call when the worker errors", async () => {
    const transport = new FakeWorker();
    const client = new WorkerStorageDatabase(transport, "/baah.sqlite3");
    const pending = failure(client.query("SELECT 1"));

    transport.emitError("the worker script failed to load");

    expect((await pending).message).toMatch(/the worker script failed to load/i);
  });

  it("fails every pending call when a message cannot be deserialised", async () => {
    const transport = new FakeWorker();
    const client = new WorkerStorageDatabase(transport, "/baah.sqlite3");
    const pending = failure(client.query("SELECT 1"));

    transport.emitMessageError();

    const result = await pending;
    expect(result.code).toBe("internal");
    expect(result.message).toMatch(/could not be deserialised/i);
  });
});

describe("openDatabase claims the tab's single slot", () => {
  it("refuses a second openDatabase() while the first is still opening", async () => {
    // The original assigned `active` *after* `await database.open(...)`, so two
    // concurrent calls both passed the `active !== null` guard and both spawned
    // a worker. The winner of the VFS race got the handle; the loser got an
    // ownership error, or worse, overwrote `active`.
    const gate = (() => {
      let open: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    })();

    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => {
        await gate.promise;
        return sqlite3;
      },
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });

    // The client's `open()` is answered only after the gate opens, so the first
    // call is provably still in flight when the second one arrives.
    const first = openDatabase({ workerFactory: loopback.workerFactory, filename: "/a.sqlite3" });
    const second = await failure(
      openDatabase({ workerFactory: loopback.workerFactory, filename: "/b.sqlite3" }),
    );

    expect(second.code).toBe("database_already_open");
    expect(second.message).toMatch(/single connection|already open/i);

    gate.open();
    const database = await first;
    // `active` is the first database, and the second never replaced it.
    expect(await database.getSession("nope")).toBeNull();
    await expect(
      openDatabase({ workerFactory: loopback.workerFactory }),
    ).rejects.toMatchObject({ code: "database_already_open" });
  });

  it("leaves active consistent after a successful open", async () => {
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });

    const database = await openDatabase({
      workerFactory: loopback.workerFactory,
      filename: "/a.sqlite3",
    });

    expect(database.kind).toBe("worker");
    // The slot is taken, so a second call is refused.
    await expect(openDatabase({ workerFactory: loopback.workerFactory })).rejects.toMatchObject({
      code: "database_already_open",
    });
    // …and the first database still works.
    expect(await database.listSessions()).toEqual([]);
  });

  it("releases the slot when the open fails, so a retry is possible", async () => {
    // Otherwise one failed open would block the tab for the rest of its life.
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        throw new Error("no OPFS here");
      },
    });

    const failed = await failure(
      openDatabase({ workerFactory: loopback.workerFactory, filename: "/a.sqlite3" }),
    );
    expect(failed.code).toBe("internal");

    // The slot is free again: a healthy worker can still open.
    const healthy: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    const database = await openDatabase({ workerFactory: healthy.workerFactory });
    expect(database.kind).toBe("worker");
  });

  it("terminates the worker it started when the open fails", async () => {
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: async () => {
        throw new Error("no OPFS here");
      },
    });

    await failure(openDatabase({ workerFactory: loopback.workerFactory }));
    expect(loopback.transport.terminated).toBe(true);
  });

  it("closeDatabase is a no-op when nothing is open", async () => {
    await expect(closeDatabase()).resolves.toBeUndefined();
  });

  it("closeDatabase releases the slot", async () => {
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });

    await openDatabase({ workerFactory: loopback.workerFactory });
    await closeDatabase();

    expect(loopback.transport.terminated).toBe(true);
    // The slot is free: a second database can be opened.
    const again: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    await expect(openDatabase({ workerFactory: again.workerFactory })).resolves.toBeDefined();
  });

  it("closes even when the worker's close request answers with a failure", async () => {
    // `client.ts:292` swallows the close failure on purpose — the worker is
    // terminated either way, and a half-closed handle would only make the
    // caller noisier. This is what that documented swallow is for: a worker
    // that is already gone still leaves the handle closed and usable-by-no-one.
    // Only `close` is answered, and with a failure. The `query` stays in
    // flight, so the swallow has to deal with both.
    const transport = new FakeWorker({
      onMessage: (data) => {
        const { id, kind } = data as { id: string; kind: string };
        if (kind !== "close") return;
        transport.emit({
          id,
          kind,
          ok: false,
          error: { code: "database_not_open", message: "already gone", details: {} },
        });
      },
    });
    const client = new WorkerStorageDatabase(transport, "/baah.sqlite3");
    const pendingCall = failure(client.query("SELECT 1"));

    await expect(client.close()).resolves.toBeUndefined();
    expect(transport.terminated).toBe(true);
    // The swallow must not leave the in-flight call hanging either.
    expect((await pendingCall).code).toBe("database_closed");
  });

  // Not tested: a worker that never answers the `close` request at all. In a
  // browser the worker's `error`/`messageerror` event always fires, which is
  // the only thing that can settle a silent `#send`. Asserting the hang would
  // document a browser behaviour this harness cannot reproduce, and the guard
  // above (`emitError` → `#failAll`) is the path that matters.
});

describe("a closed handle refuses further calls", () => {
  it("answers database_closed for a query after close", async () => {
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    const client = new WorkerStorageDatabase(loopback.transport, "/baah.sqlite3");
    await client.open({ filename: "/baah.sqlite3" });
    await client.close();

    expect(await failure(client.query("SELECT 1"))).toMatchObject({
      code: "database_closed",
    });
  });
});

describe("normaliseDrizzleParam", () => {
  it("passes the values SQLite already has through unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(normaliseDrizzleParam("text", 0)).toBe("text");
    expect(normaliseDrizzleParam(42, 0)).toBe(42);
    expect(normaliseDrizzleParam(0, 0)).toBe(0);
    expect(normaliseDrizzleParam(true, 0)).toBe(true);
    expect(normaliseDrizzleParam(false, 0)).toBe(false);
    expect(normaliseDrizzleParam(null, 0)).toBeNull();
    expect(normaliseDrizzleParam(bytes, 0)).toBe(bytes);
  });

  it("converts a Date to an ISO-8601 string", () => {
    // `drizzle`'s sqlite-proxy types params as `any[]`; a `timestamp` column
    // arrives as a `Date`, and the worker's `sqlParamsSchema` — a strict union
    // of `string | number | boolean | null | Uint8Array` — rejects it as an
    // `invalid_message`. Every timestamp column would break.
    const date = new Date("2026-09-29T10:00:00.000Z");
    expect(normaliseDrizzleParam(date, 0)).toBe("2026-09-29T10:00:00.000Z");
    expect(typeof normaliseDrizzleParam(date, 0)).toBe("string");
  });

  it("converts a bigint to a decimal string", () => {
    // SQLite has no 64-bit integer class here, and a 64-bit id above 2^53
    // would silently lose precision as a JS number. A string is lossless and
    // compares correctly against the TEXT ids the schema uses.
    expect(normaliseDrizzleParam(9007199254740993n, 0)).toBe("9007199254740993");
    expect(normaliseDrizzleParam(42n, 0)).toBe("42");
  });

  it.each([
    ["a plain object", { a: 1 }],
    ["an array", [1, 2]],
    ["a function", () => {}],
    ["a symbol", Symbol("x")],
  ])("refuses %s", async (_label, value) => {
    expect(() => normaliseDrizzleParam(value, 3)).toThrow(StorageError);
    try {
      normaliseDrizzleParam(value, 3);
    } catch (error) {
      const failureMessage = error instanceof StorageError ? error.message : String(error);
      // The message has to name the index (1-based, as a user counts) and the
      // driver, so a caller knows where the value came from.
      expect(failureMessage).toContain("parameter 4");
      expect(failureMessage).toContain("drizzle");
      // The value itself is never echoed: a bind parameter can be a secret.
      expect(failureMessage).not.toContain("not a bindable");
    }
  });

  it("refuses an invalid Date rather than binding 'Invalid Date'", () => {
    expect(() => normaliseDrizzleParam(new Date("not a date"), 0)).toThrow(/invalid Date/i);
  });

  it("refuses a non-finite number, which SQLite would bind as NULL", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => normaliseDrizzleParam(value, 0), String(value)).toThrow(/non-finite/i);
    }
  });

  it("maps a whole list, preserving order", () => {
    const date = new Date("2026-09-29T10:00:00.000Z");
    const params = normaliseDrizzleParams([1, "two", true, null, date, 7n]);
    expect(params).toEqual<SqlParam[]>([
      1,
      "two",
      true,
      null,
      "2026-09-29T10:00:00.000Z",
      "7",
    ]);
  });

  it("names the position of the offending parameter in a list", () => {
    try {
      normaliseDrizzleParams(["fine", { bad: true }]);
      expect.unreachable("the call should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      // Counted from 1, as a reader of the SQL would; the details carry the same
      // position so a caller can report it without parsing the message.
      expect((error as StorageError).message).toContain("parameter 2");
      expect((error as StorageError).details["parameter"]).toBe("2");
    }
  });
});

describe("createDrizzleCallback", () => {
  /** A client that records what reached the worker. */
  function recordingClient(): { client: WorkerStorageDatabase; transport: FakeWorker } {
    const transport = new FakeWorker({
      onMessage: (data) => {
        const { id, kind, payload } = data as {
          id: string;
          kind: string;
          payload: { sql: string; params: unknown[]; method: string };
        };
        transport.emit({
          id,
          kind,
          ok: true,
          result: { rows: [{ seen: payload.params }], changes: 0 },
        });
      },
    });
    return { client: new WorkerStorageDatabase(transport, "/baah.sqlite3"), transport };
  }

  it("sends Date and bigint params in a form the worker accepts", async () => {
    const { client, transport } = recordingClient();
    const callback = createDrizzleCallback(client);

    await callback(
      "INSERT INTO messages (id, created_at, token) VALUES (?, ?, ?)",
      ["m1", new Date("2026-09-29T10:00:00.000Z"), 9007199254740993n],
      "run",
    );

    const sent = transport.lastSent() as { payload: { params: unknown[]; method: string } };
    // Without normalisation the worker would answer `invalid_message` here.
    expect(sent.payload.params).toEqual([
      "m1",
      "2026-09-29T10:00:00.000Z",
      "9007199254740993",
    ]);
    expect(sent.payload.method).toBe("run");
  });

  it("round-trips a real Date and bigint insert through the whole stack", async () => {
    // The end-to-end version: the loopback's worker runs the real
    // `sqlParamsSchema`, so a parameter the normaliser misses fails loudly here
    // rather than in a browser.
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    await loopback.client.open({ filename: "/baah.sqlite3" });
    const callback = createDrizzleCallback(loopback.client);

    const result = await callback(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      ["when", "2026-09-29T10:00:00.000Z", "2026-09-29T10:00:00.000Z"],
      "run",
    );
    expect(result.rows).toBeDefined();

    const read = await callback("SELECT value FROM settings WHERE key = ?", ["when"], "all");
    expect(read.rows).toEqual([{ value: "2026-09-29T10:00:00.000Z" }]);
  });

  it("fails at the call site, not at the worker boundary", async () => {
    const { client } = recordingClient();
    const callback = createDrizzleCallback(client);

    // An unbindable value is refused before anything is posted, so the error
    // names the caller rather than arriving as an opaque worker failure.
    const result = await failure(
      callback("SELECT ?", [{ not: "bindable" }], "all") as Promise<unknown>,
    );
    expect(result.code).toBe("invalid_message");
    expect(result.message).toContain("drizzle");
  });

  it("passes the method through, so drizzle gets the shape it asked for", async () => {
    const { client, transport } = recordingClient();
    const callback = createDrizzleCallback(client);

    for (const method of ["run", "all", "values", "get"] as const) {
      await callback("SELECT 1", [], method);
      const sent = transport.lastSent() as { payload: { method: string } };
      expect(sent.payload.method).toBe(method);
    }
  });

  it("asks the worker for the values shape when drizzle wants rows", async () => {
    // `values` must reach the worker as `values`: the worker answers with
    // positional arrays for it and column-keyed objects for everything else.
    const loopback: Loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    await loopback.client.open({ filename: "/baah.sqlite3" });
    const callback = createDrizzleCallback(loopback.client);

    const asValues = await callback("SELECT 1 AS one, 'two' AS two", [], "values");
    const asAll = await callback("SELECT 1 AS one, 'two' AS two", [], "all");

    expect(asValues.rows).toEqual([[1, "two"]]);
    expect(asAll.rows).toEqual([{ one: 1, two: "two" }]);
  });
});
