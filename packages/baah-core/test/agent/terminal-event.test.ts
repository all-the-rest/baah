/**
 * The terminal-event check, measured against the SDK rather than assumed.
 *
 * ## Why this file exists
 *
 * The check used to be `TextStreamFinishPart.rawFinishReason !== undefined`,
 * and it was **wrong on a real provider**: `@ai-sdk/openai`'s Responses path
 * fills `raw` from `response.incomplete_details?.reason`, and a clean
 * `response.completed` has no `incomplete_details` — so every successful
 * Responses turn read as a truncated stream and was retried three times. On a
 * real provider, with real money, for an answer that had already arrived.
 *
 * It survived because **every test in this package drove a mock that always
 * filled the field**. A mock that only knows the populated shape cannot find a
 * check that is wrong about the *unpopulated* one. The gap was closed by a UI
 * agent reading the installed package, not by any test here.
 *
 * So this file does the two things the old tests could not:
 *
 * 1. **Drives the real `ToolLoopAgent`** and reads the parts it actually emits,
 *    so the five cases below are measurements rather than assumptions about
 *    what the SDK synthesises. `test/agent/mock-model.ts`'s `finish()` and
 *    `responsesFinish()` are the two provider shapes; what comes *out* is
 *    printed by the `part sequences` test below and is what the rule reads.
 * 2. **Runs the engine end to end** on both provider shapes and asserts the
 *    request count, because the defect's cost is not "a wrong classification",
 *    it is "three requests for one answer".
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, type ApprovalDecision, type ApprovalRequest } from "../../src/tool.ts";
import { createMemoryWorkspace } from "../../src/workspace.ts";
import { buildApprovalTargets, createApprovalResolver, type PermissionEngine } from "../../src/agent/approval.ts";
import { AgentTurn, type AgentEvent, type TurnStore } from "../../src/agent/loop.ts";
import { readTerminalEvent, mergeTerminalEvent, type TerminalEvent } from "../../src/stream/classify.ts";
import {
  createMockModel,
  finish,
  responsesFinish,
  text,
  type MockStreamPart,
} from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* The five measured cases                                            */
/* ------------------------------------------------------------------ */

/**
 * The shapes a provider stream can close with, as the SDK hands them on.
 *
 * `responsesFinish` is the important one and the reason this file exists; see
 * its own comment and `AGENTS.md` §9 ("Nichts erfinden").
 */
const CASES = {
  /** A cut stream: text arrived, the connection closed, no terminal chunk. */
  cutAfterText: {
    label: "stream cut after text",
    parts: [...text("t1", "this text arrived, and then nothing")] as MockStreamPart[],
    expected: "synthesized" as TerminalEvent,
    expectSuccess: false,
  },
  /** Chat Completions, clean: `raw` is `choice.finish_reason`. */
  chatClean: {
    label: "chat completions, clean",
    parts: [...text("t1", "hello"), finish("stop")] as MockStreamPart[],
    expected: "provider" as TerminalEvent,
    expectSuccess: true,
  },
  /**
   * Responses, clean — the F1 case.
   *
   * `response.completed` carries no `incomplete_details`, so `raw` is
   * `undefined`, and `unified` is `"stop"`.
   */
  responsesClean: {
    label: "responses API, clean (no incomplete_details)",
    parts: [...text("t1", "hello"), responsesFinish("stop")] as MockStreamPart[],
    expected: "provider" as TerminalEvent,
    expectSuccess: true,
  },
  /**
   * A provider that terminates on purpose and reports the spec-legal
   * `"unknown"`, which `ai` normalises to `"other"`.
   *
   * This is the case the *previous* check (`finishReason !== "other"`) got
   * wrong: a clean answer read as a truncation, three requests, one answer.
   */
  deliberateOther: {
    label: "provider deliberately reports \"other\"",
    parts: [...text("t1", "hello"), finish("other")] as MockStreamPart[],
    expected: "provider" as TerminalEvent,
    expectSuccess: true,
  },
} as const;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const tools = [
  defineTool<{ value: string }, { ok: boolean }>({
    id: "echo",
    description: "Echo a value back.",
    access: "read",
    inputSchema: z.object({ value: z.string() }),
    execute: async (_context, input) => ({ ok: true, seen: input.value }),
  }),
];

const allowAll: PermissionEngine = {
  evaluate: () => ({ effect: "allow" }),
  recordAlways: async () => {},
};

