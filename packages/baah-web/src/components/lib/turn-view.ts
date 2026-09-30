/**
 * The turn banner: one object, assembled from the runtime's snapshot, the live
 * fold and the stall report.
 *
 * ## Why this is separate from `turn.ts`
 *
 * `turn.ts` has the pure projections — a classification becomes a sentence, a
 * `turn-stopped` becomes a stop, a `StallReport` becomes a wait. What it does not
 * have is the **precedence** between them, and that precedence is the whole
 * difficulty:
 *
 * - a **user stop** outranks everything, because a stop carries no classification
 *   at all and a UI that reached for the classification first would have nothing
 *   and fall through to a generic message;
 * - **`config-error`** outranks the rest, because its fix is the key and the
 *   transcript is where the user would look instead;
 * - a **stall** never coexists with a failure — it is a waiting state, and §5.4
 *   says it is never a verdict.
 *
 * Getting that order wrong in a component is invisible in review and obvious to a
 * user, so it lives in a tested function.
 */
import type { RuntimeState } from "../../runtime/index.ts";
import type { StallReport } from "../../runtime/watchdog.ts";
import { attemptsLabel, failureView, stepsLabel, stopView, type OutcomeKey, type StopView } from "./turn.ts";
import type { LiveTurn } from "./transcript.ts";

export interface TurnBanner {
  readonly outcome: OutcomeKey | undefined;
  readonly message: string;
  /** Set only for a user stop. Never a timeout, never a stall. */
  readonly stop: StopView | undefined;
  readonly attempts: string | undefined;
  readonly steps: string | undefined;
  readonly hitStepLimit: boolean;
  /** The key is the fix. The transcript is not. */
  readonly pointsAtKey: boolean;
  /** A warning about bookkeeping, never a turn failure. */
  readonly warnings: readonly string[];
}

/**
 * Assemble the banner.
 *
 * The three inputs are the three things that can be known at a given moment, and
 * they are not all from one place: `state` is the runtime's snapshot (the durable
 * facts), `live` is this tab's own fold of the engine's events (the facts while a
 * turn is in flight), and `stall` is the watchdog's timer (an observation, which
 * says nothing about why).
 */
export function turnBanner(state: RuntimeState, stall: StallReport | undefined, live?: LiveTurn): TurnBanner {
  const stopped = live?.stopped === true && live.stopStage !== undefined
    ? stopView({ type: "turn-stopped", stage: live.stopStage })
    : undefined;

  const failure = state.classification === undefined ? undefined : failureView(state.classification);
  const stallMessage = stall === undefined ? undefined : stallNotice(stall);

  return {
    // Precedence, in the order the section header names it.
    outcome: failure?.outcome ?? (state.outcome as OutcomeKey | undefined),
    message: stopped?.message ?? failure?.message ?? stallMessage ?? defaultMessage(state),
    stop: stopped,
    // The attempts come from `attempt-started`, so the **live** numbers win while
    // a turn runs and the settled ones take over afterwards. Either way they are
    // the engine's numbers.
    attempts: attemptsLabel(live?.attempt ?? state.attempt, live?.totalAttempts || state.totalAttempts),
    steps: stepsLabel(live?.step || state.step, state.hitStepLimit),
    hitStepLimit: state.hitStepLimit,
    pointsAtKey: failure?.pointsAtKey ?? false,
    warnings: (live?.storageWarnings ?? []).map(
      (warning) =>
        `Buchführung (${warning.operation}) konnte nicht gespeichert werden: ${warning.message}. ` +
        "Der Turn läuft weiter; nach einem Neuladen ist dieser Teil des Verlaufs womöglich unvollständig.",
    ),
  };
}

function stallNotice(report: StallReport): string {
  const seconds = Math.round(report.silentForMs / 100) / 10;
  return `Der Provider antwortet seit ${seconds.toLocaleString("de-DE", { maximumFractionDigits: 1 })} s nicht — Warteanzeige, kein Fehler.`;
}

function defaultMessage(state: RuntimeState): string {
  if (state.status === "running") return "Der Turn läuft.";
  if (state.outcome === "succeeded") return "Die Antwort ist vollständig angekommen.";
  if (state.outcome === "awaiting-approval") return "Wartet auf eine Freigabe.";
  if (state.outcome === "waiting") return "Wartet auf eine Antwort des Providers.";
  if (state.outcome === "interrupted") return "Der Turn wurde beendet.";
  if (state.outcome === "failed") return "Der Turn ist fehlgeschlagen.";
  return "Bereit.";
}

/**
 * The boot report, as a banner.
 *
 * `Plan.md` §6.1's recovery: a turn whose tab died mid-step is closed honestly and
 * offered as a re-send. **There is no "continue" affordance**, because
 * `reconnectToStream()` always returns `null` (`§14.4`) — a "fortsetzen" button
 * would promise something the platform cannot deliver, and `recovery.ts` says the
 * UI must never render one.
 */
export function bootNotice(state: RuntimeState): { readonly message: string; readonly recovered: number } | undefined {
  const report = state.boot;
  if (report === undefined || report.recovered.length === 0) return undefined;
  return {
    recovered: report.recovered.length,
    message:
      `${String(report.recovered.length)} Turn(s) wurden beim Start als unterbrochen markiert, ` +
      "weil ihr Herzschlag älter war als die Schwelle. Der Teiltext bleibt stehen. " +
      "Senden genügt: es wird ein neuer Turn gestartet, kein fortgesetzter — eine Wiederaufnahme ist im Browser nicht möglich.",
  };
}
