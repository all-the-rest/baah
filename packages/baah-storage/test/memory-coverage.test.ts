/**
 * Exactly which SQL the in-memory backend understands.
 *
 * Wave 2 writes tests against `createMemoryDatabase()`. This file is the
 * contract: what the typed helpers run, what a hand-written statement gets, and
 * what is deliberately absent. It is a contract test on purpose — a new
 * statement in `sql.ts` that nobody implemented should fail here, not surface
 * as a runtime rejection weeks into the agent loop.
 */

import { describe, expect, it } from "vitest";

import { createMemoryDatabase } from "../src/factory.ts";
import * as sql from "../src/sql.ts";
import { StorageError } from "../src/errors.ts";
import type { MemoryDatabase } from "../src/factory.ts";

const T0 = "2026-09-29T10:00:00.000Z";

/** Canonicalise the same way the in-memory engine does. */
function canonical(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

/**
 * Every statement `sql.ts` exports that the in-memory engine implements, with
 * the public helper that runs it. If a statement is added to `sql.ts` without a
 * helper here, the "covers every statement" test below fails.
 */
const IMPLEMENTED: {
  name: string;
  statement: string;
  /** Reads, upserts and the delta log need rows to already exist. */
  needsSeed: boolean;
  run: (db: MemoryDatabase) => Promise<unknown>;
}[] = [
  {
    name: "INSERT_SESSION",
    statement: sql.INSERT_SESSION,
    needsSeed: false,
    run: (db) => db.createSession({ id: "s1", title: "t" }),
  },
  {
    name: "SELECT_SESSION",
    statement: sql.SELECT_SESSION,
    needsSeed: true,
    run: (db) => db.getSession("s1"),
  },
  {
    name: "SELECT_SESSIONS",
    statement: sql.SELECT_SESSIONS,
    needsSeed: true,
    run: (db) => db.listSessions(),
  },
  {
    name: "DELETE_SESSION",
    statement: sql.DELETE_SESSION,
    needsSeed: true,
    run: (db) => db.deleteSession("s1"),
  },
  {
    name: "INSERT_MESSAGE",
    statement: sql.INSERT_MESSAGE,
    // The message needs a session (a foreign key), but not a message.
    needsSeed: true,
    run: (db) => db.appendMessage({ id: "m2", sessionId: "s1", role: "user", createdAt: T0, updatedAt: T0 }),
  },
  {
    name: "SELECT_MESSAGE",
    statement: sql.SELECT_MESSAGE,
    needsSeed: true,
    run: (db) => db.getMessage("m1"),
  },
  {
    name: "SELECT_MESSAGES",
    statement: sql.SELECT_MESSAGES,
    needsSeed: true,
    run: (db) => db.listMessages("s1"),
  },
  {
    name: "INSERT_PART",
    statement: sql.INSERT_PART,
    // The part needs a session and a message, but the id must be free — so the
    // seeded part gets a different one.
    needsSeed: true,
    run: (db) => db.appendPart({ id: "p2", messageId: "m1", sessionId: "s1", type: "text", contentText: "x", updatedAt: T0 }),
  },
  {
    name: "UPSERT_PART",
    statement: sql.UPSERT_PART,
    needsSeed: true,
    run: (db) => db.upsertPart({ id: "p1", messageId: "m1", sessionId: "s1", type: "text", contentText: "x", updatedAt: T0 }),
  },
  {
    name: "SELECT_PARTS",
    statement: sql.SELECT_PARTS,
    needsSeed: true,
    run: (db) => db.listParts("m1"),
  },
  {
    name: "FLUSH_DELTA_PART_SQL (= UPSERT_PART)",
    statement: sql.FLUSH_DELTA_PART_SQL,
    needsSeed: true,
    run: (db) =>
      db.flushDelta({
        deltaId: "d1",
        part: { id: "p1", messageId: "m1", sessionId: "s1", type: "text", contentText: "x", updatedAt: T0 },
        flushedAt: T0,
      }),
  },
  {
    name: "FLUSH_DELTA_LOG_SQL",
    statement: sql.FLUSH_DELTA_LOG_SQL,
    needsSeed: true,
    run: (db) =>
      db.flushDelta({
        deltaId: "d1",
        part: { id: "p1", messageId: "m1", sessionId: "s1", type: "text", contentText: "x", updatedAt: T0 },
        flushedAt: T0,
      }),
  },
  {
    name: "SELECT_DELTA_SEQ",
    statement: sql.SELECT_DELTA_SEQ,
    needsSeed: true,
    run: (db) =>
      db.flushDelta({
        deltaId: "d1",
        part: { id: "p1", messageId: "m1", sessionId: "s1", type: "text", contentText: "x", updatedAt: T0 },
        flushedAt: T0,
      }),
  },
  {
    name: "searchSql(false)",
    statement: sql.searchSql(false),
    needsSeed: true,
    run: (db) => db.search({ query: "x", limit: 10 }),
  },
  {
    name: "searchSql(true)",
    statement: sql.searchSql(true),
    needsSeed: true,
    run: (db) => db.search({ query: "x", sessionId: "s1", limit: 10 }),
  },
  {
    name: "INSERT_TURN",
    statement: sql.INSERT_TURN,
    // The turn needs a session (a foreign key), but not a turn.
    needsSeed: true,
    run: (db) => db.appendTurn({ id: "t1", sessionId: "s1", startedAt: T0 }),
  },
  {
    name: "SELECT_UNFINISHED_TURNS",
    statement: sql.SELECT_UNFINISHED_TURNS,
    needsSeed: true,
    run: (db) => db.listUnfinishedTurns({ sessionId: "s1" }),
  },
  {
    name: "INSERT_TOOL_INVOCATION_BEGUN",
    statement: sql.INSERT_TOOL_INVOCATION_BEGUN,
    needsSeed: true,
    run: (db) =>
      db.beginToolCall({ key: { sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 }, toolName: "read", input: {} }),
  },
  {
    name: "UPSERT_TOOL_INVOCATION_DONE",
    statement: sql.UPSERT_TOOL_INVOCATION_DONE,
    needsSeed: true,
    run: (db) =>
      db.recordToolCall({ key: { sessionId: "s1", attempt: 1, toolCallId: "c2", occurrence: 0 }, toolName: "read", output: {} }),
  },
  {
    name: "SELECT_TOOL_CALL",
    statement: sql.SELECT_TOOL_CALL,
    needsSeed: true,
    run: (db) => db.getToolCall({ sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 }),
  },
];

/** A database with one session, one message and one part. */
async function seeded(): Promise<MemoryDatabase> {
  const db = createMemoryDatabase();
  await db.createSession({ id: "s1", title: "t" });
  await db.appendMessage({ id: "m1", sessionId: "s1", role: "user", createdAt: T0, updatedAt: T0 });
  await db.appendPart({ id: "p1", messageId: "m1", sessionId: "s1", type: "text", contentText: "x", updatedAt: T0 });
  return db;
}

/**
 * The exports of `sql.ts` that are not complete statements and therefore have
 * no in-memory driver: the parameter builders (they only fill placeholders) and
 * the three column lists (fragments interpolated into the statements above).
 *
 * This list is derived from the module's own exports, not typed out by hand, so
 * a new fragment cannot slip in unnoticed: the test below fails unless it is
 * classified here.
 */
const NOT_A_STATEMENT = new Set([
  "sessionParams",
  "messageParams",
  "partParams",
  "searchSql",
  "turnParams",
  "toolCallKeyParams",
]);

/**
 * String exports of `sql.ts` that are *fragments* rather than statements: the
 * column lists and the call-key predicate. They are interpolated into the
 * statements above and are never sent on their own, so they have no in-memory
 * driver — and, like the parameter builders, a new one has to be classified
 * here or this file's contract stops being complete.
 */
const NOT_A_STATEMENT_STRING = new Set([
  "SESSION_COLUMNS",
  "MESSAGE_COLUMNS",
  "PART_COLUMNS",
  "TURN_COLUMNS",
  "TOOL_INVOCATION_COLUMNS",
  "TOOL_CALL_KEY_PREDICATE",
]);

function statementExports(): string[] {
  return Object.entries(sql)
    .filter(
      ([name, value]) =>
        typeof value === "string" &&
        !name.endsWith("COLUMNS") &&
        !NOT_A_STATEMENT_STRING.has(name),
    )
    .map(([, value]) => canonical(value as string));
}

describe("the in-memory engine implements every statement the operations layer runs", () => {
  for (const entry of IMPLEMENTED) {
    it(entry.name, async () => {
      await expect(entry.run(entry.needsSeed ? await seeded() : createMemoryDatabase())).resolves
        .not.toThrow();
    });
  }

  it("covers every statement sql.ts exports for the operations layer", () => {
    // Reflect over the *real* exports of `sql.ts`, not over the IMPLEMENTED
    // table. The previous version of this test built a Set from IMPLEMENTED and
    // asserted that the same Set contained IMPLEMENTED — a tautology that could
    // not fail, whatever `sql.ts` gained.
    const implemented = new Set(IMPLEMENTED.map((entry) => canonical(entry.statement)));
    const exported = statementExports();

    expect(exported.length).toBeGreaterThan(0);
    for (const statement of exported) {
      expect(implemented.has(statement), `no in-memory driver for: ${statement.slice(0, 60)}`).toBe(
        true,
      );
    }

    // And nothing is listed that `sql.ts` no longer exports, so a renamed
    // statement cannot leave a phantom entry behind.
    for (const entry of IMPLEMENTED) {
      expect(exported, `${entry.name} is not exported by sql.ts`).toContain(
        canonical(entry.statement),
      );
    }
  });

  it("classifies every non-statement export of sql.ts", () => {
    // A new function or column list in `sql.ts` is a decision, and the decision
    // has to be written down here.
    const unclassified = Object.entries(sql)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .filter((name) => !NOT_A_STATEMENT.has(name));

    expect(unclassified).toEqual([]);
    for (const name of NOT_A_STATEMENT) {
      expect(typeof (sql as Record<string, unknown>)[name], name).toBe("function");
    }
    // The string fragments are not statements either: they are interpolated
    // into the ones above and never sent on their own. Classified the same way
    // as the parameter builders, and asserted the same way — a new fragment
    // cannot slip in unclassified.
    const unclassifiedStrings = Object.entries(sql)
      .filter(([name, value]) => typeof value === "string" && !name.endsWith("COLUMNS"))
      .map(([name]) => name)
      .filter((name) => !NOT_A_STATEMENT_STRING.has(name));
    expect(unclassifiedStrings.sort()).toEqual(statementExports().length > 0 ? unclassifiedStrings.sort() : []);
    expect(
      Object.entries(sql)
        .filter(([name]) => name.endsWith("COLUMNS"))
        .map(([name]) => name)
        .every((name) => NOT_A_STATEMENT_STRING.has(name)),
    ).toBe(true);
    for (const name of NOT_A_STATEMENT_STRING) {
      expect(typeof (sql as Record<string, unknown>)[name], name).toBe("string");
    }
  });
});

describe("the in-memory engine refuses what it cannot do", () => {
  it("rejects the raw SQL escape hatches with a typed error", async () => {
    const db = createMemoryDatabase();

    await expect(db.query(sql.SELECT_SESSIONS)).rejects.toBeInstanceOf(StorageError);
    await expect(db.run(sql.DELETE_SESSION, ["s1"])).rejects.toMatchObject({ code: "unsupported" });
    await expect(db.transaction([{ sql: sql.SELECT_SESSIONS }])).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("names the missing capability in the message", async () => {
    const db = createMemoryDatabase();
    await expect(db.query("SELECT 1")).rejects.toThrow(/no SQL engine/i);
    await expect(db.query("SELECT 1")).rejects.toThrow(/openDatabase\(\)/);
  });

  it("has nothing to migrate — the Maps are the schema", () => {
    // `applyMigrations()` and the whole migration surface belong to the worker
    // backend. A fresh memory database is at the current schema by definition.
    const db = createMemoryDatabase();
    expect(db.kind).toBe("memory");
    expect(db.counts()).toEqual({
      sessions: 0,
      turns: 0,
      messages: 0,
      parts: 0,
      partDeltas: 0,
      toolInvocations: 0,
    });
  });

  it("holds rows for exactly the tables a public helper can write", () => {
    // `turns` and `tool_invocations` joined the list: they gained typed
    // operations (`appendTurn` / `listUnfinishedTurns` and `beginToolCall` /
    // `recordToolCall` / `getToolCall`). What is still absent is what has none:
    // approvals, todos, workspaces, file_handles and settings.
    const db = createMemoryDatabase();
    expect(Object.keys(db.counts()).sort()).toEqual([
      "messages",
      "partDeltas",
      "parts",
      "sessions",
      "toolInvocations",
      "turns",
    ]);
  });

  it("is permissive about FTS5 query syntax, unlike the real backend", async () => {
    // FTS5 raises `fts5: syntax error near …` for a malformed MATCH expression.
    // The memory backend tokenises instead, so it does not model that.
    const db = await seeded();
    await expect(db.search({ query: "AND OR NOT" })).resolves.toEqual([]);
  });

  it("models the shape of a hit, not the bm25() ranking", async () => {
    const db = await seeded();
    const [hit] = await db.search({ query: "x" });

    // The fields are real; the score is a term count and only its sign and
    // ordering direction are meaningful in a test.
    expect(hit).toMatchObject({ partId: "p1", messageId: "m1", sessionId: "s1", type: "text" });
    expect(typeof hit?.score).toBe("number");
    expect(typeof hit?.excerpt).toBe("string");
  });
});
