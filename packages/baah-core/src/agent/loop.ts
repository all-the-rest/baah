/**
 * The turn runner.
 *
 * ## The loop is the SDK's, not ours
 *
 * Plan.md §5.1 and §14.4 are unambiguous: `ToolLoopAgent` + `DirectChatTransport`
 * run the whole multi-step tool-calling loop **in the browser process**, and we
 * build the drum around it — permissions, persistence, retry, the transcript.
 * There is no hand-rolled `while` around a model call here; a hand-rolled one
 * would have to re-implement approval pausing, tool-input repair and usage
 * accounting before it was worth anything.
 *
 * ## Why the transport is driven directly
 *
 * `AbstractChat` is the right base for `useChat`, but it pushes changes through
 * a React state holder and its base class exposes no subscription API — a core
 * engine that must run headless (and in a worker) would depend on React to see
 * a text delta. So this calls `DirectChatTransport.sendMessages` and consumes
 * the result with `readUIMessageStream`, which is the same public surface
 * `useChat` sits on, minus the renderer. The approval pause/resume is then
 * expressed in terms of `UIMessage[]` — which is the storage contract anyway
 * (AGENTS.md §3.1: `UIMessage[]` is the source of truth, not `ModelMessage[]`).
 *
 * ## v7 names only (AGENTS.md §3.1)
 *
 * `instructions`, `onStepEnd`, `onEnd`, `isStepCount`, `telemetry`,
 * `toolApproval`, `addToolOutput`, `stream`. The v6 spellings still exist as
 * deprecated aliases in `ai@7.0.122` — verified in `dist/index.d.ts`, which
 * marks each of them `@deprecated` — and none is used here.
 *
 * ## A `200` is not a success (Plan.md §5.4)
 *
 * Retry is driven by `stream/classify.ts`, not by "did it throw?". Two rules
 * that are easy to get wrong and are therefore load-bearing below:
 *
 * - a stream that ends **without a terminal event** is a failure, and
 * - a **retry never continues the failed attempt**: the partial text stays in
 *   the transcript marked `interrupted`, and the next attempt starts from the
 *   original prompt. Copying partial text forward would show the user text the
 *   model never finished and would make the failure undiagnosable.
 *
 * ## Nothing here writes to the console
 *
 * AGENTS.md §5: everything the user must see becomes a typed event. A provider
 * error that only reached `console.error` would be invisible in the product.
 *
 * ## Storage is injected, not imported
 *
 * `@all-the.rest/baah-storage` is a sibling, not a dependency of this package,
 * and AGENTS.md §4 forbids a pointer back. The engine talks to a narrow
 * {@link TurnStore} — six methods, all of which `StorageDatabase` already
 * implements (Plan.md §16.1).
 */

import {
  ToolLoopAgent,
  convertToModelMessages,
  isStepCount,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { classifyThrownError, type Classification } from "../stream/classify.ts";
import { MAX_ATTEMPTS, nextDelayMs, remainingAttempts } from "../stream/backoff.ts";
import type { ApprovalResolver } from "./approval.ts";
import { createToolSet, type AiToolSet, type AnyToolDefinition } from "./tools.ts";
import type { ApprovalDecision, ApprovalRequest, ToolProgress } from "../tool.ts";
import type { Workspace } from "../workspace.ts";

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * Everything the user must see, as data.
 *
 * The `attempt` number is on the failure and the start events rather than being
 * inferred, because Plan.md §5.4 insists the attempts are visible: a silent
 * retry is unhelpful precisely when the failure is hard to diagnose.
 */
export type AgentEvent =
  | { type: "attempt-started"; attempt: number; total: number; retryAfterMs: number }
  | { type: "text-delta"; text: string; messageId: string }
  | { type: "reasoning-delta"; text: string; messageId: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; error: string }
  /** The model was refused; it reads the refusal and can route around it. */
  | { type: "tool-output-denied"; toolCallId: string; toolName: string; reason: string | undefined }
  | { type: "approval-requested"; approvalId: string; toolCallId: string; toolName: string; reason: string | undefined }
  | { type: "approval-answered"; approvalId: string; approved: boolean }
  /** A step finished — the checkpoint point (AGENTS.md §3.1, `onStepEnd`). */
  | { type: "step-end"; stepNumber: number; text: string; toolCallCount: number; finishReason: string }
  | { type: "attempt-failed"; attempt: number; classification: Classification }
  /** 20 s of silence: a waiting state plus a manual action, never a retry. */
  | { type: "waiting"; reason: string; retryAfterMs: number }
  | { type: "turn-finished"; outcome: TurnOutcome; attempts: number }
  | { type: "error"; error: unknown; classification: Classification };

export type TurnOutcome = "succeeded" | "failed" | "interrupted" | "waiting" | "awaiting-approval";

export interface OpenApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  reason: string | undefined;
}

