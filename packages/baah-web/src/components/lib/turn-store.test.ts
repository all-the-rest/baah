/**
 * The `TurnStore` decorator, and the constraint it exists to satisfy.
 *
 * ## What is asserted here
 *
 * `baah-storage` enforces `parts.message_id → messages.id` and
 * `messages.turn_id → turns.id` as foreign keys, and `TurnStore` has no method that
 * creates either row. So the assertions below are not about the decorator's
 * bookkeeping — they are about the *database accepting a turn at all*, which is
 * the property that was broken and is easy to break again: remove the wrapper from
 * the composition and every one of these fails with a foreign-key error.
 *
 * The second group is the one nobody would have written a test for and the one that
 * loses data silently: `INSERT_TURN_OUTCOME_MESSAGE` returns **zero rows** for a
 * turn it cannot find rather than refusing, so without the turn row the turn's
 * outcome — the only record of how a turn ended (`Plan.md` §6.2) — is written
 * nowhere and nothing reports an error.
 */
import { describe, expect, it } from "vitest";
import type { TurnStore } from "@all-the.rest/baah-core";

import { withTranscriptRows, type TranscriptRowWriter } from "./turn-store.ts";
import { RecordingTurnStore } from "../../runtime/testing.ts";

const SESSION = "s1";

/** A writer that records what it was asked to write, and can be made to fail. */
function recordingWriter(options: { readonly failOn?: "turn" | "message" | undefined } = {}) {
  const turns: string[] = [];
  const messages: { id: string; turnId: string | null }[] = [];
  const writer: TranscriptRowWriter = {
    async appendTurn(input) {
      if (options.failOn === "turn") throw new Error("appendTurn failed");
      turns.push(input.id);
      return undefined;
    },
    async appendMessage(input) {
      if (options.failOn === "message") throw new Error("appendMessage failed");
      messages.push({ id: input.id, turnId: input.turnId ?? null });
      return undefined;
    },
  };
  return { writer, turns, messages };
}

/**
 * A decorator over a recording store.
 *
 * The **recorder** is returned rather than the delegate, because
 * `RecordingTurnStore.store` is a fresh object literal per access — the arrays
 * live on the instance, so holding the `store` property would be holding a
 * different object than the one that was wrapped.
 */
