/**
 * The replay key and the crash window, on the in-memory backend only.
 *
 * ## Why this file exists even though `tool-call-identity.test.ts` covers it
 *
 * That file is a *parity* test: it runs one input through both backends inside
 * a single `it`, so a mutation of either backend is caught by the same test
 * name. That is exactly what parity is for, and it is not enough on its own: a
 * mutation killed by one test is killed by one path, and the question "is
 * there a second one?" needs an answer that is not "the same assertion twice".
 *
 * So this file asserts the same properties on the in-memory engine alone, in a
 * different file, in a different vitest worker, with no SQL behind it at all.
 * The two files fail for different reasons if either backend's engine drifts,
 * and a mutation that removes the `status` distinction cannot hide from both.
 *
 * What is *not* asserted here: anything the two backends are allowed to
 * disagree about (`Plan.md` §16.1) — FTS5 ordering, `bm25()`, non-finite
 * limits, the `changes` channel on a mixed batch.
 */

import { describe, expect, it } from "vitest";

import { createMemoryDatabase } from "../src/factory.ts";
import { encodeToolOutput, RESULT_PREVIEW_CHARS } from "../src/operations.ts";
import type { MemoryDatabase } from "../src/factory.ts";
import type { ToolCallKey } from "../src/types.ts";

const T0 = "2026-09-29T10:00:00.000Z";

const KEY: ToolCallKey = { sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 };

async function seeded(): Promise<MemoryDatabase> {
  const db = createMemoryDatabase();
  await db.createSession({ id: "s1", title: "t" });
  return db;
}

describe("the crash window, without a database underneath", () => {
  it("a begun call is visible as begun — this is what the whole column is for", async () => {
    const db = await seeded();
    expect(await db.getToolCall(KEY)).toBeUndefined();

    await db.beginToolCall({ key: KEY, toolName: "write", input: { path: "a.txt" } });

    // Not "not present". A store that reported absence here is the old bug: a
    // crash in this window would be indistinguishable from "never ran", and the
    // only available answer would be to run a `write` tool a second time.
    expect(await db.getToolCall(KEY)).toEqual({ status: "begun" });
  });

  it("recording closes the window, and only that does", async () => {
    const db = await seeded();
    await db.beginToolCall({ key: KEY, toolName: "write", input: { path: "a.txt" } });
    await db.recordToolCall({ key: KEY, toolName: "write", output: { bytesWritten: 3 } });

    expect(await db.getToolCall(KEY)).toEqual({ status: "done", output: { bytesWritten: 3 } });
  });

  it("a second begin does not reopen a closed window", async () => {
    const db = await seeded();
    await db.beginToolCall({ key: KEY, toolName: "write", input: null });
    await db.recordToolCall({ key: KEY, toolName: "write", output: "wrote" });
    await db.beginToolCall({ key: KEY, toolName: "write", input: null });

    expect(await db.getToolCall(KEY)).toEqual({ status: "done", output: "wrote" });
    expect(db.counts().toolInvocations).toBe(1);
  });

  it("the same, three times over, is still one row", async () => {
    const db = await seeded();
    for (let round = 0; round < 4; round += 1) {
      await db.beginToolCall({ key: KEY, toolName: "write", input: round });
    }
    expect(db.counts().toolInvocations).toBe(1);
    expect(await db.getToolCall(KEY)).toEqual({ status: "begun" });
  });
});

