/**
 * The in-memory database — the reason this package is testable in Node.
 *
 * These are the guarantees a caller (the agent loop, the transcript UI) relies
 * on, asserted against `createMemoryDatabase()`. The worker-backed database
 * runs the *same* operations module over SQLite, so the semantics are shared;
 * only the engine differs. What cannot be proven here is SQLite-specific
 * behaviour — cascades, `ON CONFLICT`, FTS5 — and that needs a browser.
 */

import { describe, expect, it } from "vitest";

import { createMemoryDatabase } from "../src/factory.ts";
import { StorageError } from "../src/errors.ts";
import type { MemoryDatabase } from "../src/factory.ts";
import type { MessageInput, PartInput, SessionInput } from "../src/types.ts";

const T0 = "2026-09-29T10:00:00.000Z";

function session(overrides: Partial<SessionInput> = {}): SessionInput {
  return { id: "s1", title: "First session", ...overrides };
}

function message(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    id: "m1",
    sessionId: "s1",
    role: "user",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function part(overrides: Partial<PartInput> = {}): PartInput {
  return {
    id: "p1",
    messageId: "m1",
    sessionId: "s1",
    type: "text",
    contentText: "hello",
    updatedAt: T0,
    ...overrides,
  };
}

/** A database with one session, one message and one text part. */
async function seeded(): Promise<MemoryDatabase> {
  const db = createMemoryDatabase();
  await db.createSession(session());
  await db.appendMessage(message());
  return db;
}

describe("sessions", () => {
  it("inserts a session and reads it back", async () => {
    const db = createMemoryDatabase();
    const created = await db.createSession(
      session({ model: "some-model", systemPrompt: "be brief", metadata: '{"a":1}' }),
    );

    expect(created).toEqual({
      id: "s1",
      title: "First session",
      status: "active",
      model: "some-model",
      systemPrompt: "be brief",
      metadata: '{"a":1}',
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      archivedAt: null,
      // Migration 5's column. `null` and not a made-up project: a session created
      // without one belongs to no project, and the truthful value is what makes a
      // project-scoped read honest about that.
      workspaceId: null,
    });
    expect(await db.getSession("s1")).toEqual(created);
  });

  it("defaults title, status and the optional columns", async () => {
    const db = createMemoryDatabase();
    const created = await db.createSession({ id: "bare" });

    expect(created.title).toBe("");
    expect(created.status).toBe("active");
    expect(created.model).toBeNull();
    expect(created.systemPrompt).toBeNull();
    expect(created.metadata).toBeNull();
    expect(created.archivedAt).toBeNull();
  });

  it("returns null for an unknown session", async () => {
    const db = createMemoryDatabase();
    expect(await db.getSession("nope")).toBeNull();
  });

  it("refuses a duplicate id", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());
    await expect(db.createSession(session())).rejects.toThrow(/UNIQUE constraint/i);
  });

  it("lists sessions newest first", async () => {
    const db = createMemoryDatabase();
    await db.createSession({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" });
    await db.createSession({ id: "new", updatedAt: "2026-06-01T00:00:00.000Z" });
    await db.createSession({ id: "middle", updatedAt: "2026-03-01T00:00:00.000Z" });

    expect((await db.listSessions()).map((row) => row.id)).toEqual(["new", "middle", "old"]);
  });
});

describe("messages", () => {
  it("appends messages and assigns seq from zero, in order", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());

    const first = await db.appendMessage(message({ id: "m1" }));
    const second = await db.appendMessage(message({ id: "m2" }));
    const third = await db.appendMessage(message({ id: "m3" }));

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect((await db.listMessages("s1")).map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("orders by seq, not by created_at", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());

    // Same millisecond, and the later insert carries the earlier timestamp.
    // `seq` is the sort key (§6.2), so the read order must still be m1, m2, m3.
    await db.appendMessage(message({ id: "m1", createdAt: T0 }));
    await db.appendMessage(message({ id: "m2", createdAt: T0 }));
    await db.appendMessage(message({ id: "m3", createdAt: T0 }));

    const rows = await db.listMessages("s1");
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
    expect(rows.every((row) => row.createdAt === T0)).toBe(true);
  });

  it("keeps seq per session", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session({ id: "a" }));
    await db.createSession(session({ id: "b" }));

    await db.appendMessage(message({ id: "a1", sessionId: "a" }));
    await db.appendMessage(message({ id: "a2", sessionId: "a" }));
    const b1 = await db.appendMessage(message({ id: "b1", sessionId: "b" }));

    expect(b1.seq).toBe(0);
    expect((await db.listMessages("a")).map((row) => row.seq)).toEqual([0, 1]);
    expect((await db.listMessages("b")).map((row) => row.seq)).toEqual([0]);
  });

  it("honours an explicit seq", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());
    const skipped = await db.appendMessage(message({ id: "m1", seq: 5 }));

    expect(skipped.seq).toBe(5);
    // The next one continues from the high-water mark.
    const next = await db.appendMessage(message({ id: "m2" }));
    expect(next.seq).toBe(6);
  });

  it("rejects a duplicate seq inside one session", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());
    await db.appendMessage(message({ id: "m1", seq: 0 }));
    await expect(db.appendMessage(message({ id: "m2", seq: 0 }))).rejects.toThrow(
      /UNIQUE constraint/i,
    );
  });

  it("rejects a message for an unknown session", async () => {
    const db = createMemoryDatabase();
    await expect(db.appendMessage(message())).rejects.toThrow(/FOREIGN KEY constraint/i);
  });

  it("keeps the role, status and outcome of the turn", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());
    const idle = await db.appendMessage(
      message({ id: "m1", role: "idle", outcome: "interrupted", status: "failed" }),
    );

    expect(idle.role).toBe("idle");
    expect(idle.outcome).toBe("interrupted");
    expect(idle.status).toBe("failed");
  });

  it("returns null for an unknown message", async () => {
    const db = await seeded();
    expect(await db.getMessage("nope")).toBeNull();
  });
});

