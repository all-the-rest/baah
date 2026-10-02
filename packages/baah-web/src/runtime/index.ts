/**
 * The composition root.
 *
 * ## One module, no React, no JSX, no hooks
 *
 * `App.tsx` and `main.tsx` belong to the UI block and are untouched. Everything
 * between "the app boots" and "the UI can ask for a turn" is here, expressed as a
 * plain object with async methods and a subscribe callback. React's
 * `useSyncExternalStore(runtime.subscribeState, runtime.getState)` is the
 * adapter, and it belongs to the component that needs it.
 *
 * The reason is verification, not taste: a runtime that can be exercised in vitest
 * with no DOM and no Playwright is a runtime whose behaviour is *measured*
 * (AGENTS.md §6). Every rule below — the awaited `resolve`, the single path into the
 * store, the 30 s recovery threshold, the per-origin error codes — has a test that
 * fails when the rule is removed.
 *
 * ## Where an error gets its `code`
 *
 * `toRuntimeError(error, origin)` — and `origin` is passed by the **call site**,
 * never guessed from the message. There are eight `fail(error, origin)` calls and
 * each names the subsystem that was doing something when the error escaped; a
 * mismatch is not a vague label but a wrong one (a storage failure during a turn
 * reported as "the settings could not be saved" sends the user to a screen where
 * nothing is wrong). `error.origin-unknown.test.ts` pins the mapping, and pins that
 * the other half still holds: an arbitrary `Error.message` is never forwarded, for
 * any origin.
 *
 * ## What is injected and why
 *
 * | dependency            | injected because                                          |
 * | --------------------- | -------------------------------------------------------- |
 * | `store` (`TurnStore`) | `baah-storage` is a sibling, not a dependency (§4). Importing it here would be a second path to the database — the thing `Plan.md` §16.1 refused for the adapter. |
 * | `tools`               | `question` needs a UI channel and `todo` a store; which tools exist is the UI block's wiring decision. |
 * | `workspace`           | `createMemoryWorkspace` in tests, a real directory in the app. |
 * | `registry`            | The vendor SDKs are imported in `providers/factories.ts` and nowhere else, so a test can hand in a registry of fakes. |
 *
 * ## The two call sites, and what is still one of them
 *
 * - **Reload recovery at boot** — still this layer's. `recoverStaleTurns` and
 *   `STALE_HEARTBEAT_MS` exist in core and nothing calls them; `boot()` is the
 *   caller (`recovery.ts`).
 * - **Delta persistence** — **no longer** this layer's, and the reason is worth
 *   reading before anyone adds it back. The engine grew a per-part streaming writer
 *   while this block was being built (`DELTA_FLUSH_INTERVAL_MS`, `closePart`,
 *   `closeTurnParts`): it flushes each open part on a 100 ms interval and
 *   unconditionally when the part ends. The app-side `flushDelta` writer this file
 *   used to hold is therefore gone, and `runtime.test.ts` asserts the invariant
 *   that replaced the assertion about it — **every persisted delta carries a part id
 *   the engine minted, and each part is written exactly once.** Both halves matter:
 *   a second writer cannot mint an engine part id, and it would double the rows for
 *   a part the engine already flushed. That is the duplication `Plan.md` §16.1
 *   refused for the `TurnStore` adapter. What the app still owns is *observing* the
 *   step boundary: `handleEvent` receives `step-end` and publishes the step count, so
 *   the UI can say "step 2 of 7" from the same event the engine checkpoints on.
 *
 * ## The stall watchdog is a UI affordance, not §5.4's `no-response`
 *
 * `StallWatchdog` (`watchdog.ts`) looks like §5.4's stall detector and is not one.
 * §5.4's `no-response` verdict is a **classification**, and the engine produces it:
 * `stream/classify.ts` returns `{ kind: "no-response" }` for "nothing came back" and
 * for an abort-like error, and `agent/loop.ts` consumes that — it emits `waiting`,
 * finishes the turn `interrupted`, and writes the reason to the turn log. That is
 * the §5.4 behaviour, and it is in core.
 *
 * The watchdog is the other thing: an app-side observation that the turn has been
 * silent for a window, published so a UI can show "still waiting" with a stop button.
 * It carries `silentForMs` and `lastEventType`, it has no `Classification`, and it
 * **deliberately cannot end the turn** — `AgentTurn.stop()` would abort a provider
 * that may still be generating, and §5.4 says a stall is a waiting state plus a
 * manual action, never an automatic one.
 *
 * The distinction is stated here because the two are easy to confuse and the
 * confusion is expensive: a reader who sees a "stall watchdog" in the app and reads
 * it as §5.4's verdict will conclude §5.4 is done. It is not. What is still open is
 * what §5.4 asked for and neither piece does — measuring the *raw* provider chunks,
 * which belongs to the transport, in core.
 *
 * ## The `await` on `ProviderRegistry.resolve`
 *
 * It is `async` because the memo key is a `crypto.subtle` digest of the API key
 * (`provider/registry.ts`), and AGENTS.md §2 makes `crypto.subtle` the only
 * hashing primitive here. Dropping the `await` yields an object typed
 * `LanguageModel` that is actually a `Promise`, and the failure surfaces three
 * layers down as a provider error — the worst place to find it. So
 * {@link assertResolvedLanguageModel} runs on the value right after the await and
 * throws on a thenable. Two lines of guard, and it lives in its own module
 * (`guard.ts`) for the reason written there: while the `await` is present the guard
 * can never *fire*, so "is it called?" is only answerable by intercepting the
 * import — which "the guard is wired into the resolve" in
 * `error.origin-unknown.test.ts` does.
 *
 * ## The two call sites the loop does not own
 *
 * 1. `recoverOnBoot` — reload recovery at start-up (`recovery.ts`). Still here.
 * 2. `store.flushDelta` — was here, and is **not** any more. See above.
 *
 * ## A parked turn is not a finished turn
 *
 * The engine resolves `run()` with `outcome: "awaiting-approval"` **because** it
 * intends to be continued: the SDK is holding the loop open until
 * `respondToApproval` marks the pending part `approval-responded`, and
 * `AgentTurn.respondToApproval` is the only path that does. So `runTurn`'s `finally`
 * used to destroy the answer — it cleared `turn`, `watchdog` and `turnId`
 * unconditionally, `answerApproval` opened with `if (turn === undefined) throw`, and
 * every click on every approval card failed while the turn stood there forever.
 *
 * The rule now, in one line: **release the turn unless the result parks it.**
 * `isParked(result)` is the whole predicate, and it is asked of every result rather
 * than of the first one, because `#continue` can park a second time on another call.
 *
 * Three things are held while parked, each for its own reason, and the full argument
 * is on the `finally` itself: the `AgentTurn` (the only route to the resume), its
 * `turnId` (`settle` needs it, and the resume is a second `settle`) and its
 * `StallWatchdog` (whose `approval-requested` / `approval-answered` pair already
 * models "the human is the bottleneck" as `awaiting-human`).
 *
 * `status` is the fourth thing and the subtle one. It reads `idle` while parked —
 * nothing is running, and `turn-view.ts` turns `outcome: "awaiting-approval"` into
 * "Wartet auf eine Freigabe." — and `running` for the duration of the continuation,
 * because a card answered into a status bar that still says `idle` claims the turn
 * ended at the moment the model is being asked again. The `inFlight` guard is held
 * across the pause for `Plan.md` §15.5: a second `send` must not replace the turn
 * that owns the open card.
 *
 * ## The read port, and the shape of its failure
 *
 * `Plan.md` §16.1's second port: `baah-storage` exports a `TranscriptReader`
 * with one method, and the app takes it *beside* the `TurnStore` rather than
 * merged into it. It is **optional** here, and that is a deliberate reading of
 * the dependency rather than laziness: every existing caller — including
 * `runtime.test.ts` — would have to grow a port it does not have, and a
 * required field would be a compile error in a test suite that is already
 * correct. Omit it and {@link BaahRuntime.readTranscript} answers
 * `kind: "unavailable"`, a third state that is never an empty session.
 *
 * ### The port's types are the **real** ones, imported
 *
 * They were declared here structurally, and the header used to name that as a
 * duplication with a cost: `@all-the.rest/baah-storage` *is* a dependency of this
 * package, so the local declarations were a second, unchecked copy of another
 * package's types, and the check that used to be free — a missing dependency making
 * the import fail to compile — was gone. `components/lib/runtime.ts` papered over
 * that with a function whose parameter was the real type and whose return was the
 * local one, which is a typecheck and not an import.
 *
 * Both are gone. `TranscriptReader`, `Transcript`, `TranscriptMessage`,
 * `TranscriptPart` and `TranscriptRequest` are imported from
 * `@all-the.rest/baah-storage` and re-exported under their own names, so a caller
 * that wants the port holds the port's own type and there is nothing left to drift.
 * The import is **type-only** and is erased at build time, which is why the
 * dynamic-import discipline in the module header is untouched: no SQLite-WASM glue
 * reaches this file's bundle.
 *
 * What the narrowing cost, and why it is a gain: `role` and `type` are unions
 * (`MessageRole`, `PartType`) where the local copies said `string`, and
 * `baah-storage` enforces both at its own boundary (`messageRowSchema`,
 * `partRowSchema`, `protocol.ts`). `components/lib/transcript.ts` is a *reader* of a
 * validated port, so it reads a union and passes it into `RenderPart.role: string` —
 * no change of behaviour, and the validation happens once, at the producer, instead
 * of twice.
 *
 * ### The one type that stays here: `TranscriptRead`
 *
 * It is the app's own, because it is the only thing the storage port deliberately
 * does **not** have: a union that keeps "could not read" apart from "nothing there".
 *
 * {@link TranscriptRead} is a **union, not a promise that rejects**, and the two
 * reasons are the two things `Plan.md` §16.1 says will bite the UI:
 *
 * 1. A live part comes back with `status: "streaming"` **and its text**, at most
 *    `DELTA_FLUSH_INTERVAL_MS` behind the buffer. The UI has to render it as in
 *    flight, not hide it — so the type carries the status rather than dropping
 *    the part.
 * 2. **A closed database rejects with `database_closed`; it does not return an
 *    empty transcript.** That is the load-bearing half. A read that failed and
 *    an empty read are different facts, and the UI renders them differently — so
 *    this layer converts the rejection into `kind: "failed"` instead of letting
 *    it escape, and the empty case stays available for the only thing that
 *    actually means it: a session that says nothing.
 *
 * There is no `catch` in the read path of the storage package, and that is the
 * property this type preserves: a failure cannot be mistaken for an answer.
 */

