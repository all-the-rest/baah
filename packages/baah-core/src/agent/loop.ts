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
 * Retry is driven by `stream/classify.ts` — `classifyResponse` is called for
 * every failed turn, with the facts that turn observed, so the JSON-error-body
 * check, the content-type check and the `sawTerminalEvent` observation are
 * exercised by real turns and not only by their own unit tests. Two rules that
 * are easy to get wrong and are therefore load-bearing below:
 *
 * - a stream that ends **without a provider finish chunk** is a failure, and
 * - a **retry never continues the failed attempt**: the partial text stays in
 *   the transcript marked `interrupted`, and the next attempt starts from the
 *   original prompt. Copying partial text forward would show the user text the
 *   model never finished and would make the failure undiagnosable.
 *
 * The terminal-event check reads `rawFinishReason`, the provider's own value.
 * What is *not* reachable at this layer — the raw SSE chunk stream — is stated
 * where the check is used rather than approximated, because approximating it is
 * exactly what made the previous check fire on correct answers.
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

import { classifyResponse, isKnownErrorType, type Classification } from "../stream/classify.ts";
import { MAX_ATTEMPTS, nextDelayMs, remainingAttempts } from "../stream/backoff.ts";
import type { ApprovalResolver } from "./approval.ts";
import {
  createToolSet,
  type AiToolSet,
  type AnyToolDefinition,
  type ToolCallKey,
  type ToolCallRecord,
} from "./tools.ts";
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
  /**
   * A call began and never reported an outcome — the tab died in between, or
   * the process was killed.
   *
   * Its own event because neither of the two available responses is honest on
   * its own. Re-running risks a second side effect on the user's files
   * (corruption, which the model cannot undo); skipping silently would hand the
   * model a result for work that may never have happened. The engine does
   * neither: it surfaces the gap, and the model is told to verify rather than
   * repeat. See the residual-risk note where the short-circuit lives.
   */
  | { type: "tool-outcome-unknown"; toolCallId: string; toolName: string; input: unknown }
  | { type: "approval-requested"; approvalId: string; toolCallId: string; toolName: string; reason: string | undefined }
  | { type: "approval-answered"; approvalId: string; approved: boolean }
  /** A step finished — the checkpoint point (AGENTS.md §3.1, `onStepEnd`). */
  | { type: "step-end"; stepNumber: number; text: string; toolCallCount: number; finishReason: string }
  | { type: "attempt-failed"; attempt: number; classification: Classification }
  /** 20 s of silence: a waiting state plus a manual action, never a retry. */
  | { type: "waiting"; reason: string; retryAfterMs: number }
  /**
   * The user stopped the turn.
   *
   * Separate from a stall, and separate from `attempt-failed`, because a stop is
   * a deliberate action and not a provider verdict. `turn-finished` with
   * `outcome: "interrupted"` and **no** classification is the invariant: a stall
   * always carries `no-response`, so an interrupted turn without one is a stop.
   * The event exists so a UI does not have to infer that.
   */
  | { type: "turn-stopped"; stage: "attempt" | "approval-resume" }
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
  /**
   * Tool calls that began and never reported an outcome (Plan.md §14.4).
   *
   * The engine ran none of them a second time and reported none of them as
   * failed — both would be lies the model would act on. Every one is listed so
   * the caller can put it on screen; an empty array is the common case.
   */
  unknownOutcomes: readonly UnknownToolOutcome[];
}

