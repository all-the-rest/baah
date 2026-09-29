/**
 * The §5.4 stall watchdog — and an honest account of what it can and cannot see.
 *
 * ## What `Plan.md` §5.4 asks for, and why this file is *not* it
 *
 * §5.4 defines a `no-response` verdict for "waiting for a response that will never
 * come", with a 20 s window. It then names the gap itself: `stallTimeoutMs` is the
 * *length* of the `waiting` state and **measures nothing**, because the loop cannot
 * interrupt the `stream()` it is awaiting, so `no-response` has no producer inside
 * the engine.
 *
 * **That last clause is out of date, and the distinction below is the whole point of
 * this file.** `stream/classify.ts` *does* produce `{ kind: "no-response" }` — from
 * `!facts.responded` and from an abort-like error — and `agent/loop.ts` consumes it,
 * emitting a `waiting` event and finishing the turn `interrupted` with the reason
 * "no response". So the engine produces the verdict. Two things must not be confused:
 *
 * | | who | what it is |
 * | --- | --- | --- |
 * | **`no-response`** | `classify.ts` → `loop.ts` | a **classification**. Part of `TurnResult`, written to the turn log, ends the turn. |
 * | **`StallReport`** (this file) | `runtime/index.ts` | a **UI stall affordance**. Carries `silentForMs` and `lastEventType`, publishes to the snapshot and the bus, and **cannot end the turn**. |
 *
 * The report has no `Classification` in it and never will: it is an observation about
 * elapsed time, not a verdict about why. A stall can be a provider thinking, a
 * network that dropped a packet, or a tool that is still running — the watchdog says
 * "it has been quiet for this long", and a UI shows a spinner with a stop button.
 *
 * **So the watchdog is a named gap, not a §5.4 implementation.** A reader who finds
 * it should not conclude §5.4 is closed by it. What remains open is the thing §5.4
 * actually asked for and this file does not do: observing the *raw* provider chunks,
 * which is core's job (§5.4's own "die Messung gehört an den Transport").
 *
 * ## What this watchdog observes, precisely
 *
 * **Every `AgentEvent` the loop emits.** That is a real signal, and it is not
 * nothing: the loop emits a `text-delta` per delta, so a provider stream that goes
 * quiet mid-generation produces silence on this bus exactly as it produces silence
 * on the wire. A watchdog over these timestamps fires **no later** than a chunk-level
 * one would.
 *
 * ## What it cannot reach, and what that costs
 *
 * 1. **The raw chunk stream.** Verified against the installed `ai@7.0.122`: the
 *    `ToolLoopAgentSettings` type has no `onChunk` and no `onError` — but it *does*
 *    have `include.rawChunks`, which makes the provider's own chunks arrive as
 *    `raw` parts on the stream the loop consumes. So §5.4's "not reachable from
 *    here" is accurate about the loop's *callbacks* and slightly pessimistic about
 *    the SDK's capability: the chunks are reachable, but only by whoever constructs
 *    the `ToolLoopAgent` — which is core, and out of this block's ownership. Until
 *    core turns them into an event, the app-visible stream below is the finest
 *    signal available at this layer.
 * 2. **The reason for the silence.** This layer cannot tell "the provider is
 *    thinking" from "the connection is dead" from "a tool is running". It does not
 *    try to. It narrows the window as far as the events allow — see the arming
 *    rules — and reports a stall, not a cause.
 * 3. **Interrupting the turn.** `AgentTurn.stop()` *would* abort the in-flight
 *    fetch (§14.4), and the watchdog deliberately does not call it. Aborting would
 *    produce a turn that reads exactly like a user-initiated stop, and §5.4 says a
 *    stall is a *waiting state plus a manual action*, never an automatic one. The
 *    provider may still be generating; those tokens are billed either way
 *    (§5.4's cost note), so killing the request saves nothing and loses the answer.
 *
 * ## The false positive this design accepts, on purpose
 *
 * A tool call in flight emits `tool-call` and then nothing until `tool-result`. A
 * `question` waits for a human — potentially for minutes. So the watchdog
 * **disarms on `tool-call`** and re-arms on `tool-result`. That trades a missed
 * stall during a hung tool for never telling a user their question card is
 * "stalled" while they are reading it. Tools carry their own limits (`grep` has a
 * measured timeout), and a human is not a timeout.
 */

import { DEFAULT_STALL_TIMEOUT_MS, type AgentEvent } from "@all-the.rest/baah-core";

/**
 * Where the watchdog believes it is.
 *
 * `awaiting-provider` — armed. A request is out and nothing has come back.
 * `awaiting-human` — disarmed. An approval or a question is open.
 * `idle`        — disarmed. No turn in flight.
 */
export type StallPhase = "awaiting-provider" | "awaiting-human" | "idle";

