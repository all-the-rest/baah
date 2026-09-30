/**
 * `AgentEvent` — the union and the constructors that have to match it.
 *
 * ## The defect this file is for
 *
 * `loop.ts` builds every event with `emit({ type: …, … })` against the
 * `AgentEvent` union, and TypeScript checks that call — with **one** exception
 * it does not check: **excess-property checking does not apply to a spread**.
 *
 * The `approval-requested` constructor is `emit({ type: "approval-requested",
 * ...entry })`, where `entry` is an `OpenApproval` with **five** fields. The
 * union declared **four**. `tsc` was clean, `pnpm check` was green, and the UI
 * had to take the approval card's `input` from the turn snapshot instead of the
 * event — and documented that as if it were the SDK's behaviour. It is ours,
 * and it was wrong.
 *
 * ## Why the type is now an intersection
 *
 * Both spread constructors intersect their union member with the interface they
 * spread (`{ type: "approval-requested" } & OpenApproval`), so a field added to
 * `OpenApproval` **cannot** be missing from the event. That is a compile
 * guarantee, and it is the reason this file's central test is a *type* test.
 *
 * The runtime half is still here, because the type cannot catch the other
 * direction: a hand-written constructor that forgets a field the union requires
 * *is* caught, but a union that quietly loses one is not, and only a real turn
 * shows what actually goes out on the wire.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, type ApprovalDecision, type ApprovalRequest } from "../../src/tool.ts";
import { createMemoryWorkspace } from "../../src/workspace.ts";
import { buildApprovalTargets, createApprovalResolver, type PermissionEngine } from "../../src/agent/approval.ts";
import {
  AgentTurn,
  type AgentEvent,
  type OpenApproval,
  type TurnStore,
} from "../../src/agent/loop.ts";
import { createMockModel, finish, toolCall, type MockStreamPart } from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* The type-level half                                                 */
/* ------------------------------------------------------------------ */

/** The payload of one event variant, with the `type` discriminator removed. */
type PayloadOf<T extends AgentEvent["type"]> = Omit<Extract<AgentEvent, { type: T }>, "type">;

/**
 * The keys an intersection member has, as a *type* — so a field dropped from
 * `OpenApproval` fails `tsc` here rather than at some call site.
 *
 * Exported rather than file-local: `noUnusedLocals` would otherwise reject the
 * very construct this file exists to run, and "delete the assertion" is a
 * cheaper edit than "keep the assertion".
 */
type Expect<T extends true> = T;
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** The approval event's payload *is* `OpenApproval`, all five fields of it. */
export type _ApprovalIsTheWholeOpenApproval = Expect<
  Equals<PayloadOf<"approval-requested">, Omit<OpenApproval, never>>
>;

/** …and the same for the other spread constructor, which had the same shape. */
export type _UnknownOutcomeIsTheWholeThing = Expect<
  Equals<
    PayloadOf<"tool-outcome-unknown">,
    { toolCallId: string; toolName: string; input: unknown }
  >
>;

/**
 * `input` specifically, named: if `OpenApproval` loses it, the approval card's
 * *only* source for what it is approving disappears, and this stops compiling —
 * which is the failure a runtime test would have to catch by accident.
 */
export type _ApprovalCarriesTheInput = Expect<
  Equals<PayloadOf<"approval-requested">["input"], unknown>
>;

/**
 * A `storage-warning`, all three variants at once.
 *
 * `Extract` over the union, so a variant that stops being part of it is a
 * compile error here rather than a silently narrower assertion.
 */
type StorageWarning = Extract<AgentEvent, { type: "storage-warning" }>;

