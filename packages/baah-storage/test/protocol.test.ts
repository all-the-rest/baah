/**
 * The worker RPC boundary.
 *
 * `AGENTS.md` §5: everything crossing a boundary is parsed with zod, never
 * blind-cast. These tests are the evidence that malformed input is rejected
 * rather than reaching SQLite.
 */

import { describe, expect, it } from "vitest";

import {
  closeRequestSchema,
  flushDeltaRequestSchema,
  openRequestSchema,
  queryRequestSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  runRequestSchema,
  searchRequestSchema,
  storageErrorPayloadSchema,
  txRequestSchema,
} from "../src/protocol.ts";
import { StorageError, isOwnershipFailure, toStorageError } from "../src/errors.ts";

const VALID_PART = {
  id: "p1",
  messageId: "m1",
  sessionId: "s1",
  type: "text",
  contentText: "par",
  updatedAt: "2026-09-29T10:00:00.000Z",
} as const;

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown): boolean {
  return !schema.safeParse(value).success;
}

describe("rpcRequestSchema", () => {
  it("accepts one well-formed message of every kind", () => {
    const messages = [
      { id: "1", kind: "open", payload: { filename: "/baah.sqlite3" } },
      { id: "2", kind: "query", payload: { sql: "SELECT 1", params: [], method: "all" } },
      { id: "3", kind: "run", payload: { sql: "DELETE FROM sessions WHERE id = ?", params: ["s1"] } },
      { id: "4", kind: "tx", payload: { statements: [{ sql: "SELECT 1", params: [] }] } },
      { id: "5", kind: "search", payload: { query: "opfs", limit: 10 } },
      { id: "6", kind: "flushDelta", payload: { deltaId: "d1", part: VALID_PART, flushedAt: "2026-09-29T10:00:00.000Z" } },
      { id: "7", kind: "close", payload: {} },
    ];

    for (const message of messages) {
      const parsed = rpcRequestSchema.safeParse(message);
      expect(parsed.success, JSON.stringify(message)).toBe(true);
    }
  });

  it("fills in the defaults the SQL layer relies on", () => {
    const query = queryRequestSchema.parse({ id: "1", kind: "query", payload: { sql: "SELECT 1", method: "all" } });
    expect(query.payload.params).toEqual([]);

    const run = runRequestSchema.parse({ id: "1", kind: "run", payload: { sql: "DELETE FROM sessions" } });
    expect(run.payload.params).toEqual([]);

    const statement = txRequestSchema.parse({ id: "1", kind: "tx", payload: { statements: [{ sql: "SELECT 1" }] } });
    expect(statement.payload.statements[0]?.params).toEqual([]);

    const search = searchRequestSchema.parse({ id: "1", kind: "search", payload: { query: "opfs" } });
    expect(search.payload.limit).toBe(50);
  });

  it("rejects a message with no correlation id", () => {
    expect(rejects(rpcRequestSchema, { kind: "close", payload: {} })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: "", kind: "close", payload: {} })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: 42, kind: "close", payload: {} })).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(rejects(rpcRequestSchema, { id: "1", kind: "drop", payload: {} })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: "1", kind: "", payload: {} })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: "1", payload: {} })).toBe(true);
  });

  it("rejects values that are not messages at all", () => {
    for (const value of [null, undefined, 42, "close", [], true]) {
      expect(rejects(rpcRequestSchema, value), String(value)).toBe(true);
    }
  });

  it("rejects a missing or empty payload", () => {
    expect(rejects(rpcRequestSchema, { id: "1", kind: "query" })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: "1", kind: "query", payload: {} })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: "1", kind: "tx", payload: {} })).toBe(true);
    expect(rejects(rpcRequestSchema, { id: "1", kind: "flushDelta", payload: {} })).toBe(true);
  });

  it("rejects extra keys instead of trusting them", () => {
    expect(
      rejects(rpcRequestSchema, { id: "1", kind: "close", payload: {}, extra: "smuggled" }),
    ).toBe(true);
  });
});

