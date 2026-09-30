/**
 * A failed bookkeeping write arrives as a typed event — never as silence.
 *
 * ## What this file pins down
 *
 * Two writes on the engine's storage seam are **fired rather than awaited**:
 * `heartbeat` and `recordToolCall`. Both have synchronous SDK call sites
 * (`onStepEnd` is a synchronous callback of `ToolLoopAgent`, and the stream loop
 * has nowhere to put an `await` inside a `switch`), so awaiting them was never
 * on the table — but the *handler* was, and a bare `void store.heartbeat(…)`
 * had none.
 *
 * That shape is not "a missing `.catch`". A discarded promise does not become
 * invisible; it becomes an **unhandled promise rejection**, which the browser
 * routes to `unhandledrejection` and vitest treats as a fatal error. So the test
 * file below has a second, independent kind of evidence:
 *
 * - every test here runs a store whose write **rejects**, and
 * - a rejection that nobody handles takes the whole vitest run down with it.
 *
 * That second path matters for the report: reverting the fix to a bare `void`
 * does not merely fail one assertion, it turns the suite red on a channel no
 * assertion is watching.
 *
 * ## The policy, and why it is a warning
 *
 * Written out in full at `heartbeat()` in `src/agent/loop.ts`; the tests here
 * only hold the consequences:
 *
 * 1. a failed heartbeat is reported and the **turn still succeeds**;
 * 2. a failed `recordToolCall` is reported and the **turn still succeeds**;
 * 3. the event names the operation, the attempt, and — for the tool call — the
 *    call itself, because "storage is unhappy" is not something a user can act on;
 * 4. the message is the store's own, and never a stack trace.
 *
 * ## The store
 *
 * A fake, and a *narrow* one: this file is about the two rejected writes, so the
 * other eight methods of the seam do the minimum honest thing. The delta path is
 * left real enough for a turn to stream a part and run a tool, because "the turn
 * still succeeds" is only meaningful if a part was written and a tool returned.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMemoryWorkspace } from "../../src/workspace.ts";
import { defineTool, type ToolContext } from "../../src/tool.ts";
import {
  buildApprovalTargets,
  createApprovalResolver,
  type ApprovalResolver,
  type PermissionEngine,
} from "../../src/agent/approval.ts";
import {
  AgentTurn,
  type AgentEvent,
  type PartKind,
  type TurnStore,
  type TurnOutcome,
  type TurnOutcomeEntry,
  type UnfinishedTurn,
} from "../../src/agent/loop.ts";
import type { ToolCallRecord } from "../../src/agent/tools.ts";
import { createMockModel, finish, text, toolCall, type MockStep } from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

interface StoredPart {
  messageId: string;
  sessionId: string;
  partType: PartKind;
  contentText: string;
  status: "streaming" | "completed" | "aborted";
}

interface RejectingStore extends TurnStore {
  readonly parts: Map<string, StoredPart>;
  /** `undefined` = succeed. Otherwise the promise rejects with this value. */
  failHeartbeat: unknown | undefined;
  failRecordToolCall: unknown | undefined;
  /** How many times each of the two was called, so "it was tried" is measured. */
  heartbeatCalls: number;
  recordCalls: number;
}

/** A `StorageError`-shaped rejection — the "the database is closed" case. */
function closedDatabase(): Error {
  const error = new Error("This database handle is already closed.") as Error & { code: string };
  error.name = "StorageError";
  error.code = "database_closed";
  return error;
}