export interface StallReport {
  readonly sessionId: string;
  readonly turnId: string;
  readonly phase: StallPhase;
  readonly timeoutMs: number;
  /** How long since the last observed event. Not `timeoutMs` by construction. */
  readonly silentForMs: number;
  /** The last event seen before the silence. `undefined` if there was none. */
  readonly lastEventType: AgentEvent["type"] | undefined;
}

/**
 * Events that open a window in which only the provider can be late.
 *
 * Every one of them means "a request is out, or a step just finished". The
 * approval answer is here because the loop resumes the turn with a re-send and
 * does **not** emit `attempt-started` for it.
 */
const ARM: ReadonlySet<AgentEvent["type"]> = new Set([
  "attempt-started",
  "step-end",
  "tool-result",
  "tool-error",
  "tool-output-denied",
  "approval-answered",
]);

/**
 * Events that close the window because something other than the provider is now
 * the bottleneck. A `tool-call` means a tool is executing; an
 * `approval-requested` means a human is.
 */
const DISARM: ReadonlySet<AgentEvent["type"]> = new Set([
  "tool-call",
  "approval-requested",
  "turn-finished",
  "turn-stopped",
  "error",
]);

export interface StallWatchdogOptions {
  readonly timeoutMs?: number;
  readonly onStall: (report: StallReport) => void;
  /** Injected for tests; defaults to `setTimeout`/`clearTimeout`. */
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

/**
 * One watchdog per turn.
 *
 * Not a module-level singleton: two tabs, or two sessions in one tab, must not
 * share a timer. `armed` is public so the runtime can put it in its snapshot and
 * a test can assert the disarm rules without reaching into privates.
 */
export class StallWatchdog {
  readonly #timeoutMs: number;
  readonly #onStall: (report: StallReport) => void;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #turnId: string;

  #handle: unknown;
  #armedAtMs = 0;
  #lastEventType: AgentEvent["type"] | undefined;
  #phase: StallPhase = "idle";
  /** Latched after firing, so one silence produces one report, not a stream. */
  #fired = false;

  constructor(options: StallWatchdogOptions & { sessionId: string; turnId: string }) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.#onStall = options.onStall;
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#now = options.now ?? Date.now;
    this.#sessionId = options.sessionId;
    this.#turnId = options.turnId;
  }

  get armed(): boolean {
    return this.#phase === "awaiting-provider";
  }

  get phase(): StallPhase {
    return this.#phase;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Feed one engine event.
   *
   * Every event resets the timer while armed, so a stream that keeps producing
   * deltas can never reach the window — which is the whole of the "a healthy
   * stream is not a stall" requirement, and it is why this is not `if (silent)`.
   */
  observe(event: AgentEvent): void {
    this.#lastEventType = event.type;

    if (DISARM.has(event.type)) {
      this.#cancel();
      this.#phase = event.type === "tool-call" || event.type === "approval-requested" ? "awaiting-human" : "idle";
      // A terminal event ends the turn; a later `step-end` in the same turn (there
      // is none, but the state machine should not depend on that) re-arms below.
      return;
    }

    if (ARM.has(event.type)) {
      this.#phase = "awaiting-provider";
      this.#armedAtMs = this.#now();
      this.#fired = false;
      this.#cancel();
      this.#handle = this.#setTimer(() => {
        this.#handle = undefined;
        this.#fire();
      }, this.#timeoutMs);
      return;
    }

    // Everything else (`text-delta`, `reasoning-delta`, `attempt-failed`,
    // `waiting`) is progress: push the window out, but only while armed.
    if (!this.armed) return;
    this.#armedAtMs = this.#now();
    this.#cancel();
    this.#handle = this.#setTimer(() => {
      this.#handle = undefined;
      this.#fire();
    }, this.#timeoutMs);
  }

  /** Stop watching — the turn ended, or the runtime is closing. */
  disarm(): void {
    this.#cancel();
    this.#phase = "idle";
  }

  #fire(): void {
    // Latched, and the phase is left as it was: a stall is an observation, not a
    // state transition. Disarming here would mean the *next* silence after a
    // `tool-result` needs a fresh arm, which `observe` does anyway — but leaving
    // the phase alone keeps "the turn is still waiting on the provider" true, which
    // is what it is.
    if (this.#fired) return;
    this.#fired = true;
    this.#onStall({
      sessionId: this.#sessionId,
      turnId: this.#turnId,
      phase: this.#phase,
      timeoutMs: this.#timeoutMs,
      silentForMs: this.#now() - this.#armedAtMs,
      lastEventType: this.#lastEventType,
    });
  }

  #cancel(): void {
    if (this.#handle === undefined) return;
    this.#clearTimer(this.#handle);
    this.#handle = undefined;
  }
}