import {
  AgentTurn,
  ProviderError,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type AnyToolDefinition,
  type ProviderRegistry,
  type ProviderSettings,
  type TurnResult,
  type TurnStore,
  type Workspace,
} from "@all-the.rest/baah-core";
import type {
  Transcript,
  TranscriptMessage,
  TranscriptPart,
  TranscriptReader,
  TranscriptRequest,
} from "@all-the.rest/baah-storage";
import type { LanguageModel, UIMessage } from "ai";

import { createObservable, type Observable } from "../lib/observable.ts";
import { apiKeySlot, newId } from "../lib/ids.ts";
import { PROVIDER_CATALOG, parseCatalogId, type ProviderEntry } from "../providers/catalog.ts";
import {
  ModelListError,
  listModelsFromSettings,
  type ModelList,
  type ModelListErrorCode,
  type ModelListOptions,
} from "../providers/models.ts";
import {
  ConnectionProbeError,
  probeFromSettings,
  type ConnectionProbeOptions,
  type ConnectionProbeReport,
} from "../providers/probe.ts";
import type { SettingsDiff, SettingsExportFile, SettingsExportOptions, SettingsSnapshot } from "../lib/settings.ts";
import type { SettingsStore } from "../lib/settings-store.ts";
import { SettingsStorageError } from "../lib/storage.ts";

