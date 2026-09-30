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
 * check, the content-type check and the `terminalEvent` observation are
 * exercised by real turns and not only by their own unit tests. Two rules that
 * are easy to get wrong and are therefore load-bearing below:
 *
 * - a stream whose closing part is the **SDK's own** — synthesised from its
 *   initial `("other", undefined)` because no provider terminal chunk arrived —
 *   is a failure, and
 * - a **retry never continues the failed attempt**: the partial text stays in
 *   the transcript marked `interrupted`, and the next attempt starts from the
 *   original prompt. Copying partial text forward would show the user text the
 *   model never finished and would make the failure undiagnosable.
 *
 * The terminal-event check is a **three-state** observation, not a boolean, and
 * that shape is the whole fix. It used to read
 * `rawFinishReason !== undefined`, which is populated on four of the five
 * installed provider paths and structurally absent on the fifth — so every
 * successful OpenAI Responses turn was read as a truncated stream and retried
 * three times. What is *not* reachable at this layer — the raw SSE chunk
 * stream — is stated where the check is used rather than approximated, because
 * approximating it is exactly what made the previous check fire on correct
 * answers. See the `finish` case below and `TerminalEvent` in `classify.ts`. *
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
 * A third write, `upsertPart`, is awaited and still only *warns* on a rejection —
 * and the reason it cannot be fired is stated at its call site: three writes land
 * on the same row in order, and an overtaken one is a state the database keeps.
 *
 * ## Storage is injected, not imported
 *
 * `@all-the.rest/baah-storage` is a sibling, not a dependency of this package,
 * and AGENTS.md §4 forbids a pointer back. The engine talks to a narrow
 * {@link TurnStore} — thirteen methods, all of which `StorageDatabase` already
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
 * closed. A fifth, later: the seam could not **create** the rows its parts
 * attach to, so the first write of a turn failed a foreign key and an app
 * wrapped the store to work around it. A sixth, later still: the seam could not
 * **persist a tool part**, so the whole of §6.1's third part type was written by
 * the app — along with a second copy of the rule that decides whether a failed
 * tool is stored as a failure, which is the one rule in this file that decides
 * something a *reload* would then show. Widening an interface is cheap; a hole
 * in it is measured by somebody else, later, in a browser.
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

import {
  classifyResponse,
  isKnownErrorType,
  mergeTerminalEvent,
  readTerminalEvent,
  type Classification,
  type TerminalEvent,
} from "../stream/classify.ts";
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
  | { type: "tool-outcome-unknown" } & UnknownToolOutcome
  /**
   * An approval card is waiting for the user.
   *
   * **The payload is `OpenApproval`, intersected rather than re-listed.** It
   * used to be four hand-written fields — `approvalId`, `toolCallId`,
   * `toolName`, `reason` — while the constructor spread all five members of
   * `OpenApproval`, `input` included. TypeScript did not catch it because
   * excess-property checking does not apply to a spread of a typed value, so
   * the union silently under-described what the engine sends.
   *
   * That is not a cosmetic gap: an approval card that has to render *what is
   * about to be written* — the path, the diff, the shell command — had no
   * source for the input on the event, and the app reached into the turn
   * snapshot to get it instead, documenting the SDK's behaviour as if it were
   * ours. Intersecting the two types makes the drift impossible rather than
   * merely tested for: a field added to {@link OpenApproval} now *cannot* be
   * missing here.
   */
  | { type: "approval-requested" } & OpenApproval
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
   *
   * `operation` is the diagnostic half and it is the half that is *ours*. The
   * `message` is the store failure's **class name** and never its text — the
   * field contract is at {@link describeStorageFailure}, and it changed: this
   * used to be "the store's own message", which is a live key leak whenever the
   * store's message is a provider's.
   */
  | {
      type: "storage-warning";
      operation: "heartbeat";
      attempt: number;
      /**
       * The failure's **class name** — `StorageError`, `TypeError`, … Never the
       * store's own text: a rendered string is a screenshot, and an injected
       * store's message is a foreign one. See {@link describeStorageFailure}.
       */
      message: string;
    }
  | {
      type: "storage-warning";
      operation: "record-tool-call";
      attempt: number;
      toolCallId: string;
      toolName: string;
      message: string;
    }
  | {
      type: "storage-warning";
      operation: "upsert-part";
      attempt: number;
      toolCallId: string;
      toolName: string;
      message: string;
    };

export type TurnOutcome = "succeeded" | "failed" | "interrupted" | "waiting" | "awaiting-approval";

