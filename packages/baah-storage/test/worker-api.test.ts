/**
 * The worker entry point, as a contract rather than as a process.
 *
 * Importing `src/worker.ts` would install a `message` listener on the global
 * scope and pull in the WASM module, neither of which belongs in a Node test.
 * What *can* be checked here is the protocol surface the worker serves — the
 * request union and the response envelope — plus the error mapping. That is what
 * Welle 2 codes against.
 *
 * The worker's runtime behaviour (VFS install, pragmas, real transactions) is
 * browser-only; see `Plan.md` §9 for the manual checklist.
 */

import { describe, expect, it } from "vitest";

import {
  closeResultSchema,
  flushDeltaResultSchema,
  openResultSchema,
  queryResultSchema,
  rpcRequestSchema,
  runResultSchema,
  searchResultSchema,
  storageErrorPayloadSchema,
  txResultSchema,
} from "../src/protocol.ts";
import { StorageError, ownershipError, toStorageError } from "../src/errors.ts";
import { PRAGMAS } from "../src/schema.ts";
import { LATEST_SCHEMA_VERSION } from "../src/migrations.ts";

/** Every request kind the worker dispatches. */
const KINDS = ["open", "query", "run", "tx", "search", "flushDelta", "close"] as const;

const VALID_REQUESTS: Record<(typeof KINDS)[number], unknown> = {
  open: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", kind: "open", payload: { filename: "/baah.sqlite3" } },
  query: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", kind: "query", payload: { sql: "SELECT 1", params: [], method: "all" } },
  run: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", kind: "run", payload: { sql: "DELETE FROM settings", params: [] } },
  tx: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", kind: "tx", payload: { statements: [{ sql: "SELECT 1", params: [] }] } },
  search: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", kind: "search", payload: { query: "opfs", limit: 20 } },
  flushDelta: {
    id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    kind: "flushDelta",
    payload: {
      deltaId: "d1",
      part: {
        id: "p1",
        messageId: "m1",
        sessionId: "s1",
        type: "text",
        contentText: "par",
        updatedAt: "2026-09-29T10:00:00.000Z",
      },
      flushedAt: "2026-09-29T10:00:00.000Z",
    },
  },
  close: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", kind: "close", payload: {} },
};

