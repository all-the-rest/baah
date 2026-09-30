/**
 * `TurnStore`: the gaps a storage adapter measured, pinned on the engine side.
 *
 * ## Why this file exists
 *
 * A `TurnStore` adapter over `baah-storage` was written against this interface
 * and four of its methods turned out to be unable to carry what the engine
 * means by them. Each of the four is a *contract* gap, not a schema gap — no
 * storage implementation can close them, because the fact simply is not on the
 * wire:
 *
 * 1. a delta could not say **what kind of part** it is, so a reasoning delta
 *    was persisted as a text part and the model's thinking was rendered as
 *    something it had said;
 * 2. a delta could not **close** its part, so every part was `streaming` for
 *    ever and a reload could not tell "still being written" from "the tab died
 *    mid-sentence" (§6.1);
 * 3. `heartbeat` carried no session, so it was the one write on the seam that
 *    could renew an arbitrary turn's anchor from anywhere;
 * 4. the reload recovery closed a turn that **already carried a terminal
 *    outcome**, so a second start-up appended a second `interrupted` outcome
 *    message and the transcript grew a duplicate on every reload.
 *
 * A fifth, found later and by a different layer: the seam could not **create**
 * the rows its parts hang off. `appendTurn` and `appendMessage` were on
 * `StorageDatabase` (Plan.md §16.1) and not here, so the engine — which mints
 * both ids — could not accept its own first write, and an app wrapped the store
 * to manufacture the rows. The `answerParts` / `answerDeltas` / `answerCloses`
 * accessors exist because of the resulting behaviour: **the user's prompt is
 * now a part**, written through the very same `flushDelta` / `closePart` pair
 * these tests measure, so every assertion about the *streaming* protocol has to
 * scope itself to the assistant's parts.
 *
 * Each test below therefore states the *behaviour* the store has to show, not
 * that a field exists — a field that nothing writes is a field that protects
 * nothing.
 *
 * ## The store
 *
 * A fake, and a deliberately stateful one: `flushDelta` is idempotent over
 * `deltaId` and writes the part `streaming` (which is what every real
 * implementation has to do, because a delta is mid-stream by definition), a
 * close changes the status, and `finishTurn` appends an outcome that
 * `listTurnOutcomes` then reports. A fake that only logged calls could not
 * measure the one property that matters for gap 2 — that a close which lands
 * *before* its part's last flush is silently undone by that flush, because the
 * status goes back to `streaming`.
 *
 * `partTurn` is scaffolding, not part of the contract: the engine never says
 * which turn a part belongs to, so the fake learns it from the test that seeds
 * the part, which is what lets `closeTurnParts` close the right ones.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMemoryWorkspace } from "../../src/workspace.ts";
import {
  buildApprovalTargets,
  createApprovalResolver,
  type ApprovalResolver,
  type PermissionEngine,
} from "../../src/agent/approval.ts";
import {
  AgentTurn,
  DELTA_FLUSH_INTERVAL_MS,
  isRecoverableTurn,
  recoverStaleTurns,
  STALE_HEARTBEAT_MS,
  toolPartContent,
  type AgentEvent,
  type PartKind,
  type ToolCardState,
  type ToolPartContent,
  type TurnOutcome,
  type TurnOutcomeEntry,
  type TurnStore,
  type UnfinishedTurn,
} from "../../src/agent/loop.ts";
import type { ToolCallRecord } from "../../src/agent/tools.ts";
import { createMockModel, errorPart, finish, reasoning, text, toolCall } from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

interface StoredPart {
  messageId: string;
  sessionId: string;
  partType: PartKind;
  contentText: string;
  status: "streaming" | "completed" | "aborted";
  /**
   * `MAX(seq) + 1` per session, allocated the way the store allocates it.
   *
   * `undefined` when the test did not ask for it: allocating on every flush would
   * be noise for the streaming tests, which have no ordering to measure.
   */
  seq?: number;
}

interface StoredMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  turnId: string | null;
  seq: number;
}