/**
 * `operation` is **required** on every variant, and its three values are the
 * three fired-not-awaited writes.
 *
 * ## Why this is here and not in `storage-failure-text.test.ts`
 *
 * Because the helpers already exist in this file and `AGENTS.md` §4 treats a
 * duplicated helper as a cost. It is a *type* assertion, so `tsc` is the gate:
 * making `operation` optional, or giving a variant a fourth value, stops the
 * package compiling — which is the first line of defence and beats every
 * behavioural test.
 *
 * ## And why it is needed at all
 *
 * The `DECLARED_KEYS` audit below lists `"storage-warning"` as
 * `["attempt", "message", "operation"]`, which is **wrong for two of the three
 * variants** — `record-tool-call` and `upsert-part` also carry `toolCallId` and
 * `toolName`. The audit does not notice, because the turn it runs has no failing
 * write, so the list is never consulted. That is the `AGENTS.md` §6a lesson
 * again: an assertion that cannot be reached is not coverage. The runtime half
 * of this claim is carried where the events actually happen, in
 * `test/agent/storage-failure-text.test.ts`, which observes all three operations
 * from one real turn.
 */
export type _EveryStorageWarningNamesItsWrite = Expect<
  Equals<StorageWarning["operation"], "heartbeat" | "record-tool-call" | "upsert-part">
>;

/**
 * `message` is required on every variant and is a plain `string`.
 *
 * Its *value* is the failure's class name and never the store's text — the rule
 * is behavioural and lives in `storage-failure-text.test.ts`; what this pins is
 * that the field exists, so dropping it (and the description with it) is a
 * compile error rather than a UI that renders `undefined`.
 */
export type _EveryStorageWarningCarriesAMessage = Expect<
  Equals<StorageWarning["message"], string>
>;

/* ------------------------------------------------------------------ */
/* The runtime half                                                    */
/* ------------------------------------------------------------------ */

const tools = [
  defineTool<{ value: string }, { ok: boolean }>({
    id: "echo",
    description: "Echo a value back.",
    access: "write",
    inputSchema: z.object({ value: z.string() }),
    execute: async (_context, input) => ({ ok: true, seen: input.value }),
  }),
];

const allowAll: PermissionEngine = {
  evaluate: () => ({ effect: "allow" }),
  recordAlways: async () => {},
};
const askAll: PermissionEngine = {
  evaluate: () => ({ effect: "ask" }),
  recordAlways: async () => {},
};

function createStore(): TurnStore {
  return {
    async appendTurn() {},
    async appendMessage() {},
    // Tool parts are written on the four tool events, which this store's turn
    // never produces — the case is a plain text turn.
    async upsertPart() {},
    async flushDelta() {},
    async closePart() {},
    async closeTurnParts() {},
    async finishTurn() {},
    async heartbeat() {},
    async listUnfinishedTurns() {
      return [];
    },
    async listTurnOutcomes() {
      return [];
    },
    async recordToolCall() {},
    async getToolCall() {
      return undefined;
    },
    async beginToolCall() {},
  };
}

async function eventsOf(
  steps: MockStreamPart[][],
  engine: PermissionEngine,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const turn = new AgentTurn({
    model: createMockModel({ steps: steps.map((parts) => ({ parts })) }),
    instructions: "test",
    tools,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store: createStore(),
    approval: createApprovalResolver({ engine, targets: buildApprovalTargets({ tools }) }),
    onEvent: (event: AgentEvent) => {
      events.push(event);
    },
    approve: async (_request: ApprovalRequest): Promise<ApprovalDecision> => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
  });
  await turn.run("echo x");
  return events;
}