describe("query and run", () => {
  it("rejects a non-string or empty SQL statement", () => {
    for (const sql of [1, "", null, undefined, {}, ["SELECT 1"]]) {
      expect(
        rejects(queryRequestSchema, { id: "1", kind: "query", payload: { sql, method: "all" } }),
        String(sql),
      ).toBe(true);
    }
  });

  it("rejects a `params` key smuggled next to the payload", () => {
    // `params` belongs inside `payload`. Outside it, the statement would run
    // without its bindings — a silent, wrong query.
    expect(
      rejects(rpcRequestSchema, {
        id: "1",
        kind: "query",
        payload: { sql: "SELECT 1", method: "all" },
        params: ["x"],
      }),
    ).toBe(true);
  });

  it("accepts only the four drizzle-orm/sqlite-proxy methods", () => {
    for (const method of ["run", "all", "values", "get"]) {
      expect(
        queryRequestSchema.safeParse({ id: "1", kind: "query", payload: { sql: "SELECT 1", method } }).success,
        method,
      ).toBe(true);
    }
    for (const method of ["delete", "ALL", "exec", "", 1, null]) {
      expect(
        rejects(queryRequestSchema, { id: "1", kind: "query", payload: { sql: "SELECT 1", method } }),
        String(method),
      ).toBe(true);
    }
  });

  it("rejects a parameter that is not a bindable value", () => {
    const withParam = (params: unknown[]) => ({
      id: "1",
      kind: "query",
      payload: { sql: "SELECT 1", params, method: "all" },
    });
    expect(rejects(queryRequestSchema, withParam([{}]))).toBe(true);
    expect(rejects(queryRequestSchema, withParam([["nested"]]))).toBe(true);
    expect(rejects(queryRequestSchema, withParam([() => 1]))).toBe(true);
    expect(rejects(queryRequestSchema, withParam(["ok", { bad: true }]))).toBe(true);
  });

  it("accepts every parameter type SQLite can bind", () => {
    const params = ["text", 42, -1.5, true, false, null, new Uint8Array([1, 2, 3])];
    expect(
      queryRequestSchema.safeParse({
        id: "1",
        kind: "query",
        payload: { sql: "SELECT 1", params, method: "all" },
      }).success,
    ).toBe(true);
  });

  it("rejects an absurdly long parameter list", () => {
    const params = Array.from({ length: 65 }, () => "x");
    expect(
      rejects(rpcRequestSchema, { id: "1", kind: "run", payload: { sql: "SELECT 1", params } }),
    ).toBe(true);
  });
});

describe("tx", () => {
  it("rejects an empty batch — a no-op transaction is a bug", () => {
    expect(rejects(txRequestSchema, { id: "1", kind: "tx", payload: { statements: [] } })).toBe(true);
  });

  it("rejects a statement without SQL", () => {
    expect(
      rejects(txRequestSchema, { id: "1", kind: "tx", payload: { statements: [{ params: [] }] } }),
    ).toBe(true);
    expect(
      rejects(txRequestSchema, { id: "1", kind: "tx", payload: { statements: [{ sql: "" }] } }),
    ).toBe(true);
  });

  it("rejects statements that are not an array", () => {
    expect(
      rejects(txRequestSchema, { id: "1", kind: "tx", payload: { statements: { sql: "SELECT 1" } } }),
    ).toBe(true);
  });

  it("caps the batch size", () => {
    const statements = Array.from({ length: 513 }, () => ({ sql: "SELECT 1" }));
    expect(rejects(txRequestSchema, { id: "1", kind: "tx", payload: { statements } })).toBe(true);
  });
});

describe("search", () => {
  it("rejects an empty or non-string MATCH expression", () => {
    expect(rejects(searchRequestSchema, { id: "1", kind: "search", payload: { query: "" } })).toBe(true);
    expect(rejects(searchRequestSchema, { id: "1", kind: "search", payload: {} })).toBe(true);
    expect(rejects(searchRequestSchema, { id: "1", kind: "search", payload: { query: 5 } })).toBe(true);
  });

  it("accepts any integer limit and leaves the range to the shared clamp", () => {
    // The schema used to bound the limit at [1, 500], which made the worker
    // *reject* a value the in-memory backend quietly clamped — the two
    // backends then answered the same query differently (or not at all).
    // `clampSearchLimit()` in `operations.ts` is the single place that decides
    // the range now; see `test/backend-parity.test.ts` for the measurement.
    for (const limit of [0, -1, -(2 ** 31), 501, 10 ** 9]) {
      expect(
        searchRequestSchema.safeParse({ id: "1", kind: "search", payload: { query: "x", limit } })
          .success,
        String(limit),
      ).toBe(true);
    }
    for (const limit of [1.5, "10", null, Number.NaN]) {
      expect(
        rejects(searchRequestSchema, { id: "1", kind: "search", payload: { query: "x", limit } }),
        String(limit),
      ).toBe(true);
    }
    expect(
      searchRequestSchema.safeParse({ id: "1", kind: "search", payload: { query: "x", limit: 1 } })
        .success,
    ).toBe(true);
  });

  it("rejects an empty sessionId", () => {
    expect(
      rejects(searchRequestSchema, { id: "1", kind: "search", payload: { query: "x", sessionId: "" } }),
    ).toBe(true);
  });
});