/**
 * An approval the turn is parked on, and the payload of the
 * `approval-requested` event.
 *
 * `input` is the tool's **already-validated arguments** — the same object the
 * tool will receive, taken from the SDK's `toolCall`, not re-derived. It is the
 * only thing on this interface that tells an approval card *what* it is
 * approving, and §7.5's copy ("`write` auf `src/app.ts`") cannot be written
 * without it.
 */
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
 * now carries the session like the other eleven.
 *
 * **Two of them create rather than update**, and that is the seam's third
 * measured gap: the engine mints the ids it writes under, so a store with no
 * `appendTurn` / `appendMessage` cannot accept the first write of a turn at
 * all. `Plan.md` §6.1 wanted `appendTurn` in storage and it is there; the
 * engine's side of the contract was missing, so an app had to wrap the seam to
 * manufacture the rows. Each of the twelve is named at its declaration.
 */
export interface TurnStore {
  /**
   * Create the turn row, if it does not exist.
   *
   * ## Why this is here and was not
   *
   * `flushDelta` writes a **part**, and `parts.message_id` references
   * `messages.id` and `messages.turn_id` references `turns.id` — both enforced
   * as real foreign keys. The engine mints `turnId` and `messageId` itself and
   * then writes parts under them, so without a create the very first write of a
   * turn fails with `FOREIGN KEY constraint failed: messages.id = …`. That is
   * not hypothetical: the app hit it, and papered over it with a decorator
   * (`withTranscriptRows`) that manufactured the two rows before delegating.
   *
   * The decorator is the wrong shape for a reason beyond the extra file: the
   * engine has to *learn* the turn id from the first call that carries one,
   * because the interface never told it when the turn began. It guesses, and a
   * guess about which row a message belongs to is exactly the class of bug this
   * seam is for.
   *
   * **Idempotent by `id`.** Called once per turn by the engine, but a
   * `regenerate` re-sends into a fresh turn and a resumed approval re-enters the
   * same one, so "already there" is a normal state and not an error.
   */
  appendTurn(input: { id: string; sessionId: string; startedAt: string }): Promise<void>;
  /**
   * Create a message row, if it does not exist.
   *
   * `role: "user"` is the engine's **own** prompt, written before the first
   * model call — see `AgentTurn.run` for why that ordering is the contract and
   * not an implementation detail. `turnId` is `string | null` rather than
   * optional because a message written with no turn is a real state (a turn that
   * was never created) and it must be *said*, not omitted: with
   * `exactOptionalPropertyTypes` an omitted key is a different type from an
   * explicit `null`.
   *
   * Idempotent by `id` for the same reason {@link TurnStore.appendTurn} is.
   */
  appendMessage(input: {
    id: string;
    sessionId: string;
    role: "user" | "assistant" | "system";
    turnId: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
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
   * Persist a tool part, or fold the write into the row that is already there.
   *
   * ## Why the engine writes tool parts at all
   *
   * §6.1 gives `parts` exactly three types and one of them is `tool`, and a
   * transcript with no tool parts is not a transcript of a coding agent. The
   * engine used to emit the four tool events and leave the *row* to whoever
   * cared — which in practice meant the app, which meant a second implementation
   * of this mapping on the other side of the seam, with its own copy of the state
   * rule below. The rule is the engine's, so the engine owns the row.
   *
   * ## The state is derived here, and it is derived from the **value**
   *
   * `createSdkTool` catches everything `definition.execute` throws and returns
   * `toToolErrorResult`'s `{ ok: false, error }` as an ordinary **result**
   * (`src/tool.ts`, `toToolErrorResult`), so the SDK reports
   * `output-available` for a tool that failed and the `tool-error` branch below
   * is effectively unreachable. The value is therefore the only evidence, and a
   * row written from the envelope alone would bake "succeeded" into the
   * transcript permanently: right until a reload, wrong after it.
   *
   * **The one envelope this must not claim** is `outcome: "unknown"` — the
   * `tool-outcome-unknown` result (`src/agent/tools.ts`), which is *not* a
   * failure. It carries `ok: false` and an `error` string, so a check that reads
   * only `ok` files a "the tool failed" badge onto a call whose effect is
   * genuinely unknown. It is excluded by its own discriminator, first, in
   * {@link toolResultFailure}.
   *
   * ## One method, not one per state
   *
   * Four call sites, four states, and a fifth state that is *not* `output-*` and
   * a sixth that is a failure the envelope does not admit. A method per state
   * would be six seams to keep in step with a rule that is five lines long, and
   * the fifth and sixth are exactly the ones a per-state signature would have
   * nowhere to put. The event carries the fact; {@link toolPartContent} decides
   * the state.
   *
   * Upsert, keyed on a `partId` **derived** from the `toolCallId`: the same call
   * is reported three times (call, result, and again on a replay), and three
   * minted ids would be three rows for one call.
   */
  upsertPart(input: { sessionId: string; messageId: string; event: ToolPartEvent }): Promise<void>;
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

  /**
   * Send a prompt, stream, run tools, retry — and **own the prompt's row**.
   *
   * ## Why the engine persists the user's prompt, and not the app
   *
   * The app wrote it (`lib/runtime.ts`'s `recordUserMessage`) and the engine's
   * contract had nowhere to put it. That is work at the wrong layer, and the
   * argument is not "the engine is lower down" — it is four things, each of
   * which the app cannot do:
   *
   * 1. **The engine receives it.** `run(prompt)` is the only place the text
   *    enters the system, and `baseMessages` is the transcript the retries are
   *    computed from. An app that also holds the prompt holds a *second* copy
   *    that nothing reconciles, and the two drift the first time a retry,
   *    an approval resume or a `regenerate` happens.
   * 2. **§6.1 wants it in `seq` order with the rest of the transcript, and
   *    `seq` is allocated by whoever writes first.** The engine writes the
   *    assistant message and the `idle` outcome; the app wrote the prompt. A
   *    turn whose prompt is written by the other party has its ordering decided
   *    by a race, and `UNIQUE (session_id, seq)` turns that race into a
   *    constraint failure — which is the failure the UI actually hit.
   * 3. **The retry rule is an engine rule.** §5.4: a retry re-sends the
   *    original prompt and the failed attempt's text is never copied forward.
   *    For the prompt to be written once per turn while the *attempts* are
   *    separate, the party that decides "this is a retry" has to be the party
   *    that wrote it. Otherwise a UI that misses one `attempt-started` event
   *    produces a transcript with two questions in one turn, or none.
   * 4. **The crash window.** A turn that dies before its first delta has
   *    produced nothing yet; the prompt is the only thing the user is
   *    guaranteed to have sent, and it is the one thing that has to survive.
   *
   * ## Why the flush is here and not at a step boundary
   *
   * **Before the first model call, awaited**, and that is the contract:
   *
   * - A step boundary is only reached *after* the model produced something. A
   *   turn that fails at the first request — 401, quota, a connection that never
   *   opened — would never reach one, and those are exactly the turns a user
   *   comes back to after fixing a key. The question would be in no store.
   * - `seq` has to be deterministic. If the flush waits for the first delta, a
   *   fast provider can emit the assistant message before the prompt row lands,
   *   and the transcript reads assistant-then-user.
   * - §6.2's checkpointing exists for work already done (`onStepEnd`); the prompt
   *   is the first thing that exists, so it belongs at the first possible
   *   moment rather than the first *interesting* one.
   *
   * ## Once per turn, not once per attempt
   *
   * A retry re-sends the *same* prompt into the *same* turn, so the row is
   * written once and the attempts differ in the assistant message. The prompt
   * message id is minted here and threaded into every attempt for the same
   * reason: it used to be minted per attempt, so a retried turn put the same
   * question in the log under a different id each time.
   */
  async run(prompt: string): Promise<TurnResult> {
    const { stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS } = this.#options;
    const attemptLog: AttemptRecord[] = [];
    const baseMessages = [...(this.#options.messages ?? [])];
    /** Retries already spent on an *unrecognised* error type (§5.4: only one). */
    let unknownErrorRetries = 0;

    /**
     * The prompt's message id, or `undefined` when there is no prompt.
     *
     * `undefined` is the resumed-approval case: `#continue` re-sends the
     * transcript with no new question, and writing an empty user message there
     * would put a blank bubble in the log.
     */
    const promptMessageId = prompt === "" ? undefined : newMessageId();

    if (promptMessageId !== undefined) {
      const failure = await this.#persistPrompt(prompt, promptMessageId);
      if (failure !== undefined) return failure;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.#controller.signal.aborted) break;

      const delay = attempt === 1 ? 0 : (nextDelayMs(attempt, undefined, this.#random) ?? 0);
      this.#emit({ type: "attempt-started", attempt, total: MAX_ATTEMPTS, retryAfterMs: delay });
      if (delay > 0) await this.#sleep(delay, this.#controller.signal);
      if (this.#controller.signal.aborted) break;

      // A retry always starts from the *original* transcript. This is the
      // mechanical guarantee behind "Nie wird der Teiltext eines fehlgeschlagenen
      // Versuchs in den neuen kopiert" (Plan.md §5.4).
      const observation = await this.#runAttempt(baseMessages, prompt, attempt, promptMessageId);

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
    // `promptMessageId` is `undefined` and nothing is persisted: the question
    // was asked and written once, by `run`.
    const observation = await this.#runAttempt(messages, "", 1, undefined);
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

  /**
   * Write the turn row, the prompt's message row and its text part.
   *
   * **Awaited, in that order, before the first model call** — the ordering is
   * the foreign keys' (`parts` → `messages` → `turns`) and the argument for
   * doing it here at all is on {@link AgentTurn.run}.
   *
   * The text goes into a **part**, not into `messages`, because §6.1's schema
   * has no text column on `messages` and the read port renders parts. It is
   * written through {@link TurnStore.flushDelta} + {@link TurnStore.closePart}
   * rather than a new method, and that is not a shortcut: those two *are* the
   * engine's protocol for "a part whose text is now known", the delta id makes
   * the write idempotent, and reusing them means the prompt's part lands in the
   * same transaction shape as every other part instead of in a second code path
   * that has to be kept in step.
   *
   * A **rejection is a `failed` turn, not a thrown `run()`** — `AGENTS.md` §5:
   * what the user must see becomes a typed event. And it does *not* call
   * `finishTurn`, because there is no turn row to finish in the usual case; the
   * row that does exist is left for `recoverStaleTurns`, which is the designed
   * path for "a turn began and did not finish".
   *
   * @returns the failed `TurnResult`, or `undefined` when the write succeeded.
   */
  async #persistPrompt(
    text: string,
    messageId: string,
  ): Promise<TurnResult | undefined> {
    const { store, sessionId, turnId, now = Date.now } = this.#options;
    const at = new Date(now()).toISOString();
    /** Part id, minted once so a replay of this write lands on the same row. */
    const partId = newMessageId();
    try {
      await store.appendTurn({ id: turnId, sessionId, startedAt: at });
      await store.appendMessage({
        id: messageId,
        sessionId,
        role: "user",
        turnId,
        createdAt: at,
        updatedAt: at,
      });
      await store.flushDelta({
        deltaId: `${turnId}#prompt#${partId}#0`,
        partId,
        messageId,
        sessionId,
        partType: "text",
        contentText: text,
      });
      // `completed`, not `streaming`: the user is done typing, and a prompt
      // marked in flight is a part a reload renders as "still being written".
      await store.closePart({ sessionId, messageId, partId, status: "completed" });
      return undefined;
    } catch (error: unknown) {
      /**
       * `protocol-error`, not `no-response` and not a bare throw.
       *
       * §5.4's "no response at all" means *the provider* went quiet, and this
       * is the opposite: the turn never left the tab, so the user's wait was
       * for a request that was never sent. `protocol-error` is retryable, which
       * is also right — the next attempt re-runs the same flush against a
       * database that may have been reopened.
       *
       * **This is the call site that leaked, and the one that reached the
       * screen.** A `Classification.reason` is rendered verbatim by the app's
       * `failureView` (`protocol-error`), so whatever {@link
       * describeStorageFailure} returns here lands in a sentence on a status
       * bar — which is why that function returns a class name and not the
       * store's message. The prefix names the **operation**, and that is the
       * half of the diagnosis that is ours; see the function for why the text
       * cannot be.
       */
      const classification: Classification = {
        kind: "protocol-error",
        reason: `the turn could not be persisted: ${describeStorageFailure(error)}`,
      };
      this.#emit({ type: "error", error, classification });
      this.#emit({ type: "turn-finished", outcome: "failed", attempts: 0 });
      return {
        outcome: "failed",
        // Zero: no attempt was ever made. Reporting 1 would claim a request
        // left the process, and the whole point of failing here is that it did
        // not — which is the cheaper direction to be wrong in.
        attempts: 0,
        text: "",
        classification,
        attemptLog: [],
        openApprovals: [],
        messages: [...(this.#options.messages ?? [])],
        hitStepLimit: false,
        unknownOutcomes: [],
      };
    }
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
    promptMessageId: string | undefined,
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
     * `terminalEvent` is the success signal, and it is a **three-state
     * observation** rather than a boolean because the fields it is derived from
     * are not populated on every provider path. How it is established — and what
     * is *not* observable here — is documented at the `finish` case below and on
     * `TerminalEvent` in `stream/classify.ts`.
     */
    let text = "";
    let reasoning = "";
    /**
     * Starts `"absent"` and is folded forward by every `finish` part.
     *
     * The fold is monotone towards the worse state — a turn whose second step
     * was cut must not be excused by its first step's clean `finish`. See
     * `mergeTerminalEvent`.
     */
    let terminalEvent: TerminalEvent = "absent";
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

    /**
     * Persist one tool part, and report a failure as a typed event.
     *
     * **Awaited, and that is the decision here.** `heartbeat` above and
     * `recordToolCall` below are fire-and-report, and each has a reason that
     * holds: a lost heartbeat costs an anchor and a lost record costs a proof,
     * and neither can make the *stored state* wrong. A tool part is different.
     * The writes arrive in order — call, then result, and possibly a denial
     * instead — and each one lands on the **same row**. Fired rather than
     * awaited, a result can be overtaken by the call it follows and overwrite it
     * back to `input-available`, leaving a card frozen mid-flight in the
     * database, where no reload will ever correct it.
     *
     * Awaiting costs one row write per tool event, and that is not the hot path:
     * §6.2's buffered-delta rule is about *tokens*, and a tool call is one event
     * per step. The `tool-call`/`tool-result` pairing is what a tool that both
     * streams text and calls a tool looks like, and it is why the ordering is
     * not an optimisation to leave for later.
     *
     * Awaited, but a **failure is not fatal**: the model already holds the
     * tool's real output and the call really did happen, so a store that cannot
     * take the row costs a card after a reload rather than an answer. `AGENTS.md`
     * §5 says what the user must see becomes a typed event, so the report is
     * `storage-warning` and not a `catch {}`.
     */
    const upsertToolPart = async (event: ToolPartEvent): Promise<void> => {
      try {
        await store.upsertPart({ sessionId, messageId, event });
      } catch (error: unknown) {
        emit({
          type: "storage-warning",
          operation: "upsert-part",
          attempt,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          message: describeStorageFailure(error),
        });
      }
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
            {
              // The id the prompt was **persisted** under, not a fresh one.
              // It used to be minted per attempt, so a retried turn carried the
              // same question under a different id each time and the log grew
              // one row per attempt for a turn that asked it once.
              id: promptMessageId ?? newMessageId(),
              role: "user",
              parts: [{ type: "text", text: prompt }],
            },
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
            await upsertToolPart({
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
            // The row, and the point of the whole method: `part.output` is the
            // *value*, and a value of `{ ok: false, error }` is a failure the
            // nominal `output-available` does not admit. Persisted raw, that state
            // would survive every reload.
            await upsertToolPart({
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
            // Practically unreachable (`createSdkTool` converts every throw into
            // a result), and written anyway: the SDK's own catch is the one path
            // that would reach it, and a card that never learned about a failure
            // is worse than a redundant write.
            await upsertToolPart({
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
            // `output-denied` and not `output-error`, and the value here is
            // `undefined` so the derivation cannot promote it: a refusal is a
            // legitimate answer the model routes around (§7.6).
            await upsertToolPart({
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
             * The terminal-event check — and the reason it reads **two** fields
             * is written out here, because this is the line that used to be a
             * bug.
             *
             * It read `sawTerminalEvent = part.rawFinishReason !== undefined`.
             * That field alone is **not** a discriminator. Measured against the
             * installed providers:
             *
             * | path | `raw` on a **clean** completion | source |
             * |---|---|---|
             * | `@ai-sdk/openai` chat | `choice.finish_reason`, always set | `raw: choice.finish_reason` |
             * | `@ai-sdk/openai` **responses** | `incomplete_details?.reason` — **absent** | `raw: value.response.incomplete_details?.reason ?? void 0` |
             * | `@ai-sdk/anthropic` | `delta.stop_reason`, always set | |
             * | `@ai-sdk/google` | `candidate.finishReason`, always set | |
             * | `@ai-sdk/openai-compatible` | `choice.finish_reason`, always set | |
             *
             * `incomplete_details` is a field of an *incomplete* response, so a
             * clean `response.completed` does not carry it — and every
             * successful OpenAI Responses turn therefore read as a truncated
             * stream and was retried three times, for an answer that had already
             * arrived. It was found by a UI agent reading the installed package,
             * not by a core test, because the mock model always filled the
             * field: a mock that only knows the populated shape cannot see a
             * check that is wrong about the *unpopulated* one.
             *
             * `readTerminalEvent` (in `stream/classify.ts`, which owns the rule)
             * reads both fields. The SDK's own initial values for a step are
             * `("other", undefined)`, and a `finish` part is synthesised from
             * them **only** when no provider terminal chunk arrived — so a part
             * still holding both is the SDK reporting a cut stream, and a part
             * holding **either** a provider reason or a non-placeholder reason
             * is a provider's. Both halves are load-bearing: `raw` alone misses
             * the clean Responses turn, and `finishReason !== "other"` alone is
             * the check this replaced, which fired on a provider that terminates
             * deliberately and was retried for an answer that had arrived.
             *
             * The error direction is why this is worth the care: a false
             * "truncated" costs three requests and a visibly duplicated answer
             * **on a correct response**; a missed truncation costs one turn the
             * user regenerates.
             *
             * **What is still not observable, honestly:** the provider's *raw*
             * chunk stream, so §5.4's SSE-level `data: [DONE]` cannot be seen
             * from here at all. `ToolLoopAgentSettings` has no `onChunk`, no
             * `includeRawChunks` and no `onError` (verified against the
             * installed `dist/index.d.ts`). Reaching it means wrapping the
             * `LanguageModel` in the provider registry — a separate decision,
             * not taken here. Recorded as a limitation in Plan.md §5.4 rather
             * than papered over, because a check that pretends to be raw when it
             * is not is how this bug happened.
             */
            terminalEvent = mergeTerminalEvent(terminalEvent, readTerminalEvent(part));
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
            terminalEvent,
            sawErrorEvent: sawErrorPart,
            errorEvent: streamError,
          },
        }),
        error: streamError,
        ...shape,
      };
    }

    /**
     * Step 5 of the plan's order, asked of the **one** implementation.
     *
     * This branch used to carry its own predicate — `if (terminalEvent !==
     * "provider")` — which is the second rule set Plan.md §5.4's correction
     * block exists to forbid, and it was already drifting: the loop could
     * disagree with the classifier about the same facts, and nothing would say
     * so. It also made the code untestable in the only direction that matters:
     * with the installed SDK, `flush()` always synthesises a closing part, so
     * `"absent"` never reaches this line and a mutation from `!== "provider"`
     * to `=== "synthesized"` changed nothing any test could see.
     *
     * So the loop no longer decides. It hands the facts to
     * {@link classifyResponse} and follows the verdict, and its only remaining
     * job is to attach an `Error` for the failure — a turn that produced output
     * and was cut has no thrown value to report, and `TurnResult.error` is
     * typed `unknown`, so the classifier's own reason string is the honest
     * thing to hand back.
     */
    const classification = classifyResponse({
      responded: true,
      stream: { partCount, terminalEvent, sawErrorEvent: sawErrorPart },
    });
    if (classification.kind === "success") {
      return { kind: "success", text, ...shape };
    }
    return {
      kind: "failed",
      text,
      classification,
      error: new Error(describe(classification)),
      ...shape,
    };
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

/* ------------------------------------------------------------------ */
/* The tool part — the mapping, in the engine's vocabulary             */
/* ------------------------------------------------------------------ */

/**
 * The four tool events that are a tool part's lifecycle.
 *
 * `Extract` on the engine's own event union, so the seam cannot drift from
 * `AgentEvent` and the members are the *engine's*, not a hand-written
 * near-copy. **`tool-outcome-unknown` is not in here**, and that is the point:
 * it has its own node in the transcript (`Plan.md` §5.1) because a card claiming
 * an outcome is the lie the event exists to prevent, so there is no state to
 * write and no caller that could ask for one. The *envelope* that event's result
 * carries is a different thing entirely and is handled below, on the value.
 */
export type ToolPartEvent = Extract<
  AgentEvent,
  { type: "tool-call" | "tool-result" | "tool-error" | "tool-output-denied" }
>;

/**
 * The states a tool part can be in (`Plan.md` §15.5, plus the two the SDK adds
 * and the plan does not name).
 *
 * `output-denied` is the one that is easy to get wrong: a refusal is a
 * legitimate answer the model reads and routes around (§7.6), so it must not
 * wear the same state as a failure.
 */
export type ToolCardState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

/**
 * What a stored tool part's `data` blob carries (`Plan.md` §6.1).
 *
 * The shape a reader has to understand, and the reason the **discriminator**
 * carries the name: `ToolUIPart`'s `type` is `` `tool-${NAME}` `` and there is no
 * `toolName` field to read back, so a reader looking for one finds nothing.
 */
export interface StoredToolPart {
  readonly type: string;
  readonly toolCallId: string;
  readonly state: ToolCardState;
  readonly input: unknown;
  readonly errorText?: string;
  readonly output?: unknown;
}

/**
 * The tool part an event asks for, minus the row it is written into.
 *
 * Everything here is a fact about the call, and none of it is the storage
 * layer's business: which part the write belongs to, what the state is, what the
 * part says, and what it contributes to the searchable projection. What the
 * `data` blob looks like *on disk* — a JSON string in a `parts` row, with
 * `status` and the timestamps — is the adapter's, and it is the whole of what
 * the adapter is left to decide.
 */
export interface ToolPartContent {
  /** Derived from the `toolCallId`, never minted — see {@link TurnStore.upsertPart}. */
  readonly partId: string;
  /** The `data` blob, as a **value**. Serialising it is the adapter's job. */
  readonly data: StoredToolPart;
  /** §6.1's denormalised, searchable projection. */
  readonly contentText: string;
}

/**
 * The failure message a tool **result** carries, or `undefined`.
 *
 * ## Why the value decides and not the state
 *
 * `Plan.md` §5 wants a model-visible failure instead of a broken step, so
 * `createSdkTool` catches everything `definition.execute` throws and returns
 * `{ ok: false, error }` as an ordinary **result** (`toToolErrorResult`,
 * `src/tool.ts`). The consequence is concrete: a part written only from the
 * event's nominal state persists `output-available` for a tool that failed, and
 * persists it **permanently** — the live card would be right until the reload and
 * wrong after it, which is the one direction a card must not be able to drift.
 *
 * ## The one envelope this must not claim
 *
 * `tool-outcome-unknown` also returns `ok: false` **with** an `error` string
 * (`src/agent/tools.ts`). It is not a failure; it says the call began and never
 * reported, so its effect is unknowable. Claiming it here would paint
 * "Fehlgeschlagen" onto a card whose state is a warning, so it is excluded by
 * its own discriminator, and **first** — before the `ok` is even read.
 *
 * The `error` must also be a non-empty string, not merely present: a tool is
 * free to return `{ ok: false }` as an ordinary value, and a row that claims a
 * failure without saying why renders an empty red card.
 */
export function toolResultFailure(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as Record<string, unknown>;
  if (record["outcome"] === "unknown") return undefined;
  if (record["ok"] !== false) return undefined;
  const error = record["error"];
  return typeof error === "string" && error !== "" ? error : undefined;
}

/**
 * The state a **result** turns its nominal state into.
 *
 * Only `output-available` is reconsidered. Every other state is a fact the engine
 * reported on purpose — `output-denied` is a refusal and `output-error` is an
 * SDK-caught rejection — and re-deciding one of those from a value would let a
 * tool's own payload overrule the engine.
 */
export function toolStateForResult(state: ToolCardState, output: unknown): ToolCardState {
  if (state !== "output-available") return state;
  return toolResultFailure(output) === undefined ? "output-available" : "output-error";
}

/**
 * The part id for a tool call: `part-${toolCallId}`.
 *
 * Derived rather than minted, because the same call is reported up to three
 * times (call, result, and again on a replay) and three minted ids would be
 * three rows for one call. The prefix keeps it recognisable in a row dump.
 */
export function toolPartIdOf(toolCallId: string): string {
  return `part-${toolCallId}`;
}

/**
 * The value a tool event carries, which is what the state is derived from.
 *
 * `undefined` for a denial, and that is a fact: a refusal has no output, and a
 * row claiming one would render an empty result on a card that correctly says
 * "Abgelehnt".
 */
function toolEventValue(event: ToolPartEvent): unknown {
  switch (event.type) {
    case "tool-call":
      return event.input;
    case "tool-result":
      return event.output;
    case "tool-error":
      return event.error;
    case "tool-output-denied":
      return undefined;
  }
}

/** The state each event reports, before the value is consulted. */
function toolEventState(event: ToolPartEvent): ToolCardState {
  switch (event.type) {
    case "tool-call":
      return "input-available";
    case "tool-result":
      return "output-available";
    case "tool-error":
      return "output-error";
    case "tool-output-denied":
      return "output-denied";
  }
}

/**
 * The best text a value can contribute to a searchable projection.
 *
 * A tool part's `content_text` is the **rendered input** (§6.1: the column is the
 * denormalised projection), so a search for a path finds the call that made it.
 * `JSON.stringify` returns `undefined` for a function or `undefined`, which is
 * why the fallback exists, and which is why a value that cannot be serialised
 * falls back to `String` rather than to nothing.
 */
function textProjection(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * The part one tool event asks for.
 *
 * **The one place this decision is made.** Four events, four nominal states, and
 * one correction that can turn exactly one of them into a different one — the
 * value of a `tool-result` that is a failure envelope. Before this lived here it
 * lived in the app, next to a reader that applied the same rule again, and the
 * two could disagree; a rule that decides what a reloaded card says belongs on
 * the side that writes the row, and is stated once.
 *
 * `errorText` has a second source on purpose. A `tool-error` event carries its
 * message as a **string**, and `toolResultFailure` reads the object envelope, so
 * the string is the fallback — neither path may end up storing `output-error`
 * with nothing to render, which is how a row ends up claiming a failure and
 * staying silent about why.
 */
export function toolPartContent(event: ToolPartEvent): ToolPartContent {
  const value = toolEventValue(event);
  const state = toolStateForResult(toolEventState(event), value);
  const failure = toolResultFailure(value) ?? (state === "output-error" ? textProjection(value) : undefined);
  return {
    partId: toolPartIdOf(event.toolCallId),
    contentText: textProjection(value),
    data: {
      type: `tool-${event.toolName}`,
      toolCallId: event.toolCallId,
      state,
      input: value,
      ...(failure === undefined ? {} : { errorText: failure }),
      // Only a result that *is* one carries an output. The failure envelope's
      // whole content is its `error` string, and storing both would say the same
      // sentence twice.
      ...(state === "output-available" ? { output: value } : {}),
    },
  };
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
 * The one-line description of a store failure — the text a `storage-warning`
 * carries, and the tail of the `protocol-error` reason the prompt-persist
 * failure builds.
 *
 * ## The class name, and why the message is not an option
 *
 * **This function used to return `error.message`, and that was a live key leak.**
 * The store is injected, so what it throws is not this package's text: a worker
 * that forwards a provider rejection, or a store that reports the last request
 * it made, hands back a string that *is* the provider's — and Google's 401
 * quotes the key back inside it. The measured shape was
 *
 * ```text
 * the turn could not be persisted: 401 from Google: key sk-live-4f9a1c2b7e8d is invalid
 * ```
 *
 * becoming a `Classification.reason`, and a `reason` is rendered (`failureView`,
 * `protocol-error`, in the app). So the rule is not "be careful with this
 * string": an arbitrary `Error.message` is the one shape in this program that
 * can carry a key, and this was the path that reached the screen.
 *
 * **The alternative was redaction, and it is not one.** A redactor is a *deny*
 * list over a field the foreign side chose; a whitelist is a *permit* over a
 * field we chose. The first is unfalsifiable — the key can be in any format, and
 * a pattern that misses one is a hole nobody can test their way out of, because
 * the formats are not enumerable. The second closes by choosing a different
 * field. `error.name` is a class name by contract: `StorageError` (see
 * `describeReadFailure` in the web runtime, which already made this exact
 * trade), `Sqlite3Error`, `TypeError`, `DOMException`. A redactor's coverage is
 * an argument; a field choice is a fact.
 *
 * **What is lost, stated plainly.** For the real store the name is
 * `StorageError` for all nine `StorageErrorCode`s, so `sql_error` and
 * `database_owned_by_another_context` become the same eleven characters here.
 * That is a real loss and it is **mislocated, not destroyed**: the code is a
 * closed vocabulary owned by `baah-storage`, and the layer that sits next to
 * that vocabulary is the one that should read it — which is what
 * `describeReadFailure` does, and the reason this cannot. `TurnStore` is an
 * injected interface and does not carry a `code`; duck-typing one here would
 * have the engine vouch for a string an arbitrary implementation wrote, which is
 * the same mistake one layer down. A warning is not a verdict (the turn
 * continues), and nothing the engine can do about a code is different from
 * nothing.
 *
 * **What carries the diagnostic value instead** is the `operation` on the
 * event, and it is a field of ours: `heartbeat`, `record-tool-call`,
 * `upsert-part`, plus the `protocol-error` reason's own "the turn could not be
 * persisted". Which write failed was never answered by the text; the text
 * answered "which SQL", and SQL is the adapter's business, not the engine's and
 * not the user's.
 *
 * ## The empty name
 *
 * `error.name === "" ? "Error" : error.name` is a **narrowing** guard, not a
 * default: the alternative to an empty string here is not a better name, it is
 * a sentence with a hole in it — and the rendered case is the literal prefix
 * plus nothing, which reads as "no failure was reported" rather than "the
 * failure had no name".
 *
 * Which case it guards, so the next reader does not have to re-derive it: **not**
 * `new Error("")`, whose *message* is empty and whose name is `"Error"`; **not** a
 * subclass with no `name` of its own, which inherits `Error.prototype.name` and
 * already reads `"Error"`. It is an `Error` whose `name` was *overwritten* with
 * the empty string. Nothing in this repository does that — the pinned
 * implementation is the only writer — and it stays because `TurnStore` is an
 * injected seam: a third-party store's rejection is a value this package has
 * never seen, and this is the one malformed shape a foreign writer can produce
 * without producing anything at all.
 *
 * ## The non-`Error` case
 *
 * A constant, not `String(value)`. `String` is the same leak with one fewer
 * ceremony — the thrown value *is* the foreign text — and it was the second
 * branch of the original. `"non-Error value"` is not less information than a
 * truthy string would be: it says the store broke in a way that is not even an
 * `Error`, which is itself the diagnosis (a `postMessage`'d raw value, a
 * `throw "…"`), and it says it in a form that cannot vary.
 */
function describeStorageFailure(error: unknown): string {
  if (error instanceof Error) return error.name === "" ? "Error" : error.name;
  return "non-Error value";
}

export type { ToolSet, AiToolSet, UIMessageChunk };