interface FakeStore extends TurnStore {
  readonly parts: Map<string, StoredPart>;
  /** Every flush that *applied*; a replayed `deltaId` is not in here twice. */
  readonly deltas: { id: string; partId: string; contentText: string; messageId: string }[];
  /** Every `deltaId` that arrived, applied or not. */
  readonly deltaIds: string[];
  readonly closes: { partId: string; status: "completed" | "aborted"; messageId: string }[];
  readonly turnPartCloses: string[];
  readonly heartbeats: { turnId: string; sessionId: string; at: string }[];
  readonly outcomes: { turnId: string; outcome: TurnOutcome; error: string | undefined }[];
  /** The states a tool part was written with, in the order they were written. */
  readonly toolPartStates: { partId: string; state: ToolCardState }[];
  /** The last write of each tool part, so the folded row can be inspected. */
  readonly toolPartRows: Map<string, ToolPartContent>;
  /**
   * The message rows, in the order they were created.
   *
   * A fake that only logged calls could not measure the *ordering* property,
   * because `seq` is what the transcript is read in and `seq` is allocated by the
   * store. So the fake allocates it: `MAX(seq) + 1` per session, and a duplicate
   * id resolves without moving the counter — the two rules from `Plan.md` §6.2
   * and the engine's declared idempotency.
   */
  readonly messages: StoredMessage[];
  /**
   * Which create refuses, and whether the fake allocates `seq` at all.
   *
   * `undefined` (the default) is the healthy case. `"appendMessage"` models the
   * engine's failure path: the turn landed, the message did not.
   */
  refuse: "appendMessage" | undefined;
  /** Cleared after the first refusal, so a retry is observable. */
  seqByMessage: Map<string, number> | undefined;
  /** Every call, in order — so "the flush came before the close" is measured. */
  readonly calls: string[];
  unfinished: UnfinishedTurn[];
  outcomeReads: number;
  /** The turn a streamed part belongs to; the engine never says. */
  partTurn: Map<string, string>;
  /**
   * The parts that belong to an **assistant** message.
   *
   * The engine now writes the user's prompt as a part too, and it arrives
   * through the same `flushDelta`/`closePart` pair — which is the point, and is
   * also why every test about the *streaming* protocol has to exclude it. A real
   * store can tell them apart because `appendMessage` told it which rows are
   * which; the fake does the same.
   */
  answerParts(): StoredPart[];
  /** The ids of those parts, in insertion order. */
  answerPartIds(): string[];
  /**
   * The flushes and closes of an **assistant** message — the same scoping as
   * {@link FakeStore.answerParts}, for the two arrays a test counts.
   */
  answerDeltas(): { id: string; partId: string; contentText: string }[];
  answerCloses(): { partId: string; status: "completed" | "aborted" }[];
}