export interface AttemptRecord {
  attempt: number;
  /** The partial text of that attempt. Kept, never merged forward. */
  text: string;
  /** `true` when the attempt did not succeed. */
  interrupted: boolean;
  classification: Classification | undefined;
}

export interface TurnResult {
  outcome: TurnOutcome;
  attempts: number;
  /** Text of the successful attempt only; a failed attempt's text is not merged. */
  text: string;
  classification: Classification | undefined;
  /** Every attempt, for the transcript's `interrupted` entries. */
  attemptLog: readonly AttemptRecord[];
  openApprovals: readonly OpenApproval[];
  /** The full transcript after the turn, the storage truth (AGENTS.md §3.1). */
  messages: readonly UIMessage[];
  /**
   * The loop stopped because it hit `maxSteps`, not because the model was done.
   *
   * A legitimate termination per Plan.md §5.1 ("bis keine Tool-Calls mehr kommen
   * oder Step-Limit erreicht"), but the answer is **incomplete** — so the UI
   * has to say so rather than present a half-finished turn as finished. Kept
   * separate from `outcome` because it is not a failure and must not be
   * retried.
   */
  hitStepLimit: boolean;
}

/* ------------------------------------------------------------------ */
/* The narrow storage seam                                             */
/* ------------------------------------------------------------------ */

/**
 * The persistence operations a turn needs.
 *
 * Every one of these already exists on `StorageDatabase` (Plan.md §16.1). The
 * engine does not know that, and must not.
 */