/** A tool call whose effect is genuinely unknown. See `AgentEvent`. */
export interface UnknownToolOutcome {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/* ------------------------------------------------------------------ */
/* The narrow storage seam                                             */
/* ------------------------------------------------------------------ */

/**
 * The persistence operations a turn needs.
 *
 * Every one of these already exists on `StorageDatabase` (Plan.md §16.1) except
 * the two marked **[W2]** — the tool-call status column and the unfinished-turn
 * read. Those are the storage wiring that lands with Wave 2; the engine owns
 * the contract and the tests own the semantics, and nothing in `src/` depends
 * on the concrete backend.
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
  /**
   * **[W2]** Unfinished turns of a session, for reload recovery.
   *
   * A turn is unfinished while it is neither `succeeded` nor `failed` — the
   * window where a reload leaves a half-written transcript behind.
   */
  listUnfinishedTurns(input: { sessionId: string }): Promise<readonly UnfinishedTurn[]>;
  /** Records that a `toolCallId` ran, so a replay short-circuits it. */
  recordToolCall(input: {
    key: ToolCallKey;
    toolName: string;
    output: unknown;
  }): Promise<void>;
  /**
   * The record of a call, or `undefined` if it has never been begun.
   *
   * **The status is the point.** It was absent, and its absence was the bug: a
   * row written by `beginToolCall` and a row written by `recordToolCall` both
   * read back as "not present", so "began, outcome unknown" was
   * *unrepresentable* and a crash in that window was indistinguishable from
   * "never ran" — which is exactly the case in which re-running corrupts the
   * user's files. `status: "done"` is the only state that short-circuits.
   */
  getToolCall(key: ToolCallKey): Promise<ToolCallRecord | undefined>;
  /**
   * Mark a call as **about to run** (Plan.md §14.4, AGENTS.md §3.1).
   *
   * Written before the tool executes, not after. Afterwards would only record
   * "ran successfully", which leaves a crash in between indistinguishable from
   * "never ran" — and a tool that re-runs in that window writes twice, asks
   * twice, or (for `todo`) overwrites a newer list with a stale one while
   * reporting a change that never happened.
   */
  beginToolCall(input: { key: ToolCallKey; toolName: string; input: unknown }): Promise<void>;
}

/** A turn that a reload may have left open (Plan.md §6.1). */
export interface UnfinishedTurn {
  turnId: string;
  /** The `heartbeat_at` value the writer last renewed. ISO-8601, per AGENTS.md §5. */
  heartbeatAt: string;
  startedAt: string;
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
   * Stall window, the length of the `waiting` state (Plan.md §5.4).
   *
   * 20 s — the provider may still be generating, so this is never retried.
   *
   * **What it does and does not do, so nobody builds on a promise:** it is the
   * duration reported in the `waiting` event and nothing more. There is no timer
   * in this loop: it cannot interrupt a `stream()` it is awaiting, so it cannot
   * *measure* a stall, and `no-response` therefore has no producer here. The
   * measurement belongs at the transport — a watchdog on the chunk arrival
   * times, which is the same place the 20 s window would have to be enforced
   * to mean anything. Recorded as a gap in Plan.md §5.4 rather than papered
   * over with a heuristic, because a stall detector that cannot observe a stall
   * is indistinguishable from no detector at all.
   */
  stallTimeoutMs?: number;
  /** Injected for deterministic tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Clock for the `heartbeat_at` anchor (Plan.md §6.1). Injected for tests. */
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

/**
 * How old a `heartbeat_at` may be before the turn it belongs to counts as dead
 * (Plan.md §6.1 calls it "der Reload-/Interrupt-Anker").
 *
 * **The boundary is `age >= 30 s` → stale.** Chosen deliberately short, and the
 * trade is worth stating because it cuts both ways:
 *
 * - Too *long* and a turn whose tab was closed mid-step keeps looking alive.
 *   Nothing ever finishes it, the transcript is left mid-sentence, and the user
 *   is never told — the silent failure Plan.md §5.4 exists to prevent.
 * - Too *short* and a genuinely working turn is declared dead by whoever runs
 *   the recovery (a second tab, or the same one after a reload). The heartbeat
 *   is renewed at **every step end** (AGENTS.md §3.1), so a healthy turn
 *   refreshes it continuously; the damage of a false positive is a turn marked
 *   `interrupted` and offered as `regenerate`, which is visible and undoable.
 *
 * 30 s sits above §5.4's 20 s stall window, so a turn that produced nothing for
 * the whole stall window is already recoverable, and far below the duration of
 * a real step (a long tool, a slow model) that must not be mistaken for death.
 */
export const STALE_HEARTBEAT_MS = 30_000;

/**
 * Milliseconds between a heartbeat and `nowMs`. Unparsable input is `Infinity`
 * rather than `0`.
 *
 * `Infinity` because "I cannot tell how old this is" must resolve to *stale*,
 * the recoverable side. Guessing `0` would read as "written just now" and keep
 * a turn whose anchor is corrupt — or from a clock that disagrees with ours —
 * looking alive forever, which is the silent direction.
 */
export function heartbeatAgeMs(heartbeatAt: string, nowMs: number): number {
  const at = Date.parse(heartbeatAt);
  if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - at);
}