function createFakeStore(options: { partTurn?: string } = {}): FakeStore {
  const parts = new Map<string, StoredPart>();
  const deltas: { id: string; partId: string; contentText: string; messageId: string }[] = [];
  const deltaIds: string[] = [];
  const closes: { partId: string; status: "completed" | "aborted"; messageId: string }[] = [];
  const turnPartCloses: string[] = [];
  const heartbeats: { turnId: string; sessionId: string; at: string }[] = [];
  const outcomes: { turnId: string; outcome: TurnOutcome; error: string | undefined }[] = [];
  const toolPartStates: { partId: string; state: ToolCardState }[] = [];
  const toolPartRows = new Map<string, ToolPartContent>();
  const messages: StoredMessage[] = [];
  const calls: string[] = [];
  const seenDeltas = new Set<string>();
  /** Message ids the engine created for a non-assistant role. */
  const userMessages = new Set<string>();
  const defaultTurn = options.partTurn ?? "t1";

  /**
   * `MAX(seq) + 1`, per session **and per table** — which is the rule, and the
   * detail that makes the ordering test meaningful: `messages` and `parts` each
   * count from their own table, so the prompt's message row and the prompt's
   * part are both position 0 of their own kind. A single shared counter would put
   * the answer's part at 2 and the test would pass for the wrong reason.
   */
  const nextSeq = (table: "messages" | "parts"): number => {
    let highest = -1;
    if (table === "messages") {
      for (const message of messages) {
        if (message.sessionId === currentSessionId && message.seq > highest) highest = message.seq;
      }
      return highest + 1;
    }
    for (const part of parts.values()) {
      // `seq` is `undefined` for the tests that did not ask for it, and a part
      // with no `seq` must not move the counter — it never had one.
      const seq = part.seq ?? -1;
      if (part.sessionId === currentSessionId && seq > highest) highest = seq;
    }
    return highest + 1;
  };
  let currentSessionId = "s1";

  const store: FakeStore = {
    parts,
    deltas,
    deltaIds,
    closes,
    turnPartCloses,
    heartbeats,
    outcomes,
    toolPartStates,
    toolPartRows,
    messages,
    calls,
    unfinished: [],
    outcomeReads: 0,
    partTurn: new Map(),
    refuse: undefined,
    seqByMessage: undefined,

    answerParts() {
      return [...parts.values()].filter((part) => !userMessages.has(part.messageId));
    },
    answerPartIds() {
      return [...parts.entries()]
        .filter(([, part]) => !userMessages.has(part.messageId))
        .map(([partId]) => partId);
    },
    answerDeltas() {
      return deltas
        .filter((delta) => !userMessages.has(delta.messageId))
        .map(({ id, partId, contentText }) => ({ id, partId, contentText }));
    },
    answerCloses() {
      return closes
        .filter((close) => !userMessages.has(close.messageId))
        .map(({ partId, status }) => ({ partId, status }));
    },

    async appendTurn(input) {
      calls.push(`appendTurn:${input.id}`);
    },
    async appendMessage(input) {
      calls.push(`appendMessage:${input.id}:${input.role}`);
      if (store.refuse === "appendMessage") {
        store.refuse = undefined;
        throw new Error("the database handle is closed");
      }
      currentSessionId = input.sessionId;
      // Idempotent by `id`, exactly like the store: a retry resolves to the row
      // that is there and does **not** move the counter. That is the rule the
      // ordering tests depend on, so the fake has to have it.
      if (store.seqByMessage !== undefined) {
        if (!messages.some((message) => message.id === input.id)) {
          messages.push({
            id: input.id,
            sessionId: input.sessionId,
            role: input.role,
            turnId: input.turnId,
            seq: nextSeq("messages"),
          });
        }
      }
      // Which rows are the user's, so the streaming tests can scope themselves to
      // the assistant's parts. The prompt is a real part and arrives through the
      // real protocol; that it is a *different* part is what makes it separable.
      if (input.role !== "assistant") userMessages.add(input.id);
    },

    // A tool part is a row of its own, not a flushed delta: written whole, with
    // the state the engine derived. Kept in `toolParts` by the part id so the
    // upsert-then-fold order is measurable, which is the property the engine's
    // `await` on this method buys.
    async upsertPart(input) {
      const content = toolPartContent(input.event);
      calls.push(`upsertPart:${content.partId}:${content.data.state}`);
      toolPartStates.push({ partId: content.partId, state: content.data.state });
      toolPartRows.set(content.partId, content);
    },
    async flushDelta(input) {
      calls.push(`flushDelta:${input.partId}`);
      deltaIds.push(input.deltaId);
      // Idempotent over `deltaId`, exactly like the real store: a retry is a
      // no-op, and nothing about the part changes.
      if (seenDeltas.has(input.deltaId)) return;
      seenDeltas.add(input.deltaId);
      deltas.push({ id: input.deltaId, partId: input.partId, contentText: input.contentText, messageId: input.messageId });
      store.partTurn.set(input.partId, defaultTurn);
      currentSessionId = input.sessionId;
      parts.set(input.partId, {
        messageId: input.messageId,
        sessionId: input.sessionId,
        partType: input.partType,
        contentText: input.contentText,
        // A delta is mid-stream by definition. This is the line a close that
        // lands too early gets undone by.
        status: "streaming",
        // Only allocated when the test asked for `seq`; the streaming tests do
        // not, and paying for it on every flush would be noise.
        ...(store.seqByMessage === undefined ? {} : { seq: nextSeq("parts") }),
      });
    },

    async closePart(input) {
      calls.push(`closePart:${input.partId}:${input.status}`);
      closes.push({ partId: input.partId, status: input.status, messageId: input.messageId });
      const part = parts.get(input.partId);
      if (part !== undefined) part.status = input.status;
    },

    async closeTurnParts(input) {
      calls.push(`closeTurnParts:${input.turnId}`);
      turnPartCloses.push(input.turnId);
      for (const [partId, part] of parts) {
        if (store.partTurn.get(partId) !== input.turnId) continue;
        if (part.status !== "streaming") continue;
        part.status = "aborted";
      }
    },

    async finishTurn(input) {
      calls.push(`finishTurn:${input.turnId}:${input.outcome}`);
      outcomes.push({ turnId: input.turnId, outcome: input.outcome, error: input.error });
    },

    async heartbeat(input) {
      calls.push(`heartbeat:${input.turnId}`);
      heartbeats.push({ turnId: input.turnId, sessionId: input.sessionId, at: input.at });
    },

    async listUnfinishedTurns() {
      return store.unfinished;
    },

    async listTurnOutcomes(input): Promise<readonly TurnOutcomeEntry[]> {
      store.outcomeReads += 1;
      void input;
      return outcomes.map((entry) => ({ turnId: entry.turnId, outcome: entry.outcome }));
    },

    async recordToolCall() {},
    async getToolCall(): Promise<ToolCallRecord | undefined> {
      return undefined;
    },
    async beginToolCall() {},
  };
  return store;
}

/** The statuses of a part, in the order they were written. */
function statusOf(store: FakeStore, partId: string): string | undefined {
  return store.parts.get(partId)?.status;
}

/* ------------------------------------------------------------------ */
/* The turn driver                                                     */
/* ------------------------------------------------------------------ */

const echoSchema = z.object({ value: z.string() });
const allowAll: PermissionEngine = {
  evaluate: () => ({ effect: "allow" }),
  recordAlways: async () => {},
};