function createRejectingStore(): RejectingStore {
  const parts = new Map<string, StoredPart>();
  const outcomes: { turnId: string; outcome: TurnOutcome }[] = [];
  const store: RejectingStore = {
    parts,
    failHeartbeat: undefined,
    failRecordToolCall: undefined,
    heartbeatCalls: 0,
    recordCalls: 0,

    async flushDelta(input) {
      parts.set(input.partId, {
        messageId: input.messageId,
        sessionId: input.sessionId,
        partType: input.partType,
        contentText: input.contentText,
        // A delta is mid-stream by definition — the same line a close writes
        // back over, which is why the engine awaits the flush before closing.
        status: "streaming",
      });
    },
    async closePart(input) {
      const part = parts.get(input.partId);
      if (part !== undefined) part.status = input.status;
    },
    async closeTurnParts() {},
    async finishTurn(input) {
      outcomes.push({ turnId: input.turnId, outcome: input.outcome });
    },

    async heartbeat(input) {
      store.heartbeatCalls += 1;
      void input;
      if (store.failHeartbeat !== undefined) throw store.failHeartbeat;
    },

    async listUnfinishedTurns(): Promise<readonly UnfinishedTurn[]> {
      return [];
    },
    async listTurnOutcomes(): Promise<readonly TurnOutcomeEntry[]> {
      return outcomes.map((entry) => ({ turnId: entry.turnId, outcome: entry.outcome }));
    },

    async recordToolCall() {
      store.recordCalls += 1;
      if (store.failRecordToolCall !== undefined) throw store.failRecordToolCall;
    },
    async getToolCall(): Promise<ToolCallRecord | undefined> {
      return undefined;
    },
    async beginToolCall() {},
  };
  return store;
}

/* ------------------------------------------------------------------ */
/* The turn driver                                                     */
/* ------------------------------------------------------------------ */

const echoSchema = z.object({ value: z.string() });
const allowAll: PermissionEngine = {
  evaluate: () => ({ effect: "allow" }),
  recordAlways: async () => {},
};

/**
 * A real `echo` tool, registered with the turn.
 *
 * Not decoration: `recordToolCall` is only reached from the `tool-result` stream
 * part, and the SDK emits that part only for a tool it actually **ran**. With no
 * tool of that name in the set the SDK answers with `tool-error` instead, so a
 * turn that passed `tools: []` would never record anything and this file would
 * quietly measure nothing.
 */
const echoTool = defineTool<{ value: string }, { ok: boolean }>({
  id: "echo",
  description: "Echo a value back.",
  access: "read",
  inputSchema: echoSchema,
  execute: async (_context: ToolContext, input: { value: string }) => ({ ok: input.value.length > 0 }),
}) as ReturnType<typeof defineTool>;

/** A second tool, so a warning naming the wrong one is visible. */
const shoutTool = defineTool<{ value: string }, string>({
  id: "shout",
  description: "Shout a value.",
  access: "read",
  inputSchema: echoSchema,
  execute: async (_context: ToolContext, input: { value: string }) => input.value.toUpperCase(),
}) as ReturnType<typeof defineTool>;

const TOOLS = [echoTool, shoutTool];

/** One step that streams a sentence. */
const ANSWER: MockStep = { parts: [...text("t1", "Hello"), finish("stop")] };

/** One step that calls one tool, then a step that answers. */
function toolCallStep(toolCallId: string, toolName: string): MockStep {
  return {
    parts: [
      { type: "tool-input-start", id: toolCallId, toolName },
      toolCall({ toolCallId, toolName, input: { value: "one" } }),
      finish("tool-calls"),
    ],
  };
}

/** One tool call, then the answer. */
const TOOL_STEPS: readonly MockStep[] = [toolCallStep("c1", "echo"), ANSWER];

/** Two calls to the same tool, so two records are written in one turn. */
const TWO_ECHO_STEPS: readonly MockStep[] = [
  toolCallStep("c1", "echo"),
  toolCallStep("c2", "echo"),
  ANSWER,
];

/**
 * Two calls to **different** tools — so a warning that carried only the turn's
 * first `toolCallId`, or the wrong tool name, is wrong in a way a single-tool
 * turn could not show.
 */
const TWO_TOOL_STEPS: readonly MockStep[] = [
  toolCallStep("c1", "echo"),
  toolCallStep("c2", "shout"),
  ANSWER,
];

interface RunResult {
  readonly events: readonly AgentEvent[];
  readonly outcome: Awaited<ReturnType<AgentTurn["run"]>>["outcome"];
  readonly text: string;
}