import { createRuntimeApprovalChannel, type RuntimeApprovalChannel, type RuntimeApprovalOptions } from "./approval.ts";
import { RuntimeError } from "./error.ts";
import {
  RuntimeEventBus,
  type RuntimeErrorCode,
  type RuntimeErrorInfo,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeState,
} from "./events.ts";
import { assertResolvedLanguageModel } from "./guard.ts";
import { recoverOnBoot, type BootReport } from "./recovery.ts";
import { StallWatchdog, type StallReport } from "./watchdog.ts";

/* ------------------------------------------------------------------ */
/* The read port (Plan.md §16.1)                                       */
/* ------------------------------------------------------------------ */

/**
 * What a read produced.
 *
 * Three cases, and the third is the one the type exists for: `ok` with **zero**
 * messages is the only thing that means "here there was nothing". `failed` is a
 * read that did not happen, and a UI that renders it as an empty transcript is
 * stating a falsehood it has no evidence for.
 *
 * The `transcript` it carries is `baah-storage`'s own `Transcript` — imported, not
 * re-declared. See the module header for what that replaced and why the
 * validation now happens once, at the producer.
 */
export type TranscriptRead =
  | { readonly kind: "ok"; readonly transcript: Transcript }
  /** No read port is wired. A wiring gap, not an empty session. */
  | { readonly kind: "unavailable"; readonly reason: string }
  /** The read refused — `database_closed` and its siblings. Never an answer. */
  | { readonly kind: "failed"; readonly reason: string };

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface RuntimeDependencies extends RuntimeApprovalOptions {
  /** The persistence seam. See `TurnStore` in core. */
  readonly store: TurnStore;
  /**
   * The read port (`Plan.md` §16.1). `baah-storage`'s own `TranscriptReader`.
   * Omit it and {@link BaahRuntime.readTranscript} answers `kind: "unavailable"` —
   * never an empty transcript.
   */
  readonly transcript?: TranscriptReader | undefined;
  readonly workspace: Workspace;
  readonly settings: SettingsStore;
  readonly registry: ProviderRegistry;
  /** Which tools the loop may call. See the table in the module header. */
  readonly tools: readonly AnyToolDefinition[];
  /** The session this runtime drives. Recovery is scoped to it (§6.1). */
  readonly sessionId: string;
  /** Workspace-relative working directory. Defaults to the workspace root. */
  readonly cwd?: string | undefined;
  /** System prompt. `instructions`, never `system` (AGENTS.md §3.1). */
  readonly instructions?: string | undefined;
  /**
   * §5.4's stall window. Defaults to the engine's 20 s.
   *
   * The length of the *app-side* watchdog's silence window — see the note on
   * {@link StallWatchdog} for why that is a UI affordance and **not** §5.4's
   * `no-response` verdict, which the engine produces in `classify.ts`.
   */
  readonly stallTimeoutMs?: number | undefined;
  /**
   * Injected for tests; defaults to `setTimeout`/`clearTimeout`.
   *
   * The same seam `StallWatchdog` already offers, exposed here because the stall
   * report is the one thing this layer publishes on a **timer** — everything else
   * is a promise the test can await. Without it, "the snapshot carries a stall" is
   * only testable by sleeping, and a sleep-based test is a test that will pass on a
   * fast machine and fail on a loaded one.
   */
  readonly setStallTimer?: ((callback: () => void, ms: number) => unknown) | undefined;
  readonly clearStallTimer?: ((handle: unknown) => void) | undefined;
  /** §6.1's reload threshold. Defaults to the engine's 30 s. */
  readonly staleAfterMs?: number | undefined;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Injected for tests; defaults to `crypto.randomUUID` (AGENTS.md §5). */
  readonly createId?: ((prefix: string) => string) | undefined;
}

/* ------------------------------------------------------------------ */
/* The surface                                                         */
/* ------------------------------------------------------------------ */

export interface SendOptions {
  /**
   * The user's message. Empty starts a turn with no user message.
   *
   * It does **not** continue an approval pause — that is
   * {@link BaahRuntime.answerApproval} and nothing else, because continuing a pause
   * means answering a specific card, and `AgentTurn.respondToApproval` is the only
   * path that marks the part `approval-responded`, so the SDK's
   * `lastAssistantMessageIsCompleteWithApprovalResponses` fires and the approved tool
   * actually runs. Re-sending the transcript with an empty prompt would reach the
   * model again **without** running the tool: a green turn, a card claiming it read
   * a file, and no read. See the note on `answerApproval` below.
   */
  readonly prompt?: string | undefined;
  /** The restored transcript. `UIMessage[]` is the storage truth (§3.1). */
  readonly messages?: readonly UIMessage[] | undefined;
}

export interface PreparedSettingsImport {
  readonly diff: SettingsDiff;
  /** Applies the validated snapshot. Called only after the user agreed. */
  readonly apply: () => SettingsDiff;
}

export interface BaahRuntime {
  readonly sessionId: string;
  readonly settings: SettingsStore;
  /** `Plan.md` §9's list, for the wizard. */
  readonly providers: readonly ProviderEntry[];
  /** The tool and rule bookkeeping, for a settings screen. */
  readonly approvals: RuntimeApprovalChannel;

  /**
   * Reload recovery, once per boot.
   *
   * Idempotent, and cheap enough to call again when a tab becomes visible: the
   * second call finds nothing unfinished.
   */
  boot(): Promise<BootReport>;

  /**
   * Read the session's transcript back out of the store.
   *
   * **Never rejects.** A rejection is a fact about the database, and a caller
   * that cannot tell a rejection from an empty transcript will render "hier war
   * nichts" about a conversation it failed to read. So the two are different
   * values of a union, and the empty case is reachable only when a read
   * succeeded and the session genuinely says nothing.
   */
  readTranscript(request?: { readonly turnId?: string; readonly limit?: number }): Promise<TranscriptRead>;

  /** Resolve the configured provider. **Awaited** — see the module header. */
  resolveModel(): Promise<LanguageModel>;

