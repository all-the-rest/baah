/**
 * Turn-level projections: the five engine events that must each become a
 * *distinguishable* thing on screen.
 *
 * ## The list, and why each one is here
 *
 * Read off `packages/baah-core/src/agent/loop.ts` (`AgentEvent`) and
 * `stream/classify.ts` (`Classification`) — not from `Plan.md`'s prose. Every one
 * of these has an event type and a discriminator of its own, and the failure mode
 * for all five is the same: a UI that folds them into one "Fehler" card has
 * thrown away the distinction the engine deliberately built.
 *
 * | event | what it is | what it must **not** look like |
 * |---|---|---|
 * | `turn-stopped` | the user pressed stop | a timeout, a stall, a provider error |
 * | `tool-outcome-unknown` | a call began and never reported | a failure, or a success |
 * | `config-error` / `missing_api_key` | no key is configured | a transcript error |
 * | `storage-warning` | a bookkeeping write failed | a turn failure |
 * | `stall` (`StallReport`) | quiet for a window, still running | a failure, a verdict |
 *
 * `turn-stopped` is called out because rendering it as a timeout **was a real
 * bug** in this project: the watchdog and the stop button both end the turn, and
 * an interrupted turn with no classification is a *stop* — `Plan.md` §5.4 and the
 * loop's own comment on the event agree, and the invariant is "`turn-finished`
 * with `outcome: "interrupted"` **and no classification**".
 *
 * `StallReport` is the other half of that trap and is called out in
 * `runtime/watchdog.ts`: it is **not** §5.4's `no-response` verdict. It carries
 * `silentForMs`, it has no `Classification`, and it never ends the turn. Rendered
 * as a failure it teaches the user that a slow provider is a broken one.
 */
import type { AgentEvent, Classification, TurnResult } from "@all-the.rest/baah-core";
import type { StallReport } from "../../runtime/watchdog.ts";

/* ------------------------------------------------------------------ */
/* Classification                                                     */
/* ------------------------------------------------------------------ */

/**
 * The outcome this classification means, as the `data-baah-outcome` value.
 *
 * `missing_api_key` maps to `no-api-key` and **not** to `failed`. A turn that
 * never left the browser did not fail; pointing at the transcript is a dead end,
 * and the actual fix is a five-second one (paste the key). This is the branch the
 * report's mutation #4 kills.
 */
export type OutcomeKey =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "waiting"
  | "awaiting-approval"
  | "no-api-key"
  | "no-response"
  | "provider-error";

export interface FailureView {
  readonly outcome: OutcomeKey;
  /** One German sentence. Never an error's own text — see the note below. */
  readonly message: string;
  /** The raw code, shown as a monospace detail. Never a value. */
  readonly code: string | undefined;
  /**
   * `true` when the fix is in the provider settings, not in the transcript.
   *
   * `Plan.md` §9: the SDK reads no environment in a browser, so without
   * `apiKey` it raises `LoadAPIKeyError` on the first call. That is a
   * *configuration* fact, and the UI has to route the user to the key.
   */
  readonly pointsAtKey: boolean;
}

/**
 * Turn a classification into what the user is told.
 *
 * The messages are written here rather than taken from the error because an
 * arbitrary provider message can quote the API key back (Google's 401 does) and
 * a provider message is rendered, screenshotted and pasted into issues. The
 * `code` is the machine-readable half and is safe; the prose is ours.
 */
export function failureView(classification: Classification): FailureView {
  switch (classification.kind) {
    case "success":
      return { outcome: "succeeded", message: "Die Antwort ist vollständig angekommen.", code: undefined, pointsAtKey: false };
    case "no-response":
      return {
        outcome: "no-response",
        message:
          "Vom Provider kam innerhalb des Zeitfensters nichts. Das Modell erzeugt vielleicht noch; " +
          "du kannst warten oder den Versuch abbrechen.",
        code: "no-response",
        pointsAtKey: false,
      };
    case "http-error":
      return {
        outcome: "provider-error",
        message: classification.retryable
          ? `Der Provider hat mit HTTP ${String(classification.status)} geantwortet. Der Versuch wird wiederholt.`
          : `Der Provider hat die Anfrage mit HTTP ${String(classification.status)} abgelehnt. Wiederholen würde nichts ändern.`,
        code: `http-${String(classification.status)}`,
        pointsAtKey: classification.status === 401 || classification.status === 403,
      };
    case "body-error":
      return {
        outcome: "provider-error",
        message: classification.retryable
          ? `Der Provider antwortete mit einem Fehler im Antwortkörper (${classification.code}). Der Versuch wird wiederholt.`
          : `Der Provider lehnt die Anfrage inhaltlich ab (${classification.code}). Wiederholen würde nichts ändern.`,
        code: classification.code,
        pointsAtKey: /key|auth|permission|credential/i.test(classification.code),
      };
    case "protocol-error":
      return {
        outcome: "provider-error",
        message: `Die Antwort war unbrauchbar: ${classification.reason}. Der Versuch wird wiederholt.`,
        code: "protocol-error",
        pointsAtKey: false,
      };
    case "config-error":
      // The one branch that must not fall through. `pointsAtKey` is the whole
      // point: the key is the fix, and the transcript is not.
      return {
        outcome: "no-api-key",
        message:
          `Für ${classification.code === "missing_api_key" ? "diesen Provider" : "den Provider"} ist kein API-Key hinterlegt. ` +
          "Im Browser gibt es keine Umgebungsvariable als Ersatz — der Key muss in den Einstellungen eingetragen werden.",
        code: classification.code,
        pointsAtKey: true,
      };
  }
}

