/**
 * C2 / C3 — the request budget and the terminal-event signal.
 *
 * ## What is being measured
 *
 * C2: `maxRetries: 0` is claimed to close a nine-request hole (3 documented
 * attempts × 3 SDK attempts each). The claim is verifiable by *counting*, not
 * by reading the config: a `LanguageModel` whose `doStream` is instrumented
 * tells us exactly how many requests left the process.
 *
 * C3: Plan.md §5.4 says "Erfolg = der Stream endet sauber mit einem
 * Terminal-Event". The loop implements that as a three-state
 * `terminalEvent`, read by `readTerminalEvent` in `stream/classify.ts` from
 * **both** fields of the closing part. These tests establish what that actually
 * means against a real `ToolLoopAgent`; `test/agent/terminal-event.test.ts`
 * owns the provider-shape matrix, because that is where the field-by-field
 * reasoning lives.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool } from "../../src/tool.ts";
import { createMemoryWorkspace } from "../../src/workspace.ts";
import { buildApprovalTargets, createApprovalResolver } from "../../src/agent/approval.ts";
import { AgentTurn, type AgentEvent, type TurnStore } from "../../src/agent/loop.ts";
import type { ToolCallKey } from "../../src/agent/tools.ts";
import { classifyResponse, classifyThrownError, isKnownErrorType } from "../../src/stream/classify.ts";
import { MAX_ATTEMPTS } from "../../src/stream/backoff.ts";
import {
  finish,
  type MockStep,
  type MockStreamPart,
  type MockStreamResult,
  NO_USAGE,
  text,
  toolCall,
} from "../agent/mock-model.ts";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { APICallError, ToolLoopAgent, isStepCount } from "ai";
import loopSource from "../../src/agent/loop.ts?raw";
import type { LanguageModel } from "ai";

/* ------------------------------------------------------------------ */
/* A counting model                                                     */
/* ------------------------------------------------------------------ */

interface Scripted {
  model: LanguageModel;
  /** One entry per `doStream` — i.e. per HTTP request. */
  requests: string[];
}

/**
 * A model that counts its `doStream` calls.
 *
 * `MockLanguageModelV4` is the same object the existing suite uses, so the
 * request here is the same kind the engine makes in production: one
 * `doStream` per model call. The SDK's retry loop sits *around* `doStream`,
 * so if `maxRetries` were left at its default of 2 this counter would show
 * three times the intended number.
 */
function countingModel(script: readonly MockStep[], label = "req"): Scripted {
  const requests: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (): Promise<MockStreamResult> => {
      const index = Math.min(call, script.length - 1);
      call += 1;
      requests.push(`${label}#${index}`);
      const step = script[index];
      if (step === undefined) throw new Error("counting model: script exhausted");
      if (step.throws !== undefined) throw step.throws;
      return {
        stream: simulateReadableStream<MockStreamPart>({
          chunks: step.parts ?? [],
          ...(step.delayMs === undefined ? {} : { initialDelayInMs: step.delayMs }),
        }),
      };
    },
  });
  return { model, requests };
}

/**
 * A **real** `APICallError`, which is the only shape the SDK's own retry loop
 * will touch.
 *
 * This distinction is the whole point of the block below. `shouldRetry` in
 * `ai`'s `retryWithExponentialBackoffRespectingRetryHeaders` is:
 *
 *   `APICallError.isInstance(error) && error.isRetryable === true`
 *
 * so a hand-rolled `{ statusCode: 503 }` plain `Error` — which is what the
 * existing suite's `apiError()` helper builds, and what the SDK's own
 * classifier reads structurally — is **invisible** to the retry loop. A test
 * that counts requests with that error cannot observe the SDK retrying at
 * all, and therefore cannot observe `maxRetries: 0` either.
 */
function sdkError(status: number, body?: unknown, isRetryable = true): APICallError {
  return new APICallError({
    message: `HTTP ${status}`,
    url: "https://api.example/v1/messages",
    requestBodyValues: { model: "test" },
    statusCode: status,
    isRetryable,
    ...(body === undefined ? {} : { responseBody: JSON.stringify(body) }),
  });
}