describe("the four-part key, without a database underneath", () => {
  it("a reused id keeps both calls", async () => {
    // The silent drop. With a bare `toolCallId` the second call resolves to the
    // first one's record, the tool runs once, and the turn reports `succeeded`
    // while the model holds an answer for a call it never made.
    const db = await seeded();
    await db.recordToolCall({ key: { ...KEY, occurrence: 0 }, toolName: "read", output: "A" });
    await db.recordToolCall({ key: { ...KEY, occurrence: 1 }, toolName: "read", output: "B" });

    expect(await db.getToolCall({ ...KEY, occurrence: 0 })).toEqual({ status: "done", output: "A" });
    expect(await db.getToolCall({ ...KEY, occurrence: 1 })).toEqual({ status: "done", output: "B" });
    expect(db.counts().toolInvocations).toBe(2);
  });

  it("a second session with the same id keeps its own record", async () => {
    const db = await seeded();
    await db.createSession({ id: "s2", title: "other" });
    await db.recordToolCall({ key: { ...KEY, sessionId: "s1" }, toolName: "a", output: "one" });
    await db.recordToolCall({ key: { ...KEY, sessionId: "s2" }, toolName: "b", output: "two" });

    expect(await db.getToolCall({ ...KEY, sessionId: "s1" })).toEqual({ status: "done", output: "one" });
    expect(await db.getToolCall({ ...KEY, sessionId: "s2" })).toEqual({ status: "done", output: "two" });
  });

  it("a retry is a new attempt, and its calls are its own", async () => {
    const db = await seeded();
    await db.recordToolCall({ key: { ...KEY, attempt: 1 }, toolName: "a", output: "first" });
    await db.recordToolCall({ key: { ...KEY, attempt: 2 }, toolName: "a", output: "second" });

    expect(await db.getToolCall({ ...KEY, attempt: 1 })).toEqual({ status: "done", output: "first" });
    expect(await db.getToolCall({ ...KEY, attempt: 2 })).toEqual({ status: "done", output: "second" });
  });

  it("a begun call in one session is not visible from another", async () => {
    const db = await seeded();
    await db.createSession({ id: "s2", title: "other" });
    await db.beginToolCall({ key: { ...KEY, sessionId: "s1" }, toolName: "write", input: null });

    expect(await db.getToolCall({ ...KEY, sessionId: "s1" })).toEqual({ status: "begun" });
    expect(await db.getToolCall({ ...KEY, sessionId: "s2" })).toBeUndefined();
  });
});

describe("listUnfinishedTurns, without a database underneath", () => {
  it("excludes succeeded and failed, keeps everything else", async () => {
    const db = await seeded();
    for (const status of ["pending", "streaming", "succeeded", "failed", "interrupted"] as const) {
      await db.appendTurn({ id: `t-${status}`, sessionId: "s1", startedAt: T0, status });
    }

    const ids = (await db.listUnfinishedTurns({ sessionId: "s1" })).map((turn) => turn.turnId);
    expect(ids).toEqual(["t-pending", "t-streaming", "t-interrupted"]);
  });

  it("orders by seq, not by insertion accident", async () => {
    const db = await seeded();
    // Three turns created in the same millisecond — the case `created_at`
    // cannot order (`Plan.md` §6.2).
    await db.appendTurn({ id: "a", sessionId: "s1", startedAt: T0 });
    await db.appendTurn({ id: "b", sessionId: "s1", startedAt: T0 });
    await db.appendTurn({ id: "c", sessionId: "s1", startedAt: T0 });

    expect((await db.listUnfinishedTurns({ sessionId: "s1" })).map((turn) => turn.turnId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("a turn with no heartbeat reports its own start", async () => {
    // A blank would read as "infinitely stale" and close a turn created a
    // moment ago; the engine's 30 s threshold would never get to run.
    const db = await seeded();
    await db.appendTurn({ id: "t", sessionId: "s1", startedAt: T0 });

    expect(await db.listUnfinishedTurns({ sessionId: "s1" })).toEqual([
      { turnId: "t", heartbeatAt: T0, startedAt: T0 },
    ]);
  });
});

describe("the output encoding, on its own", () => {
  it("`undefined` is NULL, not the JSON text `null`", () => {
    // `JSON.stringify(undefined)` is `undefined`. Coercing it would turn "the
    // tool returned nothing" into "the tool returned null" and a replay would
    // hand the second to the model as the first's answer.
    expect(encodeToolOutput(undefined)).toBeNull();
    expect(encodeToolOutput(null)).toBe("null");
    expect(encodeToolOutput(0)).toBe("0");
    expect(encodeToolOutput(false)).toBe("false");
    expect(encodeToolOutput("")).toBe('""');
  });

  it("the preview is bounded and never the replayed value", () => {
    const long = "x".repeat(RESULT_PREVIEW_CHARS + 100);
    // The preview is a display copy. `output` is never derived from it, so a
    // long answer must not come back shortened.
    expect(encodeToolOutput(long)?.length).toBe(long.length + 2);
  });
});