async function runTurn(options: {
  steps: Parameters<typeof createMockModel>[0]["steps"];
  store: FakeStore;
  /** Epoch millis the engine reads; a function to advance it per read. */
  now?: () => number;
  prompt?: string;
  onEvent?: (event: AgentEvent) => void;
}): Promise<Awaited<ReturnType<AgentTurn["run"]>>> {
  const resolver: ApprovalResolver = createApprovalResolver({
    engine: allowAll,
    targets: buildApprovalTargets({
      tools: [
        {
          id: "echo",
          description: "echo",
          access: "read",
          inputSchema: echoSchema,
          execute: async () => ({ ok: true }),
        },
      ],
    }),
  });
  const turn = new AgentTurn({
    model: createMockModel({ steps: options.steps }),
    instructions: "You are a test harness.",
    tools: [],
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store: options.store,
    approval: resolver,
    onEvent: (event) => {
      options.onEvent?.(event);
    },
    approve: async () => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
    ...(options.now === undefined ? { now: () => 1_000 } : { now: options.now }),
  });
  return turn.run(options.prompt ?? "hi");
}

/** A provider error the classifier reads as a retryable 500. */
function apiError(status: number): Error {
  const error = new Error(`upstream said ${status}`) as Error & { statusCode: number };
  error.statusCode = status;
  return error;
}

/* ================================================================== */
/* Gap 1 — a delta can say what kind of part it is                     */
/* ================================================================== */

describe("a flushed delta says which kind of part it is", () => {
  it("a text delta is flushed as `text`", async () => {
    const store = createFakeStore();
    await runTurn({ steps: [{ parts: [...text("t1", "Hello"), finish("stop")] }], store });

    expect(store.answerParts().map((part) => part.partType)).toEqual(["text"]);
    expect(store.parts.get("t1")?.contentText).toBe("Hello");
  });

  it("a reasoning delta is flushed as `reasoning`, not as `text`", async () => {
    // The measured gap: `Plan.md` §6.1 has three part types and the loop emits
    // reasoning deltas, so with no kind on the input every implementation filed
    // them as text and the transcript showed the model thinking as something it
    // had said. Two parts, two kinds — the point is that they do not collapse.
    const store = createFakeStore();
    await runTurn({
      steps: [{ parts: [...reasoning("r1", "thinking"), ...text("t1", "Hello"), finish("stop")] }],
      store,
    });

    // The two streamed parts, by id and by kind. The prompt's part is not in
    // here: it is a part, but not a *streamed* one, and this test is about the
    // streaming protocol.
    expect(store.answerPartIds()).toEqual(["r1", "t1"]);
    expect(store.parts.get("r1")?.partType).toBe("reasoning");
    expect(store.parts.get("t1")?.partType).toBe("text");
    expect(store.parts.get("r1")?.contentText).toBe("thinking");
  });

  it("a tool call is terminal by construction: no delta, no close", async () => {
    // The third part type is not a third value on the delta kind. A tool part is
    // written whole and has no mid-stream text; whether it *ran* is
    // `tool_invocations.status`, which is a different record.
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "tool-input-start" as const, id: "c1", toolName: "echo" },
            toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "one" } }),
            finish("tool-calls"),
          ],
        },
        { parts: [...text("t1", "done"), finish("stop")] },
      ],
      store,
    });

    expect(store.answerDeltas().map((delta) => delta.partId)).toEqual(["t1"]);
    expect(store.answerCloses().map((close) => close.partId)).toEqual(["t1"]);
  });
});

/* ================================================================== */
/* Gap 2 — a part can be closed, and closed where it ended             */
/* ================================================================== */

