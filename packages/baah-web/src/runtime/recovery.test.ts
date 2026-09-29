/**
 * Reload recovery, tested on **both** sides of the 30 s boundary.
 *
 * `Plan.md` §6.1 states the boundary table, and the two rows fail in opposite ways:
 * closing a fresh heartbeat kills a live turn in another tab, and not closing a
 * stale one is the silent failure §5.4 exists to prevent. A suite that only tests
 * the stale side proves half of it.
 */

import { describe, expect, it } from "vitest";
import { STALE_HEARTBEAT_MS, type UnfinishedTurn } from "@all-the.rest/baah-core";

import { recoverOnBoot } from "./recovery.ts";
import { RecordingTurnStore } from "./testing.ts";

const T0 = Date.parse("2026-09-29T12:00:00.000Z");

function turn(ageSeconds: number): UnfinishedTurn {
  const heartbeatAt = new Date(T0 - ageSeconds * 1000).toISOString();
  return { turnId: `turn-${ageSeconds}`, heartbeatAt, startedAt: heartbeatAt };
}

describe("recoverOnBoot", () => {
  it("uses the engine's 30 s threshold by default", async () => {
    expect(STALE_HEARTBEAT_MS).toBe(30_000);

    const store = new RecordingTurnStore();
    const report = await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(report.staleAfterMs).toBe(30_000);
  });

  it("closes a turn whose heartbeat is past the threshold", async () => {
    const store = new RecordingTurnStore({ unfinished: [turn(31)] });

    const report = await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(report.recovered.map((entry) => entry.turnId)).toEqual(["turn-31"]);
    expect(store.finishes).toHaveLength(1);
    expect(store.finishes[0]?.outcome).toBe("interrupted");
  });

  it("leaves a turn whose heartbeat is inside the window alone", async () => {
    const store = new RecordingTurnStore({ unfinished: [turn(29)] });

    const report = await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(report.recovered).toHaveLength(0);
    expect(report.untouched.map((entry) => entry.turnId)).toEqual(["turn-29"]);
    expect(store.finishes).toHaveLength(0);
  });

  it("treats exactly the threshold as stale, not one millisecond under", async () => {
    const stale = new RecordingTurnStore({ unfinished: [turn(30)] });
    await recoverOnBoot({ store: stale.store, sessionId: "s1", now: () => T0 });
    expect(stale.finishes).toHaveLength(1);

    const alive = new RecordingTurnStore({ unfinished: [turn(30 - 0.001)] });
    await recoverOnBoot({ store: alive.store, sessionId: "s1", now: () => T0 });
    expect(alive.finishes).toHaveLength(0);
  });

  it("records the age in the reason, so a reload is distinguishable from a failure", async () => {
    const store = new RecordingTurnStore({ unfinished: [turn(95)] });

    await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    // "interrupted" with no explanation reads as a crash, and the user cannot tell
    // a closed tab from a provider failure.
    expect(store.finishes[0]?.error).toBe("interrupted: no heartbeat for 95s");
  });

  it("splits the turns across both sides in one pass", async () => {
    const store = new RecordingTurnStore({ unfinished: [turn(5), turn(45), turn(120)] });

    const report = await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(report.recovered.map((entry) => entry.turnId)).toEqual(["turn-45", "turn-120"]);
    expect(report.untouched.map((entry) => entry.turnId)).toEqual(["turn-5"]);
    expect(store.finishes).toHaveLength(2);
  });

  it("writes nothing but the outcome — the partial text is left alone", async () => {
    // "Keep the partial text" (§6.1) is guaranteed by this module issuing no other
    // write at all. A `flushDelta` or a delete here would be the regression.
    const store = new RecordingTurnStore({ unfinished: [turn(60)] });

    await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(store.deltas).toHaveLength(0);
    expect(store.recordedToolCalls).toHaveLength(0);
    expect(store.beganToolCalls).toHaveLength(0);
    expect(store.heartbeats).toHaveLength(0);
    expect(store.finishes).toHaveLength(1);
  });

  it("scopes the read to one session", async () => {
    const store = new RecordingTurnStore({ unfinished: [turn(60)] });

    await recoverOnBoot({ store: store.store, sessionId: "session-a", now: () => T0 });

    expect(store.finishes[0]?.sessionId).toBe("session-a");
  });

  it("treats an unparsable heartbeat as dead, not as fresh", async () => {
    // `heartbeatAgeMs` returns `Infinity` for a corrupt anchor, so a broken
    // timestamp resolves to the recoverable side. Guessing `0` would read as
    // "written just now" and keep a dead turn looking alive forever.
    const store = new RecordingTurnStore({
      unfinished: [{ turnId: "broken", heartbeatAt: "not-a-date", startedAt: "not-a-date" }],
    });

    const report = await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(report.recovered).toHaveLength(1);
    expect(store.finishes).toHaveLength(1);
  });

  it("accepts an injected threshold", async () => {
    const store = new RecordingTurnStore({ unfinished: [turn(10)] });

    const report = await recoverOnBoot({
      store: store.store,
      sessionId: "s1",
      staleAfterMs: 5_000,
      now: () => T0,
    });

    expect(report.staleAfterMs).toBe(5_000);
    expect(report.recovered).toHaveLength(1);
  });

  it("does nothing when there is nothing unfinished", async () => {
    const store = new RecordingTurnStore();

    const report = await recoverOnBoot({ store: store.store, sessionId: "s1", now: () => T0 });

    expect(report.recovered).toHaveLength(0);
    expect(report.untouched).toHaveLength(0);
    expect(store.finishes).toHaveLength(0);
  });
});