/* ------------------------------------------------------------------ */
/* turn-stopped                                                        */
/* ------------------------------------------------------------------ */

export interface StopView {
  readonly outcome: "interrupted";
  /**
   * Whether this stop came from the *approval resume* leg.
   *
   * The loop emits `turn-stopped` in two places (`agent/loop.ts`), and a user who
   * pressed stop on an approval card should not be told they stopped an attempt.
   */
  readonly stage: "attempt" | "approval-resume";
  readonly message: string;
  readonly code: "user-stop";
}

/**
 * A `turn-stopped` is the **user's** decision.
 *
 * Never a timeout, never a stall, never a provider error — and the wording
 * says so. "Der Turn wurde abgebrochen" without naming who cancelled leaves the
 * user guessing whether their provider is broken, which is the confusion this
 * function exists to remove.
 */
export function stopView(event: Extract<AgentEvent, { type: "turn-stopped" }>): StopView {
  return {
    outcome: "interrupted",
    stage: event.stage,
    message:
      event.stage === "approval-resume"
        ? "Du hast die Freigabe-Karte abgebrochen. Der Turn wurde beendet — es wurde nichts ausgeführt."
        : "Du hast den Turn abgebrochen. Der Provider kann weiterlaufen und abrechnen; der Teiltext bleibt stehen.",
    code: "user-stop",
  };
}

/* ------------------------------------------------------------------ */
/* tool-outcome-unknown                                               */
/* ------------------------------------------------------------------ */

export interface UnknownOutcomeView {
  readonly outcome: "unknown";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: string;
  /**
   * What baah does **not** know, in words.
   *
   * `Plan.md` §5.1: whether the effect happened is unknowable from here, so the
   * UI says that rather than choosing. The engine ran it a second time and
   * reported it as failed — both are lies the model would act on.
   */
  readonly message: string;
  /** The action that is correct under either answer. */
  readonly advice: string;
}

/** An unknown tool outcome, rendered as its own thing and not as a card state. */
export function unknownOutcomeView(
  event: Extract<AgentEvent, { type: "tool-outcome-unknown" }>,
  describeInput: (value: unknown) => string,
): UnknownOutcomeView {
  return {
    outcome: "unknown",
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    input: describeInput(event.input),
    message:
      `Der Aufruf von „${event.toolName}“ hat begonnen, aber nie ein Ergebnis gemeldet. ` +
      "Ob die Wirkung eingetreten ist, weiß baah nicht — der Tab wurde dazwischen beendet oder der Prozess abgeschossen. " +
      "Der Aufruf wurde **nicht** wiederholt und **nicht** als fehlgeschlagen gemeldet.",
    advice:
      "Prüfe das Ergebnis selbst, bevor du den Schritt wiederholst: lies die Datei oder liste das Verzeichnis. " +
      "Ein zweiter Schreibvorgang auf dieselbe Datei ist ein Datenverlust, den das Modell nicht zurücknehmen kann.",
  };
}

/* ------------------------------------------------------------------ */
/* storage-warning                                                     */
/* ------------------------------------------------------------------ */

/**
 * A bookkeeping write that failed.
 *
 * A **warning, not a verdict** — the loop says so at the event and explains why
 * at `heartbeat()`: a heartbeat's only reader is the next start-up, and the write
 * that genuinely ends a turn (the delta flush) is awaited and fails loudly on its
 * own. Rendering this as a turn failure would train the user to ignore the one
 * warning that matters.
 */
export function storageWarningView(event: Extract<AgentEvent, { type: "storage-warning" }>): string {
  const subject =
    event.operation === "heartbeat"
      ? "Der Lebenserhaltungs-Puls (heartbeat)"
      : `Die Buchführung über den Werkzeugaufruf „${event.toolName}“`;
  return (
    `${subject} konnte nicht gespeichert werden: ${event.message}. ` +
    "Der Turn läuft weiter, aber nach einem Neuladen ist dieser Teil des Verlaufs womöglich unvollständig."
  );
}

/* ------------------------------------------------------------------ */
/* stall                                                               */
/* ------------------------------------------------------------------ */

export interface StallView {
  readonly outcome: "waiting";
  /** Seconds of silence, rounded. Rendered, and named as a measurement. */
  readonly silentSeconds: number;
  readonly timeoutSeconds: number;
  readonly lastEventType: string | undefined;
  readonly message: string;
  /**
   * `false`, and it is worth a type: this is **not** a failure and not a
   * verdict. `Plan.md` §5.4 — a stall is a waiting state plus a manual action,
   * never an automatic one. Nothing here ends the turn.
   */
  readonly isFailure: false;
}