  /**
   * Run a turn. Rejects with a typed error while another turn is in flight.
   *
   * **Or while one is parked on an approval** — `Plan.md` §15.5 wants the card to
   * block further operation, and a second turn would take over the `AgentTurn` that
   * owns the open question.
   */
  send(input?: SendOptions): Promise<TurnResult>;

  /**
   * Answer an open approval card and continue the paused turn.
   *
   * The **only** way `Plan.md` §7.6's pause-and-resume is reachable. It publishes
   * `status: "running"` for the duration of the continuation, and resolves with the
   * continuation's own `TurnResult` — or with `undefined` when no pending card
   * matched the id, which is a double click on an already-answered card rather than
   * a turn.
   */
  answerApproval(input: {
    readonly approvalId: string;
    readonly approved: boolean;
    readonly reason?: string | undefined;
  }): Promise<TurnResult | undefined>;

  /** User-initiated stop. Never used by the watchdog (§5.4). */
  stop(): Promise<void>;

  /** The §8.1 connection test. Never throws for a provider problem. */
  probe(options?: ConnectionProbeOptions): Promise<ConnectionProbeReport>;

  /**
   * `Plan.md` §8.1 step 4's model list, read from the provider's own `/models`.
   *
   * **This is what makes the loader reachable at all.** The loader itself was
   * correct and fully unit-tested while nothing in the app could call it, and
   * `ModelList.complete` — the field whose entire reason for existing is "an
   * incomplete list must not look like a complete one" — was a return value no
   * screen ever rendered.
   *
   * The key is read out of the store here for the same reason `probe` does it: a
   * component holding a key can render it, log it and put it in a dependency
   * array. Rejects with a `RuntimeError` carrying **the loader's own code**, so
   * `state.lastError.code` says which of the six failures happened.
   */
  listModels(options?: ModelListOptions): Promise<ModelList>;

  /** §8.2 export. Keys are excluded unless `options.includeApiKeys` says so. */
  exportSettings(options?: SettingsExportOptions): SettingsExportFile;
  /** §8.2 import, validated. Returns the diff; applies nothing. */
  prepareSettingsImport(raw: string): PreparedSettingsImport;
  /** Apply a snapshot `prepareSettingsImport` validated and the user agreed to. */
  applySettings(next: SettingsSnapshot): SettingsDiff;

  readonly state: RuntimeState;
  subscribe(listener: RuntimeEventListener): () => void;
  getState(): RuntimeState;
  subscribeState(listener: () => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Where an error came from, decided by the **call site** and not by the message.
 *
 * The call site knows; the error text does not. `toRuntimeError` receives a bare
 * `unknown`, and everything readable about it is either redacted on purpose (this
 * file never forwards an arbitrary `Error.message`) or belongs to a third party. So
 * the classifier is handed the origin as a parameter instead of inferring one.
 *
 * That matters because the alternative is a *wrong* label rather than a vague one:
 * a storage failure during a turn reported as "the settings could not be saved"
 * sends the user to the settings screen, where nothing is wrong, while the actual
 * fault — a full disk, a closed database — is never looked at. A user who is told
 * the wrong subsystem failed looks in the wrong place first.
 */
export type ErrorOrigin =
  /** Anything raised while running or preparing a turn. */
  | "turn"
  /** Reading or writing the settings. */
  | "settings"
  /** Resolving or probing a provider. */
  | "provider"
  /** Reload recovery. */
  | "recovery"
  /** The settings transfer boundary. */
  | "settings-transfer";

/** The `code` each origin falls back to for an error it does not recognise. */
const FALLBACK_CODE: Readonly<Record<ErrorOrigin, RuntimeErrorCode>> = {
  turn: "turn-failed",
  settings: "settings-write-failed",
  provider: "provider-unresolved",
  recovery: "recovery-failed",
  "settings-transfer": "settings-import-rejected",
};

/** What the user is told, per origin. Never quotes the error's own text. */
const FALLBACK_MESSAGE: Readonly<Record<ErrorOrigin, string>> = {
  turn: "the turn could not be completed",
  settings: "the settings could not be saved",
  provider: "the provider could not be reached",
  recovery: "the interrupted turns could not be closed",
  "settings-transfer": "the settings file could not be imported",
};

/**
 * `ModelListError`'s six codes → this layer's own, **one for one**.
 *
 * A `Record` rather than six `if`s so that a **seventh** code added to
 * `ModelListError` is a type error *here* — the compiler lists the members that are
 * missing, at the one place the mapping lives. A chain of string comparisons would
 * accept a new code silently and fall through to the generic branch, which is the
 * defect this mapping exists to fix.
 */
const MODEL_LIST_CODES: Readonly<Record<ModelListErrorCode, RuntimeErrorCode>> = {
  unknown_provider: "model-list-unknown-provider",
  missing_endpoint: "model-list-missing-endpoint",
  missing_api_key: "model-list-missing-api-key",
  http_error: "model-list-http-error",
  unreachable: "model-list-unreachable",
  malformed_response: "model-list-malformed-response",
};

/**
 * Why a transcript read was refused, in words a user can act on.
 *
 * The store's **`code`** is preferred over its message, and the reason is the
 * same one `toRuntimeError` documents: a `StorageError` message names SQL, a
 * filename or a driver, and the one thing the user can do anything about is
 * `database_closed`. An error the class does not recognise falls back to the
 * class name — never to `error.message`, which is the one shape in this program
 * that can carry a key into a screenshot.
 */
function describeReadFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return `${code}: the stored transcript could not be read. Nothing was lost — the read simply did not happen, so this view cannot say what is in it.`;
    }
  }
  const name = error instanceof Error ? error.name : "unknown error";
  return `${name}: the stored transcript could not be read. This is not an empty conversation.`;
}