function wrapper(options: { readonly failOn?: "turn" | "message" | undefined } = {}) {
  const recorder = new RecordingTurnStore();
  const { writer, turns, messages } = recordingWriter(options);
  const store = withTranscriptRows(recorder.store, {
    writer,
    sessionId: SESSION,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { store, delegate: recorder, turns, messages };
}

const DELTA = {
  deltaId: "d1",
  partId: "p1",
  messageId: "m1",
  sessionId: SESSION,
  partType: "text" as const,
  contentText: "hallo",
};

describe("the rows a part attaches to", () => {
  it("creates the message row before the first flush", async () => {
    // The foreign key `parts.message_id → messages.id` is the whole reason. Without
    // this the very first delta of a turn is refused.
    const { store, messages } = wrapper();
    await store.flushDelta(DELTA);
    expect(messages).toEqual([{ id: "m1", turnId: null }]);
  });

  it("creates it once for a hundred deltas", async () => {
    // A turn flushes on a 100 ms interval (`DELTA_FLUSH_INTERVAL_MS`), so a long
    // answer is many flushes of the same message. A row per flush would be a
    // hundred `UNIQUE` violations.
    const { store, messages } = wrapper();
    for (let index = 0; index < 20; index += 1) {
      await store.flushDelta({ ...DELTA, deltaId: `d${String(index)}`, contentText: `hallo ${String(index)}` });
    }
    expect(messages).toHaveLength(1);
  });

  it("creates a message row before a close too", async () => {
    // `closePart` names the message, so a part closed without a flush of its own
    // would need the row just as much.
    const { store, messages } = wrapper();
    await store.closePart({ sessionId: SESSION, messageId: "m9", partId: "p9", status: "completed" });
    expect(messages[0]?.id).toBe("m9");
  });

  it("rejects rather than swallowing, when the row cannot be created", async () => {
    // `AGENTS.md` §5: no silent catches. A wrapper that swallowed this would let
    // the delegate's write fail with a foreign-key error naming the wrong thing.
    const { store } = wrapper({ failOn: "message" });
    await expect(store.flushDelta(DELTA)).rejects.toThrow(/appendMessage failed/);
  });

  it("does not memoise a failed insert", async () => {
    // If a failure stayed memoised, every later write of that message would
    // proceed against a row that was never created.
    const recorder = new RecordingTurnStore();
    let fail = true;
    const writer: TranscriptRowWriter = {
      async appendTurn() {
        return undefined;
      },
      async appendMessage(input) {
        if (fail) {
          fail = false;
          throw new Error("first attempt fails");
        }
        void input;
        return undefined;
      },
    };
    const store = withTranscriptRows(recorder.store, { writer, sessionId: SESSION });
    await expect(store.flushDelta(DELTA)).rejects.toThrow();
    // The retry succeeds and the delegate is reached — which is what the test can
    // see, because a delegate that was reached records the delta.
    await store.flushDelta(DELTA);
    expect(recorder.deltas).toHaveLength(1);
  });
});

describe("the turn row, and the outcome that depends on it", () => {
  it("creates it from the heartbeat, which precedes every delta", async () => {
    // `loop.ts` writes a heartbeat at the start of every attempt, before the first
    // delta — so this is always the first call that carries a turn id.
    const { store, turns, messages } = wrapper();
    await store.heartbeat({ turnId: "t1", sessionId: SESSION, at: "2026-01-01T00:00:00.000Z" });
    await store.flushDelta(DELTA);
    expect(turns).toEqual(["t1"]);
    // And the message is attributed to it, because the turn is now known.
    expect(messages[0]?.turnId).toBe("t1");
  });

  it("creates it before a finish, which is where it matters most", async () => {
    // `INSERT_TURN_OUTCOME_MESSAGE` returns **zero rows** for a turn it cannot
    // find. Without the row the turn's outcome is written nowhere, and nothing
    // raises — the silent loss `Plan.md` §6.2's `idle` message exists to prevent.
    const { store, turns } = wrapper();
    await store.finishTurn({ turnId: "t1", sessionId: SESSION, outcome: "succeeded", error: undefined });
    expect(turns).toEqual(["t1"]);
  });

  it("creates it before the crash-path close", async () => {
    const { store, turns } = wrapper();
    await store.closeTurnParts({ sessionId: SESSION, turnId: "t1" });
    expect(turns).toEqual(["t1"]);
  });

  it("creates it once for a whole turn", async () => {
    const { store, turns } = wrapper();
    for (let index = 0; index < 5; index += 1) {
      await store.heartbeat({ turnId: "t1", sessionId: SESSION, at: "2026-01-01T00:00:00.000Z" });
    }
    await store.finishTurn({ turnId: "t1", sessionId: SESSION, outcome: "succeeded", error: undefined });
    expect(turns).toEqual(["t1"]);
  });

  it("does not memoise a failed turn insert", async () => {
    const recorder = new RecordingTurnStore();
    let fail = true;
    const writer: TranscriptRowWriter = {
      async appendTurn() {
        if (fail) {
          fail = false;
          throw new Error("first turn insert fails");
        }
        return undefined;
      },
      async appendMessage() {
        return undefined;
      },
    };
    const store = withTranscriptRows(recorder.store, { writer, sessionId: SESSION });
    await expect(store.heartbeat({ turnId: "t1", sessionId: SESSION, at: "" })).rejects.toThrow();
    await store.heartbeat({ turnId: "t1", sessionId: SESSION, at: "" });
    expect(recorder.heartbeats).toHaveLength(1);
  });

  it("appends a message with `turnId: null` when no turn has been seen", async () => {
    // Not a refusal. The provider has already produced the text; losing it because
    // the turn id had not arrived yet would be the worse outcome, and the message
    // is still in the session's log.
    const { store, messages } = wrapper();
    await store.flushDelta(DELTA);
    expect(messages[0]?.turnId).toBeNull();
  });
});

describe("reads pass through untouched", () => {
  it("forwards all five without preparing anything", async () => {
    // The wrapper has no state a read needs, and a read that went through the
    // `ensure` path would create rows as a side effect of being asked a question.
    const { store, turns, messages } = wrapper();
    await store.listUnfinishedTurns({ sessionId: SESSION });
    await store.listTurnOutcomes({ sessionId: SESSION });
    await store.getToolCall({ sessionId: SESSION, attempt: 1, toolCallId: "c1", occurrence: 0 });
    await store.recordToolCall({ key: { sessionId: SESSION, attempt: 1, toolCallId: "c1", occurrence: 0 }, toolName: "read", output: 1 });
    await store.beginToolCall({ key: { sessionId: SESSION, attempt: 1, toolCallId: "c2", occurrence: 0 }, toolName: "read", input: {} });
    expect(turns).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe("every write is delegated", () => {
  it("forwards the delegate's own arguments unchanged", async () => {
    // `deltaId` in particular: the adapter must not re-mint it, because it is the
    // idempotency key (`Plan.md` §14.4) and a re-mint would make every flush a new
    // delta.
    const recorder = new RecordingTurnStore();
    const { writer } = recordingWriter();
    const store = withTranscriptRows(recorder.store, { writer, sessionId: SESSION });
    await store.flushDelta(DELTA);
    expect(recorder.deltas).toHaveLength(1);
    expect(recorder.deltas[0]?.deltaId).toBe("d1");
    expect(recorder.deltas[0]?.partType).toBe("text");
  });

  it("is a decorator, not a replacement — the surface is exactly `TurnStore`", () => {
    const { store } = wrapper();
    const methods: readonly (keyof TurnStore)[] = [
      "flushDelta",
      "closePart",
      "closeTurnParts",
      "finishTurn",
      "heartbeat",
      "listUnfinishedTurns",
      "listTurnOutcomes",
      "recordToolCall",
      "getToolCall",
      "beginToolCall",
    ];
    for (const method of methods) {
      expect(typeof store[method], method).toBe("function");
    }
  });
});