/** The keys the union declares for one event type, written out by hand. */
const DECLARED_KEYS: Record<AgentEvent["type"], readonly string[]> = {
  "attempt-started": ["attempt", "total", "retryAfterMs"],
  "text-delta": ["messageId", "text"],
  "reasoning-delta": ["messageId", "text"],
  "tool-call": ["input", "toolCallId", "toolName"],
  "tool-result": ["output", "toolCallId", "toolName"],
  "tool-error": ["error", "toolCallId", "toolName"],
  "tool-output-denied": ["reason", "toolCallId", "toolName"],
  "tool-outcome-unknown": ["input", "toolCallId", "toolName"],
  // Five, not four. `input` is the one the union was missing.
  "approval-requested": ["approvalId", "input", "reason", "toolCallId", "toolName"],
  "approval-answered": ["approvalId", "approved"],
  "step-end": ["finishReason", "stepNumber", "text", "toolCallCount"],
  "attempt-failed": ["attempt", "classification"],
  waiting: ["reason", "retryAfterMs"],
  "turn-stopped": ["stage"],
  "turn-finished": ["attempts", "outcome"],
  error: ["classification", "error"],
  "storage-warning": ["attempt", "message", "operation"],
};

describe("AgentEvent — what actually goes out on the wire", () => {
  it("every emitted event carries exactly the keys the union declares for it", async () => {
    /**
     * The audit. Every event a real turn produces, compared against the union —
     * both directions, because both are bugs: a key the constructor sends and
     * the union does not declare is a field a consumer cannot type-check, and a
     * key the union declares and the constructor omits is a field a consumer
     * reads and gets `undefined`.
     */
    const events = await eventsOf(
      [
        // An approval that pauses, so `approval-requested` is really emitted.
        [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")],
        [finish("stop")],
      ],
      askAll,
    );

    expect(events.length).toBeGreaterThan(0);
    const seen = new Set<AgentEvent["type"]>();
    for (const event of events) {
      seen.add(event.type);
      const declared = DECLARED_KEYS[event.type];
      expect(declared, `no declared key set for "${event.type}"`).toBeDefined();
      // `type` is the discriminator, present on both sides by construction.
      const actual = Object.keys(event).filter((key) => key !== "type").toSorted();
      expect(actual, `event "${event.type}"`).toEqual([...declared].toSorted());
    }
    // And the interesting ones were actually exercised, so the audit is not
    // vacuously true over three event types.
    expect(seen).toContain("approval-requested");
    expect(seen).toContain("tool-call");
    expect(seen).toContain("attempt-started");
    expect(seen).toContain("turn-finished");
  });

  it("the approval event carries the tool's input, not just its name", async () => {
    /**
     * The F2 regression, at the level the UI consumed it.
     *
     * §7.5's copy names the resource being approved ("`write` auf
     * `src/app.ts`"), and `input` is the only thing on the event that says what
     * that is. A consumer that has to reach into the turn snapshot instead is
     * working around a hole in *our* type, not around the SDK.
     */
    const events = await eventsOf(
      [
        [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")],
        [finish("stop")],
      ],
      askAll,
    );
    const requested = events.find((event) => event.type === "approval-requested");

    expect(requested).toBeDefined();
    expect(requested?.input).toEqual({ value: "x" });
    // The rest of the payload is unchanged by the fix.
    expect(requested?.approvalId).toEqual(expect.any(String));
    expect(requested?.toolCallId).toBe("c1");
    expect(requested?.toolName).toBe("echo");
  });

  it("the approval event's input is the same object the tool will receive", async () => {
    // Not a copy, not a re-parse. The SDK's `toolCall.input` is what `execute`
    // gets after validation, and a card that shows something *different* from
    // what runs is worse than a card that shows nothing.
    const events = await eventsOf(
      [
        [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")],
        [finish("stop")],
      ],
      askAll,
    );
    const requested = events.find((event) => event.type === "approval-requested");
    expect(requested).toMatchObject({ input: { value: "x" }, toolName: "echo" });
  });

  it("an automatic denial emits no approval card, so no payload is owed", async () => {
    // `isAutomatic` is a decision the rule engine already made. Counting it as
    // an open question would park the turn forever on a card nobody will see.
    const events = await eventsOf(
      [
        [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")],
        [finish("stop")],
      ],
      allowAll,
    );
    expect(events.some((event) => event.type === "approval-requested")).toBe(false);
  });
});
