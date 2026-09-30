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
 * ## Nothing here writes to the console, and no promise is discarded bare
 *
 * AGENTS.md §5: everything the user must see becomes a typed event. A provider
 * error that only reached `console.error` would be invisible in the product.
 *
 * The same rule extends to a **discarded promise**, and there the shape matters
 * rather than the syntax. `void somePromise()` throws the rejection away with no
 * `.catch`, so it does not become invisible — it becomes an *unhandled promise
 * rejection*, which the browser routes to `unhandledrejection` and vitest
 * treats as a fatal error. That is the same silent failure as a `catch {}` with
 * one extra step. Two writes on {@link TurnStore} are fired rather than awaited —
 * `heartbeat` and `recordToolCall`, both because their call sites are synchronous
 * SDK callbacks — and both attach a handler that reports a `storage-warning`. The
 * reasoning for *warning* rather than *abort* is written out at `heartbeat()`; the
 * short version is that both are bookkeeping, and the write that genuinely ends a
 * turn is the delta flush, which is awaited.
 *
 * ## Storage is injected, not imported
 *
 * `@all-the.rest/baah-storage` is a sibling, not a dependency of this package,
 * and AGENTS.md §4 forbids a pointer back. The engine talks to a narrow
 * {@link TurnStore} — ten methods, all of which `StorageDatabase` already
 * implements (Plan.md §16.1).
 *
 * ## The seam is this wide for a reason
 *
 * Four of the methods exist because a storage adapter measured a gap in the
 * contract rather than in the schema, and each is named at its declaration: a
 * delta that cannot say what kind of part it is (a reasoning delta persisted as
 * text), a part that cannot be closed (every part `streaming` forever, so a
 * reload cannot tell "still writing" from "died mid-sentence"), a heartbeat
 * that was the one write on the interface not scoped to a session, and a
 * recovery that appended a second `interrupted` outcome to a turn it had already
 * closed. Widening an interface is cheap; a hole in it is measured by somebody
 * else, later, in a browser.
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
  | { type: "error"; error: unknown; classification: Classification }
  /**
   * A **bookkeeping** write the engine fires without awaiting failed.
   *
   * Its own event, and not a `catch {}`, because `AGENTS.md` §5 is a rule about
   * what the user gets to see and a discarded promise is worse than a silent
   * catch: with a bare `void` the rejection never reaches the turn at all, it
   * leaves as an *unhandled promise rejection* — routed to the browser's
   * `unhandledrejection`, and fatal to a vitest run. The three states that
   * matters are named on the interface: the operation, the attempt it belongs
   * to, and — for the one that has a subject — which tool call it is about.
   *
   * A **warning, not a verdict.** The full argument is at
   * {@link describeStorageFailure}'s call site, in `heartbeat()`; the short
   * version is that a heartbeat is a liveness ping whose only reader is the
   * *next* start-up, and that the write which genuinely ends a turn — the delta
   * flush — is awaited and does fail loudly on its own.
   */
  | {
      type: "storage-warning";
      operation: "heartbeat";
      attempt: number;
      /** The store's own message. Never a stack trace (`AGENTS.md` §5). */
      message: string;
    }
  | {
      type: "storage-warning";
      operation: "record-tool-call";
      attempt: number;
      toolCallId: string;
      toolName: string;
      message: string;
    };

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
 * The kind of part a streamed delta belongs to.
 *
 * `Plan.md` §6.1 allows `text | reasoning | tool` on `parts.type`, and the loop
 * streams **two** of the three — a reasoning delta is a first-class part type,
 * not a flavour of text. `tool` is missing on purpose: a tool part is written
 * whole (input at `tool-call`, output at `tool-result`) and has no mid-stream
 * text, so there is nothing to flush and nothing to close. Were a tool ever to
 * need incremental persistence, what would be missing is not the kind but the
 * payload — §6.1's `data` / `metadata.files` — and that is a different write,
 * not a third value here.
 */
export type PartKind = "text" | "reasoning";

/** An outcome a turn's log already carries (Plan.md §6.2: an `idle` message). */
export interface TurnOutcomeEntry {
  turnId: string;
  outcome: TurnOutcome;
}