export interface TurnStore {
  /** Idempotent over `deltaId`; this is what makes a retry safe. */
  flushDelta(input: {
    deltaId: string;
    partId: string;
    messageId: string;
    sessionId: string;
    contentText: string;
  }): Promise<void>;
  /** The turn outcome is an `idle` message (Plan.md §6.2) — not a table. */
  finishTurn(input: {
    turnId: string;
    sessionId: string;
    outcome: "succeeded" | "failed" | "interrupted";
    error: string | undefined;
  }): Promise<void>;
  /** Renews `heartbeat_at`; a stale heartbeat is the reload anchor (§6.1). */
  heartbeat(input: { turnId: string; at: string }): Promise<void>;
  /** Records that a `toolCallId` ran, so a replay short-circuits it. */
  recordToolCall(input: { toolCallId: string; toolName: string; output: unknown }): Promise<void>;
  /**
   * The recorded output of an already-executed `toolCallId`, or `undefined` if
   * it has never run.
   */
  getToolCall(toolCallId: string): Promise<{ output: unknown } | undefined>;
  /**
   * Mark a `toolCallId` as **about to run** (Plan.md §14.4, AGENTS.md §3.1).
   *
   * Written before the tool executes, not after. Afterwards would only record
   * "ran successfully", which leaves a crash in between indistinguishable from
   * "never ran" — and a tool that re-runs in that window writes twice, asks
   * twice, or (for `todo`) overwrites a newer list with a stale one while
   * reporting a change that never happened.
   */
  beginToolCall(input: { toolCallId: string; toolName: string; input: unknown }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface AgentLoopOptions {
  model: LanguageModel;
  /** System prompt. `instructions`, never `system` (AGENTS.md §3.1). */
  instructions: string;
  tools: readonly AnyToolDefinition[];
  workspace: Workspace;
  cwd: string;
  sessionId: string;
  turnId: string;
  store: TurnStore;
  approval: ApprovalResolver;
  /**
   * The in-tool permission decision point (Plan.md §4.2). Only tools whose
   * `access` is not `read` reach it; `read` runs free.
   */
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  onEvent: (event: AgentEvent) => void;
  onProgress?: (progress: ToolProgress) => void;
  /** Stop condition. Defaults to 20, the SDK's own default. */
  maxSteps?: number;
  /**
   * Stall window before a response counts as "no response" (Plan.md §5.4).
   * 20 s — the provider may still be generating, so this is never retried.
   */
  stallTimeoutMs?: number;
  /** Injected for deterministic tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** A caller-supplied signal; combined with {@link AgentTurn.stop}. */
  abortSignal?: AbortSignal;
  /** Restored transcript. `UIMessage[]` is the storage truth (AGENTS.md §3.1). */
  messages?: readonly UIMessage[];
  chatId?: string;
}

const DEFAULT_MAX_STEPS = 20;
/** Plan.md §5.4: 20 s of silence is a waiting state, not a retry. */
export const DEFAULT_STALL_TIMEOUT_MS = 20_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* The runner                                                          */
/* ------------------------------------------------------------------ */

type AttemptObservation =
  | { kind: "success"; text: string; messages: UIMessage[]; hitStepLimit: boolean }
  | {
      kind: "awaiting-approval";
      text: string;
      messages: UIMessage[];
      openApprovals: OpenApproval[];
      hitStepLimit: boolean;
    }
  | { kind: "aborted"; text: string; messages: UIMessage[]; hitStepLimit: boolean }
  | {
      kind: "failed";
      text: string;
      messages: UIMessage[];
      classification: Classification;
      error: unknown;
      hitStepLimit: boolean;
    };

/**
 * One turn: send a prompt, stream, run tools, checkpoint per step, and retry a
 * *retryable* provider failure up to three attempts (Plan.md §5.4).
 *
 * The retry re-runs the whole turn from the original prompt. It cannot continue
 * the previous stream — `DirectChatTransport.reconnectToStream()` always returns
 * `null` (§14.4) — so the failed attempt is kept in the transcript, marked
 * `interrupted`, and never becomes input to the next one.
 */
export class AgentTurn {
  readonly #options: AgentLoopOptions;
  readonly #emit: (event: AgentEvent) => void;
  readonly #controller = new AbortController();
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  /**
   * The transcript as of the last attempt.
   *
   * {@link respondToApproval} needs it because the caller does not have to be
   * holding a `TurnResult` in order to answer a card — the UI answers by
   * `approvalId` alone. Kept in sync at the end of every attempt.
   */
  #transcript: UIMessage[] = [];
  #stopped = false;

  constructor(options: AgentLoopOptions) {
    this.#options = options;
    this.#emit = options.onEvent;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    if (options.abortSignal !== undefined) {
      if (options.abortSignal.aborted) this.#controller.abort();
      else options.abortSignal.addEventListener("abort", () => this.#controller.abort(), { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * Stop the turn.
   *
   * Real, not cosmetic: with no server in the path, aborting the signal aborts
   * the in-flight `fetch` (§14.4). Generated tokens stay.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#controller.abort();
  }

  async run(prompt: string): Promise<TurnResult> {
    const { store, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS } = this.#options;
    const attemptLog: AttemptRecord[] = [];
    const baseMessages = [...(this.#options.messages ?? [])];
    /** Retries already spent on an *unrecognised* error type (§5.4: only one). */
    let unknownErrorRetries = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.#controller.signal.aborted) break;

      const delay = attempt === 1 ? 0 : (nextDelayMs(attempt, undefined, this.#random) ?? 0);
      this.#emit({ type: "attempt-started", attempt, total: MAX_ATTEMPTS, retryAfterMs: delay });
      if (delay > 0) await this.#sleep(delay, this.#controller.signal);
      if (this.#controller.signal.aborted) break;

      // A retry always starts from the *original* transcript. This is the
      // mechanical guarantee behind "Nie wird der Teiltext eines fehlgeschlagenen
      // Versuchs in den neuen kopiert" (Plan.md §5.4).
      const observation = await this.#runAttempt(baseMessages, prompt, attempt);

      if (observation.kind === "success") {
        attemptLog.push({ attempt, text: observation.text, interrupted: false, classification: { kind: "success" } });
        this.#emit({ type: "turn-finished", outcome: "succeeded", attempts: attempt });
        await this.#finish("succeeded", undefined);
        return {
          outcome: "succeeded",
          attempts: attempt,
          text: observation.text,
          classification: { kind: "success" },
          attemptLog,
          openApprovals: [],
          messages: observation.messages,
          hitStepLimit: observation.hitStepLimit,
        };
      }

      if (observation.kind === "awaiting-approval") {
        // The SDK paused; the UI answers and the caller re-runs. Not a failure,
        // and never retried — a retry would re-ask the same question.
        attemptLog.push({
          attempt,
          text: observation.text,
          interrupted: false,
          classification: undefined,
        });
        this.#emit({ type: "turn-finished", outcome: "awaiting-approval", attempts: attempt });
        await this.#finish("interrupted", "awaiting approval");
        return {
          outcome: "awaiting-approval",
          attempts: attempt,
          text: observation.text,
          classification: undefined,
          attemptLog,
          openApprovals: observation.openApprovals,
          messages: observation.messages,
          hitStepLimit: observation.hitStepLimit,
        };
      }

      // A stop is a user action, not a provider verdict, so the aborted branch
      // comes first and carries no classification at all.
      if (observation.kind === "aborted") {
        attemptLog.push({
          attempt,
          text: observation.text,
          interrupted: true,
          classification: undefined,
        });
        this.#emit({ type: "turn-finished", outcome: "interrupted", attempts: attempt });
        await this.#finish("interrupted", "stopped");
        return {
          outcome: "interrupted",
          attempts: attempt,
          // Kept: this is what the user actually saw, and hiding it would make
          // a stop look like a crash.
          text: observation.text,
          classification: undefined,
          attemptLog,
          openApprovals: [],
          messages: observation.messages,
          hitStepLimit: observation.hitStepLimit,
        };
      }

      const classification = observation.classification;

      // Plan.md §5.4: no response at all is NOT retried. The provider may still
      // be generating; a retry would double-bill, and the stream cannot be
      // resumed. The user gets a waiting state and a manual action instead.
      if (classification.kind === "no-response") {
        attemptLog.push({ attempt, text: observation.text, interrupted: true, classification });
        this.#emit({ type: "waiting", reason: "no response within the stall window", retryAfterMs: stallTimeoutMs });
        // Deliberately no `attempt-failed` here: nothing failed. The provider
        // may still be generating, and a UI that renders this as a red error
        // would train the user to ignore the event that means a real failure.
        this.#emit({ type: "turn-finished", outcome: "waiting", attempts: attempt });
        await this.#finish("interrupted", "no response");
        return {
          outcome: "waiting",
          attempts: attempt,
          text: observation.text,
          classification,
          attemptLog,
          openApprovals: [],
          messages: observation.messages,
          hitStepLimit: observation.hitStepLimit,
        };
      }

      attemptLog.push({ attempt, text: observation.text, interrupted: true, classification });
      this.#emit({ type: "attempt-failed", attempt, classification });

      const budget = remainingAttempts(attempt);
      /**
       * An unrecognised error type gets **one** retry in total, not one per
       * decision.
       *
       * Capped per attempt it was a no-op: `min(budget, 1)` is 1 for every
       * attempt, so an unknown type quietly got the full three tries — the
       * opposite of "retry once, then hand it to the user" (§5.4). The counter
       * has to live across attempts.
       */
      const unknown = isUnknownBodyError(classification);
      const allowed = unknown ? (unknownErrorRetries < 1 ? 1 : 0) : budget;
      if (unknown && allowed > 0) unknownErrorRetries += 1;

      if (!isRetryable(classification) || allowed <= 0) {
        this.#emit({ type: "error", error: observation.error, classification });
        this.#emit({ type: "turn-finished", outcome: "failed", attempts: attempt });
        await this.#finish("failed", describe(classification));
        return {
          outcome: "failed",
          attempts: attempt,
          text: observation.text,
          classification,
          attemptLog,
          openApprovals: [],
          messages: observation.messages,
          hitStepLimit: observation.hitStepLimit,
        };
      }

      // The failed attempt stays visible, marked interrupted, with its partial
      // text — that is what makes a 200-but-broken turn diagnosable at all.
      // The failed attempt stays visible, marked interrupted, with its partial
      // text — that is what makes a 200-but-broken turn diagnosable at all.
      await this.#finish("interrupted", describe(classification));
      void store;
    }

    this.#emit({ type: "turn-finished", outcome: "interrupted", attempts: MAX_ATTEMPTS });
    await this.#finish("interrupted", "attempts exhausted");
    return {
      outcome: "interrupted",
      attempts: MAX_ATTEMPTS,
      text: "",
      classification: attemptLog.at(-1)?.classification,
      attemptLog,
      openApprovals: [],
      messages: baseMessages,
      hitStepLimit: false,
    };
  }

  /**
   * Answer an open approval and continue the paused turn.
   *
   * The SDK's own resume path is `addToolApprovalResponse` + a re-send
   * (§7.6). Expressed over `UIMessage[]` that means: mark the pending tool part
   * approved, append it, and send again. The re-send re-enters the same loop,
   * so no tool runs twice — the executed `toolCallId`s short-circuit via
   * {@link TurnStore.getToolCall}.
   */
  async respondToApproval(answer: {
    approvalId: string;
    approved: boolean;
    reason?: string;
  }): Promise<TurnResult | undefined> {
    // Built immutably rather than mutated. The `approval` field is a union
    // discriminated on `approved` (`approved?: never` while requested,
    // `approved: boolean` once answered — verified in `dist/index.d.ts`), so an
    // in-place `{ ...part.approval, approved }` does not typecheck and, if it
    // were forced, would leave a part claiming to be both.
    const source = [...this.#transcript];
    let answered = false;

    const messages = source.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (!isToolPart(part) || part.state !== "approval-requested") return part;
        if (part.approval.id !== answer.approvalId) return part;
        answered = true;
        return {
          ...part,
          state: "approval-responded",
          approval: {
            id: part.approval.id,
            approved: answer.approved,
            requestReason: part.approval.requestReason,
            ...(answer.reason === undefined ? {} : { reason: answer.reason }),
          },
        } as ToolPart;
      }),
    }));

    if (!answered) return undefined;
    this.#emit({ type: "approval-answered", approvalId: answer.approvalId, approved: answer.approved });
    return this.#continue(messages);
  }

  async #continue(messages: readonly UIMessage[]): Promise<TurnResult | undefined> {
    // No new prompt: the transport re-sends the transcript, and the SDK's
    // `lastAssistantMessageIsCompleteWithApprovalResponses` (the
    // `sendAutomaticallyWhen` condition from §7.6) sees that the pending call
    // now has its answer, so this continues the turn instead of starting one.
    const observation = await this.#runAttempt(messages, "", 1);
    if (observation.kind === "success") {
      this.#emit({ type: "turn-finished", outcome: "succeeded", attempts: 1 });
      await this.#finish("succeeded", undefined);
      return {
        outcome: "succeeded",
        attempts: 1,
        text: observation.text,
        classification: { kind: "success" },
        attemptLog: [{ attempt: 1, text: observation.text, interrupted: false, classification: { kind: "success" } }],
        openApprovals: [],
        messages: observation.messages,
        hitStepLimit: observation.hitStepLimit,
      };
    }
    if (observation.kind === "awaiting-approval") {
      return {
        outcome: "awaiting-approval",
        attempts: 1,
        text: observation.text,
        classification: undefined,
        attemptLog: [{ attempt: 1, text: observation.text, interrupted: false, classification: undefined }],
        openApprovals: observation.openApprovals,
        messages: observation.messages,
        hitStepLimit: observation.hitStepLimit,
      };
    }
    // A resume has no retry budget of its own: it is the tail of an attempt that
    // already succeeded up to the pause. A failure here ends the turn.
    const aborted = observation.kind === "aborted";
    const classification: Classification = aborted
      ? { kind: "no-response" }
      : observation.classification;
    this.#emit({ type: "attempt-failed", attempt: 1, classification });
    const outcome: TurnOutcome = aborted ? "interrupted" : "failed";
    this.#emit({ type: "turn-finished", outcome, attempts: 1 });
    await this.#finish(outcome === "interrupted" ? "interrupted" : "failed", describe(classification));
    return {
      outcome,
      attempts: 1,
      text: observation.text,
      classification,
      attemptLog: [{ attempt: 1, text: observation.text, interrupted: true, classification }],
      openApprovals: [],
      messages: observation.messages,
      hitStepLimit: observation.hitStepLimit,
    };
  }

  async #finish(outcome: "succeeded" | "failed" | "interrupted", error: string | undefined): Promise<void> {
    const { store, sessionId, turnId } = this.#options;
    // `error` is always sent, as `undefined` when there is none: with
    // `exactOptionalPropertyTypes` an omitted key is a *different* type than an
    // explicitly-undefined one, and the store declares the latter.
    await store.finishTurn({ turnId, sessionId, outcome, error });
  }

  async #runAttempt(
    messages: readonly UIMessage[],
    prompt: string,
    attempt: number,
  ): Promise<AttemptObservation> {
    const {
      store,
      turnId,
      instructions,
      tools,
      workspace,
      cwd,
      approve,
      onProgress,
      maxSteps = DEFAULT_MAX_STEPS,
    } = this.#options;
    const emit = this.#emit;

    const toolSet = createToolSet({
      tools,
      workspace,
      cwd,
      approve,
      ...(onProgress === undefined ? {} : { emit: onProgress }),
      signal: this.#controller.signal,
      // The id is minted once per call by the SDK and threaded through every
      // path: validation, the replay short-circuit, the "may have run" write,
      // and the tool context itself. A retry gets fresh ids, because a retry is
      // a new turn rather than a continuation.
      attempt,
      lookupExecutedToolCall: (toolCallId) => store.getToolCall(toolCallId),
      beginToolCall: (info) => store.beginToolCall(info),
    });

    /**
     * Observations for one attempt.
     *
     * `sawTerminalEvent` is the success signal, not "the stream ended": a
     * stream that stops without a `finish` part is a failure whatever the HTTP
     * status said (Plan.md §5.4, step 5).
     */
    let text = "";
    let reasoning = "";
    let sawTerminalEvent = false;
    let lastFinishReason: string | undefined;
    /** Steps completed so far, from `onStepEnd`. */
    let steps = 0;
    let streamError: unknown;
    const openApprovals: OpenApproval[] = [];
    const parts: UIMessage["parts"] = [];
    let currentText: { id: string; part: Extract<UIMessage["parts"][number], { type: "text" }> } | undefined;
    let currentReasoning:
      | { id: string; part: Extract<UIMessage["parts"][number], { type: "reasoning" }> }
      | undefined;
    /** toolCallId → the tool part, so a result updates the call's own part. */
    const toolParts = new Map<
      string,
      { name: string; part: Record<string, unknown> }
    >();

    const agent = new ToolLoopAgent({
      model: this.#options.model,
      instructions,
      tools: toolSet,
      stopWhen: isStepCount(maxSteps),
      // Off, explicitly: the docs treat telemetry as default-on once an
      // integration is registered, and a silent upgrade must not start sending.
      telemetry: { isEnabled: false },
      /**
       * The SDK's own retry loops, off.
       *
       * `maxRetries` **defaults to 2** (verified in `ai/dist/index.d.ts`:
       * "Maximum number of retries. Set to 0 to disable retries. Default:
       * 2"). Left on, every 5xx and 429 would be retried twice more by the SDK
       * *under its own backoff* before our classification ever saw the failure
       * — so a turn would silently make up to nine requests, six of them
       * invisible to the UI, and §5.4's "at most 3 attempts, all visible" would
       * be false.
       *
       * `streamRetries` exists on `streamText` but is **not** part of
       * `ToolLoopAgentSettings` (verified: passing it is a type error), so there
       * is no second loop to disable.
       *
       * Our schedule (0 s / 2 s / 8 s, capped at 3) is the only retry here.
       */
      maxRetries: 0,
      toolApproval: this.#options.approval,
      // Checkpoint per step, not once at the end (AGENTS.md §3.1). A turn that
      // dies in step 7 of 20 must not lose steps 1..6.
      onStepEnd: (step) => {
        steps = step.stepNumber + 1;
        emit({
          type: "step-end",
          stepNumber: step.stepNumber,
          text: step.text,
          toolCallCount: step.toolCalls.length,
          finishReason: step.finishReason,
        });
        void store.heartbeat({ turnId, at: new Date().toISOString() });
      },
    });

    /**
     * The model messages for this attempt.
     *
     * `UIMessage[]` is the storage truth (AGENTS.md §3.1) and `ModelMessage[]`
     * is computed from it per request — which is also what makes a retry a
     * clean re-send: the failed attempt's parts are never in here.
     */
    const uiMessages: UIMessage[] =
      prompt === ""
        ? [...messages]
        : [
            ...messages,
            { id: newMessageId(), role: "user", parts: [{ type: "text", text: prompt }] },
          ];
    const modelMessages = await convertToModelMessages(uiMessages, { tools: toolSet });

    const messageId = newMessageId();

    try {
      const result = await agent.stream({
        messages: modelMessages,
        abortSignal: this.#controller.signal,
      });

      for await (const part of result.stream) {
        switch (part.type) {
          case "start":
            parts.push({ type: "step-start" } as UIMessage["parts"][number]);
            break;

          case "text-start":
            currentText = {
              id: part.id,
              part: { type: "text", text: "", state: "streaming" },
            };
            parts.push(currentText.part);
            break;

          case "text-delta": {
            if (currentText?.id !== part.id) {
              // A delta without a start is a provider protocol break; ignoring
              // it silently would lose text, so it starts a fresh part.
              currentText = {
                id: part.id,
                part: { type: "text", text: "", state: "streaming" },
              };
              parts.push(currentText.part);
            }
            currentText.part.text += part.text;
            text = currentText.part.text;
            emit({ type: "text-delta", text: part.text, messageId });
            break;
          }

          case "text-end":
            if (currentText?.id === part.id) currentText.part.state = "done";
            currentText = undefined;
            break;

          case "reasoning-start":
            currentReasoning = {
              id: part.id,
              part: { type: "reasoning", id: part.id, text: "", state: "streaming" },
            };
            parts.push(currentReasoning.part);
            break;

          case "reasoning-delta":
            if (currentReasoning?.id !== part.id) {
              currentReasoning = {
                id: part.id,
                part: { type: "reasoning", id: part.id, text: "", state: "streaming" },
              };
              parts.push(currentReasoning.part);
            }
            currentReasoning.part.text += part.text;
            reasoning = currentReasoning.part.text;
            emit({ type: "reasoning-delta", text: part.text, messageId });
            break;

          case "reasoning-end":
            if (currentReasoning?.id === part.id) currentReasoning.part.state = "done";
            currentReasoning = undefined;
            break;

          case "tool-call": {
            const entry = { name: part.toolName, part: toolCallPart(part) };
            toolParts.set(part.toolCallId, entry);
            parts.push(entry.part as UIMessage["parts"][number]);
            emit({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            break;
          }

          case "tool-result": {
            const entry = toolParts.get(part.toolCallId);
            if (entry !== undefined) {
              Object.assign(entry.part, { state: "output-available", output: part.output });
            }
            emit({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            });
            // Recorded at once, not at turn end: a crash mid-turn must not lose
            // the fact that the tool ran, or a replay would run it again.
            void store.recordToolCall({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            });
            break;
          }

          case "tool-error": {
            const entry = toolParts.get(part.toolCallId);
            if (entry !== undefined) {
              Object.assign(entry.part, { state: "output-error", errorText: String(part.error) });
            }
            emit({
              type: "tool-error",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              error: String(part.error),
            });
            break;
          }

          case "tool-output-denied": {
            const entry = toolParts.get(part.toolCallId);
            if (entry !== undefined) {
              Object.assign(entry.part, { state: "output-denied" });
            }
            // A denial, not an error: the model reads the refusal and routes
            // around it instead of retrying a malfunction (§7.6).
            emit({
              type: "tool-output-denied",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              reason: undefined,
            });
            break;
          }

          case "tool-approval-request": {
            const entry: OpenApproval = {
              approvalId: part.approvalId,
              toolCallId: part.toolCall.toolCallId,
              toolName: part.toolCall.toolName,
              input: part.toolCall.input,
              reason: part.reason,
            };
            // The persisted part has to carry the pending approval, or
            // `respondToApproval` finds nothing to answer after a reload.
            const toolEntry = toolParts.get(part.toolCall.toolCallId);
            if (toolEntry !== undefined) {
              Object.assign(toolEntry.part, {
                state: part.isAutomatic === true ? "output-denied" : "approval-requested",
                approval: { id: part.approvalId, requestReason: part.reason },
              });
            }
            /**
             * `isAutomatic` marks a decision the rule engine already made
             * (`'not-applicable'`, or a `deny`). It is **not** an open
             * question: counting it as one would park the turn forever waiting
             * for a card that is never going to be shown. Verified in
             * `ToolApprovalRequestOutput.isAutomatic` (`dist/index.d.ts`).
             */
            if (part.isAutomatic === true) {
              emit({ type: "approval-answered", approvalId: part.approvalId, approved: false });
              break;
            }
            if (!openApprovals.some((open) => open.approvalId === entry.approvalId)) {
              openApprovals.push(entry);
            }
            emit({ type: "approval-requested", ...entry });
            break;
          }

          case "tool-approval-response":
            emit({
              type: "approval-answered",
              approvalId: part.approvalId,
              approved: part.approved,
            });
            break;

          case "finish":
            /**
             * The terminal-event check — with an honest caveat.
             *
             * The provider's raw `finish` part is **not observable** through
             * the SDK: when a provider stream ends without one, `streamText`
             * synthesises a `finish` itself, and the only thing that
             * distinguishes the two is the reason — measured against
             * `ai@7.0.122`: a clean run reports the provider's real reason
             * (`stop`, `tool-calls`, …), a truncated one reports `"other"`.
             *
             * So `"other"` is the observable proxy for "no terminal event",
             * and a turn that only ever produces it is classified as a
             * protocol error and retried. This is a heuristic, not the raw
             * signal §5.4 asks for; a provider that legitimately finishes with
             * reason `"other"` would be misread. Verified by measurement, and
             * the one place where the SDK's normalisation costs us fidelity.
             */
            sawTerminalEvent = part.finishReason !== "other";
            lastFinishReason = part.finishReason;
            break;

          case "abort":
            break;

          case "error":
            // The real provider error, with its `statusCode` and
            // `responseBody` intact — which the UI-message path redacts to
            // `Error: An error occurred.`, which would make §5.4's whole
            // classification impossible.
            streamError = part.error;
            break;

          default:
            break;
        }
      }
    } catch (error) {
      // A throw before or around the stream: the agent itself failed.
      streamError = error;
    }

    const assistant: UIMessage = { id: messageId, role: "assistant", parts };
    const allMessages: UIMessage[] = [...uiMessages, assistant];
    this.#transcript = allMessages;
    void reasoning;

    /**
     * The loop stopped at the step ceiling rather than because the model was
     * done. `finishReason: "tool-calls"` on the last step is the tell: the model
     * wanted another round and was not given one. Not a failure — the UI says so
     * rather than presenting a half-finished turn as finished.
     */
    const hitStepLimit = steps >= maxSteps && lastFinishReason === "tool-calls";
    const shape = { messages: allMessages, hitStepLimit };

    if (this.#stopped || this.#controller.signal.aborted) {
      return { kind: "aborted", text, ...shape };
    }

    if (openApprovals.length > 0) {
      return { kind: "awaiting-approval", text, openApprovals, ...shape };
    }

    if (streamError !== undefined) {
      return {
        kind: "failed",
        text,
        classification: classifyThrown(streamError),
        error: streamError,
        ...shape,
      };
    }

    // Step 5 of the plan's order: a stream that ends without a terminal event
    // is a failure, whatever the status line said.
    if (!sawTerminalEvent) {
      const reason =
        text === "" && parts.length === 0
          ? "no response: the stream produced nothing"
          : `stream ended without a terminal event (${text.length} chars of text, no provider finish)`;
      return {
        kind: "failed",
        text,
        classification: { kind: "protocol-error", reason },
        error: new Error(reason),
        ...shape,
      };
    }

    return { kind: "success", text, ...shape };
  }
}
/**
 * Build the persisted UI part for a tool call.
 *
 * `ToolUIPart`'s `type` is `` `tool-${NAME}` ``, so the name goes into the
 * discriminator and there is no `toolName` field to read back (verified in
 * `dist/index.d.ts`; this was a type error and a runtime `undefined` before).
 */
function toolCallPart(call: { toolCallId: string; toolName: string; input: unknown }): UIMessage["parts"][number] {
  return {
    type: `tool-${call.toolName}`,
    toolCallId: call.toolCallId,
    state: "input-available",
    input: call.input,
  } as UIMessage["parts"][number];
}

/** The union of both tool-part shapes (static `tool-<name>` and dynamic). */
type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/**
 * Is this UI part a tool invocation?
 *
 * A static tool part's `type` is `` `tool-${NAME}` `` — `tool-read`, not
 * `tool` (verified in `dist/index.d.ts`, `type ToolUIPart`) — and a dynamic one
 * is literally `dynamic-tool`. Both carry the same `UIToolInvocation` states, so
 * one guard covers them.
 */
function isToolPart(part: UIMessage["parts"][number]): part is ToolPart {
  return (
    (part.type === "dynamic-tool" || part.type.startsWith("tool-")) &&
    "toolCallId" in part &&
    "state" in part
  );
}

/** `crypto.randomUUID()` per AGENTS.md §5; falls back only where it is absent. */
function newMessageId(): string {
  const cryptoRef = globalThis.crypto;
  return typeof cryptoRef?.randomUUID === "function"
    ? cryptoRef.randomUUID()
    : `msg-${Date.now()}-${Math.trunc(performance.now() * 1000)}`;
}

function isRetryable(classification: Classification): boolean {
  switch (classification.kind) {
    case "success":
    case "no-response":
      return false;
    case "http-error":
    case "body-error":
      return classification.retryable;
    case "protocol-error":
      // "Antwort kam, unbrauchbar" — retryable by definition (§5.4).
      return true;
  }
}

const KNOWN_BODY_ERROR_TYPES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "billing",
  "credit",
  "invalid_api_key",
  "authentication",
  "permission",
  "not_found",
  "rate_limit",
  "overloaded",
  "server_error",
  "internal",
]);

/** An unrecognised error type is retried **once** (Plan.md §5.4). */
function isUnknownBodyError(classification: Classification): boolean {
  if (classification.kind !== "body-error") return false;
  const normalized = classification.code.toLowerCase().replaceAll("-", "_").replace(/_error$/, "");
  return !KNOWN_BODY_ERROR_TYPES.has(normalized);
}

function describe(classification: Classification): string {
  switch (classification.kind) {
    case "success":
      return "ok";
    case "no-response":
      return "no response within the stall window";
    case "http-error":
      return `HTTP ${classification.status}${classification.retryable ? " (retryable)" : ""}`;
    case "body-error":
      return `${classification.code}: ${classification.message}`;
    case "protocol-error":
      return classification.reason;
  }
}

/**
 * Classify a thrown or emitted provider error.
 *
 * Delegates to `stream/classify.ts`, which is the single place that knows the
 * rules. This file deliberately has **no** second copy: an earlier version had
 * one, and it disagreed — it classified an `AbortError` as a retryable protocol
 * error, so a user pressing stop was answered with three pointless retries.
 */
function classifyThrown(error: unknown): Classification {
  return classifyThrownError(error);
}

export type { ToolSet, AiToolSet, UIMessageChunk };