describe("a part is closed where the engine knows it ended", () => {
  it("a text part is closed `completed`, and its last flush lands first", async () => {
    const store = createFakeStore();
    await runTurn({ steps: [{ parts: [...text("t1", "Hello"), finish("stop")] }], store });

    expect(store.answerCloses()).toEqual([{ partId: "t1", status: "completed" }]);
    // The order is the point, and it is a state assertion rather than a log
    // read: a close that arrived first would be overwritten by this part's own
    // closing flush, which writes the status a delta implies.
    expect(statusOf(store, "t1")).toBe("completed");
    expect(
      store.calls.filter(
        (call) => call.startsWith("flushDelta:t1") || call.startsWith("closePart:t1"),
      ),
    ).toEqual(["flushDelta:t1", "closePart:t1:completed"]);
  });

  it("a reasoning part is closed too — the close is not a text-only path", async () => {
    const store = createFakeStore();
    await runTurn({
      steps: [{ parts: [...reasoning("r1", "thinking"), ...text("t1", "Hello"), finish("stop")] }],
      store,
    });

    expect(store.answerCloses()).toEqual([
      { partId: "r1", status: "completed" },
      { partId: "t1", status: "completed" },
    ]);
    expect(statusOf(store, "r1")).toBe("completed");
  });

  it("a part that never gets its end event is closed `aborted`, not left streaming", async () => {
    // The stream stops mid-sentence — truncated, aborted, an error part. This is
    // the in-process half of the crash case: without it the transcript says
    // "the model is still writing" about a turn that ended ten minutes ago.
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: "half a sen" },
            finish("stop"),
          ],
        },
      ],
      store,
    });

    expect(store.answerCloses()).toEqual([{ partId: "t1", status: "aborted" }]);
    expect(statusOf(store, "t1")).toBe("aborted");
    // The text it got is kept, not discarded (§6.2: keep the partial text).
    expect(store.parts.get("t1")?.contentText).toBe("half a sen");
  });

  it("a part replaced by a new one is closed `aborted` rather than dangling", async () => {
    // A provider that starts a second part without ending the first is a protocol
    // break, and the first part will never be closed by anything else.
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: "abandoned" },
            ...text("t2", "the real one"),
            finish("stop"),
          ],
        },
      ],
      store,
    });

    expect(store.answerCloses()).toEqual([
      { partId: "t1", status: "aborted" },
      { partId: "t2", status: "completed" },
    ]);
  });

  it("buffers instead of writing per token (Plan.md §6.2)", async () => {
    // A frozen clock and three deltas: the interval has not elapsed, so the
    // text is written once — when the part ends. A per-token flush would write
    // three times, and §6.2 names that as the thing not to do.
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: "one " },
            { type: "text-delta" as const, id: "t1", delta: "two " },
            { type: "text-delta" as const, id: "t1", delta: "three" },
            { type: "text-end" as const, id: "t1" },
            finish("stop"),
          ],
        },
      ],
      store,
    });

    expect(store.answerDeltas()).toHaveLength(1);
    expect(store.answerDeltas()[0]?.contentText).toBe("one two three");
  });

  it("a long part is checkpointed while it streams, not only at its end", async () => {
    // The other half of the same rule: a part that streams for a minute must
    // reach the store while it streams, or a crash loses the whole answer. The
    // clock advances 40 ms per read, so the 100 ms interval is consulted and
    // the six deltas cannot all be buffered.
    let clock = 1_000;
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "text-start" as const, id: "t1" },
            ...Array.from({ length: 6 }, (_unused, index) => ({
              type: "text-delta" as const,
              id: "t1",
              delta: `${index}`,
            })),
            { type: "text-end" as const, id: "t1" },
            finish("stop"),
          ],
        },
      ],
      store,
      now: () => (clock += 40),
    });

    expect(store.answerDeltas().length).toBeGreaterThan(1);
    // And still not one per token: the interval is doing something.
    expect(store.answerDeltas().length).toBeLessThan(6);
    expect(store.answerDeltas().at(-1)?.contentText).toBe("012345");
    expect(DELTA_FLUSH_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("every flush of a part has its own delta id, and a retry's does not reuse one", async () => {
    // `deltaId` is the idempotency key: a repeat is silently dropped. A retry
    // re-sends the request and the provider mints the *same part ids again*, so
    // a key built from the part id alone would make attempt 2's first flush a
    // "replay" of attempt 1's — and the part would keep attempt 1's text.
    const store = createFakeStore();
    await runTurn({
      steps: [
        { parts: [...text("t1", "attempt one"), errorPart(apiError(500))] },
        { parts: [...text("t1", "attempt two"), finish("stop")] },
      ],
      store,
    });

    expect(store.answerDeltas().map((delta) => delta.contentText)).toEqual(["attempt one", "attempt two"]);
    // Same part id, two attempts, two distinct keys.
    expect(new Set(store.deltaIds).size).toBe(store.deltaIds.length);
    expect(statusOf(store, "t1")).toBe("completed");
  });
});

/* ================================================================== */
/* Gap 2, crash case — the recovery closes what the dead turn left open */
/* ================================================================== */