/** Is this heartbeat on the stale side of {@link STALE_HEARTBEAT_MS}? */
export function isTurnStale(
  heartbeatAt: string,
  nowMs: number,
  staleAfterMs: number = STALE_HEARTBEAT_MS,
): boolean {
  return heartbeatAgeMs(heartbeatAt, nowMs) >= staleAfterMs;
}

/**
 * Close turns that a reload left open (AGENTS.md §3.1, Plan.md §6.1).
 *
 * Called once at start-up, before a new turn starts. It marks every unfinished
 * turn whose heartbeat is on the stale side of the boundary `interrupted` and
 * leaves the rest alone — a fresh heartbeat means **someone else is still
 * working on it**, and closing that would kill a live turn in another tab.
 *
 * Resume is impossible (§14.4: `reconnectToStream()` always returns `null`), so
 * the recovery is not "continue": it is "close it honestly and let `regenerate`
 * re-send", with the partial text kept.
 */
export async function recoverStaleTurns(options: {
  store: TurnStore;
  sessionId: string;
  staleAfterMs?: number;
  nowMs?: number;
}): Promise<readonly UnfinishedTurn[]> {
  const { store, sessionId } = options;
  const staleAfterMs = options.staleAfterMs ?? STALE_HEARTBEAT_MS;
  const nowMs = options.nowMs ?? Date.now();
  const unfinished = await store.listUnfinishedTurns({ sessionId });

  const recovered: UnfinishedTurn[] = [];
  for (const turn of unfinished) {
    if (!isTurnStale(turn.heartbeatAt, nowMs, staleAfterMs)) continue;
    await store.finishTurn({
      turnId: turn.turnId,
      sessionId,
      outcome: "interrupted",
      // Said out loud, because "interrupted" with no reason reads as a crash and
      // the user has to be able to tell a reload from a provider failure.
      error: `interrupted: no heartbeat for ${Math.round(heartbeatAgeMs(turn.heartbeatAt, nowMs) / 1000)}s`,
    });
    recovered.push(turn);
  }
  return recovered;
}

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
  | { kind: "success"; text: string; messages: UIMessage[]; hitStepLimit: boolean; unknownOutcomes: UnknownToolOutcome[] }
  | {
      kind: "awaiting-approval";
      text: string;
      messages: UIMessage[];
      openApprovals: OpenApproval[];
      hitStepLimit: boolean;
      unknownOutcomes: UnknownToolOutcome[];
    }
  | { kind: "aborted"; text: string; messages: UIMessage[]; hitStepLimit: boolean; unknownOutcomes: UnknownToolOutcome[] }
  | {
      kind: "failed";
      text: string;
      messages: UIMessage[];
      classification: Classification;
      error: unknown;
      hitStepLimit: boolean;
      unknownOutcomes: UnknownToolOutcome[];
    };

/**
 * The settings handed to `ToolLoopAgent` that do not vary per attempt.
 *
 * Exported, and in its own function, for one reason: **both values here are
 * rules, and rules that are only stated in a comment are rules that a later edit
 * can delete without a test noticing.**
 *
 * - `maxRetries: 0` — the SDK's default is 2, retried under *its own* backoff,
 *   below our classification. Left on, one turn makes up to 9 requests of which
 *   6 are invisible to the UI, and §5.4's "at most 3 attempts, all visible"
 *   becomes false. It survives as long as it is a value somebody can assert.
 * - `telemetry: { isEnabled: false }` — AGENTS.md §3.1 requires it, §14.4 gives
 *   the reason (the docs treat telemetry as default-on once an integration is
 *   registered, so a silent upgrade would start sending). It is trivially
 *   assertable here, and was previously pinned by nothing at all.
 */