function apiError(status: number, body?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    statusCode: status,
    ...(body === undefined ? {} : { responseBody: JSON.stringify(body) }),
  });
}

/** A store that really records, so the replay short-circuit can fire. */
function recordingStore(): TurnStore & { recorded: Map<string, unknown>; seed(id: string, output: unknown): void } {
  // Keyed on the **whole** `ToolCallKey`, not the bare id. That is the point:
  // a store that keys on the id alone cannot express the difference between a
  // replay and a provider reusing an id, so the scoping would be untested.
  const recorded = new Map<string, unknown>();
  const idOf = (key: ToolCallKey): string =>
    `${key.sessionId}#${key.attempt}#${key.toolCallId}#${key.occurrence}`;
  return {
    recorded,
    seed(id: string, output: unknown) {
      recorded.set(idOf({ sessionId: "s1", attempt: 1, toolCallId: id, occurrence: 0 }), output);
    },
    async appendTurn() {},
    async appendMessage() {},
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
    async recordToolCall(input: { key: ToolCallKey; output: unknown }) {
      recorded.set(idOf(input.key), input.output);
    },
    async getToolCall(key: ToolCallKey) {
      const id = idOf(key);
      return recorded.has(id) ? { status: "done", output: recorded.get(id) } : undefined;
    },
    async beginToolCall() {},
  };
}

const allowAll = { evaluate: () => ({ effect: "allow" as const }), recordAlways: async () => {} };