async function runTurn(options: {
  steps: Parameters<typeof createMockModel>[0]["steps"];
  store: RejectingStore;
}): Promise<RunResult> {
  const events: AgentEvent[] = [];
  const resolver: ApprovalResolver = createApprovalResolver({
    engine: allowAll,
    targets: buildApprovalTargets({ tools: TOOLS }),
  });
  const turn = new AgentTurn({
    model: createMockModel({ steps: options.steps }),
    instructions: "You are a test harness.",
    tools: TOOLS,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store: options.store,
    approval: resolver,
    onEvent: (event) => events.push(event),
    approve: async () => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
    now: () => 1_000,
  });
  const result = await turn.run("hi");
  return { events, outcome: result.outcome, text: result.text };
}

function warnings(events: readonly AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "storage-warning" }> =>
      event.type === "storage-warning",
  );
}

/* ================================================================== */
/* The heartbeat                                                        */
/* ================================================================== */

describe("a heartbeat that cannot be written is a typed event", () => {
  it("reaches the turn as a storage-warning naming the operation and the attempt", async () => {
    // The measured gap. `void store.heartbeat(…)` discarded the promise, so the
    // rejection left the turn as an unhandled promise rejection and nothing in
    // the event stream said the anchor had stopped being renewed.
    //
    // A one-step turn writes **two** heartbeats (one at the attempt start, one
    // at the step end), so the assertion is on the shape of every event rather
    // than on a count — the count has its own test below.
    const store = createRejectingStore();
    store.failHeartbeat = closedDatabase();

    const { events } = await runTurn({ steps: [ANSWER], store });

    expect(store.heartbeatCalls).toBeGreaterThan(0);
    const heartbeatWarnings = warnings(events).filter((event) => event.operation === "heartbeat");
    expect(heartbeatWarnings).toEqual([
      {
        type: "storage-warning",
        operation: "heartbeat",
        attempt: 1,
        message: "This database handle is already closed.",
      },
      {
        type: "storage-warning",
        operation: "heartbeat",
        attempt: 1,
        message: "This database handle is already closed.",
      },
    ]);
  });

  it("is reported once per heartbeat, not once per turn", async () => {
    // The call sites are one per attempt start and one per `onStepEnd`, so a
    // two-step turn writes more than one. A single event would mean the handler
    // was only on one of them — which is the shape a "fix" that wrapped the
    // first call site would have.
    const store = createRejectingStore();
    store.failHeartbeat = closedDatabase();

    const { events } = await runTurn({ steps: TOOL_STEPS, store });

    const heartbeats = warnings(events).filter((event) => event.operation === "heartbeat");
    expect(store.heartbeatCalls).toBeGreaterThan(1);
    expect(heartbeats).toHaveLength(store.heartbeatCalls);
  });

  it("does NOT end the turn — a ping is not a verdict", async () => {
    // The decision, measured. A heartbeat is a best-effort liveness ping whose
    // only reader is `recoverStaleTurns` on the *next* start-up; the write that
    // genuinely ends a turn is the delta flush, and that one is awaited. So the
    // turn succeeds, the answer is complete, and the part was still written.
    const store = createRejectingStore();
    store.failHeartbeat = closedDatabase();

    const { outcome, text, events } = await runTurn({ steps: [ANSWER], store });

    expect(outcome).toBe("succeeded");
    expect(text).toBe("Hello");
    expect(store.parts.get("t1")?.contentText).toBe("Hello");
    // And no `error` event: a warning is not a failure, and a UI that renders
    // both as red would train the user to ignore the one that is a failure.
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "turn-finished" && event.outcome === "succeeded")).toBe(
      true,
    );
  });

  it("says nothing at all when the heartbeat succeeds", async () => {
    // The other direction, so the warning cannot be satisfied by "always warn".
    const store = createRejectingStore();

    const { events } = await runTurn({ steps: [ANSWER], store });

    expect(store.heartbeatCalls).toBeGreaterThan(0);
    expect(warnings(events)).toEqual([]);
  });

  it("carries the message, not a stack trace (AGENTS.md §5)", async () => {
    // The same rule `toToolErrorResult` follows for tool failures: the string
    // reaches the UI, and a stack trace is engine internals in a rendered field.
    const store = createRejectingStore();
    store.failHeartbeat = new Error("SQLITE_MISUSE: bad parameter or other API misuse");

    const { events } = await runTurn({ steps: [ANSWER], store });

    const event = warnings(events)[0];
    expect(event?.message).toBe("SQLITE_MISUSE: bad parameter or other API misuse");
    expect(event?.message).not.toContain("at ");
    expect(event?.message).not.toContain(".ts:");
  });

  it("describes a thrown non-Error instead of dropping it", async () => {
    // A store that rejects with a string is a store that rejects; reporting
    // nothing would be the same silent failure the fix removed.
    const store = createRejectingStore();
    store.failHeartbeat = "the worker vanished";

    const { events } = await runTurn({ steps: [ANSWER], store });

    expect(warnings(events)[0]?.message).toBe("the worker vanished");
  });
});