describe("flushDelta", () => {
  it("rejects a missing delta id — the idempotency key is not optional", () => {
    expect(
      rejects(flushDeltaRequestSchema, {
        id: "1",
        kind: "flushDelta",
        payload: { part: VALID_PART, flushedAt: "2026-09-29T10:00:00.000Z" },
      }),
    ).toBe(true);
    expect(
      rejects(flushDeltaRequestSchema, {
        id: "1",
        kind: "flushDelta",
        payload: { deltaId: "", part: VALID_PART, flushedAt: "2026-09-29T10:00:00.000Z" },
      }),
    ).toBe(true);
  });

  it("rejects a part with a fourth type", () => {
    for (const type of ["file", "patch", "snapshot", "step-start", "", null]) {
      expect(
        rejects(flushDeltaRequestSchema, {
          id: "1",
          kind: "flushDelta",
          payload: {
            deltaId: "d1",
            part: { ...VALID_PART, type },
            flushedAt: "2026-09-29T10:00:00.000Z",
          },
        }),
        String(type),
      ).toBe(true);
    }
  });

  it("accepts the three real part types", () => {
    for (const type of ["text", "reasoning", "tool"]) {
      expect(
        flushDeltaRequestSchema.safeParse({
          id: "1",
          kind: "flushDelta",
          payload: { deltaId: "d1", part: { ...VALID_PART, type }, flushedAt: "2026-09-29T10:00:00.000Z" },
        }).success,
        type,
      ).toBe(true);
    }
  });

  it("rejects a part without the fields a delta needs", () => {
    for (const part of [
      { ...VALID_PART, id: undefined },
      { ...VALID_PART, messageId: undefined },
      { ...VALID_PART, sessionId: undefined },
      { ...VALID_PART, contentText: undefined },
      { ...VALID_PART, updatedAt: undefined },
    ]) {
      expect(
        rejects(flushDeltaRequestSchema, {
          id: "1",
          kind: "flushDelta",
          payload: { deltaId: "d1", part, flushedAt: "2026-09-29T10:00:00.000Z" },
        }),
        JSON.stringify(part),
      ).toBe(true);
    }
  });

  it("rejects a part with a negative or non-integer seq", () => {
    for (const seq of [-1, 1.5, "0", null]) {
      expect(
        rejects(flushDeltaRequestSchema, {
          id: "1",
          kind: "flushDelta",
          payload: {
            deltaId: "d1",
            part: { ...VALID_PART, seq },
            flushedAt: "2026-09-29T10:00:00.000Z",
          },
        }),
        String(seq),
      ).toBe(true);
    }
  });

  it("accepts an unknown status as null but not as a made-up one", () => {
    const base = {
      id: "1",
      kind: "flushDelta",
      payload: { deltaId: "d1", part: VALID_PART, flushedAt: "2026-09-29T10:00:00.000Z" },
    };
    expect(flushDeltaRequestSchema.safeParse({ ...base, payload: { ...base.payload, part: { ...VALID_PART, status: null } } }).success).toBe(true);
    expect(flushDeltaRequestSchema.safeParse({ ...base, payload: { ...base.payload, part: { ...VALID_PART, status: "streaming" } } }).success).toBe(true);
    expect(rejects(flushDeltaRequestSchema, { ...base, payload: { ...base.payload, part: { ...VALID_PART, status: "thinking" } } })).toBe(true);
  });

  it("rejects a non-string part payload", () => {
    expect(
      rejects(flushDeltaRequestSchema, {
        id: "1",
        kind: "flushDelta",
        payload: { deltaId: "d1", part: "text", flushedAt: "2026-09-29T10:00:00.000Z" },
      }),
    ).toBe(true);
  });
});

describe("open and close", () => {
  it("rejects an open without a filename", () => {
    expect(rejects(openRequestSchema, { id: "1", kind: "open", payload: {} })).toBe(true);
    expect(rejects(openRequestSchema, { id: "1", kind: "open", payload: { filename: "" } })).toBe(true);
  });

  it("rejects an empty vfs name or directory", () => {
    expect(
      rejects(openRequestSchema, { id: "1", kind: "open", payload: { filename: "/a", vfsName: "" } }),
    ).toBe(true);
    expect(
      rejects(openRequestSchema, { id: "1", kind: "open", payload: { filename: "/a", directory: "" } }),
    ).toBe(true);
  });

  it("accepts a close with any payload — it has no arguments", () => {
    expect(closeRequestSchema.safeParse({ id: "1", kind: "close", payload: {} }).success).toBe(true);
  });
});