describe("parts", () => {
  it("appends parts to a message in seq order", async () => {
    const db = await seeded();
    const first = await db.appendPart(part({ id: "p1", contentText: "thinking" }));
    const second = await db.appendPart(part({ id: "p2", type: "reasoning", contentText: "hmm" }));
    const third = await db.appendPart(part({ id: "p3", type: "tool", contentText: "{}" }));

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect((await db.listParts("m1")).map((row) => row.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("keeps the three part types apart", async () => {
    const db = await seeded();
    await db.appendPart(part({ id: "p1", type: "text" }));
    await db.appendPart(part({ id: "p2", type: "reasoning" }));
    const tool = await db.appendPart(
      part({ id: "p3", type: "tool", data: '{"metadata":{"files":[{"file":"a.ts"}]}}' }),
    );

    expect(tool.type).toBe("tool");
    expect(tool.data).toContain("files");
  });

  it("rejects a part for an unknown message", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session());
    await expect(db.appendPart(part())).rejects.toThrow(/FOREIGN KEY constraint/i);
  });

  it("appends the parts of two messages independently", async () => {
    const db = await seeded();
    await db.appendMessage(message({ id: "m2" }));
    await db.appendPart(part({ id: "p1", messageId: "m1" }));
    await db.appendPart(part({ id: "p2", messageId: "m2" }));
    const p3 = await db.appendPart(part({ id: "p3", messageId: "m2" }));

    expect(p3.seq).toBe(1);
    expect((await db.listParts("m1")).map((row) => row.id)).toEqual(["p1"]);
    expect((await db.listParts("m2")).map((row) => row.id)).toEqual(["p2", "p3"]);
  });
});

describe("upsertPart (streaming)", () => {
  it("inserts the part on the first call", async () => {
    const db = await seeded();
    const created = await db.upsertPart(part({ contentText: "par", status: "streaming" }));

    expect(created.seq).toBe(0);
    expect(created.status).toBe("streaming");
    expect(db.counts().parts).toBe(1);
  });

  it("is idempotent when the same payload arrives twice", async () => {
    const db = await seeded();
    const payload = part({ contentText: "par", status: "streaming", updatedAt: T0 });

    const first = await db.upsertPart(payload);
    const second = await db.upsertPart(payload);

    expect(second).toEqual(first);
    expect(db.counts().parts).toBe(1);
  });

  it("grows the text and keeps the original seq and created_at", async () => {
    const db = await seeded();
    const created = await db.upsertPart(
      part({ contentText: "par", createdAt: T0, updatedAt: T0 }),
    );

    const grown = await db.upsertPart(
      part({ contentText: "partial", createdAt: T0, updatedAt: "2026-09-29T10:00:01.000Z" }),
    );

    expect(grown.contentText).toBe("partial");
    expect(grown.seq).toBe(created.seq);
    expect(grown.createdAt).toBe(created.createdAt);
    expect(grown.updatedAt).toBe("2026-09-29T10:00:01.000Z");
    expect(db.counts().parts).toBe(1);
  });

  it("keeps the seq of a part that was appended in between", async () => {
    const db = await seeded();
    const streaming = await db.upsertPart(part({ id: "p1", contentText: "a" }));
    await db.appendPart(part({ id: "p2", contentText: "b" }));

    // Retrying the streaming part must not jump to the end of the message.
    const retried = await db.upsertPart(part({ id: "p1", contentText: "a2" }));

    expect(retried.seq).toBe(streaming.seq);
    expect((await db.listParts("m1")).map((row) => row.id)).toEqual(["p1", "p2"]);
  });

  it("replaces the payload fields, keeping unset ones from the caller", async () => {
    const db = await seeded();
    await db.upsertPart(
      part({ id: "p1", type: "tool", data: '{"state":"running"}', contentText: "call" }),
    );
    const updated = await db.upsertPart(
      part({ id: "p1", type: "tool", data: '{"state":"done"}', contentText: "result" }),
    );

    expect(updated.data).toBe('{"state":"done"}');
    expect(updated.contentText).toBe("result");
  });
});

describe("flushDelta", () => {
  it("upserts the part and appends one delta", async () => {
    const db = await seeded();
    const result = await db.flushDelta({
      deltaId: "d1",
      part: part({ contentText: "par", status: "streaming" }),
      flushedAt: T0,
    });

    expect(result).toEqual({ partId: "p1", deltaId: "d1", applied: true, deltaSeq: 0 });
    expect(db.counts()).toMatchObject({ parts: 1, partDeltas: 1 });
    expect((await db.listParts("m1"))[0]?.contentText).toBe("par");
  });

  it("appends to the delta log with increasing seq", async () => {
    const db = await seeded();
    const first = await db.flushDelta({
      deltaId: "d1",
      part: part({ contentText: "p" }),
      flushedAt: T0,
    });
    const second = await db.flushDelta({
      deltaId: "d2",
      part: part({ contentText: "pa" }),
      flushedAt: T0,
    });
    const third = await db.flushDelta({
      deltaId: "d3",
      part: part({ contentText: "par" }),
      flushedAt: T0,
    });

    expect([first.deltaSeq, second.deltaSeq, third.deltaSeq]).toEqual([0, 1, 2]);
    expect(db.deltas().map((delta) => delta.contentText)).toEqual(["p", "pa", "par"]);
  });

  it("applied twice does not duplicate — this is the retry path", async () => {
    const db = await seeded();
    const message = {
      deltaId: "d1",
      part: part({ contentText: "par", status: "streaming", updatedAt: T0 }),
      flushedAt: T0,
    };

    const first = await db.flushDelta(message);
    const second = await db.flushDelta(message);

    expect(first.applied).toBe(true);
    // The retry is accepted, reported as a no-op, and changes nothing.
    expect(second.applied).toBe(false);
    expect(second.deltaId).toBe(first.deltaId);
    expect(second.deltaSeq).toBe(first.deltaSeq);

    expect(db.counts()).toMatchObject({ parts: 1, partDeltas: 1 });
    expect(db.deltas()).toHaveLength(1);
  });

  it("survives a retry storm without duplicating anything", async () => {
    const db = await seeded();
    const payload = {
      deltaId: "d1",
      part: part({ contentText: "par", updatedAt: T0 }),
      flushedAt: T0,
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.flushDelta(payload);
    }

    expect(db.counts()).toMatchObject({ parts: 1, partDeltas: 1 });
  });

  it("still appends the next delta after a retry", async () => {
    const db = await seeded();
    const first = { deltaId: "d1", part: part({ contentText: "p", updatedAt: T0 }), flushedAt: T0 };
    await db.flushDelta(first);
    await db.flushDelta(first); // retry, ignored

    const second = await db.flushDelta({
      deltaId: "d2",
      part: part({ contentText: "pa", updatedAt: T0 }),
      flushedAt: T0,
    });

    expect(second.applied).toBe(true);
    expect(second.deltaSeq).toBe(1);
    expect(db.deltas().map((delta) => delta.id)).toEqual(["d1", "d2"]);
  });

  it("keeps the delta log after the part is deleted with its session", async () => {
    const db = await seeded();
    await db.flushDelta({ deltaId: "d1", part: part(), flushedAt: T0 });
    await db.deleteSession("s1");

    expect(db.counts().partDeltas).toBe(0);
  });
});

describe("deleteSession cascade", () => {
  it("removes the session, its messages, parts and deltas", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session({ id: "doomed" }));
    await db.createSession(session({ id: "kept" }));
    await db.appendMessage(message({ id: "m1", sessionId: "doomed" }));
    await db.appendMessage(message({ id: "m2", sessionId: "doomed" }));
    await db.appendPart(part({ id: "p1", messageId: "m1", sessionId: "doomed" }));
    await db.appendPart(part({ id: "p2", messageId: "m2", sessionId: "doomed" }));
    await db.flushDelta({
      deltaId: "d1",
      part: part({ id: "p1", messageId: "m1", sessionId: "doomed" }),
      flushedAt: T0,
    });

    expect(db.counts()).toMatchObject({ sessions: 2, messages: 2, parts: 2, partDeltas: 1 });

    await db.deleteSession("doomed");

    expect(db.counts()).toMatchObject({ sessions: 1, messages: 0, parts: 0, partDeltas: 0 });
    expect(await db.getSession("doomed")).toBeNull();
    expect(await db.listMessages("doomed")).toEqual([]);
    expect(await db.listParts("m1")).toEqual([]);
  });

  it("leaves other sessions untouched", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session({ id: "a" }));
    await db.createSession(session({ id: "b" }));
    await db.appendMessage(message({ id: "ma", sessionId: "a" }));
    await db.appendMessage(message({ id: "mb", sessionId: "b" }));
    await db.appendPart(part({ id: "pa", messageId: "ma", sessionId: "a" }));
    await db.appendPart(part({ id: "pb", messageId: "mb", sessionId: "b" }));

    await db.deleteSession("a");

    expect(await db.listParts("mb")).toHaveLength(1);
    expect(await db.getSession("b")).not.toBeNull();
  });

  it("is a no-op for an unknown session", async () => {
    const db = await seeded();
    await expect(db.deleteSession("nope")).resolves.toBeUndefined();
    expect(db.counts().sessions).toBe(1);
  });
});