export function staticAgentSettings(): {
  maxRetries: 0;
  telemetry: { isEnabled: false };
} {
  return { maxRetries: 0, telemetry: { isEnabled: false } };
}

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
    const { stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS } = this.#options;
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
          unknownOutcomes: observation.unknownOutcomes,
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
          unknownOutcomes: observation.unknownOutcomes,
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
        this.#emit({ type: "turn-stopped", stage: "attempt" });
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
          unknownOutcomes: observation.unknownOutcomes,
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
          unknownOutcomes: observation.unknownOutcomes,
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
          unknownOutcomes: observation.unknownOutcomes,
        };
      }

      // The failed attempt stays visible, marked interrupted, with its partial
      // text — that is what makes a 200-but-broken turn diagnosable at all.
      await this.#finish("interrupted", describe(classification));
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
      unknownOutcomes: [],
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
        unknownOutcomes: observation.unknownOutcomes,
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
        unknownOutcomes: observation.unknownOutcomes,
      };
    }

    /**
     * A stop during a resume is a stop, not a stall.
     *
     * This used to synthesise `{ kind: "no-response" }` and emit
     * `attempt-failed`, which told the UI that a person pressing stop during an
     * approval resume had hit §5.4's 20-second stall — "waiting for a response
     * that will never come" — for a response that was never even asked for. The
     * two are now separated exactly as they are in `run()`: `turn-stopped`
     * first, no `attempt-failed` at all, and a `classification` of `undefined`.
     *
     * The invariant is the one the event documents: an interrupted turn with a
     * classification is a failure, and an interrupted turn without one is a
     * stop. Both branches below obey it, so a UI never has to guess.
     */
    if (observation.kind === "aborted") {
      this.#emit({ type: "turn-stopped", stage: "approval-resume" });
      this.#emit({ type: "turn-finished", outcome: "interrupted", attempts: 1 });
      await this.#finish("interrupted", "stopped");
      return {
        outcome: "interrupted",
        attempts: 1,
        text: observation.text,
        classification: undefined,
        attemptLog: [{ attempt: 1, text: observation.text, interrupted: true, classification: undefined }],
        openApprovals: [],
        messages: observation.messages,
        hitStepLimit: observation.hitStepLimit,
        unknownOutcomes: observation.unknownOutcomes,
      };
    }

    // A resume has no retry budget of its own: it is the tail of an attempt that
    // already succeeded up to the pause. A failure here ends the turn.
    const classification = observation.classification;
    this.#emit({ type: "attempt-failed", attempt: 1, classification });
    this.#emit({ type: "turn-finished", outcome: "failed", attempts: 1 });
    await this.#finish("failed", describe(classification));
    return {
      outcome: "failed",
      attempts: 1,
      text: observation.text,
      classification,
      attemptLog: [{ attempt: 1, text: observation.text, interrupted: true, classification }],
      openApprovals: [],
      messages: observation.messages,
      hitStepLimit: observation.hitStepLimit,
      unknownOutcomes: observation.unknownOutcomes,
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
      sessionId,
      instructions,
      tools,
      workspace,
      cwd,
      approve,
      onProgress,
      maxSteps = DEFAULT_MAX_STEPS,
      now = Date.now,
    } = this.#options;
    const emit = this.#emit;

    /**
     * How many calls with a given id have already been begun in this attempt.
     *
     * The scope of the dedup key, and the reason a reused `toolCallId` is not a
     * correctness hole any more. A provider that reuses `c1` for two *different*
     * calls in one turn used to have the second one silently dropped: the tool
     * ran once, the model was handed `ran: 1` for a call it had never made, and
     * the turn still reported `succeeded`. Keying on the id alone cannot tell
     * that case from a genuine replay — they are the same string.
     *
     * `occurrence` is the discriminator, and it is 0-based: the first call with
     * an id is occurrence 0 and is a candidate for the replay short-circuit;
     * every later call with the same id is a distinct call and must run. The
     * counter is per **attempt**, which is what makes a `regenerate` (a new
     * attempt that re-sends the same ids) replay, while a provider's reuse
     * inside one attempt does not.
     *
     * **The counter is advanced by the *lookup*, not by the begin** — a point
     * that cost a test to find. Advancing it in `begin` looked equivalent and
     * was not: a short-circuited call never begins, so a turn that replayed two
     * calls sharing an id resolved *both* to occurrence 0 and handed the model
     * the first call's recorded answer for the second. Every call consumes an
     * occurrence, whether or not it went on to execute.
     */
    const occurrences = new Map<string, number>();
    /**
     * toolCallId → the key its most recent `lookupToolCall` produced, so the
     * `beginToolCall` and the `tool-result` that follow both record **that**
     * call and not a freshly minted key. Without it the record write and the
     * short-circuit read could land on different occurrences of a reused id, and
     * the outcome would be filed against a call the short-circuit never reads.
     */
    const toolCallKeys = new Map<string, ToolCallKey>();
    /** Idempotency bookkeeping for this attempt, as the tool adapter sees it. */
    const toolCallIds: {
      lookup: (toolCallId: string) => Promise<ToolCallRecord | undefined>;
      begin: (info: { toolCallId: string; toolName: string; input: unknown }) => Promise<void>;
      unknownOutcomes: UnknownToolOutcome[];
    } = {
      lookup: async (toolCallId) => {
        const key = nextToolCallKey(sessionId, attempt, toolCallId, occurrences);
        toolCallKeys.set(toolCallId, key);
        occurrences.set(toolCallId, (occurrences.get(toolCallId) ?? 0) + 1);
        return store.getToolCall(key);
      },
      begin: async (info) => {
        const key = toolCallKeys.get(info.toolCallId) ?? nextToolCallKey(sessionId, attempt, info.toolCallId, occurrences);
        await store.beginToolCall({ key, toolName: info.toolName, input: info.input });
        toolCallKeys.set(info.toolCallId, key);
      },
      unknownOutcomes: [],
    };

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
      lookupToolCall: toolCallIds.lookup,
      beginToolCall: toolCallIds.begin,
      onUnknownOutcomeToolCall: (info) => {
        toolCallIds.unknownOutcomes.push({
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          input: info.input,
        });
        emit({ type: "tool-outcome-unknown", ...info });
      },
    });

    /**
     * Observations for one attempt.
     *
     * `sawTerminalEvent` is the success signal, not "the stream ended": a stream
     * that stops without a provider `finish` chunk is a failure whatever the
     * HTTP status said (Plan.md §5.4, step 5). How it is established — and what
     * is *not* observable here — is documented at the `finish` case below.
     */
    let text = "";
    let reasoning = "";
    let sawTerminalEvent = false;
    /** Parts observed, the evidence §5.4's step 5 is reported with. */
    let partCount = 0;
    let lastFinishReason: string | undefined;
    /** Steps completed so far, from `onStepEnd`. */
    let steps = 0;
    let streamError: unknown;
    let sawErrorPart = false;
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

    const heartbeat = (): void => {
      void store.heartbeat({ turnId, at: new Date(now()).toISOString() });
    };
    // Written at the start of every attempt, not only per step, so a turn that
    // dies *before* its first `onStepEnd` still has an anchor to be measured
    // against (Plan.md §6.1).
    heartbeat();

    const agent = new ToolLoopAgent({
      model: this.#options.model,
      instructions,
      tools: toolSet,
      stopWhen: isStepCount(maxSteps),
      // `maxRetries: 0` and `telemetry: { isEnabled: false }` — both are rules
      // from AGENTS.md §3.1, and both live in `staticAgentSettings()` so a test
      // can assert them instead of trusting a comment. The reasoning is there.
      ...staticAgentSettings(),
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
        heartbeat();
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
        partCount += 1;
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
            // the fact that the tool ran, or a replay would run it again. The
            // key is the *same* one the short-circuit will look the call up
            // under, so a replay finds it and a same-id reuse does not.
            void store.recordToolCall({
              key: toolCallKeys.get(part.toolCallId) ?? nextToolCallKey(sessionId, attempt, part.toolCallId, occurrences),
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
            /**
             * No `recordToolCall` here, and that is a fact about reachability
             * rather than an oversight.
             *
             * A `tool-error` part means the SDK caught a rejection from
             * `execute` — and `createSdkTool` never lets one escape: every
             * failure inside `definition.execute` is converted into a tool
             * *result* (`toToolErrorResult`), which the `tool-result` case above
             * does record. The two throws that do escape, `parseInput` and
             * `MissingToolCallIdError`, both happen *before* `beginToolCall`, so
             * there is no `begun` record for them to close either.
             *
             * If that ever stops being true, the record will legitimately read
             * as `begun` and a replay will report the outcome as unknown — which
             * is the recoverable direction, not the corrupting one.
             */
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
             * The terminal-event check — on the provider's own signal, not a
             * guess about the finish reason.
             *
             * `TextStreamFinishPart.rawFinishReason` is the provider's own finish
             * reason, verbatim; the SDK leaves it `undefined` on a finish part it
             * **synthesises** after a stream that ended without one. That is the
             * discriminator, and it is a public, typed field
             * (`ai/dist/index.d.ts`, `type TextStreamFinishPart`) rather than an
             * inference from a normalised value.
             *
             * What it replaces, and why that had to go: `finishReason !== "other"`
             * cannot work, because `ai@7.0.122` does
             * `unified: finishReason === "unknown" ? "other" : finishReason`. A
             * provider that terminates *deliberately* with the spec-legal
             * `"unknown"` produces a part sequence **byte-identical** to a
             * truncated one — both report `"other"` — and was therefore read as a
             * truncation and retried: three requests for an answer that had
             * already arrived. Guessing a terminal event from a normalised
             * reason is worse than having no check, because it fires on answers.
             *
             * The second, typed half of the check is
             * `AI_NoOutputGeneratedError` — the SDK's own "the model stream
             * ended without a finish chunk", which it raises when a stream closes
             * with neither a terminal chunk nor any output. That one carries no
             * guess at all, and it is handled below where the error is
             * classified.
             *
             * **What is still not observable, honestly:** the provider's *raw*
             * chunk stream. `ToolLoopAgentSettings` has no `onChunk`, no
             * `includeRawChunks` and no `onError` (verified against the installed
             * `dist/index.d.ts`), so the SSE-level `data: [DONE]` that Plan.md
             * §5.4 names cannot be seen from here at all. Reaching it means
             * wrapping the `LanguageModel` in the provider registry — a separate
             * decision, not taken here. This is recorded as a limitation in
             * Plan.md §5.4 rather than papered over, because a check that
             * pretends to be raw when it is not is how this bug happened.
             */
            sawTerminalEvent = part.rawFinishReason !== undefined;
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
            sawErrorPart = true;
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
    const shape = { messages: allMessages, hitStepLimit, unknownOutcomes: toolCallIds.unknownOutcomes };

    if (this.#stopped || this.#controller.signal.aborted) {
      return { kind: "aborted", text, ...shape };
    }

    if (openApprovals.length > 0) {
      return { kind: "awaiting-approval", text, openApprovals, ...shape };
    }

    /**
     * Every failure goes through `classifyResponse` — the one implementation of
     * §5.4's order of checks.
     *
     * The facts it is given are exactly what the turn observed: the error itself
     * (which carries `statusCode`, `responseHeaders` and `responseBody`
     * structurally, so the JSON-error-body and content-type checks of §5.4's
     * step 4 really do run here, not only in their own unit tests) and the
     * stream observation, whose `sawTerminalEvent` is the provider's own answer
     * from the `finish` case above.
     *
     * `responded: true`: the throwable reached us, so the attempt got far enough
     * to have an outcome. A connection that never opened and one that died after
     * the headers both surface as a bare `TypeError` from `fetch` and cannot be
     * told apart here; both are treated as retryable, which is §5.4's
     * "Antwort kam, unbrauchbar". The residual is stated rather than hidden.
     */
    if (streamError !== undefined) {
      return {
        kind: "failed",
        text,
        classification: classifyResponse({
          responded: true,
          error: streamError,
          stream: {
            partCount,
            sawTerminalEvent,
            sawErrorEvent: sawErrorPart,
            errorEvent: streamError,
          },
        }),
        error: streamError,
        ...shape,
      };
    }

    // Step 5 of the plan's order: a stream that ends without a terminal event
    // is a failure, whatever the status line said. Same single implementation —
    // no `error` here only because there is nothing to read a status or a body
    // from.
    if (!sawTerminalEvent) {
      const reason = `stream ended without a terminal event (${partCount} parts, no provider finish chunk)`;
      return {
        kind: "failed",
        text,
        classification: classifyResponse({
          responded: true,
          stream: { partCount, sawTerminalEvent: false, sawErrorEvent: sawErrorPart },
        }),
        error: new Error(reason),
        ...shape,
      };
    }

    return { kind: "success", text, ...shape };
  }
}

/**
 * The key a tool call is recorded under.
 *
 * All three parts earn their place, and the reasoning is the reason the bare
 * `toolCallId` this replaces was a correctness bug rather than a simplification:
 *
 * - `sessionId` — `tool_invocations` has the column (Plan.md §6.1) and the store
 *   knows the session. Without it, two sessions that happen to mint the same id
 *   share one short-circuit record, and the second session's model is handed the
 *   first session's output.
 * - `attempt` — §5.4 caps a turn at three attempts, and a retry is a fresh
 *   re-send. Scoping by attempt means a `regenerate` replays what the previous
 *   attempt recorded, instead of that attempt's record silencing a call the new
 *   one made in good faith.
 * - `occurrence` — 0-based, per attempt. A provider that reuses one id for two
 *   *different* calls is measured, not hypothetical, and the id alone cannot
 *   tell it from a replay. The first call is occurrence 0 and may be
 *   short-circuited; every later one must run.
 */
function nextToolCallKey(
  sessionId: string,
  attempt: number,
  toolCallId: string,
  occurrences: ReadonlyMap<string, number>,
): ToolCallKey {
  return { sessionId, attempt, toolCallId, occurrence: occurrences.get(toolCallId) ?? 0 };
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
    // A local configuration error. Repeating a request that was never
    // configured produces the identical error; §5.4's rule for `invalid_api_key`
    // — "Key ist falsch, nicht kaputt" — applies verbatim.
    case "config-error":
      return false;
    case "http-error":
    case "body-error":
      return classification.retryable;
    case "protocol-error":
      // "Antwort kam, unbrauchbar" — retryable by definition (§5.4).
      return true;
  }
}

/**
 * Is this a body error whose type the plan does not name?
 *
 * §5.4: an unknown type is retried **once**, a known transient type may spend
 * the whole budget. The test is {@link isKnownErrorType} — exported from
 * `stream/classify.ts` for precisely this caller.
 *
 * It used to be a private copy of the normaliser here, and the copy was wrong:
 * it stripped a trailing `_error` **unconditionally**, so `server_error` — which
 * is a key in its own right, not a decorated `server` — became `server`, missed
 * every table, and was treated as unknown. The effect was a listed *retryable*
 * type spending 2 attempts instead of 3. `classify.ts` documents that exact bug
 * in the comment on {@link normalizeErrorType} and guards it by stripping only
 * when the stripped form is itself a key; the guard was simply never carried
 * across. One implementation now, so the two cannot drift again.
 */
function isUnknownBodyError(classification: Classification): boolean {
  return classification.kind === "body-error" && !isKnownErrorType(classification.code);
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
    case "config-error":
      // Named, not paraphrased: the UI shows this string, and "API key missing"
      // is the difference between a five-second fix and an afternoon of guessing
      // at the network.
      return `API key missing: ${classification.message}`;
  }
}

export type { ToolSet, AiToolSet, UIMessageChunk };
