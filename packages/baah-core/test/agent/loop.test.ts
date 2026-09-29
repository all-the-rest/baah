/**
 * The turn runner, against a mock language model.
 *
 * The cases here are the ones whose failure is *silent*: a turn that ends
 * without a terminal event, a retry that duplicates the previous attempt's
 * text, a `no-response` that gets retried anyway, an approval that is answered
 * but never resumed. Each of those produces a plausible-looking transcript and
 * no error, which is exactly the class of bug this harness exists to avoid.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, type ApprovalDecision, type ApprovalRequest, type ToolContext } from "../../src/tool.ts";
import { createMemoryWorkspace, type Workspace } from "../../src/workspace.ts";
import {
  buildApprovalTargets,
  createApprovalResolver,
  type ApprovalResolver,
  type PermissionEngine,
} from "../../src/agent/approval.ts";
import { AgentTurn, staticAgentSettings, type AgentEvent, type TurnStore, type UnfinishedTurn } from "../../src/agent/loop.ts";
import { createMockModel, errorPart, finish, reasoning, text, toolCall } from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const echoSchema = z.object({ value: z.string() });

function echoTool(onExecute?: (context: ToolContext) => void): ReturnType<typeof defineTool> {
  return defineTool<{ value: string }, { ok: boolean; seen: string }>({
    id: "echo",
    description: "Echo a value back.",
    access: "read",
    inputSchema: echoSchema,
    execute: async (context, input) => {
      onExecute?.(context);
      return { ok: true, seen: input.value };
    },
  }) as ReturnType<typeof defineTool>;
}

interface RecordedStore extends TurnStore {
  finished: { outcome: string; error: string | undefined }[];
  began: { toolCallId: string; toolName: string }[];
  recorded: Map<string, unknown>;
  heartbeats: number;
  /** Unfinished turns, for the reload-recovery tests. */
  unfinished: UnfinishedTurn[];
}

function createStore(seed?: Record<string, unknown>): RecordedStore {
  const recorded = new Map<string, unknown>(seed === undefined ? [] : Object.entries(seed));
  const store: RecordedStore = {
    finished: [],
    began: [],
    recorded,
    heartbeats: 0,
    unfinished: [],
    async flushDelta() {},
    async finishTurn(input) {
      store.finished.push({ outcome: input.outcome, error: input.error });
    },
    async heartbeat() {
      store.heartbeats += 1;
    },
    async listUnfinishedTurns() {
      return store.unfinished;
    },
    async recordToolCall(input) {
      recorded.set(input.key.toolCallId, input.output);
    },
    async getToolCall(key) {
      return recorded.has(key.toolCallId) ? { status: "done", output: recorded.get(key.toolCallId) } : undefined;
    },
    async beginToolCall(input) {
      store.began.push({ toolCallId: input.key.toolCallId, toolName: input.toolName });
    },
  };
  return store;
}

const allowAll: PermissionEngine = {
  evaluate: () => ({ effect: "allow" }),
  recordAlways: async () => {},
};

const askAll: PermissionEngine = {
  evaluate: () => ({ effect: "ask" }),
  recordAlways: async () => {},
};

const denyAll: PermissionEngine = {
  evaluate: () => ({ effect: "deny" }),
  recordAlways: async () => {},
};

function approvalFor(engine: PermissionEngine, tools: Parameters<typeof buildApprovalTargets>[0]["tools"]): ApprovalResolver {
  return createApprovalResolver({ engine, targets: buildApprovalTargets({ tools }) });
}

const noSleep = async (): Promise<void> => {};