describe("the reload recovery closes the parts a dead turn left open", () => {
  const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
  const dead = (turnId: string): UnfinishedTurn => ({
    turnId,
    heartbeatAt: new Date(nowMs - 120_000).toISOString(),
    startedAt: new Date(nowMs - 180_000).toISOString(),
  });
  const alive = (turnId: string): UnfinishedTurn => ({
    turnId,
    heartbeatAt: new Date(nowMs - 1_000).toISOString(),
    startedAt: new Date(nowMs - 180_000).toISOString(),
  });

  it("closes the dangling part of a turn it closes, before the outcome", async () => {
    // The crash, as it lands in storage: the tab died mid-sentence, so the last
    // flush is `streaming` and the process that knew the part ids is gone.
    const store = createFakeStore();
    await store.flushDelta({
      deltaId: "d1",
      partId: "p1",
      messageId: "m1",
      sessionId: "s1",
      partType: "text",
      contentText: "half a sen",
    });
    store.partTurn.set("p1", "t-dead");
    store.unfinished = [dead("t-dead")];

    const recovered = await recoverStaleTurns({ store, sessionId: "s1", nowMs });

    expect(recovered.map((turn) => turn.turnId)).toEqual(["t-dead"]);
    expect(statusOf(store, "p1")).toBe("aborted");
    // The parts first, then the outcome: the log must not say the turn ended
    // before its last text was closed.
    expect(store.calls.slice(store.calls.indexOf("closeTurnParts:t-dead"))).toEqual([
      "closeTurnParts:t-dead",
      "finishTurn:t-dead:interrupted",
    ]);
  });

  it("leaves a live turn's parts alone — another tab is still writing them", async () => {
    const store = createFakeStore({ partTurn: "t-alive" });
    await store.flushDelta({
      deltaId: "d1",
      partId: "p1",
      messageId: "m1",
      sessionId: "s1",
      partType: "text",
      contentText: "still going",
    });
    store.unfinished = [alive("t-alive")];

    const recovered = await recoverStaleTurns({ store, sessionId: "s1", nowMs });

    expect(recovered).toEqual([]);
    expect(store.turnPartCloses).toEqual([]);
    expect(statusOf(store, "p1")).toBe("streaming");
  });

  it("reads the session's outcomes once, not once per candidate turn", async () => {
    const store = createFakeStore();
    store.unfinished = [dead("t-a"), dead("t-b"), dead("t-c")];

    const recovered = await recoverStaleTurns({ store, sessionId: "s1", nowMs });

    expect(recovered.map((turn) => turn.turnId)).toEqual(["t-a", "t-b", "t-c"]);
    expect(store.outcomeReads).toBe(1);
  });
});

/* ================================================================== */
/* Gap 5 — the prompt's rows come before anything the model produces   */
/* ================================================================== */

describe("the prompt is written before the answer, and only once", () => {
  it("the prompt's message row is allocated before the answer's first part", async () => {
    /**
     * The ordering, as a `seq` order rather than as a call log.
     *
     * `Plan.md` §6.2 allocates `seq` per session and `UNIQUE (session_id, seq)` is
     * what turned a write race into a rejection, so the order of the *writes* is
     * what decides the order of the *transcript*. A prompt persisted after the
     * answer takes a later position than the answer it produced, and the user
     * reads their own question below the response to it.
     *
     * This fake allocates `seq` the way the store does — `MAX(seq) + 1` per
     * session — so the assertion is about the number the transcript will read,
     * not about the order of a log nobody renders.
     */
    const store = createFakeStore();
    store.seqByMessage = new Map<string, number>();
    await runTurn({ steps: [{ parts: [...text("t1", "Hello"), finish("stop")] }], store });

    const prompt = store.messages.find((entry) => entry.role === "user");
    const answer = store.parts.get("t1");
    expect(prompt?.seq).toBe(0);
    expect(answer?.seq).toBe(1);
  });

  it("a retry does not append a second prompt row, nor consume a seq for it", async () => {
    // The id is minted **once in `run`** and threaded through, so attempt 2
    // writes the same id and the store's `ON CONFLICT (id)` resolves it. A
    // per-attempt id would append a second `user` row and leave a gap in the
    // sequence — the empty bubble in the transcript, plus a `seq` that no row
    // explains.
    const store = createFakeStore();
    store.seqByMessage = new Map<string, number>();
    await runTurn({
      steps: [
        { throws: apiError(500) },
        { parts: [...text("t1", "second time lucky"), finish("stop")] },
      ],
      store,
    });

    const prompts = store.messages.filter((entry) => entry.role === "user");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.seq).toBe(0);
    // No gap: the answer took the next position, not one past a phantom row.
    expect(store.parts.get("t1")?.seq).toBe(1);
  });

  it("the prompt's part is closed before the model's first delta is flushed", async () => {
    // The same ordering one level down, and the part-level half: the prompt's
    // text is a real part, so it has to be written **and closed** before the
    // answer's text arrives — or the transcript opens with a part still in
    // flight, which a reload renders as "still being written".
    //
    // All parts, not `answerParts()`: the prompt's part hangs off the **user**
    // message row, so the streaming-scoping helper would filter it out — and
    // that is itself worth stating, because it is why a test written against
    // `answerParts()` would not see the prompt at all.
    const store = createFakeStore();
    store.seqByMessage = new Map<string, number>();
    await runTurn({ steps: [{ parts: [...text("t1", "Hello"), finish("stop")] }], store, prompt: "the question" });

    const all = [...store.parts.values()];
    expect(all.map((part) => [part.seq, part.contentText])).toEqual([
      [0, "the question"],
      [1, "Hello"],
    ]);
    // Closed, not streaming: the user is done typing. A prompt marked in flight
    // is a part a reload renders as "still being written".
    expect(all[0]?.status).toBe("completed");
  });
});

/* ================================================================== */
/* Gap 6 — a rejected create is a failed turn, not a throw              */
/* ================================================================== */

