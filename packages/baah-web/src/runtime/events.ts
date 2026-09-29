/**
 * The event stream the UI subscribes to.
 *
 * ## Why a wrapper and not the raw `AgentEvent`
 *
 * `AgentEvent` is the engine's vocabulary and it is exactly right for what it
 * describes. The runtime has three things the engine does not know about, and
 * folding them into the same union would make every consumer re-check a
 * discriminator it can never match:
 *
 * - **boot** — reload recovery ran and found N stale turns (`Plan.md` §6.1). The
 *   UI has to say "this turn was interrupted, here is the partial text, re-send
 *   it" and it cannot know that without being told.
 * - **stall** — the app-side stall watchdog (`watchdog.ts`). **Not** §5.4's
 *   `no-response` verdict: the engine produces that one (`stream/classify.ts`, and
 *   `agent/loop.ts` consumes it). This is a UI affordance — "the turn has been quiet
 *   for this long" — and it can only come from here, because the engine measures
 *   nothing. `StallReport` carries `silentForMs` and `lastEventType`, not a
 *   `Classification`, and it never ends the turn.
 * - **runtime-error** — a failure of the app around the engine: settings that
 *   would not persist, a provider that could not be resolved, a second turn
 *   started while one is running.
 *
 * The engine's events are forwarded **verbatim** under `kind: "agent"`. Not
 * mapped, not renamed: the loop's documentation is careful about every event's
 * meaning (`tool-outcome-unknown` versus `tool-error` is a distinction a mapper
 * would eventually blur), and the UI block should read that documentation, not a
 * paraphrase of it.
 *
 * ## No secrets, structurally
 *
 * `RuntimeErrorInfo` carries a `code` and a `message`, and **no** `cause`. Every
 * message in this layer is built from a fixed template plus values this layer
 * chose. A provider error — which can quote the key, as Google's does — is
 * classified by the engine and reaches the UI as `AgentEvent.error`, whose
 * `classification` is what the UI renders; the raw error never enters this union.
 * Dropping `cause` is what makes that structural rather than a policy.
 */

import type { AgentEvent, Classification, TurnResult, UnknownToolOutcome } from "@all-the.rest/baah-core";
import type { UIMessage } from "ai";

import type { ProviderEntry } from "../providers/catalog.ts";
import type { BootReport } from "./recovery.ts";
import type { StallReport } from "./watchdog.ts";

export type RuntimeErrorCode =
  | "no-provider-configured"
  | "provider-unresolved"
  | "turn-busy"
  | "turn-failed"
  | "recovery-failed"
  | "settings-write-failed"
  | "settings-unavailable"
  | "settings-import-rejected"
  | "settings-corrupt"
  | "probe-failed";

export interface RuntimeErrorInfo {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}

/**
 * A stall report, echoed onto the stream.
 *
 * The echo is for a subscriber that is *already* attached. `RuntimeState.stall` is
 * the other half and the one that cannot be replaced by this: the watchdog latches,
 * so a component mounting after the report missed it entirely.
 */
export interface StallEvent {
  readonly report: StallReport;
}

export type RuntimeEvent =
  /** The engine's own event, unchanged. */
  | { readonly kind: "agent"; readonly event: AgentEvent }
  /** Reload recovery ran. Carries the turns it closed. */
  | { readonly kind: "boot"; readonly report: BootReport }
  /**
   * The app-side watchdog fired. **Not** §5.4's `no-response` verdict — that is a
   * `Classification` on a `TurnResult`, produced by the engine. See `watchdog.ts`.
   */
  | { readonly kind: "stall"; readonly report: StallReport }
  /** The turn reached a terminal state; the state snapshot is updated too. */
  | { readonly kind: "turn-settled"; readonly turnId: string; readonly result: TurnResult }
  | { readonly kind: "runtime-error"; readonly error: RuntimeErrorInfo };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * A minimal fan-out bus.
 *
 * Not `EventTarget`: that is a DOM API, and this layer has to run in vitest with
 * no DOM. Handlers are called in registration order on a copy of the set, so a
 * handler that unsubscribes cannot disturb the iteration — the same reason the
 * observable in `lib/observable.ts` copies.
 *
 * A throwing handler is **not** isolated: AGENTS.md §5 forbids silent catch
 * blocks, and a swallowed exception in a subscriber is exactly the failure mode
 * that hides a real bug. It propagates out of {@link RuntimeEventBus.emit}.
 */
export class RuntimeEventBus {
  readonly #listeners = new Set<RuntimeEventListener>();

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  get size(): number {
    return this.#listeners.size;
  }
}

/* ------------------------------------------------------------------ */
/* The snapshot                                                        */
/* ------------------------------------------------------------------ */

/**
 * What the UI renders from.
 *
 * ## Why not the raw `UIMessage[]` alone
 *
 * Because three of the facts a transcript needs are not in a message: the turn
 * ended *how* (§5.4's five outcomes look the same in a message list), how many
 * attempts it spent, and which tool calls have an unknown effect (`Plan.md`
 * §5.1). All three are engine events that no renderer would otherwise see.
 *
 * Immutable and replaced wholesale, so `useSyncExternalStore` gets a new
 * reference exactly when something changed.
 */
export interface RuntimeState {
  readonly sessionId: string;
  readonly turnId: string | undefined;
  /** `idle` — nothing running. `running` — a turn is in flight. */
  readonly status: "idle" | "running";
  readonly attempt: number;
  readonly totalAttempts: number;
  /**
   * Steps completed so far, from the engine's `step-end`.
   *
   * §5.4 makes the attempts visible and AGENTS.md §3.1 makes the step boundary the
   * checkpoint point, so "step 2 of 7" is a thing the UI must be able to say. It
   * comes from the same `step-end` event the engine checkpoints on, which is the
   * only reason the number can be right.
   */
  readonly step: number;
  readonly messages: readonly UIMessage[];
  /** Text of the current attempt only; a failed attempt's text is not merged. */
  readonly text: string;
  readonly classification: Classification | undefined;
  readonly outcome: TurnResult["outcome"] | undefined;
  /** Tool calls that began and never reported an outcome (`Plan.md` §5.1). */
  readonly unknownOutcomes: readonly UnknownToolOutcome[];
  /** The turn stopped at the step ceiling, not because the model was done. */
  readonly hitStepLimit: boolean;
  readonly boot: BootReport | undefined;
  /**
   * The last stall report, and the reason this is in the snapshot rather than only
   * on the bus: the watchdog **latches**, so it reports one silence once. A
   * component that mounts after that report has fired would otherwise wait for a
   * second one that never comes. This is the only place a late subscriber can learn
   * that the turn is waiting.
   *
   * Cleared when the next turn starts — a report about a turn that no longer exists
   * is a claim the UI must not render.
   */
  readonly stall: StallReport | undefined;
  readonly lastError: RuntimeErrorInfo | undefined;
  readonly providers: readonly ProviderEntry[];
}