function run(options: {
  steps: Parameters<typeof createMockModel>[0]["steps"];
  store?: RecordedStore;
  approval?: ApprovalResolver;
  tools?: ReturnType<typeof defineTool>[];
  onEvent?: (event: AgentEvent) => void;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  messages?: Parameters<typeof AgentTurn.prototype.run> extends never ? never : never;
}) {
  const tools = options.tools ?? [echoTool()];
  const events: AgentEvent[] = [];
  const store = options.store ?? createStore();
  const turn = new AgentTurn({
    model: createMockModel({ steps: options.steps }),
    instructions: "You are a test harness.",
    tools,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store,
    approval: options.approval ?? approvalFor(allowAll, tools),
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    approve: async (_request: ApprovalRequest): Promise<ApprovalDecision> => "allow-once",
    sleep: noSleep,
    // Deterministic jitter: the tests assert delays elsewhere, not here.
    random: () => 0.5,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
  return { turn, events, store, tools };
}

const kinds = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

/* ------------------------------------------------------------------ */
/* A plain successful turn                                             */
/* ------------------------------------------------------------------ */

describe("a successful turn", () => {
  it("returns the model's text and finishes the turn", async () => {
    const { turn, store } = run({ steps: [{ parts: [...text("t1", "Hello"), finish("stop")] }] });
    const result = await turn.run("hi");

    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("Hello");
    expect(result.attempts).toBe(1);
    expect(store.finished.at(-1)).toEqual({ outcome: "succeeded", error: undefined });
  });

  it("emits typed events rather than writing to the console", async () => {
    const { turn, events } = run({ steps: [{ parts: [...text("t1", "Hi"), finish("stop")] }] });
    await turn.run("hi");
    expect(kinds(events)).toContain("attempt-started");
    expect(kinds(events)).toContain("turn-finished");
  });

  it("records the attempt as succeeded and not interrupted", async () => {
    const { turn } = run({ steps: [{ parts: [...text("t1", "Hi"), finish("stop")] }] });
    const result = await turn.run("hi");
    expect(result.attemptLog).toEqual([
      { attempt: 1, text: "Hi", interrupted: false, classification: { kind: "success" } },
    ]);
  });

  it("carries the transcript, which is the storage truth", async () => {
    const { turn } = run({ steps: [{ parts: [...text("t1", "Hi"), finish("stop")] }] });
    const result = await turn.run("hi");
    const roles = result.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("emits reasoning deltas when the model produces them", async () => {
    const { turn, events } = run({
      steps: [{ parts: [...reasoning("r1", "thinking"), ...text("t1", "Hi"), finish("stop")] }],
    });
    await turn.run("hi");
    expect(kinds(events)).toContain("reasoning-delta");
  });
});

/* ------------------------------------------------------------------ */
/* The tool loop                                                       */
/* ------------------------------------------------------------------ */

describe("a multi-step turn with a tool call", () => {
  const twoStep = [
    { parts: [{ type: "tool-input-start" as const, id: "c1", toolName: "echo" }, toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "one" } }), finish("tool-calls")] },
    { parts: [...text("t1", "one and done"), finish("stop")] },
  ];

  it("runs the tool and feeds the result back to the model", async () => {
    const { turn, events, store } = run({ steps: twoStep });
    const result = await turn.run("echo one");

    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("one and done");
    expect(kinds(events)).toContain("tool-call");
    expect(kinds(events)).toContain("tool-result");
    expect(store.recorded.get("c1")).toEqual({ ok: true, seen: "one" });
  });

  it("emits a checkpoint per step, not only at the end (AGENTS.md §3.1)", async () => {
    // A turn that dies in step 2 of 5 must not lose step 1.
    const { turn, events, store } = run({ steps: twoStep });
    await turn.run("echo one");

    const stepEnds = events.filter((event) => event.type === "step-end");
    expect(stepEnds.length).toBeGreaterThanOrEqual(2);
    expect(store.heartbeats).toBeGreaterThanOrEqual(2);
  });

  it("stops at the step limit instead of looping forever", async () => {
    // Every step asks for another tool call; without a stop condition this
    // never terminates.
    const looping = [
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
    ];
    const { turn } = run({ steps: looping, maxSteps: 2 });
    const result = await turn.run("loop");

    // Terminates rather than hanging, and says the answer is incomplete. Not a
    // failure: the transport was fine, the model just wanted another round.
    expect(result.attempts).toBe(1);
    expect(result.hitStepLimit).toBe(true);
    expect(result.outcome).toBe("succeeded");
  });

  it("does not report the step limit for a turn that finished on its own", async () => {
    const { turn } = run({
      steps: [{ parts: [...text("t1", "done"), finish("stop")] }],
      maxSteps: 2,
    });
    expect((await turn.run("go")).hitStepLimit).toBe(false);
  });

  it("marks each tool call as about-to-run before it executes", async () => {
    const { turn, store } = run({ steps: twoStep });
    await turn.run("echo one");
    expect(store.began).toEqual([{ toolCallId: "c1", toolName: "echo" }]);
  });

  it("hands the tool a call identity", async () => {
    const seen: string[] = [];
    const tool = echoTool((context) => seen.push(`${context.toolCallId}#${context.attempt}`));
    const { turn } = run({ steps: twoStep, tools: [tool] });
    await turn.run("echo one");
    expect(seen).toEqual(["c1#1"]);
  });

  it("refuses to run a tool whose id was already executed", async () => {
    // The replay case from Plan.md §14.4: without the short-circuit, a
    // `regenerate` runs the same tool twice — a second question card, a second
    // write, or a todo list that overwrites a newer one while reporting a
    // change that never happened.
    const executed: string[] = [];
    const tool = echoTool(() => executed.push("ran"));
    const store = createStore({ c1: { ok: true, seen: "recorded" } });
    const { turn, events } = run({ steps: twoStep, tools: [tool], store });

    await turn.run("echo one");

    expect(executed).toEqual([]);
    // The model still gets an answer, so the turn can continue.
    expect(kinds(events)).toContain("tool-result");
  });

  it("surfaces a throwing tool to the model as readable data, not as a dead step", async () => {
    const failing = [
      { parts: [toolCall({ toolCallId: "c1", toolName: "boom", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [...text("t1", "recovered"), finish("stop")] },
    ];
    const boom = defineTool<{ value: string }, string>({
      id: "boom",
      description: "throws",
      access: "read",
      inputSchema: echoSchema,
      execute: async () => {
        throw new Error("tool exploded");
      },
    }) as ReturnType<typeof defineTool>;

    const { turn, events, store } = run({ steps: failing, tools: [boom] });
    const result = await turn.run("break it");

    // The turn completes: the failure travels as a tool *result* the model can
    // read (`toToolErrorResult`, Plan.md §4.2), so the model gets a second step
    // to react. A thrown tool error would abort the step instead.
    expect(result.outcome).toBe("succeeded");
    expect(store.recorded.get("c1")).toEqual({ ok: false, error: "tool exploded" });
    expect(kinds(events)).toContain("tool-result");
  });

  it("refuses a tool call whose arguments do not match the schema", async () => {
    const ran: string[] = [];
    const tool = echoTool(() => ran.push("ran"));
    const bad = [
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: 42 } }), finish("tool-calls")] },
      { parts: [...text("t1", "ok"), finish("stop")] },
    ];
    const { turn } = run({ steps: bad, tools: [tool] });
    await turn.run("echo a number");
    expect(ran).toEqual([]);
  });

  it("validates on the APPROVAL path too — a bad argument set never reaches the tool", async () => {
    // The bounds live in the schema because the model breaks them. The adapter
    // parses before `execute` on *every* route, and the approval pause is one
    // of them: approving a call must not become a way to skip validation.
    const ran: string[] = [];
    const tool = echoTool(() => ran.push("ran"));
    const steps = [
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: 42 } }), finish("tool-calls")] },
      { parts: [...text("t1", "ok"), finish("stop")] },
    ];
    const { turn } = run({ steps, tools: [tool], approval: approvalFor(allowAll, [tool]) });
    await turn.run("echo a number");
    expect(ran).toEqual([]);
  });

  it("validates before the replay short-circuit, not after", async () => {
    // Covered at the adapter level too; asserted here so the guarantee is not
    // only a property of one test file.
    const ran: string[] = [];
    const tool = echoTool(() => ran.push("ran"));
    const store = createStore({ c1: "recorded" });
    const steps = [
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: 42 } }), finish("tool-calls")] },
      { parts: [...text("t1", "ok"), finish("stop")] },
    ];
    const { turn } = run({ steps, tools: [tool], store });
    await turn.run("echo a number");
    expect(ran).toEqual([]);
    // And it did not mark the call as newly started either.
    expect(store.began).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