function toRuntimeError(error: unknown, origin: ErrorOrigin): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof ProviderError) {
    // `ProviderError`'s messages are written by the registry and never quote the
    // key — which is exactly why they can be shown to a user. The code is added so
    // "a provider that could not be resolved" stays distinguishable from "the turn
    // failed".
    return new RuntimeError("provider-unresolved", `${error.code}: ${error.message}`);
  }
  if (error instanceof SettingsStorageError) {
    return new RuntimeError(
      error.code === "corrupt" ? "settings-corrupt" : "settings-unavailable",
      error.message,
    );
  }
  if (error instanceof ConnectionProbeError) {
    return new RuntimeError("probe-failed", `${error.code}: ${error.message}`);
  }
  if (error instanceof ModelListError) {
    /**
     * The model list, and the reason this is **not** `probe-failed`.
     *
     * It had no case here at all, so every `ModelListError` fell through to the
     * generic branch and arrived as
     * `RuntimeError("provider-unresolved", "ModelListError: the provider could not
     * be reached")` — while `Onboarding.runModelList` renders `error.name`, so the
     * user literally read **„RuntimeError"**. All six of `ModelListError`'s codes
     * became one sentence, which is the exact collapse the six exist to prevent:
     * `models.ts`'s own doc table promises the wizard "reacts differently to each".
     *
     * The mapping is **one for one** rather than a single `model-list-failed`, so
     * `runtime-error-code` on the status bar — and any future branch in the wizard —
     * can tell "the provider answered 401" from "we could not parse what it
     * answered". The message keeps the class's own `code` as a prefix for the same
     * reason `ProviderError`'s does: the union member says which subsystem, and the
     * prefix says which of its six codes.
     */
    return new RuntimeError(MODEL_LIST_CODES[error.code], `${error.code}: ${error.message}`);
  }
  /**
   * The redaction, unchanged and deliberate.
   *
   * An arbitrary `Error.message` is the one shape in this program that can carry a
   * key — Google's 401 quotes it back verbatim — and a `RuntimeError` is rendered
   * on screen and logged. So only the class name survives, whatever the origin.
   * Changing *which subsystem is named* must never become a reason to forward the
   * text; `error.origin-unknown.test.ts` pins both halves together.
   */
  if (error instanceof Error) {
    return new RuntimeError(FALLBACK_CODE[origin], `${error.name}: ${FALLBACK_MESSAGE[origin]}`);
  }
  return new RuntimeError(FALLBACK_CODE[origin], FALLBACK_MESSAGE[origin]);
}

/* ------------------------------------------------------------------ */
/* The runtime                                                         */
/* ------------------------------------------------------------------ */