/* ================================================================== */
/* The recorded tool call                                               */
/* ================================================================== */

describe("a tool call that cannot be recorded is the same kind of event", () => {
  it("names the call, because 'storage is unhappy' is not actionable", async () => {
    const store = createRejectingStore();
    store.failRecordToolCall = closedDatabase();

    const { events } = await runTurn({ steps: TOOL_STEPS, store });

    expect(store.recordCalls).toBeGreaterThan(0);
    const records = warnings(events).filter((event) => event.operation === "record-tool-call");
    expect(records[0]).toEqual({
      type: "storage-warning",
      operation: "record-tool-call",
      attempt: 1,
      toolCallId: "c1",
      toolName: "echo",
      message: "This database handle is already closed.",
    });
  });

  it("does NOT end the turn, and does not become an unknown outcome", async () => {
    // The reasoning, measured. The tool ran and the model has its real output, so
    // the *outcome* is known — only the proof is missing. `UnknownToolOutcome`
    // says the opposite ("begun, outcome unknown") and would send the model off
    // to verify a call whose answer it just received. And the turn is not failed:
    // the answer the user is reading is complete.
    const store = createRejectingStore();
    store.failRecordToolCall = closedDatabase();

    const { outcome, text, events } = await runTurn({ steps: TOOL_STEPS, store });

    expect(outcome).toBe("succeeded");
    expect(text).toBe("Hello");
    // Asserted here as well as in the test above, on purpose: this test is about
    // what the turn does *not* do, so a handler that swallowed the failure would
    // leave it green. "The turn survived" and "the failure was reported" are two
    // different claims, and asserting only the first is how a report of a failure
    // can be deleted and nothing notices.
    expect(warnings(events).filter((event) => event.operation === "record-tool-call")).toHaveLength(
      store.recordCalls,
    );
  });

  it("one warning per recorded call — two calls, two warnings", async () => {
    // A handler attached to the first call site only would pass every test above
    // and leave the second call unreported, which is the shape the whole
    // "one helper, both call sites" argument exists to prevent.
    const store = createRejectingStore();
    store.failRecordToolCall = closedDatabase();

    const { events } = await runTurn({ steps: TWO_ECHO_STEPS, store });

    const records = warnings(events).filter((event) => event.operation === "record-tool-call");
    expect(store.recordCalls).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map((event) => event.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("names each of them: two tools, so a handler that reported one id for both fails", async () => {
    // The `toolCallId` and `toolName` travel with the event, which is what makes
    // the warning actionable — "storage is unhappy" is not something a user can do
    // anything about, and a handler that reported the *turn's* first call for
    // every warning would look plausible in a transcript with one call in it.
    const store = createRejectingStore();
    store.failRecordToolCall = closedDatabase();

    const { events } = await runTurn({ steps: TWO_TOOL_STEPS, store });

    const records = warnings(events).filter((event) => event.operation === "record-tool-call");
    expect(records.map((event) => [event.toolCallId, event.toolName])).toEqual([
      ["c1", "echo"],
      ["c2", "shout"],
    ]);
  });

  it("says nothing when the record is written", async () => {
    const store = createRejectingStore();

    const { events } = await runTurn({ steps: TOOL_STEPS, store });

    expect(store.recordCalls).toBeGreaterThan(0);
    expect(warnings(events)).toEqual([]);
  });
});