describe("rpcResponseSchema", () => {
  it("accepts a success envelope", () => {
    expect(
      rpcResponseSchema.safeParse({ id: "1", kind: "query", ok: true, result: { rows: [], changes: 0 } })
        .success,
    ).toBe(true);
  });

  it("accepts a failure envelope", () => {
    expect(
      rpcResponseSchema.safeParse({
        id: "1",
        kind: "open",
        ok: false,
        error: { code: "database_owned_by_another_context", message: "taken", details: {} },
      }).success,
    ).toBe(true);
  });

  it("rejects an error code that is not in the union", () => {
    expect(
      rejects(rpcResponseSchema, {
        id: "1",
        kind: "open",
        ok: false,
        error: { code: "kaboom", message: "boom", details: {} },
      }),
    ).toBe(true);
  });

  it("rejects non-string detail values — details must stay flat", () => {
    expect(
      rejects(rpcResponseSchema, {
        id: "1",
        kind: "open",
        ok: false,
        error: {
          code: "internal",
          message: "boom",
          details: { nested: { deeper: 1 } },
        },
      }),
    ).toBe(true);
  });

  it("rejects an envelope with no correlation id or kind", () => {
    expect(rejects(rpcResponseSchema, { kind: "query", ok: true, result: {} })).toBe(true);
    expect(rejects(rpcResponseSchema, { id: "1", ok: true, result: {} })).toBe(true);
    expect(rejects(rpcResponseSchema, { id: "1", kind: "query" })).toBe(true);
  });

  it("validates the error payload on its own too", () => {
    expect(
      storageErrorPayloadSchema.safeParse({ code: "sql_error", message: "m", details: {} }).success,
    ).toBe(true);
    expect(rejects(storageErrorPayloadSchema, { code: "sql_error", message: "m" })).toBe(true);
  });
});

describe("error serialization", () => {
  it("keeps a StorageError as-is", () => {
    const original = new StorageError("sql_error", "constraint failed", { sqliteCodeName: "SQLITE_CONSTRAINT" });
    expect(toStorageError(original)).toBe(original);
  });

  it("flattens a SQLite-WASM error object", () => {
    const sqliteError = {
      resultCode: 19,
      resultCodeName: "SQLITE_CONSTRAINT",
      message: "UNIQUE constraint failed: parts.id",
    };
    const error = toStorageError(sqliteError, "sql_error");

    expect(error.code).toBe("sql_error");
    expect(error.message).toContain("UNIQUE constraint failed");
    expect(error.details).toEqual({ sqliteCode: "19", sqliteCodeName: "SQLITE_CONSTRAINT" });
  });

  it("survives a thrown non-Error", () => {
    expect(toStorageError("plain string").message).toBe("plain string");
    expect(toStorageError(undefined).code).toBe("internal");
    expect(toStorageError({}).code).toBe("internal");
  });

  it("round-trips through the payload", () => {
    const original = new StorageError("database_owned_by_another_context", "taken", { name: "NoModificationAllowedError" });
    const restored = StorageError.fromPayload(JSON.parse(JSON.stringify(original.toPayload())) as never);

    expect(restored.code).toBe(original.code);
    expect(restored.message).toBe(original.message);
    expect(restored.details).toEqual(original.details);
  });

  it("copies the details instead of aliasing them", () => {
    const details = { a: "1" };
    const error = new StorageError("internal", "m", details);
    details["a"] = "2";
    expect(error.details["a"]).toBe("1");
  });
});

describe("ownership detection", () => {
  it("recognises the OPFS lock failures as another context holding the VFS", () => {
    for (const name of [
      "NoModificationAllowedError",
      "InvalidStateError",
      "NotAllowedError",
      "NotReadableError",
    ]) {
      expect(isOwnershipFailure({ name, message: "opaque" }), name).toBe(true);
    }
  });

  it("recognises a lock message without a DOM exception name", () => {
    expect(isOwnershipFailure(new Error("The file is locked by another context"))).toBe(true);
    expect(isOwnershipFailure(new Error("VFS is already installed"))).toBe(true);
  });

  it("does not claim a plain bug is an ownership problem", () => {
    expect(isOwnershipFailure(new Error("network unreachable"))).toBe(false);
    expect(isOwnershipFailure(new TypeError("x is not a function"))).toBe(false);
    expect(isOwnershipFailure(undefined)).toBe(false);
  });

  it("passes a StorageError through by its code", () => {
    expect(isOwnershipFailure(new StorageError("database_owned_by_another_context", "m"))).toBe(true);
    expect(isOwnershipFailure(new StorageError("sql_error", "m"))).toBe(false);
  });
});