export function createRuntime(dependencies: RuntimeDependencies): BaahRuntime {
  const {
    store,
    workspace,
    settings,
    registry,
    tools,
    sessionId,
    stallTimeoutMs,
    staleAfterMs,
    now = Date.now,
    setStallTimer,
    clearStallTimer,
  } = dependencies;

  const cwd = dependencies.cwd ?? "/";
  const mintId = dependencies.createId ?? newId;
  const bus = new RuntimeEventBus();
  const approvals = createRuntimeApprovalChannel(dependencies);

  /**
   * Set **synchronously** on entry to `send`, cleared when the turn is over.
   *
   * Not derived from `turn !== undefined`: `send` awaits `resolveModel()` before it
   * constructs the `AgentTurn`, so a second call arriving in that window would find
   * `turn` still `undefined` and start a second turn — two turns interleaving their
   * parts into one transcript, which is exactly what the guard exists to prevent.
   *
   * It also stays `true` for a turn that **parked** on an approval, because the
   * parked turn is not over — it is waiting for a decision, and a second `send`
   * would replace the `AgentTurn` that owns the open card. `Plan.md` §15.5 asks for
   * exactly this ("Approval-Card blockiert die weitere Bedienung eindeutig"), so the
   * block is the requirement and not a side effect of the bookkeeping.
   */
  let inFlight = false;
  /** The turn in flight — **or parked on an approval** — plus its collaborator. */
  let turn: AgentTurn | undefined;
  let watchdog: StallWatchdog | undefined;
  let turnId: string | undefined;
  /** The current attempt's text, appended per delta and copied into the snapshot. */
  let text = "";

  const state: Observable<RuntimeState> = createObservable<RuntimeState>({
    sessionId,
    turnId: undefined,
    status: "idle",
    attempt: 0,
    totalAttempts: 0,
    step: 0,
    messages: [],
    text: "",
    classification: undefined,
    outcome: undefined,
    unknownOutcomes: [],
    hitStepLimit: false,
    boot: undefined,
    stall: undefined,
    lastError: undefined,
    providers: PROVIDER_CATALOG,
  });

  const publish = (patch: Partial<RuntimeState>): void => {
    state.set({ ...state.get(), ...patch });
  };

  /**
   * Turn a thrown value into the error the UI sees, and say so out loud.
   *
   * `origin` is a **parameter and not a guess**. The call site is the only place
   * that knows which subsystem was doing something when the error escaped, and
   * the two halves of this function are only correct together: naming the
   * origin must never become a reason to forward `error.message`, and redacting
   * the message must never make the origin `undefined`. Passing one argument here
   * is what made a database failure reach the user as `code: undefined` and
   * `"Error: undefined"`. `error.origin-unknown.test.ts` pins both halves.
   */
  const fail = (error: unknown, origin: ErrorOrigin): RuntimeError => {
    const runtimeError = toRuntimeError(error, origin);
    const info: RuntimeErrorInfo = { code: runtimeError.code, message: runtimeError.message };
    publish({ lastError: info });
    bus.emit({ kind: "runtime-error", error: info });
    return runtimeError;
  };

  /* ---- the single event entry point --------------------------- */

  /**
   * The one place an engine event arrives.
   *
   * Three consumers, ordered on purpose: the state snapshot is updated before the
   * bus fires, so a subscriber that reads `getState()` sees the event it was just
   * handed; and the watchdog sees the event **after** the snapshot but **before**
   * anything downstream can conclude it was silent.
   *
   * ## What is deliberately *not* here
   *
   * A `store.flushDelta` call site. It was one — this file used to hold a
   * `StepCheckpoint` that flushed the step's text on `step-end`. It was removed
   * because the engine now owns it, and correctly so: `AgentTurn` tracks every open
   * text and reasoning part and flushes each one on a 100 ms interval and
   * unconditionally when the part ends (`DELTA_FLUSH_INTERVAL_MS`). Keeping the
   * app-side writer would have been a **second path into the database** writing
   * deltas the engine was also writing — the exact duplication `Plan.md` §16.1
   * refused for the `TurnStore` adapter, where two paths into one store are how the
   * two classifiers drifted apart. Two writers, one part, two `deltaId` schemes.
   *
   * "Flush at attempt end instead of the part boundary" survived 128/128 as a
   * mutant. Restoring a step-boundary flush to catch it would re-introduce the bug
   * the removal fixed, so what is asserted instead is the invariant that actually
   * holds: every delta's `partId` is one the engine minted, and each part is written
   * once. `runtime.test.ts`, "the step boundary".
   */
  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "attempt-started":
        publish({ attempt: event.attempt, totalAttempts: event.total });
        break;
      case "step-end":
        // The same event the engine checkpoints on. The app does not write here —
        // it counts, so the UI can say "step 2 of 7" from a fact rather than from a
        // second guess at when a step ended.
        publish({ step: event.stepNumber + 1 });
        break;
      case "text-delta":
      case "reasoning-delta":
        text += event.text;
        publish({ text });
        break;
      case "attempt-failed":
        publish({ classification: event.classification });
        break;
      default:
        break;
    }

    watchdog?.observe(event);
    bus.emit({ kind: "agent", event });
  }

  /* ---- the provider ------------------------------------------- */

  /**
   * Turn the stored settings into the registry's input.
   *
   * The key is read here and passed explicitly, because in a browser there is no
   * environment to fall back on (§9) and the SDK's own `LoadAPIKeyError` arrives
   * one request later — as a network error the user cannot act on.
   */
  function readProviderSettings(): ProviderSettings {
    const selection = settings.get().provider;
    if (selection === undefined) {
      throw new RuntimeError(
        "no-provider-configured",
        "No provider is configured. Finish the onboarding wizard (Plan.md §8.1) or pick one in the settings.",
      );
    }
    const { name } = parseCatalogId(selection.vendor);
    // Idempotent: the stored vendor already carries the `:name` suffix, so the slot
    // must be derived by splitting rather than by appending to it again.
    const slot = apiKeySlot(selection.vendor, name);
    const apiKey = settings.get().apiKeys[slot];
    if (apiKey === undefined || apiKey === "") {
      throw new RuntimeError(
        "no-provider-configured",
        `No API key is stored for "${slot}". The AI SDK reads no environment in a browser, ` +
          "so the key must be given explicitly (Plan.md §9).",
      );
    }
    return {
      vendor: selection.vendor,
      model: selection.model,
      apiKey,
      ...(selection.baseUrl === undefined ? {} : { baseUrl: selection.baseUrl }),
      ...(name === undefined ? {} : { name }),
    };
  }

  async function resolveModel(): Promise<LanguageModel> {
    const providerSettings = readProviderSettings();
    // The `await` is load-bearing. See the module header and the guard below.
    const model = await registry.resolve(providerSettings);
    return assertResolvedLanguageModel(model, providerSettings.vendor);
  }

  /* ---- turns --------------------------------------------------- */

  /**
   * Is this turn still resumable?
   *
   * `AgentTurn.run` resolves with `outcome: "awaiting-approval"` **precisely so it
   * can be continued** (`packages/baah-core/src/agent/loop.ts:817-834`): the SDK is
   * holding the loop open until `respondToApproval` sends the answer, and the
   * transcript already carries the `approval-requested` part. `#continue` can park a
   * **second** time on another call, so this is asked of every result, not only of
   * the first one.
   */
  function isParked(result: TurnResult | undefined): boolean {
    return result?.outcome === "awaiting-approval";
  }

  /**
   * Let go of the turn: its watchdog, its id, and the `inFlight` guard.
   *
   * One function so "the turn is over" has exactly one spelling. The previous code
   * cleared three variables and a status flag in a `finally` and, in
   * {@link answerApproval}, cleared **none** of them — which is how a resume left the
   * status bar reading `running` forever after the continuation had finished.
   */
  function releaseTurn(): void {
    turn = undefined;
    watchdog?.disarm();
    watchdog = undefined;
    turnId = undefined;
    inFlight = false;
    publish({ status: "idle" });
  }

  async function send(input: SendOptions = {}): Promise<TurnResult> {
    if (inFlight) {
      throw new RuntimeError(
        "turn-busy",
        "A turn is already running for this session. Wait for it or stop it first — two " +
          "concurrent turns would interleave their parts into one transcript.",
      );
    }
    inFlight = true;

    try {
      return await runTurn(input);
    } finally {
      /**
       * The safety net, and it is a real one: {@link runTurn} throws *before* its own
       * `finally` when `resolveModel()` fails, so this is the only place that runs for
       * a provider error. `turn === undefined` is the predicate rather than
       * `result?.outcome` because `releaseTurn` already cleared the reference — the
       * two stay in step by construction, and a parked turn leaves it set.
       */
      if (turn === undefined) inFlight = false;
    }
  }

  async function runTurn(input: SendOptions): Promise<TurnResult> {
    let model: LanguageModel;
    try {
      model = await resolveModel();
    } catch (error) {
      // **Provider, not turn.** The only thing that can reach the generic branch
      // here is `registry.resolve` itself (a `ProviderError` and a
      // `RuntimeError` are classified before it). Calling it a turn failure would
      // send the user to the transcript to look for a turn that never started,
      // while the actual fault is a key, a vendor or `crypto.subtle`.
      throw fail(error, "provider");
    }

    const nextTurnId = mintId("turn");
    watchdog = new StallWatchdog({
      sessionId,
      turnId: nextTurnId,
      now,
      onStall: (report: StallReport) => {
        // Two consumers, and the order matters: the snapshot first, so a
        // subscriber that reads `getState()` sees the report it was just handed.
        // The publish is the half that is easy to drop — `bus.emit` is the half a
        // reader notices, because a live subscriber still gets the event — so it
        // is pinned separately in `runtime.test.ts`.
        publish({ stall: report });
        bus.emit({ kind: "stall", report });
      },
      ...(stallTimeoutMs === undefined ? {} : { timeoutMs: stallTimeoutMs }),
      ...(setStallTimer === undefined ? {} : { setTimer: setStallTimer }),
      ...(clearStallTimer === undefined ? {} : { clearTimer: clearStallTimer }),
    });

    turnId = nextTurnId;
    text = "";
    publish({
      turnId: nextTurnId,
      status: "running",
      text: "",
      step: 0,
      classification: undefined,
      outcome: undefined,
      unknownOutcomes: [],
      hitStepLimit: false,
      stall: undefined,
      lastError: undefined,
    });

    const run = new AgentTurn({
      model,
      // `instructions`, never `system` (AGENTS.md §3.1).
      instructions: dependencies.instructions ?? "",
      tools,
      workspace,
      cwd,
      sessionId,
      turnId: nextTurnId,
      store,
      approval: approvals.rule,
      approve: (request: ApprovalRequest): Promise<ApprovalDecision> => approvals.request(request),
      onEvent: handleEvent,
      now,
      ...(stallTimeoutMs === undefined ? {} : { stallTimeoutMs }),
      ...(input.messages === undefined ? {} : { messages: input.messages }),
    });
    turn = run;

    /**
     * Hoisted out of the `try` because the `finally` has to be able to ask what came
     * back. Declaring it inside would make "is this turn parked" unanswerable from
     * the one place that is allowed to release it.
     */
    let result: TurnResult | undefined;

    try {
      result = await run.run(input.prompt ?? "");
      settle(nextTurnId, result);
      return result;
    } catch (error) {
      // A turn is in flight and something in it broke. This is the origin the
      // brief's tally calls "the database failure during a checkpoint": the write
      // is the engine's, so the error says `turn-failed`, never `settings-write-failed`.
      throw fail(error, "turn");
    } finally {
      /**
       * ## The parked case, which used to throw the turn away
       *
       * This `finally` used to clear `turn`, `watchdog`, `turnId` and publish
       * `status: "idle"` **unconditionally**. So a turn that parked on an approval
       * lost the one object that could answer it, `answerApproval` — which opens
       * with `if (turn === undefined) throw` — failed on every click, and the turn
       * stood there forever. The engine had resolved with `awaiting-approval`
       * *because* it intended to be continued; the `finally` threw that intent away.
       *
       * All three references are load-bearing while parked, and each for its own
       * reason:
       *
       * - `turn` — the `AgentTurn` that owns the open card. There is no other route
       *   to `respondToApproval`.
       * - `turnId` — `settle` needs it, and the resume is a second `settle`.
       * - `watchdog` — the user is the bottleneck, and `StallWatchdog`'s
       *   `approval-requested`/`approval-answered` pair already models that
       *   (`awaiting-human` → `awaiting-provider`). Disarming it here would leave a
       *   resume with no stall affordance at all.
       *
       * `inFlight` is released by the same rule, and that is the *other* half of
       * §15.5's "the approval card blocks further operation": a second `send` while
       * a card is open must not replace the turn that owns it.
       *
       * `status` goes to `idle` while parked because nothing is running — the
       * outcome (`awaiting-approval`, published by `settle`) and the card are what
       * say the turn is waiting, and `turn-view.ts` renders exactly that sentence. It
       * is published as `running` again by {@link answerApproval} for the duration of
       * the continuation.
       */
      if (isParked(result)) {
        publish({ status: "idle" });
      } else {
        releaseTurn();
      }
    }
  }

  async function answerApproval(input: {
    readonly approvalId: string;
    readonly approved: boolean;
    readonly reason?: string | undefined;
  }): Promise<TurnResult | undefined> {
    const parked = turn;
    if (parked === undefined) {
      throw new RuntimeError(
        "turn-busy",
        "No paused turn to answer. An approval belongs to the AgentTurn instance that opened it, " +
          "and that instance is gone — re-send the turn instead.",
      );
    }
    // Read before the await. `respondToApproval` can park the turn a second time on
    // another call, and the id it settled under is the one this continuation belongs
    // to; re-reading the mutable `turnId` afterwards would settle a later turn.
    const parkedTurnId = turnId;

    /**
     * The continuation is **in flight from here**, and the status bar has to say so.
     * The parked turn published `idle`, which is right while a human is deciding and
     * wrong from the moment they have decided — a card that answers into a status bar
     * reading "idle" claims the turn is over while the model is still being asked.
     * `stall` is cleared with it: the watchdog latched its report about a silence
     * that the answer has just ended, and a report about the past is not a report
     * about the turn.
     */
    publish({ status: "running", stall: undefined, lastError: undefined });

    try {
      const result = await parked.respondToApproval({
        approvalId: input.approvalId,
        approved: input.approved,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      if (result === undefined) {
        /**
         * `respondToApproval` resolves `undefined` when **no** pending part matched the
         * id — a card for a turn that is gone, or a second click on a card that was
         * already answered. Nothing ran, so there is nothing to wait for, and holding
         * the turn open would re-create the dead end this whole path exists to end.
         */
        releaseTurn();
        return undefined;
      }
      if (parkedTurnId !== undefined) settle(parkedTurnId, result);
      if (isParked(result)) {
        // Another call wants a decision. Parked again, same rules as above.
        publish({ status: "idle" });
      } else {
        releaseTurn();
      }
      return result;
    } catch (error) {
      // Same subsystem as `run.run` — the loop is mid-turn and the store, a tool
      // or the provider failed. The approval card is a step *within* the turn, so
      // it does not make this a different origin. The turn is over either way, so it
      // is released: a held turn with a failed continuation is a turn nobody can
      // finish.
      releaseTurn();
      throw fail(error, "turn");
    }
  }

  /**
   * Publish the terminal state and tell the subscribers.
   *
   * Synchronous, and that is a deliberate change: it used to `await` a
   * `checkpoint.drain()` first so the UI would never show a finished turn whose
   * text was not yet on disk. That ordering was a workaround for the app-side
   * writer that no longer exists — the engine now flushes and closes each part
   * *inside* `run()`, and `finishTurn` is the last write, so by the time `run()`
   * resolves the transcript is already on disk. Awaiting something that cannot be
   * pending would be a promise about the future that nothing keeps.
   */
  function settle(id: string, result: TurnResult): void {
    publish({
      messages: result.messages,
      text: result.text,
      classification: result.classification,
      outcome: result.outcome,
      unknownOutcomes: result.unknownOutcomes,
      hitStepLimit: result.hitStepLimit,
    });
    bus.emit({ kind: "turn-settled", turnId: id, result });
  }

  async function boot(): Promise<BootReport> {
    try {
      const report = await recoverOnBoot({
        store,
        sessionId,
        now,
        ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
      });
      publish({ boot: report });
      bus.emit({ kind: "boot", report });
      return report;
    } catch (error) {
      // Reload recovery and nothing else is on the stack here.
      throw fail(error, "recovery");
    }
  }

  /* ---- the read port -------------------------------------------- */

  /**
   * Read the transcript, and keep "could not read" apart from "nothing there".
   *
   * Three things are worth reading here rather than in the component:
   *
   * 1. **The empty result is passed through untouched.** A successful read of a
   *    session with nothing in it is the only `kind: "ok"` with zero messages,
   *    and it is the only state a transcript view may render as "hier war
   *    nichts".
   * 2. **A rejection becomes `kind: "failed"`** with the store's own code, and
   *    the code is what the user can act on. `database_closed` says the tab's
   *    database went away; "empty transcript" says the opposite, and a user who
   *    believed it would conclude their work is gone.
   * 3. **A missing port is `kind: "unavailable"`**, a third state, because
   *    "not wired" and "wired and empty" are different facts about the program
   *    and the UI says so in both cases differently.
   *
   * `fail(error, …)` is deliberately **not** used: it would publish a
   * `runtime-error` and set `lastError`, which is right for an action the user
   * took and wrong for a restore the app performs on its own. A refused restore
   * belongs in the transcript view, which is where it is rendered.
   */
  async function readTranscript(
    request: { readonly turnId?: string; readonly limit?: number } = {},
  ): Promise<TranscriptRead> {
    const reader = dependencies.transcript;
    if (reader === undefined) {
      return {
        kind: "unavailable",
        reason:
          "This build has no read port wired, so the transcript cannot be read back. " +
          "The running turn is unaffected — only the reload view is missing.",
      };
    }
    try {
      const transcript = await reader.read({
        sessionId,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return { kind: "ok", transcript };
    } catch (error) {
      return { kind: "failed", reason: describeReadFailure(error) };
    }
  }

  /* ---- settings ------------------------------------------------ */

  return {
    sessionId,
    settings,
    providers: PROVIDER_CATALOG,
    approvals,

    boot,
    resolveModel,
    send,
    answerApproval,
    readTranscript,

    stop: async () => {
      await turn?.stop();
    },

    async probe(probeOptions = {}): Promise<ConnectionProbeReport> {
      try {
        return await probeFromSettings(settings.get(), probeOptions);
      } catch (error) {
        // Provider, same as the resolve above: the probe is the other way of
        // asking "can this provider be reached", and §8.1's wizard has to be able
        // to say which subsystem to look at.
        throw fail(error, "provider");
      }
    },

    async listModels(modelOptions = {}): Promise<ModelList> {
      try {
        return await listModelsFromSettings(settings.get(), modelOptions);
      } catch (error) {
        // **Provider, and specifically the reason the mapping above exists.** A
        // `ModelListError` with no case here became a generic `provider-unresolved`
        // whose `name` the wizard rendered verbatim — so the user read
        // „RuntimeError" instead of whether to fill in a base URL, save a key, or
        // read a status code. `MODEL_LIST_CODES` keeps all six apart.
        throw fail(error, "provider");
      }
    },

    exportSettings: (options) => {
      try {
        return settings.export(options);
      } catch (error) {
        // §8.2's read side. Same origin as `applySettings`: it is a settings
        // failure, and the wizard shows a different panel for it than for a turn.
        throw fail(error, "settings");
      }
    },

    prepareSettingsImport(raw): PreparedSettingsImport {
      try {
        const { next, diff } = settings.prepareImport(raw);
        return { diff, apply: () => settings.applyImport(next) };
      } catch (error) {
        // The transfer boundary (§8.2): reading and *validating* somebody else's
        // file. Distinct from `settings` on purpose — a rejected import is not a
        // browser that cannot store anything, and the code says so.
        throw fail(error, "settings-transfer");
      }
    },

    applySettings(next) {
      try {
        return settings.applyImport(next);
      } catch (error) {
        // Writing *our* settings. The `SettingsImportError` a bad file produces
        // never reaches here (it is rejected in `prepareSettingsImport`), so what
        // arrives is a storage failure or something unanticipated.
        throw fail(error, "settings");
      }
    },

    subscribe: (listener) => bus.subscribe(listener),
    getState: () => state.get(),
    subscribeState: (listener) => state.subscribe(listener),
    get state() {
      return state.get();
    },
  };
}

// The composition root's public surface. `RuntimeError` and the guard are
// re-exported rather than declared here: the error type moved to `error.ts` so
// `guard.ts` could use it without a cycle, and the guard to `guard.ts` so its
// call site could be pinned (`guard-call.test.ts`). Both were exported from this
// module before, and every importer — including the UI block — keeps working.
export { RuntimeError } from "./error.ts";
export { assertResolvedLanguageModel } from "./guard.ts";

export type {
  AgentEvent,
  BootReport,
  RuntimeErrorCode,
  RuntimeErrorInfo,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeState,
  StallReport,
};

/**
 * The read port's own types, re-exported so a caller that wants them does not have
 * to reach into `baah-storage` for a name it only learned from here.
 *
 * Re-exported rather than re-declared, and that is the whole difference: the five
 * structural copies this module used to carry are gone, so there is no second
 * version of `Transcript` to keep in step. See the module header.
 */
export type { Transcript, TranscriptMessage, TranscriptPart, TranscriptReader, TranscriptRequest };