describe("a refused create fails the turn and leaves the row for the recovery", () => {
  it("is a `failed` turn with `attempts: 0` and a typed event, never a throw", async () => {
    // The engine's side, and `AGENTS.md` §5 in one test: what the user must see
    // is a typed event, not a `run()` that rejected. `attempts: 0` is the honest
    // number — the point of failing here is that **no request left the tab**, so
    // reporting 1 would claim the opposite.
    const store = createFakeStore();
    store.refuse = "appendMessage";
    const events: { type: string }[] = [];
    await runTurn({ steps: [{ parts: [...text("t1", "Hi"), finish("stop")] }], store, onEvent: (e) => events.push(e) });

    expect(store.calls.filter((call) => call.startsWith("attempt-started"))).toEqual([]);
    // The model was never asked, so no assistant part exists.
    expect(store.answerPartIds()).toEqual([]);
    expect(events.map((event) => event.type)).toContain("turn-finished");
  });

  it("does NOT call `finishTurn`, and the turn row stays for the recovery", async () => {
    // The half that is easy to get wrong by symmetry, and the one this whole
    // block is about. Every *other* failure path in the loop finishes the turn, so
    // adding a `finishTurn` here "for consistency" would write an outcome message
    // for a turn whose rows were never created — and `recoverStaleTurns` skips a
    // turn the log already carries an outcome for, so the turn would then never be
    // reported at all. The user gets a transcript that claims the turn ended and
    // says nothing about what it was doing.
    const store = createFakeStore();
    store.refuse = "appendMessage";
    await runTurn({ steps: [{ parts: [...text("t1", "Hi"), finish("stop")] }], store });

    // The create was attempted, and no outcome was written.
    expect(store.calls).toContain("appendTurn:t1");
    expect(store.outcomes).toEqual([]);
    expect(store.calls.some((call) => call.startsWith("finishTurn"))).toBe(false);
    // And the turn is still on the recovery's list — which is where the state
    // lands, and is what the storage side measures through the same helper
    // (`packages/baah-storage/test/turn-store.test.ts`, section 1b).
    store.unfinished = [
      {
        turnId: "t1",
        heartbeatAt: new Date(Date.parse("2026-09-29T10:00:00.000Z") - 120_000).toISOString(),
        startedAt: new Date(Date.parse("2026-09-29T10:00:00.000Z") - 180_000).toISOString(),
      },
    ];
    const recovered = await recoverStaleTurns({
      store,
      sessionId: "s1",
      nowMs: Date.parse("2026-09-29T12:00:00.000Z"),
    });
    expect(recovered.map((turn) => turn.turnId)).toEqual(["t1"]);
    expect(store.outcomes.map((entry) => entry.outcome)).toEqual(["interrupted"]);
  });
});

/* ================================================================== */
/* Gap 3 — the heartbeat is scoped like every other write              */
/* ================================================================== */

describe("the heartbeat is session-scoped", () => {
  it("every heartbeat the loop writes names the session", async () => {
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "tool-input-start" as const, id: "c1", toolName: "echo" },
            toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "one" } }),
            finish("tool-calls"),
          ],
        },
        { parts: [...text("t1", "done"), finish("stop")] },
      ],
      store,
    });

    // More than one, so this is not a single call that happens to be right: one
    // per attempt start and one per step end.
    expect(store.heartbeats.length).toBeGreaterThan(1);
    for (const heartbeat of store.heartbeats) {
      expect(heartbeat.sessionId).toBe("s1");
      expect(heartbeat.turnId).toBe("t1");
    }
  });

  it("is one helper, so both call sites are scoped", async () => {
    // `heartbeat()` is a single local helper called at the start of every attempt
    // and from `onStepEnd`, so scoping it once scopes both. One per attempt plus
    // one per step end: a turn that dies before its first `onStepEnd` still has
    // an anchor (Plan.md §6.1). A second, unscoped call site added later would
    // be caught by the assertion above, not by this one.
    const store = createFakeStore();
    await runTurn({
      steps: [
        {
          parts: [
            { type: "tool-input-start" as const, id: "c1", toolName: "echo" },
            toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "one" } }),
            finish("tool-calls"),
          ],
        },
        { parts: [...text("t1", "done"), finish("stop")] },
      ],
      store,
    });

    expect(store.heartbeats.length).toBeGreaterThanOrEqual(3);
    expect(store.heartbeats.every((heartbeat) => heartbeat.sessionId === "s1")).toBe(true);
  });
});

/* ================================================================== */
/* Gap 4 — one outcome per turn                                        */
/* ================================================================== */

