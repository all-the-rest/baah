/**
 * The streaming flush, in isolation.
 *
 * `Plan.md` §6.2: deltas are buffered in the worker and flushed every ~50–100 ms
 * in **one short transaction** (UPSERT on `parts` + an append to
 * `part_deltas`). The buffer can be lost — a reload, a crashed worker — so the
 * flush must survive being retried. That retry is what this file is about.
 */

import { describe, expect, it } from "vitest";

import { createMemoryDatabase } from "../src/factory.ts";
import { FLUSH_DELTA_LOG_SQL, FLUSH_DELTA_PART_SQL } from "../src/sql.ts";
import type { MemoryDatabase } from "../src/factory.ts";
import type { PartInput, SqlStatement } from "../src/types.ts";

const T0 = "2026-09-29T10:00:00.000Z";

/** The exact statements one `flushDelta` runs, in order. */
const FLUSH_STATEMENTS: SqlStatement[] = [
  { sql: FLUSH_DELTA_PART_SQL, params: [] },
  { sql: FLUSH_DELTA_LOG_SQL, params: [] },
];

async function seeded(): Promise<MemoryDatabase> {
  const db = createMemoryDatabase();
  await db.createSession({ id: "s1" });
  await db.appendMessage({
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: T0,
    updatedAt: T0,
  });
  return db;
}

function part(contentText: string, updatedAt = T0): PartInput {
  return {
    id: "p1",
    messageId: "m1",
    sessionId: "s1",
    type: "text",
    contentText,
    status: "streaming",
    createdAt: T0,
    updatedAt,
  };
}

describe("the flush statement pair", () => {
  it("is exactly two statements, part first then delta log", () => {
    expect(FLUSH_STATEMENTS).toHaveLength(2);
    expect(FLUSH_STATEMENTS[0]?.sql).toContain("INSERT INTO parts");
    expect(FLUSH_STATEMENTS[0]?.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(FLUSH_STATEMENTS[1]?.sql).toContain("INSERT INTO part_deltas");
    expect(FLUSH_STATEMENTS[1]?.sql).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("makes both statements idempotent on the part id", () => {
    // Without this a retry would fail on UNIQUE (message_id, seq).
    expect(FLUSH_DELTA_PART_SQL).toMatch(/ON CONFLICT \(id\)/);
    expect(FLUSH_DELTA_LOG_SQL).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });
});

describe("a retried flush", () => {
  it("is reported as not applied the second time", async () => {
    const db = await seeded();
    const payload = { deltaId: "d1", part: part("par"), flushedAt: T0 };

    expect((await db.flushDelta(payload)).applied).toBe(true);
    expect((await db.flushDelta(payload)).applied).toBe(false);
  });

  it("leaves exactly one part and one delta behind", async () => {
    const db = await seeded();
    const payload = { deltaId: "d1", part: part("par"), flushedAt: T0 };

    await db.flushDelta(payload);
    await db.flushDelta(payload);
    await db.flushDelta(payload);

    expect(db.counts()).toMatchObject({ sessions: 1, messages: 1, parts: 1, partDeltas: 1 });
  });

  it("does not advance the delta sequence on a retry", async () => {
    const db = await seeded();
    const payload = { deltaId: "d1", part: part("par"), flushedAt: T0 };

    const first = await db.flushDelta(payload);
    const retry = await db.flushDelta(payload);

    expect(retry.deltaSeq).toBe(first.deltaSeq);
    expect(db.deltas().map((delta) => delta.seq)).toEqual([0]);
  });

  it("does not overwrite newer text with a stale retry", async () => {
    const db = await seeded();

    // The buffer is flushed, then a newer chunk arrives and is flushed too.
    await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });
    await db.flushDelta({
      deltaId: "d2",
      part: part("partial", "2026-09-29T10:00:01.000Z"),
      flushedAt: "2026-09-29T10:00:01.000Z",
    });

    // Now the *old* message is retried — the out-of-order case.
    const stale = await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });

    expect(stale.applied).toBe(false);
    expect(db.deltas().map((delta) => delta.contentText)).toEqual(["par", "partial"]);
  });

  it("keeps the newest part text after a stale retry", async () => {
    const db = await seeded();
    await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });
    await db.flushDelta({
      deltaId: "d2",
      part: part("partial result", "2026-09-29T10:00:01.000Z"),
      flushedAt: "2026-09-29T10:00:01.000Z",
    });

    // The part projection always takes the newest write; only the log is
    // protected by the idempotency key.
    await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });

    expect((await db.listParts("m1"))[0]?.contentText).toBe("par");
    expect(db.counts().partDeltas).toBe(2);
  });

  it("is idempotent per delta, and a different delta still lands", async () => {
    const db = await seeded();

    const first = await db.flushDelta({ deltaId: "d1", part: part("p"), flushedAt: T0 });
    const retry = await db.flushDelta({ deltaId: "d1", part: part("p"), flushedAt: T0 });
    const next = await db.flushDelta({ deltaId: "d2", part: part("pa"), flushedAt: T0 });

    expect([first.applied, retry.applied, next.applied]).toEqual([true, false, true]);
    expect([first.deltaSeq, retry.deltaSeq, next.deltaSeq]).toEqual([0, 0, 1]);
  });

  it("keeps the part's created_at and seq stable across a retry", async () => {
    const db = await seeded();
    const first = await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });
    const before = (await db.listParts("m1"))[0];

    await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });
    const after = (await db.listParts("m1"))[0];

    expect(after?.createdAt).toBe(first.partId === "p1" ? T0 : after?.createdAt);
    expect(before?.createdAt).toBe(T0);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.seq).toBe(before?.seq);
  });
});

describe("a rolled back flush", () => {
  it("leaves no partial state behind", async () => {
    const db = createMemoryDatabase();
    // No session, so the part upsert violates the foreign key. The whole
    // batch must roll back — including anything the first statement did.
    await expect(
      db.flushDelta({
        deltaId: "d1",
        part: { ...part("par") },
        flushedAt: T0,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint/i);

    expect(db.counts()).toMatchObject({ sessions: 0, messages: 0, parts: 0, partDeltas: 0 });
  });

  it("is retryable after the cause is fixed", async () => {
    const db = createMemoryDatabase();
    await expect(
      db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 }),
    ).rejects.toThrow();

    await db.createSession({ id: "s1" });
    await db.appendMessage({ id: "m1", sessionId: "s1", role: "assistant", createdAt: T0, updatedAt: T0 });

    const result = await db.flushDelta({ deltaId: "d1", part: part("par"), flushedAt: T0 });
    expect(result.applied).toBe(true);
    expect(db.counts().partDeltas).toBe(1);
  });
});