/**
 * A `StallReport` is a **measurement**, not a diagnosis.
 *
 * The report carries `silentForMs` and `lastEventType` and no `Classification`
 * (`runtime/watchdog.ts`), so this function must not invent a cause. The
 * sentence names the measurement and offers the two actions §5.4 prescribes:
 * wait, or stop.
 */
export function stallView(report: StallReport): StallView {
  const silentSeconds = Math.round(report.silentForMs / 100) / 10;
  const timeoutSeconds = Math.round(report.timeoutMs / 100) / 10;
  return {
    outcome: "waiting",
    silentSeconds,
    timeoutSeconds,
    lastEventType: report.lastEventType,
    message:
      `Seit ${formatSeconds(silentSeconds)} s kam kein Signal mehr vom Provider` +
      (report.lastEventType === undefined ? "" : ` (zuletzt: ${report.lastEventType})`) +
      `. Das ist eine Warteanzeige, kein Fehler — der Turn läuft weiter, und baah beendet ihn nicht von selbst.`,
    isFailure: false,
  };
}

function formatSeconds(value: number): string {
  return value.toLocaleString("de-DE", { maximumFractionDigits: 1 });
}

/* ------------------------------------------------------------------ */
/* Attempts and steps                                                  */
/* ------------------------------------------------------------------ */

/**
 * §5.4: "Die Versuche werden im UI sichtbar: ‚Versuch 2 von 3'".
 *
 * `undefined` before the first attempt, so the bar does not flash "Versuch 1 von
 * 0" on an idle screen.
 */
export function attemptsLabel(attempt: number, totalAttempts: number): string | undefined {
  if (attempt <= 0 || totalAttempts <= 0) return undefined;
  return `Versuch ${String(attempt)} von ${String(totalAttempts)}`;
}

/**
 * The step counter, from the same `step-end` event the engine checkpoints on.
 *
 * `Plan.md` §5.1: the answer is complete only if the model stopped calling tools
 * itself — a turn that hit the ceiling is a legitimate termination whose *answer
 * is incomplete*, so it gets its own sentence.
 */
export function stepsLabel(step: number, hitStepLimit: boolean): string | undefined {
  if (step <= 0) return undefined;
  return hitStepLimit
    ? `Schritt ${String(step)} — Step-Limit erreicht, die Antwort ist unvollständig`
    : `Schritt ${String(step)}`;
}

/* ------------------------------------------------------------------ */
/* The whole result                                                    */
/* ------------------------------------------------------------------ */

export interface TurnView {
  readonly outcome: OutcomeKey;
  readonly message: string;
  /** Present only when the turn ended because the user said so. */
  readonly stop: StopView | undefined;
  /**
   * Present only when the turn ended because a key is missing, never with a
   * transcript error. Kept as a boolean on the view rather than folded into
   * `message` so a component cannot render the sentence without the affordance.
   */
  readonly pointsAtKey: boolean;
  readonly attempts: string | undefined;
  readonly steps: string | undefined;
  readonly unknownOutcomes: readonly UnknownOutcomeView[];
}

export interface TurnViewInput {
  readonly outcome: TurnResult["outcome"];
  readonly classification: Classification | undefined;
  /** `Plan.md` §5.4's budget, for "Versuch 2 von 3". */
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly step: number;
  readonly hitStepLimit: boolean;
  readonly unknownOutcomes: readonly { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }[];
  /** The `turn-stopped` event, when the turn ended that way. */
  readonly stopped: StopView | undefined;
}

/**
 * Project a turn into the banner.
 *
 * Precedence is deliberate and is the point of the function: a **user stop**
 * outranks a classification, because a stop has no classification at all and a
 * UI that reached for `classification` first would have nothing to show and fall
 * through to a generic message. `config-error` outranks everything else, because
 * its fix is elsewhere in the app.
 */
export function turnView(input: TurnViewInput, describeInput: (value: unknown) => string): TurnView {
  const failure = input.classification === undefined ? undefined : failureView(input.classification);
  const stopped = input.stopped;

  return {
    outcome: failure?.outcome ?? (input.outcome as OutcomeKey),
    message:
      stopped?.message ??
      failure?.message ??
      (input.outcome === "succeeded"
        ? "Die Antwort ist vollständig angekommen."
        : "Der Turn wurde beendet."),
    stop: stopped,
    pointsAtKey: failure?.pointsAtKey ?? false,
    attempts: attemptsLabel(input.attempt, input.totalAttempts),
    steps: stepsLabel(input.step, input.hitStepLimit),
    unknownOutcomes: input.unknownOutcomes.map((entry) => ({
      outcome: "unknown" as const,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      input: describeInput(entry.input),
      message:
        `Der Aufruf von „${entry.toolName}“ hat begonnen, aber nie ein Ergebnis gemeldet. ` +
        "Ob die Wirkung eingetreten ist, weiß baah nicht.",
      advice:
        "Prüfe das Ergebnis selbst, bevor du den Schritt wiederholst: lies die Datei oder liste das Verzeichnis.",
    })),
  };
}