/**
 * The persistence operations a turn needs.
 *
 * Every one of these already exists on `StorageDatabase` (Plan.md §16.1) except
 * the two marked **[W2]** — the tool-call status column and the unfinished-turn
 * read. Those are the storage wiring that lands with Wave 2; the engine owns
 * the contract and the tests own the semantics, and nothing in `src/` depends
 * on the concrete backend.
 *
 * **Every write on this seam is session-scoped, and one of them used not to
 * be.** `heartbeat` carried only a `turnId`, so it was the single write on the
 * interface that could renew an arbitrary turn's anchor from any session. It
 * now carries the session like the other nine.
 */
export interface TurnStore {
  /**
   * One buffered streaming flush (Plan.md §6.2), idempotent over `deltaId`.
   *
   * `partType` is required, not defaulted. A delta used to name a part, a
   * message, a session and a string, and every implementation had to guess the
   * kind — so a reasoning delta was persisted as a text part, and the
   * transcript showed the model's thinking as something it said. An optional
   * field with a `"text"` default would be the same guess with a louder type.
   */
  flushDelta(input: {
    deltaId: string;
    partId: string;
    messageId: string;
    sessionId: string;
    partType: PartKind;
    contentText: string;
  }): Promise<void>;
  /**
   * Close a part: it will receive no further delta.
   *
   * A delta is mid-stream by definition, so every part this seam ever wrote was
   * `streaming`, and nothing could ever say otherwise. That is not a cosmetic
   * gap: a reload could not tell "still being written" from "the tab died
   * mid-sentence", and §6.1's `interrupted` recovery depends on exactly that
   * difference. Called where the engine *knows* the part ended — the `text-end`
   * and `reasoning-end` events, and the end of an attempt — not only at turn
   * end, because a crash before turn end is precisely the case that would
   * leave a dangling part.
   *
   * `status` names which ending it was, and the two are not interchangeable:
   * `completed` means the provider's end event arrived, `aborted` means it never
   * will. There is no `failed` — a part does not fail, the *turn* does, and the
   * turn's outcome already says so.
   */
  closePart(input: {
    sessionId: string;
    messageId: string;
    partId: string;
    status: "completed" | "aborted";
  }): Promise<void>;
  /**
   * Close **every still-open part of a turn**, as `aborted`.
   *
   * The crash case, and why it is not `closePart` with a list: after a reload
   * the engine no longer knows which parts it was writing, so the recovery
   * cannot name them. Naming the *turn* is what it can still do, and finding
   * that turn's open parts is the store's query. A turn that is merely alive
   * must never be passed here — that would truncate a live turn in another tab,
   * which is why the caller is the recovery and not the heartbeat.
   */
  closeTurnParts(input: { sessionId: string; turnId: string }): Promise<void>;
  /** The turn outcome is an `idle` message (Plan.md §6.2) — not a table. */
  finishTurn(input: {
    turnId: string;
    sessionId: string;
    outcome: "succeeded" | "failed" | "interrupted";
    error: string | undefined;
  }): Promise<void>;
  /**
   * Renews `heartbeat_at`; a stale heartbeat is the reload anchor (§6.1).
   *
   * Scoped by `sessionId` so that every write on this seam is scoped. The call
   * site has it in hand — it is a field of `AgentLoopOptions` and is already
   * passed to `flushDelta` and `finishTurn` from the same closure — so this cost
   * nothing at the call site and removed the one write that could renew any
   * turn's anchor from anywhere.
   */
  heartbeat(input: { turnId: string; sessionId: string; at: string }): Promise<void>;
  /**
   * **[W2]** Unfinished turns of a session, for reload recovery.
   *
   * A turn is unfinished while it is neither `succeeded` nor `failed` — the
   * window where a reload leaves a half-written transcript behind.
   */
  listUnfinishedTurns(input: { sessionId: string }): Promise<readonly UnfinishedTurn[]>;
  /**
   * The turn outcomes this session's log already carries.
   *
   * Read once at start-up rather than per turn: it is what lets the recovery
   * tell a turn it has *just* closed from one that still has to be closed.
   * `Plan.md` §6.2 makes the outcome an `idle` message, so this is the reload
   * check the plan describes — a read of the log, not a column on the turn. It
   * is a separate read because `listUnfinishedTurns` is a read of the *anchor*,
   * and the anchor deliberately keeps reporting an `interrupted` turn as
   * unfinished: that is what makes it re-sendable, and it is why the second
   * read exists.
   */
  listTurnOutcomes(input: { sessionId: string }): Promise<readonly TurnOutcomeEntry[]>;
  /**
   * Records that a `toolCallId` ran, so a replay short-circuits it.
   *
   * A **tool part needs no `closePart`**: it is terminal by construction. It is
   * written whole at `tool-call` and completed whole at `tool-result` /
   * `tool-error`, there is no mid-stream text to buffer, and whether it *ran* is
   * recorded here rather than in `parts.status`. That is why {@link PartKind} has
   * two values and not three.
   */
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
  /**
   * The engine's clock: the `heartbeat_at` anchor (§6.1) and the delta-flush
   * interval (§6.2) are both measured against it. Injected for tests, and
   * deliberately the *only* clock here — a second one would be a second thing
   * that has to be faked.
   */
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
 * How often a streaming part's text reaches the store (Plan.md §6.2).
 *
 * §6.2 asks for "every ~50–100 ms in **one short** transaction" and, in the same
 * sentence, "**never** a write per token" — the two are the same requirement,
 * since a per-token write is what makes the flush expensive enough that nobody
 * wants it. 100 ms is the top of the plan's window: a crash costs the buffered
 * tail rather than the answer, and a long answer is checkpointed continuously
 * instead of only at its end.
 *
 * There is no timer behind it. The check runs when a delta arrives, which is the
 * only place the engine learns that there is something new to write, and it
 * means the engine needs no clock of its own — {@link AgentLoopOptions.now},
 * which the heartbeat already uses, is the whole of it.
 */
export const DELTA_FLUSH_INTERVAL_MS = 100;

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
 * May the recovery close this turn?
 *
 * Both conditions are load-bearing and both were measured rather than assumed;
 * the predicate is named and exported so neither can be dropped into a comment
 * and lost.
 *
 * 1. **The heartbeat is on the stale side of {@link STALE_HEARTBEAT_MS}.** A
 *    fresh heartbeat means somebody else is still working on this turn, and
 *    closing it would kill a live turn in another tab — the damage is a turn
 *    marked `interrupted` and offered as `regenerate`, which is visible but
 *    still a turn the user did not lose.
 * 2. **The turn carries no terminal outcome yet.** This is the one that was
 *    missing. `listUnfinishedTurns` counts `interrupted` as unfinished *on
 *    purpose* (AGENTS.md §3.1: an unfinished turn is marked `interrupted` and
 *    repeated with `regenerate`), so the turn the recovery closed at start-up 1
 *    is still reported at start-up 2 — with a stale heartbeat, because closing a
 *    turn does not renew its anchor. Every reload therefore appended a *second*
 *    `interrupted` outcome message to the same turn, and the transcript grew a
 *    duplicate every time the tab was reopened. A turn that was interrupted at
 *    start-up 1 stays interrupted at start-up 2; what changes between the two is
 *    only the part that says the user may regenerate it, and that is the turn
 *    row, not the log.
 *
 * The condition is the *outcome* rather than "is it `interrupted`": `succeeded`
 * and `failed` are terminal too, and a store that reported one of those on a
 * turn it still lists unfinished (a read that raced a finish) must not have a
 * second outcome written over it.
 */
export function isRecoverableTurn(
  turn: UnfinishedTurn,
  facts: {
    nowMs: number;
    staleAfterMs: number;
    /** The outcome the log already carries, if any. */
    recordedOutcome: TurnOutcome | undefined;
  },
): boolean {
  if (!isTurnStale(turn.heartbeatAt, facts.nowMs, facts.staleAfterMs)) return false;
  if (facts.recordedOutcome !== undefined) return false;
  return true;
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
 *
 * The second condition of {@link isRecoverableTurn} — no terminal outcome yet —
 * is what makes this idempotent: two start-ups in a row produce one outcome, not
 * two.
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
  /**
   * One read for every candidate, not one per candidate.
   *
   * It is read up front rather than lazily so that a turn closed by *this* pass
   * cannot be seen as already-closed by a later iteration — the outcomes map is
   * a snapshot, and the loop below adds to it explicitly where it matters (it
   * does not: a turn is listed once).
   */
  const recordedOutcomes = new Map<string, TurnOutcome>();
  for (const entry of await store.listTurnOutcomes({ sessionId })) {
    recordedOutcomes.set(entry.turnId, entry.outcome);
  }

  const recovered: UnfinishedTurn[] = [];
  for (const turn of unfinished) {
    if (
      !isRecoverableTurn(turn, {
        nowMs,
        staleAfterMs,
        recordedOutcome: recordedOutcomes.get(turn.turnId),
      })
    ) {
      continue;
    }
    /**
     * The parts first, then the outcome.
     *
     * A part that was still streaming when the tab died is the half-written
     * sentence the user sees, and closing it as `aborted` is what makes it
     * readable as "this was cut off" instead of "this is still being written".
     * Order matters for the log: the outcome message says the turn ended, so it
     * must not claim that before the last text of the turn is closed.
     */
    await store.closeTurnParts({ sessionId, turnId: turn.turnId });
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
    /**
     * The assistant message this attempt produces.
     *
     * Minted before the stream rather than after it, because every flushed
     * delta and every closed part has to name the message it belongs to.
     */
    const messageId = newMessageId();

    /**
     * The parts of this attempt that are still being written, and when each was
     * last flushed.
     *
     * This is the whole of the streaming persistence protocol, and it is here
     * because the engine is the only layer that knows when a part has ended.
     * `Plan.md` §6.2 forbids a write per token, so a delta is not persisted when
     * it arrives: the part's cumulative text is flushed at most once per
     * {@link DELTA_FLUSH_INTERVAL_MS} and unconditionally when the part ends.
     */
    const openParts = new Map<string, { kind: PartKind; part: { text: string }; openedAt: number }>();
    /** partId → when its last flush went out. */
    const lastFlushAt = new Map<string, number>();
    /** partId → how many flushes it has had; the delta id's sequence number. */
    const flushCount = new Map<string, number>();

    /**
     * The idempotency key of one flush (Plan.md §6.2: `deltaId`).
     *
     * All four components are needed, and each closes a measured failure:
     * `turnId` keeps two turns apart; `attempt` is what separates two attempts
     * of the *same* turn, because a retry re-sends the request and the provider
     * mints the **same part ids again** — a per-part counter alone would make
     * attempt 2's first flush a replay of attempt 1's and drop it silently;
     * `partId` separates the parts of one step; and the trailing counter keeps
     * repeated flushes of one part apart, because a second flush with an id the
     * store has already seen is a no-op — which would leave the part stuck at
     * the text of the first flush.
     */
    const nextDeltaId = (partId: string): string => {
      const sequence = flushCount.get(partId) ?? 0;
      flushCount.set(partId, sequence + 1);
      return `${turnId}#${attempt}#${partId}#${sequence}`;
    };

    /** Write a part's cumulative text. */
    const flushPart = async (partId: string): Promise<void> => {
      const entry = openParts.get(partId);
      if (entry === undefined) return;
      await store.flushDelta({
        deltaId: nextDeltaId(partId),
        partId,
        messageId,
        sessionId,
        // Not inferred from anything: the two call sites below know which kind
        // of part they are opening, and §6.1's `reasoning` is a different part
        // type, not a flavour of text.
        partType: entry.kind,
        contentText: entry.part.text,
      });
      lastFlushAt.set(partId, now());
    };

    /**
     * Flush, then close — in that order, and awaited.
     *
     * A flush carries the part's text and a store is free to write it with the
     * status a delta implies (`streaming`), so a close that landed first would
     * be overwritten by this part's own next flush and the part would read as
     * streaming again. Awaiting (rather than firing and forgetting, as the
     * heartbeat does) is what makes the order real; a rejected flush surfaces
     * as the turn's error rather than as a lost sentence.
     */
    const closePart = async (partId: string, status: "completed" | "aborted"): Promise<void> => {
      if (!openParts.has(partId)) return;
      await flushPart(partId);
      await store.closePart({ sessionId, messageId, partId, status });
      openParts.delete(partId);
    };

    /** Open a streamed part, closing a previous one that never got its end event. */
    const openPart = (partId: string, kind: PartKind, part: { text: string }): void => {
      openParts.set(partId, { kind, part, openedAt: now() });
    };

    /**
     * The time-gated flush of §6.2: a delta that arrives less than
     * {@link DELTA_FLUSH_INTERVAL_MS} after the last one is buffered instead of
     * written. A crash costs the buffered tail, not the answer.
     */
    const flushIfDue = async (partId: string): Promise<void> => {
      const entry = openParts.get(partId);
      if (entry === undefined) return;
      const since = now() - (lastFlushAt.get(partId) ?? entry.openedAt);
      if (since < DELTA_FLUSH_INTERVAL_MS) return;
      await flushPart(partId);
    };

    /**
     * Renew the reload anchor, and report a failure as a typed event.
     *
     * ## Why the call is not awaited
     *
     * `onStepEnd` is a **synchronous** callback of `ToolLoopAgent`; there is no
     * promise for it to return, and awaiting inside it is not an option. Making
     * the callback async would not help — the SDK does not await it, so the
     * heartbeat would become a floating promise anyway, one call removed.
     *
     * ## Why a rejection is a `storage-warning` and not a verdict
     *
     * This is the decision the whole helper is, so it is written out rather than
     * left to the next reader:
     *
     * 1. **A heartbeat is a best-effort liveness ping.** Its only reader is
     *    {@link recoverStaleTurns}, on the *next* start-up — nothing in the
     *    running turn consults it. `UPDATE_TURN_HEARTBEAT` writes one column and
     *    touches no other row, so a heartbeat that cannot be written has not
     *    corrupted anything the user is looking at.
     * 2. **Aborting here would throw away a turn that is working.** The stream
     *    is in flight and the user is watching tokens arrive. The signal lands at
     *    the start of an attempt, i.e. routinely *before* the first delta flush —
     *    and that flush is the write whose rejection is allowed to end the turn,
     *    because it is the write that carries the sentence. Letting the ping
     *    decide the turn's outcome would invert the two: the least load-bearing
     *    write would be fatal and the transcript would lose its text to it.
     * 3. **The damage is bounded, visible and reversible.** A stale anchor means
     *    the next start-up marks the turn `interrupted` and offers `regenerate`
     *    (`Plan.md` §5.1) — a turn the user did not lose, offered back to them.
     *    That is the same trade §5.1 already makes for the 30 s threshold,
     *    applied one level up.
     * 4. **The first heartbeat is the *earliest* symptom, not different
     *    information.** A rejection here is almost always "the database is
     *    closed", and the delta flush that follows fails loudly on its own. So
     *    the warning buys earliness, not a verdict — which is exactly why it is
     *    worth reporting and not worth aborting over.
     *
     * `onEvent` is the caller's callback and is deliberately not wrapped: a throw
     * there is a bug in the app, and every other `emit` in this file has the same
     * exposure. Inside this handler it would additionally leave an unhandled
     * rejection rather than a classified turn error, which is the one asymmetry
     * worth stating rather than hiding.
     */
    const heartbeat = (): void => {
      store
        .heartbeat({ turnId, sessionId, at: new Date(now()).toISOString() })
        .catch((error: unknown) => {
          emit({
            type: "storage-warning",
            operation: "heartbeat",
            attempt,
            message: describeStorageFailure(error),
          });
        });
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

          case "text-start": {
            // A part that is still open when the next one starts will never get
            // an end event — the provider replaced it — so it is closed as
            // `aborted` here rather than left `streaming` for the rest of the
            // transcript's life.
            if (currentText !== undefined) await closePart(currentText.id, "aborted");
            currentText = {
              id: part.id,
              part: { type: "text", text: "", state: "streaming" },
            };
            openPart(part.id, "text", currentText.part);
            parts.push(currentText.part);
            break;
          }

          case "text-delta": {
            if (currentText?.id !== part.id) {
              // A delta without a start is a provider protocol break; ignoring
              // it silently would lose text, so it starts a fresh part.
              if (currentText !== undefined) await closePart(currentText.id, "aborted");
              currentText = {
                id: part.id,
                part: { type: "text", text: "", state: "streaming" },
              };
              openPart(part.id, "text", currentText.part);
              parts.push(currentText.part);
            }
            currentText.part.text += part.text;
            text = currentText.part.text;
            emit({ type: "text-delta", text: part.text, messageId });
            await flushIfDue(currentText.id);
            break;
          }

          case "text-end":
            if (currentText?.id === part.id) {
              currentText.part.state = "done";
              // The engine knows this part ended, and this is that point — not
              // the end of the turn, which a crash never reaches.
              await closePart(part.id, "completed");
            }
            currentText = undefined;
            break;

          case "reasoning-start": {
            if (currentReasoning !== undefined) await closePart(currentReasoning.id, "aborted");
            currentReasoning = {
              id: part.id,
              part: { type: "reasoning", id: part.id, text: "", state: "streaming" },
            };
            openPart(part.id, "reasoning", currentReasoning.part);
            parts.push(currentReasoning.part);
            break;
          }

          case "reasoning-delta": {
            if (currentReasoning?.id !== part.id) {
              if (currentReasoning !== undefined) await closePart(currentReasoning.id, "aborted");
              currentReasoning = {
                id: part.id,
                part: { type: "reasoning", id: part.id, text: "", state: "streaming" },
              };
              openPart(part.id, "reasoning", currentReasoning.part);
              parts.push(currentReasoning.part);
            }
            currentReasoning.part.text += part.text;
            reasoning = currentReasoning.part.text;
            emit({ type: "reasoning-delta", text: part.text, messageId });
            await flushIfDue(currentReasoning.id);
            break;
          }

          case "reasoning-end":
            if (currentReasoning?.id === part.id) {
              currentReasoning.part.state = "done";
              await closePart(part.id, "completed");
            }
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
            //
            // A rejection is the `storage-warning` case too, and the reasoning
            // mirrors the heartbeat's with the stakes inverted. It does not
            // make *this* turn fail: the model already holds the tool's real
            // output, and the call really did happen. What a lost record costs
            // is the *proof* — a later replay of the same
            // `(sessionId, attempt, toolCallId, occurrence)` may run the tool
            // again, which for a `write` tool is a second append to the user's
            // file. That is worth a line on screen and nothing more; the engine
            // has no way to make the record appear.
            //
            // It is deliberately *not* an `UnknownToolOutcome`: that says the
            // outcome is unknown, and here it is known exactly — only the proof
            // of it is missing. Filing it as unknown would send the model off to
            // "verify instead of repeating" about a call whose answer it just
            // received.
            store
              .recordToolCall({
                key: toolCallKeys.get(part.toolCallId) ?? nextToolCallKey(sessionId, attempt, part.toolCallId, occurrences),
                toolName: part.toolName,
                output: part.output,
              })
              .catch((error: unknown) => {
                emit({
                  type: "storage-warning",
                  operation: "record-tool-call",
                  attempt,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  message: describeStorageFailure(error),
                });
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

    /**
     * A part that is still open when the attempt is over will never be closed by
     * anything else — the stream is done, whether it succeeded, was cut off, or
     * died on a provider error.
     *
     * Closed as `aborted`, not `completed`: the provider never sent the end
     * event, and a transcript that claims otherwise is exactly the state §6.1
     * says a reload must be able to tell from "still being written". This is the
     * in-process half of the crash case; `recoverStaleTurns` is the half where
     * the process is gone and nobody knows these part ids any more.
     */
    for (const partId of [...openParts.keys()]) {
      await closePart(partId, "aborted");
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

/**
 * The one-line description of a store failure, for a `storage-warning`.
 *
 * **The message and nothing else.** `AGENTS.md` §5's rule for the tool-error
 * path applies verbatim here: a stack trace is a leak of engine internals into
 * a string the UI renders, and the store's own `code` (`sql_error`,
 * `database_closed`, …) is the part a user can act on. A thrown value that is
 * not an `Error` is stringified rather than dropped — an unprintable failure is
 * still a failure, and `String(value)` is all a description can honestly be.
 */
function describeStorageFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ToolSet, AiToolSet, UIMessageChunk };