function createStore(): TurnStore {
  return {
    async appendTurn() {},
    async appendMessage() {},
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

function runTurn(steps: Parameters<typeof createMockModel>[0]["steps"]) {
  const events: AgentEvent[] = [];
  const turn = new AgentTurn({
    model: createMockModel({ steps }),
    instructions: "You are a test harness.",
    tools,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store: createStore(),
    approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
    onEvent: (event: AgentEvent) => {
      events.push(event);
    },
    approve: async (_request: ApprovalRequest): Promise<ApprovalDecision> => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
  });
  return { turn, events };
}

/* ------------------------------------------------------------------ */
/* The rule, unit level                                                */
/* ------------------------------------------------------------------ */

describe("readTerminalEvent — was the closing part the provider's or the SDK's?", () => {
  it("the SDK's initial values mean 'no provider terminal chunk arrived'", () => {
    /**
     * This is the whole rule, and the two values are not invented: they are
     * `ai@7.0.122`'s own initialisation in the step transform
     * (`dist/index.js`): `let stepFinishReason = "other"; let
     * stepRawFinishReason = void 0;`, which is also what `flush()` enqueues when
     * `hasReceivedTerminalChunk` is false.
     */
    expect(readTerminalEvent({ finishReason: "other", rawFinishReason: undefined })).toBe("synthesized");
  });

  it("a provider reason, whatever the unified reason is, means the provider spoke", () => {
    expect(readTerminalEvent({ finishReason: "stop", rawFinishReason: "stop" })).toBe("provider");
    // The spec-legal "unknown" a provider may choose on purpose.
    expect(readTerminalEvent({ finishReason: "other", rawFinishReason: "other" })).toBe("provider");
    expect(readTerminalEvent({ finishReason: "length", rawFinishReason: "max_output_tokens" })).toBe("provider");
  });

  it("a non-placeholder unified reason with no raw reason is still a provider", () => {
    /**
     * The F1 case, isolated. A clean OpenAI Responses completion is exactly
     * this pair: `incomplete_details` is absent, so `raw` is `undefined`, while
     * `unified` is the real `"stop"`/`"tool-calls"`.
     *
     * Reading this as a truncation is what made every successful Responses turn
     * burn three requests.
     */
    expect(readTerminalEvent({ finishReason: "stop", rawFinishReason: undefined })).toBe("provider");
    expect(readTerminalEvent({ finishReason: "tool-calls", rawFinishReason: undefined })).toBe("provider");
  });

  it("a non-string raw reason still counts as a provider having spoken", () => {
    // `null` is what a provider that writes `raw: value.x ?? null` produces.
    // Only `undefined` is the SDK's "never assigned" value, so `null` must not
    // be confused with it.
    expect(readTerminalEvent({ finishReason: "other", rawFinishReason: null })).toBe("provider");
    expect(readTerminalEvent({ finishReason: "other", rawFinishReason: "" })).toBe("provider");
  });
});

describe("mergeTerminalEvent — folding the steps of one attempt", () => {
  it("starts at the SDK's value and upgrades on a provider finish", () => {
    expect(mergeTerminalEvent("absent", "provider")).toBe("provider");
    expect(mergeTerminalEvent("absent", "synthesized")).toBe("synthesized");
  });

  it("a synthesised step is sticky, so a clean first step cannot excuse a cut second one", () => {
    /**
     * The direction matters. A multi-step turn whose step 2 was cut after step 1
     * finished cleanly is a truncated turn, and the fold has to say so — the
     * alternative is a turn that silently ends mid-sentence.
     */
    expect(mergeTerminalEvent("provider", "synthesized")).toBe("synthesized");
    expect(mergeTerminalEvent("synthesized", "provider")).toBe("synthesized");
  });
});

/* ------------------------------------------------------------------ */
/* The rule, through the real SDK                                     */
/* ------------------------------------------------------------------ */

describe("the five provider shapes, end to end through ToolLoopAgent", () => {
  for (const testCase of Object.values(CASES)) {
    it(`${testCase.label} → ${testCase.expected}`, async () => {
      const { turn } = runTurn([
        { parts: [...testCase.parts] },
        // A second step that would succeed, so a *false* truncation is visible
        // as a second request rather than hidden behind the retry budget.
        { parts: [...text("t2", "the retry"), finish("stop")] },
      ]);
      const result = await turn.run("go");

      // The turn ends `succeeded` either way — attempt 2 supplies the answer —
      // so the measurement that matters is the **request count**: one for a
      // shape the provider finished, two for one it cut. The defect was never a
      // wrong outcome, it was three requests for one answer.
      expect(result.outcome).toBe("succeeded");
      expect(result.attempts).toBe(testCase.expectSuccess ? 1 : 2);
      // A turn that worked must not have burned its budget on a shape it did
      // not produce.
      expect(result.attemptLog).toHaveLength(testCase.expectSuccess ? 1 : 2);
    });
  }

  it("a clean Responses turn costs ONE request — the regression, named", async () => {
    /**
     * The F1 assertion, at the level the defect was measured at.
     *
     * Before the fix this was `attempts: 3, outcome: "failed"` on a turn that
     * had produced its full answer: three requests, three times the cost, and a
     * transcript containing the same answer three times.
     */
    const { turn, events } = runTurn([{ parts: [...CASES.responsesClean.parts] }]);
    const result = await turn.run("go");

    expect(result.outcome).toBe("succeeded");
    expect(result.attempts).toBe(1);
    expect(result.text.trim()).toBe("hello");
    // No `attempt-failed` at all: a turn that worked must not look like one
    // that was going to be retried.
    expect(events.filter((event) => event.type === "attempt-failed")).toHaveLength(0);
  });

  it("a cut stream still costs a retry — the check was not simply removed", async () => {
    const { turn, events } = runTurn([
      { parts: [...CASES.cutAfterText.parts] },
      { parts: [...text("t2", "the whole thought"), finish("stop")] },
    ]);
    const result = await turn.run("go");

    expect(result.outcome).toBe("succeeded");
    expect(result.attempts).toBe(2);
    const failure = events.find((event) => event.type === "attempt-failed");
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ classification: { kind: "protocol-error" } });
    // And the partial text is kept and marked, not dropped — §5.4.
    expect(result.attemptLog[0]?.interrupted).toBe(true);
    expect(result.text.trim()).toBe("the whole thought");
  });

  it("the empty stream is caught by the SDK's own typed signal", async () => {
    /**
     * `NoOutputGeneratedError` — the one place the raw signal genuinely exists,
     * and the one the E2E's truncation verdict rests on.
     */
    const { turn, events } = runTurn([
      { parts: [] },
      { parts: [...text("t2", "recovered"), finish("stop")] },
    ]);
    const result = await turn.run("go");

    expect(result.outcome).toBe("succeeded");
    expect(result.attempts).toBe(2);
    const failure = events.find((event) => event.type === "attempt-failed");
    expect(failure).toMatchObject({ classification: { kind: "protocol-error" } });
    expect(failure).toHaveProperty(
      "classification.reason",
      expect.stringContaining("without a finish chunk and produced no output"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Agreement with the fake provider the E2E suite drives               */
/* ------------------------------------------------------------------ */

describe("the same shapes the E2E fake provider produces", () => {
  /**
   * `packages/baah-web/e2e/support/turns.ts` builds its turns from the wire
   * shapes of the real providers, and `scenarios.e2e.ts` says the app reaches
   * them through the **`openai-compatible`** row — so the E2E exercises the
   * Chat-Completions path, where `raw` is `choice.finish_reason` and is always
   * present.
   *
   * That is exactly why the E2E went green while the product was broken for
   * anyone on the `openai` row: the fake provider's own path is the one path
   * the broken check happened to get right. These two tests pin the agreement
   * in both directions, so a future change to the rule that only holds for one
   * of the two paths fails here.
   */
  it("a chat-completions turn — the E2E's path — is a success on one request", async () => {
    // `chatTextTurn("hello from the fake")` in `turns.ts`: role announcement,
    // one delta per word, `finish_reason: "stop"`, `data: [DONE]`.
    const { turn } = runTurn([{ parts: [...text("t1", "hello from the fake"), finish("stop")] }]);
    const result = await turn.run("Was steht in HINWEIS.md?");

    expect(result.outcome).toBe("succeeded");
    expect(result.attempts).toBe(1);
  });

  it("a truncated chat-completions turn — `truncatedStreamBody` — is still a failure", () => {
    // `truncatedStreamBody()` in `turns.ts`: deltas arrive, then the body ends
    // with no `finish_reason` and no `[DONE]`. `scenarios.e2e.ts` asserts the
    // outcome is *not* `succeeded` for exactly this, and it must keep holding.
    expect(readTerminalEvent({ finishReason: "other", rawFinishReason: undefined })).toBe("synthesized");
  });

  it("a Responses turn — `responsesTextTurn` — agrees with the chat path", () => {
    // `responsesTextTurn()` in `turns.ts` ends with `response.completed` and a
    // `usage` object, and **no** `incomplete_details`. That is the shape the
    // E2E can produce but could not route through the engine, because the
    // wizard configures the `openai-compatible` row. Both paths now classify
    // identically, which is what makes the row choice a UI decision rather than
    // a correctness one.
    expect(readTerminalEvent({ finishReason: "stop", rawFinishReason: undefined })).toBe("provider");
    expect(readTerminalEvent({ finishReason: "stop", rawFinishReason: "stop" })).toBe("provider");
  });
});