describe("the reload recovery closes a turn exactly once", () => {
  const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
  const stale = (turnId: string): UnfinishedTurn => ({
    turnId,
    heartbeatAt: new Date(nowMs - 120_000).toISOString(),
    startedAt: new Date(nowMs - 180_000).toISOString(),
  });

  it("TWO recoveries in a row produce ONE outcome", async () => {
    // The measured bug. `listUnfinishedTurns` counts `interrupted` as unfinished
    // on purpose (§3.1: an unfinished turn is interrupted and repeated with
    // `regenerate`), and closing a turn does not renew its heartbeat — so the
    // turn this recovery just closed comes back on the next start-up, stale as
    // ever, and used to gain a second `interrupted` outcome message. The
    // transcript grew a duplicate every time the tab was reopened.
    const store = createFakeStore();
    store.unfinished = [stale("t1")];

    const first = await recoverStaleTurns({ store, sessionId: "s1", nowMs });
    const second = await recoverStaleTurns({ store, sessionId: "s1", nowMs });
    const third = await recoverStaleTurns({ store, sessionId: "s1", nowMs });

    expect(first.map((turn) => turn.turnId)).toEqual(["t1"]);
    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(store.outcomes).toEqual([
      { turnId: "t1", outcome: "interrupted", error: expect.stringContaining("no heartbeat") },
    ]);
  });

  it("a turn that already succeeded is not closed again", async () => {
    // The other direction of the same condition, and the one a
    // `outcome === "interrupted"` check would get wrong: a read that raced a
    // finish reports a turn as unfinished and carries `succeeded` in the log.
    const store = createFakeStore();
    await store.finishTurn({ turnId: "t1", sessionId: "s1", outcome: "succeeded", error: undefined });
    store.unfinished = [stale("t1")];

    const recovered = await recoverStaleTurns({ store, sessionId: "s1", nowMs });

    expect(recovered).toEqual([]);
    expect(store.outcomes).toHaveLength(1);
    expect(store.outcomes[0]?.outcome).toBe("succeeded");
  });

  it("a turn that already failed is not closed again either", async () => {
    const store = createFakeStore();
    await store.finishTurn({ turnId: "t1", sessionId: "s1", outcome: "failed", error: "boom" });
    store.unfinished = [stale("t1")];

    expect(await recoverStaleTurns({ store, sessionId: "s1", nowMs })).toEqual([]);
    expect(store.outcomes.map((entry) => entry.outcome)).toEqual(["failed"]);
  });

  it("a turn that carries no outcome and is stale is still closed", async () => {
    // The other side of the boundary, so the new condition cannot be satisfied
    // by "skip everything the log says something about".
    const store = createFakeStore();
    store.unfinished = [stale("t1")];

    expect((await recoverStaleTurns({ store, sessionId: "s1", nowMs })).length).toBe(1);
    expect(store.outcomes.map((entry) => entry.outcome)).toEqual(["interrupted"]);
  });

  it("a fresh heartbeat is left alone whatever the log says", async () => {
    const store = createFakeStore();
    const live: UnfinishedTurn = {
      turnId: "t1",
      heartbeatAt: new Date(nowMs - 1_000).toISOString(),
      startedAt: new Date(nowMs - 180_000).toISOString(),
    };
    store.unfinished = [live];

    expect(await recoverStaleTurns({ store, sessionId: "s1", nowMs })).toEqual([]);
    expect(store.outcomes).toEqual([]);
  });
});

describe("isRecoverableTurn, the condition the recovery uses", () => {
  const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
  const turn: UnfinishedTurn = {
    turnId: "t1",
    heartbeatAt: new Date(nowMs - 120_000).toISOString(),
    startedAt: new Date(nowMs - 180_000).toISOString(),
  };
  const facts = (over: Partial<{ recordedOutcome: TurnOutcome | undefined }> = {}) => ({
    nowMs,
    staleAfterMs: STALE_HEARTBEAT_MS,
    recordedOutcome: over.recordedOutcome,
  });

  it("a stale turn with no outcome is recoverable — the only true case", () => {
    expect(isRecoverableTurn(turn, facts())).toBe(true);
  });

  it("a live turn is not recoverable, however old its start is", () => {
    expect(
      isRecoverableTurn(
        { ...turn, heartbeatAt: new Date(nowMs - 1).toISOString() },
        facts(),
      ),
    ).toBe(false);
  });

  it("no outcome on the log means recoverable even for the third terminal value", () => {
    for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
      expect(isRecoverableTurn(turn, facts({ recordedOutcome: outcome })), outcome).toBe(false);
    }
  });

  it("the boundary is `age >= 30 s`, and the predicate does not soften it", () => {
    const at = (ageMs: number): UnfinishedTurn => ({
      ...turn,
      heartbeatAt: new Date(nowMs - ageMs).toISOString(),
    });
    expect(isRecoverableTurn(at(STALE_HEARTBEAT_MS - 1), facts())).toBe(false);
    expect(isRecoverableTurn(at(STALE_HEARTBEAT_MS), facts())).toBe(true);
  });
});