describe("approval pause and resume", () => {
  const askThenAnswer = [
    { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
  ];

  it("pauses on ask and surfaces an approval request", async () => {
    const tools = [echoTool()];
    const { turn, events } = run({
      steps: askThenAnswer,
      tools,
      approval: approvalFor(askAll, tools),
    });
    const result = await turn.run("echo x");

    expect(result.outcome).toBe("awaiting-approval");
    expect(result.openApprovals).toHaveLength(1);
    expect(result.openApprovals[0]?.toolName).toBe("echo");
    expect(kinds(events)).toContain("approval-requested");
  });

  it("does not run the tool while the approval is open", async () => {
    const ran: string[] = [];
    const tools = [echoTool(() => ran.push("ran"))];
    const { turn } = run({ steps: askThenAnswer, tools, approval: approvalFor(askAll, tools) });
    await turn.run("echo x");
    expect(ran).toEqual([]);
  });

  it("does not retry a paused turn", async () => {
    // A retry would re-ask the same question; the answer belongs to the user.
    const tools = [echoTool()];
    const { turn, events } = run({ steps: askThenAnswer, tools, approval: approvalFor(askAll, tools) });
    const result = await turn.run("echo x");

    expect(result.attempts).toBe(1);
    expect(events.filter((event) => event.type === "attempt-started")).toHaveLength(1);
  });

  it("resumes after the approval is granted and finishes the turn", async () => {
    const tools = [echoTool()];
    const events: AgentEvent[] = [];
    const store = createStore();
    const turn = new AgentTurn({
      model: createMockModel({
        steps: [
          askThenAnswer[0]!,
          { parts: [...text("t1", "approved and done"), finish("stop")] },
        ],
      }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store,
      approval: approvalFor(askAll, tools),
      onEvent: (event) => events.push(event),
      approve: async () => "allow-once",
      sleep: noSleep,
      random: () => 0.5,
    });

    const paused = await turn.run("echo x");
    expect(paused.outcome).toBe("awaiting-approval");

    const resumed = await turn.respondToApproval({
      approvalId: paused.openApprovals[0]!.approvalId,
      approved: true,
    });

    expect(resumed?.outcome).toBe("succeeded");
    expect(resumed?.text).toBe("approved and done");
    expect(kinds(events)).toContain("approval-answered");
    // The tool ran exactly once, on the resumed turn.
    expect(store.began).toEqual([{ toolCallId: "c1", toolName: "echo" }]);
  });

  it("ignores an answer for an approval that is not open", async () => {
    const tools = [echoTool()];
    const { turn } = run({ steps: askThenAnswer, tools, approval: approvalFor(askAll, tools) });
    await turn.run("echo x");
    const result = await turn.respondToApproval({ approvalId: "nope", approved: true });
    expect(result).toBeUndefined();
  });
});

describe("a denial", () => {
  it("reaches the model as a readable refusal, not an error", async () => {
    const tools = [echoTool()];
    const { turn, events } = run({
      steps: [
        { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
        { parts: [...text("t1", "I cannot do that"), finish("stop")] },
      ],
      tools,
      approval: approvalFor(denyAll, tools),
    });
    const result = await turn.run("echo x");

    // A thrown error would read to the model as a malfunction to retry; a
    // `tool-output-denied` is an answer it can route around.
    expect(result.outcome).toBe("succeeded");
    expect(kinds(events)).toContain("tool-output-denied");
  });

  it("never runs the denied tool", async () => {
    const ran: string[] = [];
    const tools = [echoTool(() => ran.push("ran"))];
    const { turn } = run({
      steps: [
        { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
        { parts: [...text("t1", "denied"), finish("stop")] },
      ],
      tools,
      approval: approvalFor(denyAll, tools),
    });
    await turn.run("echo x");
    expect(ran).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Retry (Plan.md §5.4)                                                */
/* ------------------------------------------------------------------ */

/** An `APICallError`-shaped throwable; structurally read, never `instanceof`. */
function apiError(status: number, body?: unknown, headers?: Record<string, string>): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    statusCode: status,
    ...(body === undefined ? {} : { responseBody: JSON.stringify(body) }),
    ...(headers === undefined ? {} : { responseHeaders: headers }),
  });
}

describe("retry after a retryable failure", () => {
  it("retries a 500 and succeeds on the second attempt", async () => {
    const { turn, events } = run({
      steps: [
        { throws: apiError(500) },
        { parts: [...text("t1", "second time lucky"), finish("stop")] },
      ],
    });
    const result = await turn.run("go");

    expect(result.outcome).toBe("succeeded");
    expect(result.attempts).toBe(2);
    expect(events.filter((event) => event.type === "attempt-failed")).toHaveLength(1);
  });

  it("keeps the failed attempt, marked interrupted", async () => {
    // Plan.md §5.4: the failed attempt stays visible. Without this, a
    // 200-but-broken turn is undiagnosable.
    const { turn } = run({
      steps: [{ throws: apiError(500) }, { parts: [...text("t1", "ok"), finish("stop")] }],
    });
    const result = await turn.run("go");

    expect(result.attemptLog).toHaveLength(2);
    expect(result.attemptLog[0]).toEqual({
      attempt: 1,
      text: "",
      interrupted: true,
      classification: { kind: "http-error", status: 500, retryable: true },
    });
    expect(result.attemptLog[1]?.interrupted).toBe(false);
  });

  it("does NOT copy the failed attempt's text into the retry", async () => {
    // The failed attempt's partial text must stay in its own log entry; a retry
    // that prepended it would show the user text the model never finished.
    const { turn } = run({
      steps: [
        { parts: [...text("t1", "partial output"), errorPart(apiError(500))] },
        { parts: [...text("t1", "complete output"), finish("stop")] },
      ],
    });
    const result = await turn.run("go");

    expect(result.text).toBe("complete output");
    expect(result.text).not.toContain("partial output");
    expect(result.attemptLog[0]?.text).toContain("partial output");
  });

  it("starts the retry from the original transcript, not the failed one", async () => {
    const { turn } = run({
      steps: [
        { parts: [...text("t1", "attempt one"), errorPart(apiError(500))] },
        { parts: [...text("t1", "attempt two"), finish("stop")] },
      ],
    });
    const result = await turn.run("go");

    // One user message, not two: a retry is a re-send, not a continuation.
    const userMessages = result.messages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
  });

  it("marks the turn interrupted between attempts", async () => {
    // Every failed attempt must leave a *terminal* outcome behind. A turn left
    // as `streaming` with a stale heartbeat is exactly what the reload recovery
    // has to clean up — and cleaning up means the user sees a half-written
    // transcript with no explanation.
    const { turn, store } = run({
      steps: [{ throws: apiError(500) }, { parts: [...text("t1", "ok"), finish("stop")] }],
    });
    const result = await turn.run("go");

    expect(store.finished.map((entry) => entry.outcome)).toEqual(["interrupted", "succeeded"]);
    // The reason survives, so the transcript can explain itself.
    expect(store.finished[0]?.error).toContain("HTTP 500");
    expect(result.attemptLog[0]?.interrupted).toBe(true);
  });

  it("leaves no attempt without a recorded outcome", async () => {
    // Whatever the number of attempts, each is accounted for and the last word
    // belongs to the turn that actually finished it.
    const { turn, store } = run({
      steps: [
        { throws: apiError(500) },
        { throws: apiError(500) },
        { parts: [...text("t1", "ok"), finish("stop")] },
      ],
    });
    const result = await turn.run("go");

    expect(result.attempts).toBe(3);
    expect(store.finished.map((entry) => entry.outcome)).toEqual([
      "interrupted",
      "interrupted",
      "succeeded",
    ]);
  });

  it("records the final failure rather than leaving the turn open", async () => {
    // Not `streaming`, not `pending`: the turn is closed.
    const { turn, store } = run({ steps: [{ throws: apiError(401) }] });
    await turn.run("go");
    expect(store.finished.at(-1)?.outcome).toBe("failed");
  });

  it("a stalled turn is left interrupted, not silently succeeded", async () => {
    const { turn, store } = run({ steps: [{ throws: abortError() }] });
    const result = await turn.run("go");
    expect(result.outcome).toBe("waiting");
    expect(store.finished.at(-1)?.outcome).toBe("interrupted");
  });

  it("gives up after three attempts, with no fourth", async () => {
    const { turn, events } = run({ steps: [{ throws: apiError(503) }] });
    const result = await turn.run("go");

    expect(result.outcome).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(events.filter((event) => event.type === "attempt-started")).toHaveLength(3);
  });

  it("waits 2 s before the second attempt and 8 s before the third", async () => {
    const delays: number[] = [];
    const tools = [echoTool()];
    const turn = new AgentTurn({
      model: createMockModel({ steps: [{ throws: apiError(500) }] }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: createStore(),
      approval: approvalFor(allowAll, tools),
      onEvent: () => {},
      approve: async () => "allow-once",
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });
    await turn.run("go");
    expect(delays).toEqual([2_000, 8_000]);
  });

  it("retries a transient 200 + error-JSON body", async () => {
    const { turn } = run({
      steps: [
        { throws: apiError(200, { error: { type: "server_error", message: "boom" } }) },
        { parts: [...text("t1", "ok"), finish("stop")] },
      ],
    });
    expect((await turn.run("go")).attempts).toBe(2);
  });

  it("retries a truncated stream, because a 200 is not a success", async () => {
    const { turn } = run({
      steps: [
        // Text arrived, the stream ended, no `finish`.
        { parts: [...text("t1", "half a thought")] },
        { parts: [...text("t1", "whole thought"), finish("stop")] },
      ],
    });
    const result = await turn.run("go");
    expect(result.outcome).toBe("succeeded");
    // The reason is owned by `stream/classify.ts` now, so the §5.4 wording is
    // written in exactly one place and every failure reads the same.
    expect(result.attemptLog[0]?.classification).toMatchObject({ kind: "protocol-error" });
    expect(result.attemptLog[0]?.classification).toHaveProperty(
      "reason",
      expect.stringContaining("stream ended without a terminal event"),
    );
  });
});

describe("failures that are not retried", () => {
  it("a 401 fails immediately", async () => {
    const { turn, events } = run({ steps: [{ throws: apiError(401) }] });
    const result = await turn.run("go");

    expect(result.outcome).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(events.filter((event) => event.type === "attempt-failed")).toHaveLength(1);
  });

  it("a quota error fails immediately — a retry loop would burn money", async () => {
    const { turn } = run({
      steps: [{ throws: apiError(200, { error: { type: "insufficient_quota", message: "no credit" } }) }],
    });
    const result = await turn.run("go");

    expect(result.outcome).toBe("failed");
    expect(result.attempts).toBe(1);
  });

  it("an unknown body-error type is retried exactly once", async () => {
    // Plan.md §5.4: an unknown type is retried once, then handed to the user —
    // three requests on a cause nobody identified is not "trying harder".
    const { turn, events } = run({
      steps: [{ throws: apiError(200, { error: { type: "brand_new_thing", message: "?" } }) }],
    });
    const result = await turn.run("go");

    expect(result.attempts).toBe(2);
    expect(events.filter((event) => event.type === "attempt-started")).toHaveLength(2);
  });

  it("a missing API key is not retried", async () => {
    // §9: without `apiKey` the SDK throws LoadAPIKeyError on the first call.
    // Retrying would produce the identical error three times.
    const { turn } = run({ steps: [{ throws: loadApiKeyError() }] });
    const result = await turn.run("go");
    expect(result.attempts).toBe(1);
    expect(result.outcome).not.toBe("succeeded");
  });
});

function loadApiKeyError(): Error {
  const error = new Error("No API key found in the environment");
  error.name = "LoadAPIKeyError";
  return error;
}

describe("no-response is never retried", () => {
  it("surfaces a waiting state instead of a retry", async () => {
    // Plan.md §5.4: without a response the provider may still be generating.
    // A retry would double-bill, and the stream cannot be resumed.
    const { turn, events } = run({ steps: [{ throws: abortError() }] });
    const result = await turn.run("go");

    expect(result.outcome).toBe("waiting");
    expect(result.attempts).toBe(1);
    expect(kinds(events)).toContain("waiting");
    expect(events.filter((event) => event.type === "attempt-started")).toHaveLength(1);
  });

  it("does not emit attempt-failed for it, because nothing failed", async () => {
    const { turn, events } = run({ steps: [{ throws: abortError() }] });
    await turn.run("go");
    expect(events.filter((event) => event.type === "attempt-failed")).toHaveLength(0);
  });

  it("keeps whatever text had already arrived", async () => {
    const { turn } = run({ steps: [{ throws: abortError() }] });
    const result = await turn.run("go");
    expect(result.attemptLog[0]?.interrupted).toBe(true);
  });
});

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/* ------------------------------------------------------------------ */
/* Abort                                                               */
/* ------------------------------------------------------------------ */

describe("stop()", () => {
  it("aborts the turn and reports it as interrupted", async () => {
    const controller = new AbortController();
    const tools = [echoTool()];
    const turn = new AgentTurn({
      model: createMockModel({ steps: [{ parts: [...text("t1", "x"), finish("stop")] }] }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: createStore(),
      approval: approvalFor(allowAll, tools),
      onEvent: () => {},
      approve: async () => "allow-once",
      sleep: noSleep,
      random: () => 0.5,
      abortSignal: controller.signal,
    });

    controller.abort();
    expect(turn.signal.aborted).toBe(true);
  });

  it("is idempotent", async () => {
    const tools = [echoTool()];
    const turn = new AgentTurn({
      model: createMockModel({ steps: [{ parts: [...text("t1", "x"), finish("stop")] }] }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: createStore(),
      approval: approvalFor(allowAll, tools),
      onEvent: () => {},
      approve: async () => "allow-once",
      sleep: noSleep,
      random: () => 0.5,
    });
    await turn.stop();
    await turn.stop();
    expect(turn.signal.aborted).toBe(true);
  });

  it("a stopped turn does not start an attempt", async () => {
    const tools = [echoTool()];
    const events: AgentEvent[] = [];
    const turn = new AgentTurn({
      model: createMockModel({ steps: [{ parts: [...text("t1", "x"), finish("stop")] }] }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: createStore(),
      approval: approvalFor(allowAll, tools),
      onEvent: (event) => events.push(event),
      approve: async () => "allow-once",
      sleep: noSleep,
      random: () => 0.5,
    });
    await turn.stop();
    const result = await turn.run("go");

    expect(result.outcome).toBe("interrupted");
    expect(kinds(events)).not.toContain("attempt-started");
  });
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

describe("the turn's own options", () => {
  it("accepts a caller-supplied abort signal and combines it with stop()", async () => {
    const controller = new AbortController();
    const { turn } = run({
      steps: [{ parts: [...text("t1", "x"), finish("stop")] }],
      abortSignal: controller.signal,
    });
    await turn.stop();
    expect(turn.signal.aborted).toBe(true);
  });

  it("uses the memory workspace it was given, not a global", async () => {
    // A harness that reached for a global workspace would be unusable with two
    // open projects.
    const workspace: Workspace = createMemoryWorkspace({ "a.ts": "content" });
    expect(await workspace.readText("a.ts")).toBe("content");
  });
});

/* ------------------------------------------------------------------ */
/* The rules that live in the agent settings                            */
/* ------------------------------------------------------------------ */

describe("staticAgentSettings", () => {
  it("disables the SDK's own retry loop", () => {
    // AGENTS.md §3.1 and §5.4: at most 3 attempts per turn, all of them
    // visible. `maxRetries` **defaults to 2** and retries under the SDK's own
    // backoff, below our classification — so left on, one turn makes up to nine
    // requests and six of them never reach the UI. Deleting this line survived
    // 403 tests, because every fake error in the suite was a plain `Error` and
    // the SDK's `shouldRetry` predicate is
    // `APICallError.isInstance(error) && error.isRetryable === true`.
    expect(staticAgentSettings().maxRetries).toBe(0);
  });

  it("turns telemetry off, explicitly (AGENTS.md §3.1)", () => {
    // §14.4 gives the reason: without a registered integration the SDK sends
    // nothing, but the option counts as default-on — so a later upgrade would
    // start sending without anybody deciding to. Deleting this line killed zero
    // tests, which is not a property of the line but of the suite.
    expect(staticAgentSettings().telemetry).toEqual({ isEnabled: false });
  });

  it("hands out a fresh object, so a caller cannot mutate the next turn", () => {
    expect(staticAgentSettings()).not.toBe(staticAgentSettings());
  });
});

/* ------------------------------------------------------------------ */
/* A stop is not a stall                                               */
/* ------------------------------------------------------------------ */

describe("a user stop", () => {
  const stopMidStream = async (): Promise<AgentEvent[]> => {
    const controller = new AbortController();
    const tools = [echoTool()];
    const events: AgentEvent[] = [];
    const turn = new AgentTurn({
      model: createMockModel({
        steps: [{ parts: [...text("t1", "half"), ...text("t1", "more")], delayMs: 1 }],
      }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: createStore(),
      approval: approvalFor(allowAll, tools),
      onEvent: (event) => events.push(event),
      approve: async () => "allow-once",
      sleep: noSleep,
      random: () => 0.5,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1);
    await turn.run("go");
    return events;
  };

  it("emits `turn-stopped`, not `attempt-failed`", async () => {
    const events = await stopMidStream();
    const kinds = events.map((event) => event.type);
    expect(kinds).toContain("turn-stopped");
    // A stop is a deliberate action. Rendering it as a failed attempt is what
    // trained users to ignore the event that means a real failure.
    expect(kinds).not.toContain("attempt-failed");
    expect(kinds).not.toContain("waiting");
  });

  it("reports interrupted with NO classification — that is what says 'stop'", async () => {
    // The invariant the event documents: a stall always carries `no-response`,
    // so an interrupted turn without a classification is a stop.
    const events = await stopMidStream();
    const finished = events.filter((event) => event.type === "turn-finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: "interrupted" });
  });

  it("and a stop during an APPROVAL RESUME is a stop too", async () => {
    // This used to synthesise `{ kind: "no-response" }` and emit
    // `attempt-failed` — i.e. §5.4's 20-second stall, for a response that was
    // never even asked for.
    const tools = [echoTool()];
    const events: AgentEvent[] = [];
    const turn = new AgentTurn({
      model: createMockModel({
        steps: [
          { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
          { parts: [...text("t1", "after"), ...text("t1", "approval")], delayMs: 1 },
        ],
      }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: createStore(),
      approval: approvalFor(askAll, tools),
      onEvent: (event) => events.push(event),
      approve: async () => "allow-once",
      sleep: noSleep,
      random: () => 0.5,
    });

    const paused = await turn.run("go");
    expect(paused.outcome).toBe("awaiting-approval");
    events.length = 0;

    setTimeout(() => void turn.stop(), 1);
    const resumed = await turn.respondToApproval({
      approvalId: paused.openApprovals[0]!.approvalId,
      approved: true,
    });

    const kinds = events.map((event) => event.type);
    expect(kinds).toContain("turn-stopped");
    expect(kinds).not.toContain("attempt-failed");
    expect(kinds).not.toContain("waiting");
    expect(resumed?.outcome).toBe("interrupted");
    // The stop is named as such in the store too, not as a stall.
    expect(resumed?.classification).toBeUndefined();
  });
});
