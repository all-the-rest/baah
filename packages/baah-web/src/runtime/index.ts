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
import type { LanguageModel, UIMessage } from "ai";

import { createObservable, type Observable } from "../lib/observable.ts";
import { apiKeySlot, newId } from "../lib/ids.ts";
import { PROVIDER_CATALOG, parseCatalogId, type ProviderEntry } from "../providers/catalog.ts";
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
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface RuntimeDependencies extends RuntimeApprovalOptions {
  /** The persistence seam. See `TurnStore` in core. */
  readonly store: TurnStore;
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
  /** An empty prompt continues an approval pause rather than starting a turn. */
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

  /** Resolve the configured provider. **Awaited** — see the module header. */
  resolveModel(): Promise<LanguageModel>;

  /** Run a turn. Rejects with a typed error while another turn is in flight. */
  send(input?: SendOptions): Promise<TurnResult>;

  /** Answer an open approval card and resume the paused turn. */
  answerApproval(input: {
    readonly approvalId: string;
    readonly approved: boolean;
    readonly reason?: string | undefined;
  }): Promise<TurnResult | undefined>;

  /** User-initiated stop. Never used by the watchdog (§5.4). */
  stop(): Promise<void>;

  /** The §8.1 connection test. Never throws for a provider problem. */
  probe(options?: ConnectionProbeOptions): Promise<ConnectionProbeReport>;

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
   * Set **synchronously** on entry to `send`, cleared in its `finally`.
   *
   * Not derived from `turn !== undefined`: `send` awaits `resolveModel()` before it
   * constructs the `AgentTurn`, so a second call arriving in that window would find
   * `turn` still `undefined` and start a second turn — two turns interleaving their
   * parts into one transcript, which is exactly what the guard exists to prevent.
   */
  let inFlight = false;
  /** The turn in flight, plus its per-turn collaborator. */
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
      inFlight = false;
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

    try {
      const result = await run.run(input.prompt ?? "");
      settle(nextTurnId, result);
      return result;
    } catch (error) {
      // A turn is in flight and something in it broke. This is the origin the
      // brief's tally calls "the database failure during a checkpoint": the write
      // is the engine's, so the error says `turn-failed`, never `settings-write-failed`.
      throw fail(error, "turn");
    } finally {
      turn = undefined;
      watchdog?.disarm();
      watchdog = undefined;
      turnId = undefined;
      publish({ status: "idle" });
    }
  }

  async function answerApproval(input: {
    readonly approvalId: string;
    readonly approved: boolean;
    readonly reason?: string | undefined;
  }): Promise<TurnResult | undefined> {
    if (turn === undefined) {
      throw new RuntimeError(
        "turn-busy",
        "No paused turn to answer. An approval belongs to the AgentTurn instance that opened it, " +
          "and that instance is gone — re-send the turn instead.",
      );
    }
    try {
      const result = await turn.respondToApproval({
        approvalId: input.approvalId,
        approved: input.approved,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      if (result !== undefined && turnId !== undefined) settle(turnId, result);
      return result;
    } catch (error) {
      // Same subsystem as `run.run` — the loop is mid-turn and the store, a tool
      // or the provider failed. The approval card is a step *within* the turn, so
      // it does not make this a different origin.
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