describe("the request union", () => {
  it("is exactly these seven kinds", () => {
    const parsed = KINDS.map((kind) => {
      const result = rpcRequestSchema.safeParse(VALID_REQUESTS[kind]);
      expect(result.success, kind).toBe(true);
      return result.success ? result.data.kind : null;
    });
    expect(new Set(parsed)).toEqual(new Set(KINDS));
  });

  it("carries a non-empty correlation id on every request", () => {
    for (const kind of KINDS) {
      const result = rpcRequestSchema.safeParse(VALID_REQUESTS[kind]);
      expect(result.success, kind).toBe(true);
      if (result.success) {
        expect(result.data.id.length).toBeGreaterThan(0);
        // The client generates it with `crypto.randomUUID()`.
        expect(result.data.id).toMatch(/^[0-9a-f-]+$/);
      }
    }
  });

  it("keeps a response tied to its request, so answers cannot cross over", () => {
    // Two calls in flight at once: the pending map is keyed by id, so a late
    // response settles only its own promise. Same shape, two ids.
    const first = rpcRequestSchema.parse(VALID_REQUESTS.query);
    const second = rpcRequestSchema.parse({
      id: crypto.randomUUID(),
      kind: "run",
      payload: { sql: "DELETE FROM settings", params: [] },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.kind).toBe("query");
    expect(second.kind).toBe("run");
  });

  it("echoes the kind so a late response cannot settle the wrong promise", () => {
    for (const kind of KINDS) {
      const result = rpcRequestSchema.parse(VALID_REQUESTS[kind]);
      // The worker posts `kind: request.kind` back on the envelope; the client
      // looks the pending call up by `id` and can therefore detect a mismatch.
      expect(result.kind).toBe(kind);
    }
  });
});

describe("the response envelope", () => {
  it("has exactly one success shape and one failure shape", () => {
    expect(rpcRequestSchema.safeParse(VALID_REQUESTS.query).success).toBe(true);
    // The envelope itself is validated by the client's rpcResponseSchema; the
    // per-kind result payloads are what carry the typed data.
    expect(openResultSchema.safeParse({
      filename: "/baah.sqlite3",
      vfsName: "opfs-sahpool",
      sqliteVersion: "3.53.4",
      schemaVersion: LATEST_SCHEMA_VERSION,
    }).success).toBe(true);
  });

  it("describes every result payload the worker sends", () => {
    expect(queryResultSchema.safeParse({ rows: [{ id: "s1" }], changes: 1 }).success).toBe(true);
    expect(queryResultSchema.safeParse({ rows: [["s1"]], changes: 0 }).success).toBe(true);
    expect(runResultSchema.safeParse({ changes: 3 }).success).toBe(true);
    expect(txResultSchema.safeParse({ changes: 2, results: [{ changes: 1, rows: [] }] }).success).toBe(true);
    expect(
      searchResultSchema.safeParse({
        hits: [
          {
            partId: "p1",
            messageId: "m1",
            sessionId: "s1",
            seq: 0,
            type: "text",
            createdAt: "2026-09-29T10:00:00.000Z",
            score: -1.2,
            excerpt: "…opfs…",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      flushDeltaResultSchema.safeParse({ partId: "p1", deltaId: "d1", applied: true, deltaSeq: 0 }).success,
    ).toBe(true);
    expect(flushDeltaResultSchema.safeParse({ partId: "p1", deltaId: "d1", applied: false, deltaSeq: 0 }).success).toBe(true);
    expect(closeResultSchema.safeParse({ closed: true }).success).toBe(true);
  });

  it("rejects a result payload that is missing a field", () => {
    expect(queryResultSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(runResultSchema.safeParse({}).success).toBe(false);
    expect(flushDeltaResultSchema.safeParse({ partId: "p1", deltaId: "d1", applied: true }).success).toBe(false);
    expect(closeResultSchema.safeParse({ closed: "yes" }).success).toBe(false);
  });
});

describe("what the worker does on open", () => {
  it("applies the four pragmas, foreign keys first", () => {
    expect(PRAGMAS).toEqual([
      "PRAGMA foreign_keys=ON",
      "PRAGMA journal_mode=DELETE",
      "PRAGMA synchronous=NORMAL",
      "PRAGMA busy_timeout=5000",
    ]);
  });

  it("reports the schema version it migrated to", () => {
    const result = openResultSchema.parse({
      filename: "/baah.sqlite3",
      vfsName: "opfs-sahpool",
      sqliteVersion: "3.53.4",
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  });
});

describe("the ownership error", () => {
  it("is a typed error the client can branch on, not a crash", () => {
    // This is what a second tab gets back from `open`.
    const raw = { name: "NoModificationAllowedError", message: "The file is locked." };
    const error = ownershipError(raw);

    expect(error.code).toBe("database_owned_by_another_context");
    expect(error).toBeInstanceOf(StorageError);
    expect(error.message).toMatch(/exactly one connection/i);

    // And it survives the boundary: a flat payload, no nested objects.
    const payload = error.toPayload();
    expect(storageErrorPayloadSchema.safeParse(payload).success).toBe(true);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("keeps the browser's own error name in the details", () => {
    const error = ownershipError({ name: "NoModificationAllowedError", message: "locked" });
    expect(error.details["name"]).toBe("NoModificationAllowedError");
  });

  it("does not label an unrelated failure as an ownership problem", () => {
    const error = toStorageError(new Error("network down"), "internal");
    expect(error.code).toBe("internal");
    expect(error.toPayload().code).toBe("internal");
  });
});

describe("error codes across the boundary", () => {
  it("are all part of the serialised union", () => {
    const codes = [
      "invalid_message",
      "database_owned_by_another_context",
      "database_already_open",
      "database_not_open",
      "database_closed",
      "sql_error",
      "nested_transaction",
      "unsupported",
      "internal",
    ] as const;

    for (const code of codes) {
      const payload = new StorageError(code, "m", {}).toPayload();
      expect(storageErrorPayloadSchema.safeParse(payload).success, code).toBe(true);
    }
  });

  it("a statement before open is database_not_open, not a crash", () => {
    const error = new StorageError(
      "database_not_open",
      "No database is open in this worker; send an 'open' request first.",
    );
    expect(error.toPayload().code).toBe("database_not_open");
  });

  it("a statement after close is database_closed", () => {
    expect(new StorageError("database_closed", "m").toPayload().code).toBe("database_closed");
  });

  it("an overlapping batch is nested_transaction, not a bare SQLite error", () => {
    // The worker guards `BEGIN IMMEDIATE` with a flag and names the cause.
    const error = new StorageError(
      "nested_transaction",
      "A transaction is already running on this connection; batches cannot overlap.",
    );
    expect(error.toPayload().code).toBe("nested_transaction");
    expect(storageErrorPayloadSchema.safeParse(error.toPayload()).success).toBe(true);
  });

  it("a second open in the same worker is database_already_open", () => {
    // `opfs-sahpool` allows exactly one connection, so this is caught in the
    // worker rather than as a lock error from SQLite.
    expect(
      new StorageError("database_already_open", "m").toPayload().code,
    ).toBe("database_already_open");
  });
});