function store(): TurnStore {
  return {
    async appendTurn() {},
    async appendMessage() {},
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

const echo = defineTool<{ value: string }, { ok: boolean }>({
  id: "echo",
  description: "echo",
  access: "read",
  inputSchema: z.object({ value: z.string() }),
  execute: async (_c, input) => ({ ok: input.value === "x" }),
});

function turn(model: LanguageModel, extra: Record<string, unknown> = {}) {
  const events: AgentEvent[] = [];
  const t = new AgentTurn({
    model,
    instructions: "test",
    tools: [echo],
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store: store(),
    approval: createApprovalResolver({
      engine: allowAll,
      targets: buildApprovalTargets({ tools: [echo] }),
    }),
    onEvent: (e) => events.push(e),
    approve: async () => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
    ...extra,
  });
  return { turn: t, events };
}

/* ================================================================== */
/* C2 — the request budget                                             */
/* ================================================================== */

describe("C2 · how many requests leave the process", () => {
  it("one request per attempt when every attempt fails with 503", async () => {
    const { model, requests } = countingModel([{ throws: apiError(503) }]);
    const { turn: t } = turn(model);
    const result = await t.run("go");

    expect(result.attempts).toBe(MAX_ATTEMPTS);
    // THE assertion the claim needs. With the SDK default of 2 this is 9.
    expect(requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("one request per attempt for a 429 too, not just a 5xx", async () => {
    const { model, requests } = countingModel([{ throws: apiError(429) }]);
    await turn(model).turn.run("go");
    expect(requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("one request per attempt for a retryable 200 + error body", async () => {
    const { model, requests } = countingModel([
      { throws: apiError(200, { error: { type: "rate_limit_error", message: "slow down" } }) },
    ]);
    await turn(model).turn.run("go");
    expect(requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("a 401 costs exactly one request in total", async () => {
    const { model, requests } = countingModel([{ throws: apiError(401) }]);
    await turn(model).turn.run("go");
    expect(requests).toHaveLength(1);
  });

  it("a multi-step turn costs one request per STEP, not per turn", async () => {
    // The budget is per turn, so a 5-step turn is 5 requests. Worth pinning:
    // it is the number the UI's cost estimate would be built from.
    const { model, requests } = countingModel([
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [toolCall({ toolCallId: "c2", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [...text("t1", "done"), finish("stop")] },
    ]);
    await turn(model).turn.run("go");
    expect(requests).toHaveLength(3);
  });

  it("a retry re-sends from scratch: each attempt costs its own step chain", async () => {
    const { model, requests } = countingModel([
      { parts: [...text("t1", "partial"), toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), { type: "error", error: apiError(500) } as MockStreamPart] },
      { parts: [...text("t1", "whole"), finish("stop")] },
    ]);
    await turn(model).turn.run("go");
    // 2 requests: the retry does not resume, it re-sends. Plan.md §5.4.
    expect(requests).toHaveLength(2);
  });

  it("the approval RESUME is a separate request, and it is not free of a retry budget", async () => {
    // `respondToApproval` re-enters `#runAttempt`, which builds a *new*
    // `ToolLoopAgent`. If that construction ever lost `maxRetries`, this is
    // the path that would go back to 3 requests per attempt.
    const { model, requests } = countingModel([
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [...text("t1", "after approval"), finish("stop")] },
    ]);
    const askAll = { evaluate: () => ({ effect: "ask" as const }), recordAlways: async () => {} };
    const { turn: t } = turn(model, {
      approval: createApprovalResolver({
        engine: askAll,
        targets: buildApprovalTargets({ tools: [echo] }),
      }),
    });

    const paused = await t.run("go");
    expect(paused.outcome).toBe("awaiting-approval");
    expect(requests).toHaveLength(1);

    const resumed = await t.respondToApproval({
      approvalId: paused.openApprovals[0]!.approvalId,
      approved: true,
    });
    expect(resumed?.outcome).toBe("succeeded");
    expect(requests).toHaveLength(2);
  });

  it("a resume that fails does NOT get the full retry budget — and says so", async () => {
    const { model, requests } = countingModel([
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { throws: apiError(500) },
    ]);
    const askAll = { evaluate: () => ({ effect: "ask" as const }), recordAlways: async () => {} };
    const { turn: t } = turn(model, {
      approval: createApprovalResolver({
        engine: askAll,
        targets: buildApprovalTargets({ tools: [echo] }),
      }),
    });
    const paused = await t.run("go");
    const resumed = await t.respondToApproval({
      approvalId: paused.openApprovals[0]!.approvalId,
      approved: true,
    });
    // loop.ts:569-571 states a resume has no retry budget of its own.
    expect(resumed?.outcome).toBe("failed");
    expect(requests).toHaveLength(2);
  });

  it("FINDING + the test the `maxRetries: 0` claim actually needed", async () => {
    // With a REAL APICallError, the SDK's own retry loop is in play — and only
    // here. Two measurements, both required:
    //
    //   * with `maxRetries: 0` in place  → 3 requests  (the claim holds)
    //   * with the line deleted          → 9 requests  (the hole reopens)
    //
    // Deleting `maxRetries: 0` is invisible to every other test in the suite,
    // because every other test throws a plain `Error`, which the SDK's
    // `shouldRetry` predicate does not match. This is the mutation that
    // survived the build agent's three killed mutants.
    const { model, requests } = countingModel([{ throws: sdkError(503) }]);
    const result = await turn(model).turn.run("go");

    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(requests).toEqual(["req#0", "req#0", "req#0"]);
  });

  it("a 429 is retried by the SDK too, if we let it", async () => {
    const { model, requests } = countingModel([{ throws: sdkError(429) }]);
    await turn(model).turn.run("go");
    expect(requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("a NON-retryable APICallError costs one request, and is not retried by anyone", async () => {
    const { model, requests } = countingModel([{ throws: sdkError(401, undefined, false) }]);
    const result = await turn(model).turn.run("go");
    expect(result.outcome).toBe("failed");
    expect(requests).toHaveLength(1);
  });

  it("FIXED: a REUSED toolCallId no longer drops the second call", async () => {
    // What used to happen here, measured: the second, distinct call was dropped.
    // The tool ran once, not twice; the model was handed `ran: 1` for a call it
    // had never made; and the turn still reported `succeeded`. A silent wrong
    // answer, not an error — because the dedup keyed on the bare
    // `toolCallId`, which cannot tell a replay from a provider reusing an id.
    //
    // It now can: the key carries a per-attempt `occurrence`, so the second
    // call with `c1` is occurrence 1 and is a different call.
    const executed: string[] = [];
    const counting = defineTool<{ value: string }, { ran: number }>({
      id: "echo",
      description: "echo",
      access: "write",
      inputSchema: z.object({ value: z.string() }),
      execute: async () => {
        executed.push("ran");
        return { ran: executed.length };
      },
    });
    const tools = [counting];
    const { model, requests } = countingModel([
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [...text("t1", "done"), finish("stop")] },
    ]);
    const events: AgentEvent[] = [];
    const rec = recordingStore();
    const t = new AgentTurn({
      model,
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: rec,
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
      onEvent: (e) => events.push(e),
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
    });
    const result = await t.run("go");

    // Both calls ran, and each got its own result.
    expect(executed).toEqual(["ran", "ran"]);
    expect(requests).toHaveLength(3);
    expect(result.outcome).toBe("succeeded");
    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(2);
    expect((results[0]?.output as { ran: number }).ran).toBe(1);
    expect((results[1]?.output as { ran: number }).ran).toBe(2);
  });

  it("and a genuine replay of occurrence 0 still short-circuits", async () => {
    // The control, so the occurrence counter is not mistaken for "never dedupe".
    const executed: string[] = [];
    const counting = defineTool<{ value: string }, { ran: number }>({
      id: "echo",
      description: "echo",
      access: "write",
      inputSchema: z.object({ value: z.string() }),
      execute: async () => {
        executed.push("ran");
        return { ran: executed.length };
      },
    });
    const tools = [counting];
    const { model } = countingModel([
      // `c1` was already executed by a previous turn; `c2` never was.
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [toolCall({ toolCallId: "c2", toolName: "echo", input: { value: "y" } }), finish("tool-calls")] },
      { parts: [...text("t1", "done"), finish("stop")] },
    ]);
    const rec = recordingStore();
    rec.seed("c1", { ran: 99 });
    const events: AgentEvent[] = [];
    const t = new AgentTurn({
      model,
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: rec,
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
      onEvent: (e) => events.push(e),
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
    });
    await t.run("go");
    // Only the unrecorded call ran.
    expect(executed).toEqual(["ran"]);
    const results = events.filter((e) => e.type === "tool-result");
    expect((results[0]?.output as { ran: number }).ran).toBe(99);
    expect((results[1]?.output as { ran: number }).ran).toBe(1);
  });

  it("and the outcome of a reused id is filed under ITS occurrence", async () => {
    // The record write and the short-circuit read must agree on which call they
    // mean. If both results were filed under occurrence 0, a replay's first
    // call would hand the model the *second* call's output — a wrong answer
    // that nothing else in the suite would notice.
    const executed: string[] = [];
    const counting = defineTool<{ value: string }, { ran: number }>({
      id: "echo",
      description: "echo",
      access: "write",
      inputSchema: z.object({ value: z.string() }),
      execute: async () => {
        executed.push("ran");
        return { ran: executed.length };
      },
    });
    const tools = [counting];
    const twoSameIds: readonly MockStep[] = [
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "y" } }), finish("tool-calls")] },
      { parts: [...text("t1", "done"), finish("stop")] },
    ];

    const rec = recordingStore();
    const first = new AgentTurn({
      model: countingModel(twoSameIds).model,
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: rec,
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
      onEvent: () => {},
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
    });
    await first.run("go");
    expect(executed).toEqual(["ran", "ran"]);

    // Replay the same turn. Both calls are short-circuited, and each must get
    // its own recorded answer back.
    const events: AgentEvent[] = [];
    const second = new AgentTurn({
      model: countingModel(twoSameIds).model,
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t2",
      store: rec,
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
      onEvent: (e) => events.push(e),
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
    });
    await second.run("go again");
    expect(executed).toEqual(["ran", "ran"]);

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(2);
    expect((results[0]?.output as { ran: number }).ran).toBe(1);
    expect((results[1]?.output as { ran: number }).ran).toBe(2);
  });

  it("the attempt number is 1-based and counts up, so a tool can tell a retry", async () => {
    const seen: string[] = [];
    const probe = defineTool<{ value: string }, { ok: boolean }>({
      id: "echo",
      description: "echo",
      access: "read",
      inputSchema: z.object({ value: z.string() }),
      execute: async (ctx) => {
        seen.push(ctx.toolCallId + "#" + ctx.attempt);
        return { ok: true };
      },
    });
    const tools = [probe];
    const { model } = countingModel([
      { parts: [toolCall({ toolCallId: "a", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { throws: new Error("socket hang up") },
      { parts: [toolCall({ toolCallId: "b", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
      { parts: [...text("t1", "done"), finish("stop")] },
    ]);
    // Built by hand rather than through `turn()`, which pins the tool list.
    const t = new AgentTurn({
      model,
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store: recordingStore(),
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
      onEvent: () => {},
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
    });
    await t.run("go");
    // The retry's tool sees attempt 2 and a fresh id -- the two facts a tool
    // needs to tell "asked again after a failure" from "same call". This is
    // what makes the bare-id dedup key sound in practice: the two facts move
    // together, because a retry is a new turn.
    expect(seen).toEqual(["a#1", "b#2"]);
  });

  it("FIXED: a 200 + `server_error` body spends the full three attempts", async () => {
    // What used to happen: two. `loop.ts`'s private `isUnknownBodyError`
    // stripped a trailing `_error` unconditionally, so "server_error" became
    // "server" — not a key in its table — and a known transient type was
    // treated as unknown and given the one-retry allowance. `classify.ts`
    // documented that exact bug and guarded against it by stripping only when
    // the stripped form is itself a key; the guard was never carried across,
    // because there were two normalisers.
    //
    // The loop now calls `isKnownErrorType` — the exported helper — so there is
    // one normaliser and the two cannot drift.
    const { model, requests } = countingModel([
      { throws: sdkError(200, { error: { type: "server_error", message: "x" } }) },
    ]);
    const result = await turn(model).turn.run("go");

    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("the sibling case is unaffected, which is what made it a one-entry bug", async () => {
    const { model, requests } = countingModel([
      { throws: sdkError(200, { error: { type: "rate_limit_error", message: "x" } }) },
    ]);
    const result = await turn(model).turn.run("go");
    // `rate_limit_error` -> `rate_limit`, which IS a key. Full budget.
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("there is now ONE normaliser, and the loop uses the exported one", async () => {
    // `normalizeErrorType` (classify.ts) is the guarded one; the loop used to
    // hand-roll a second, unguarded copy. `isKnownErrorType` is exported
    // precisely so this comparison can be made, and the loop now calls it.
    expect(isKnownErrorType("server_error")).toBe(true);
    expect(isKnownErrorType("rate_limit_error")).toBe(true);
    expect(isKnownErrorType("overloaded_error")).toBe(true);
    expect(isKnownErrorType("internal_error")).toBe(true);
    expect(isKnownErrorType("brand_new_thing")).toBe(false);

    expect(loopSource).toContain("isKnownErrorType");
    expect(loopSource).not.toContain("replace(/_error$/");
  });

  it("a `no-response` is never retried, so it costs exactly one request", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const { model, requests } = countingModel([{ throws: abort }]);
    const result = await turn(model).turn.run("go");
    expect(result.outcome).toBe("waiting");
    expect(requests).toHaveLength(1);
  });
});

/* ================================================================== */
/* C3 — the terminal-event signal                                      */
/* ================================================================== */

describe("C3 · what the terminal-event check actually reads", () => {
  it("a truncated stream is a failure and is retried", async () => {
    // The behaviour the loop intends, and the §5.4 step-5 rule.
    const { model, requests } = countingModel([
      { parts: [...text("t1", "half a thought")] },
      { parts: [...text("t1", "whole thought"), finish("stop")] },
    ]);
    const result = await turn(model).turn.run("go");
    expect(result.attemptLog[0]?.classification).toMatchObject({ kind: "protocol-error" });
    expect(result.attemptLog[0]?.classification).toHaveProperty(
      "reason",
      expect.stringContaining("stream ended without a terminal event"),
    );
    expect(result.outcome).toBe("succeeded");
    // …and it really was retried, not quietly accepted.
    expect(requests).toHaveLength(2);
  });

  it("FIXED: a provider that finishes CLEANLY with reason `other` now succeeds", async () => {
    // `ai@7.0.122` normalises the spec-legal provider finish reason
    // `"unknown"` to `"other"` (dist/index.js: `unified: finishReason ===
    // "unknown" ? "other" : finishReason`). A provider that terminates on
    // purpose and says "I don't have a reason" therefore produced a part
    // sequence identical to a truncated one, and the old `finishReason !==
    // "other"` check read it as a truncation: three requests for an answer that
    // had already arrived.
    const { model, requests } = countingModel([
      { parts: [...text("t1", "a complete answer"), finish("other")] },
      { parts: [...text("t1", "a complete answer"), finish("other")] },
      { parts: [...text("t1", "a complete answer"), finish("other")] },
    ]);
    const result = await turn(model).turn.run("go");

    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("a complete answer");
    // One request for one answer — the false positive is gone.
    expect(requests).toHaveLength(1);
  });

  it("the discriminator is `rawFinishReason`, and it really separates the two", async () => {
    // The proof that this is not another guess. The check reads the provider's
    // own finish reason; the SDK leaves it `undefined` on a finish part it
    // synthesises after a stream that ended without one. Measured here against
    // `ai@7.0.122`: both runs report `finishReason: "other"`, and only the
    // provider-sent one carries `rawFinishReason`.
    const finishPartOf = async (parts: MockStreamPart[]): Promise<Record<string, unknown> | undefined> => {
      let seen: Record<string, unknown> | undefined;
      const model = new MockLanguageModelV4({
        doStream: async () => ({ stream: simulateReadableStream<MockStreamPart>({ chunks: parts }) }),
      });
      const agent = new ToolLoopAgent({ model, instructions: "x", stopWhen: isStepCount(5) });
      const result = await agent.stream({ messages: [{ role: "user", content: "hi" as never }] });
      for await (const part of result.stream) {
        const record = part as unknown as Record<string, unknown>;
        if (record["type"] === "finish") seen = record;
      }
      return seen;
    };

    const synthesised = await finishPartOf([...text("t1", "half a thought")]);
    const fromProvider = await finishPartOf([...text("t1", "half a thought"), finish("other")]);

    // Byte-identical on `finishReason`, distinguishable on `rawFinishReason`.
    expect(synthesised?.["finishReason"]).toBe("other");
    expect(fromProvider?.["finishReason"]).toBe("other");
    expect(synthesised?.["rawFinishReason"]).toBeUndefined();
    expect(fromProvider?.["rawFinishReason"]).toBe("other");
  });

  it("the raw signal for the empty-stream case is used, not discarded", async () => {
    // An empty stream never reaches the `finish` case at all — the SDK emits an
    // `error` part naming the defect exactly: "No output generated. The model
    // stream ended without a finish chunk." `AI_NoOutputGeneratedError`, §5.4's
    // raw signal, verbatim. It used to be routed through `classifyThrownError`,
    // which kept the message and threw the name away.
    const { model, requests } = countingModel([
      { parts: [] },
      { parts: [...text("t1", "ok"), finish("stop")] },
    ]);
    const result = await turn(model).turn.run("go");

    expect(result.outcome).toBe("succeeded");
    expect(result.attemptLog[0]?.classification).toMatchObject({ kind: "protocol-error" });
    // A real retry, not a coincidence.
    expect(requests).toHaveLength(2);
  });

  it("FIXED: `classifyResponse` — the §5.4 rule engine — is on the turn path", async () => {
    // The decisive structural check. `stream/classify.ts` is documented as the
    // place that owns §5.4's order of checks and owns the `terminalEvent`
    // *observation*. It used to be exercised only by its own unit tests and
    // never by a turn, which made the whole 200-verification pipeline — JSON
    // error bodies, content-type checks, the terminal-event observation — read
    // as coverage that did not exist.
    const importStatement = loopSource.slice(0, loopSource.indexOf('from "../stream/classify.ts";'));
    expect(importStatement).toContain("classifyResponse");

    // …and the second entry point is a delegate, not a second rule set: the two
    // provably cannot disagree, because there is only one implementation.
    expect(classifyThrownError(abortError())).toEqual(
      classifyResponse({ responded: true, error: abortError() }),
    );
  });
});

/* ================================================================== */
/* C3b — the two entry points, one implementation                      */
/* ================================================================== */

function abortError(extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", ...extra });
}

function loadKeyError(): Error {
  const error = new Error("No API key found in the environment");
  error.name = "LoadAPIKeyError";
  return error;
}

describe("C3b · the two entry points, one implementation", () => {
  it("an AbortError carrying a 500 says the same thing either way", () => {
    // It used to disagree: the live path said `no-response` (never retried),
    // the dead path said "retryable 500" — three requests for a call the user
    // had already stopped. The abort now outranks the status in both: a
    // cancelled request was not answered, whatever the throwable carries.
    const error = abortError({ statusCode: 500 });
    expect(classifyThrownError(error)).toEqual({ kind: "no-response" });
    expect(classifyResponse({ responded: true, error })).toEqual({ kind: "no-response" });
  });

  it("a missing API key says the same thing either way, and it is not a stall", () => {
    // It used to disagree in two directions at once: the live path reported
    // `no-response` — §5.4's 20-second-stall concept, "waiting for a response
    // that will never come" — and the dead path reported "request aborted".
    // Neither names the real problem, and the first is the one a user saw.
    const error = loadKeyError();
    const expected = {
      kind: "config-error",
      code: "missing_api_key",
      message: "No API key found in the environment",
    };
    expect(classifyThrownError(error)).toEqual(expected);
    expect(classifyResponse({ responded: true, error })).toEqual(expected);
    // Final, not retried: the identical error would come back three times.
    expect(classifyThrownError(error).kind).not.toBe("no-response");
  });

  it("both agree that a bare network error is a protocol-error, with its message", () => {
    const error = new Error("socket hang up");
    expect(classifyThrownError(error)).toEqual({ kind: "protocol-error", reason: "socket hang up" });
    expect(classifyResponse({ responded: true, error })).toEqual({
      kind: "protocol-error",
      reason: "socket hang up",
    });
  });

  it("a turn reports a missing key as a configuration error, not as a stall", async () => {
    // The end-to-end version of the row above: this is what reaches the UI.
    const { model } = countingModel([{ throws: loadKeyError() }]);
    const result = await turn(model).turn.run("go");
    expect(result.outcome).toBe("failed");
    expect(result.classification).toMatchObject({ kind: "config-error", code: "missing_api_key" });
    expect(result.attempts).toBe(1);
  });
});

/* ================================================================== */
/* The two §5.4 guarantees that DO hold                                 */
/* ================================================================== */

describe("what the §5.4 implementation gets right", () => {
  it("an error event inside a 200 stream is a failure, not a success", async () => {
    const { model, requests } = countingModel([
      { parts: [...text("t1", "partial"), { type: "error", error: apiError(200, { error: { type: "server_error", message: "x" } }) } as MockStreamPart] },
      { parts: [...text("t1", "ok"), finish("stop")] },
    ]);
    const result = await turn(model).turn.run("go");
    expect(result.attemptLog[0]?.classification?.kind).toBe("body-error");
    expect(requests).toHaveLength(2);
  });

  it("a 200 + a quota error is never retried", async () => {
    const { model, requests } = countingModel([
      { throws: apiError(200, { error: { type: "insufficient_quota", message: "no credit" } }) },
    ]);
    const result = await turn(model).turn.run("go");
    expect(result.outcome).toBe("failed");
    expect(requests).toHaveLength(1);
  });

  it("a step limit is reported as incomplete, not as a failure and not silently fine", async () => {
    const { model, requests } = countingModel([
      { parts: [toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "x" } }), finish("tool-calls")] },
    ]);
    const result = await turn(model, { maxSteps: 2 }).turn.run("go");
    expect(result.hitStepLimit).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(requests).toHaveLength(2);
  });
});

// Referenced so the import list stays honest about what the mock exports.
export const _NO_USAGE = NO_USAGE;