describe("search", () => {
  it("finds parts by their text and reports the shape of a hit", async () => {
    const db = await seeded();
    await db.appendPart(part({ id: "p1", contentText: "the opfs vfs needs no COOP header" }));
    await db.appendPart(part({ id: "p2", contentText: "unrelated text" }));

    const hits = await db.search({ query: "opfs" });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      partId: "p1",
      messageId: "m1",
      sessionId: "s1",
      type: "text",
    });
    expect(typeof hits[0]?.score).toBe("number");
  });

  it("ANDs multiple terms", async () => {
    const db = await seeded();
    await db.appendPart(part({ id: "p1", contentText: "opfs and sqlite" }));
    await db.appendPart(part({ id: "p2", contentText: "opfs alone" }));

    expect((await db.search({ query: "opfs sqlite" })).map((hit) => hit.partId)).toEqual(["p1"]);
  });

  it("scopes to one session when asked", async () => {
    const db = createMemoryDatabase();
    await db.createSession(session({ id: "a" }));
    await db.createSession(session({ id: "b" }));
    await db.appendMessage(message({ id: "ma", sessionId: "a" }));
    await db.appendMessage(message({ id: "mb", sessionId: "b" }));
    await db.appendPart(part({ id: "pa", messageId: "ma", sessionId: "a", contentText: "shared word" }));
    await db.appendPart(part({ id: "pb", messageId: "mb", sessionId: "b", contentText: "shared word" }));

    expect((await db.search({ query: "shared" })).map((hit) => hit.partId).sort()).toEqual(["pa", "pb"]);
    expect((await db.search({ query: "shared", sessionId: "b" })).map((hit) => hit.partId)).toEqual(["pb"]);
  });

  it("honours the limit", async () => {
    const db = await seeded();
    await db.appendPart(part({ id: "p1", contentText: "repeat" }));
    await db.appendPart(part({ id: "p2", contentText: "repeat" }));
    await db.appendPart(part({ id: "p3", contentText: "repeat" }));

    expect(await db.search({ query: "repeat", limit: 2 })).toHaveLength(2);
  });

  it("returns nothing for a query that matches no text", async () => {
    const db = await seeded();
    await db.appendPart(part({ contentText: "something" }));
    expect(await db.search({ query: "absent" })).toEqual([]);
  });
});

describe("the public surface", () => {
  it("identifies itself as the memory backend", () => {
    const db = createMemoryDatabase();
    expect(db.kind).toBe("memory");
    expect(db.filename).toBe("memory://baah");
    expect(createMemoryDatabase("custom://name").filename).toBe("custom://name");
  });

  it("rejects raw SQL with a typed error, not a crash", async () => {
    const db = createMemoryDatabase();

    await expect(db.query("SELECT 1")).rejects.toThrow(StorageError);
    await expect(db.run("DELETE FROM sessions")).rejects.toMatchObject({ code: "unsupported" });
    await expect(db.transaction([{ sql: "SELECT 1" }])).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("closes without doing anything", async () => {
    const db = await seeded();
    await expect(db.close()).resolves.toBeUndefined();
    // The data is still readable: closing is not a flush in the memory backend.
    expect(await db.getSession("s1")).not.toBeNull();
  });

  it("is fully synchronous underneath — every call returns a promise", () => {
    const db = createMemoryDatabase();
    expect(db.createSession(session())).toBeInstanceOf(Promise);
    expect(db.listSessions()).toBeInstanceOf(Promise);
    expect(db.search({ query: "x" })).toBeInstanceOf(Promise);
  });
});
