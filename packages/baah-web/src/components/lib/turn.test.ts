/**
 * The five engine events that must each produce a **distinguishable** thing, and
 * the precedence between them.
 *
 * ## Why each test names the thing it is protecting
 *
 * `turn-stopped` rendered as a timeout was a real bug in this project, and
 * `StallReport` rendered as a failure is the same mistake one layer over. Both are
 * invisible in review — the markup looks fine, the code looks fine, and the user
 * concludes their provider is broken. So each test below is a claim about a
 * distinction, not about a string.
 */
import { describe, expect, it } from "vitest";
import type { Classification } from "@all-the.rest/baah-core";
import type { StallReport } from "../../runtime/watchdog.ts";

import { failureView, stepsLabel, stopView, storageWarningView, stallView, unknownOutcomeView, attemptsLabel } from "./turn.ts";
import { turnBanner, bootNotice } from "./turn-view.ts";
import { EMPTY_LIVE_TURN, type LiveTurn } from "./transcript.ts";
import type { RuntimeState } from "../../runtime/index.ts";

const stringer = (value: unknown): string => JSON.stringify(value);

/**
 * The session the fixtures below belong to.
 *
 * Every `AgentEvent` names one, so a fixture that omitted it would not typecheck —
 * which is the property under test elsewhere, and here it is just the price of
 * writing an event literal at all.
 */
const SESSION = "s";

function stallReport(overrides: Partial<StallReport> = {}): StallReport {
  return {
    sessionId: "s",
    turnId: "t",
    phase: "awaiting-provider",
    timeoutMs: 20_000,
    silentForMs: 20_000,
    lastEventType: "attempt-started",
    ...overrides,
  };
}

function stateWith(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    sessionId: "s",
    turnId: "t",
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
    providers: [],
    ...overrides,
  };
}

describe("turn-stopped is the user's decision, not a timeout", () => {
  it("says so in words, and names who stopped", () => {
    const view = stopView({ type: "turn-stopped", stage: "attempt", sessionId: SESSION });
    // "Du hast abgebrochen" is the claim. A message that only said "beendet" would
    // leave the user wondering whether the provider died.
    expect(view.message).toContain("Du hast den Turn abgebrochen");
    expect(view.outcome).toBe("interrupted");
    expect(view.code).toBe("user-stop");
  });

  it("distinguishes the approval-resume leg from the attempt leg", () => {
    // The loop emits `turn-stopped` in two places. A user who cancelled an approval
    // card should not read "you stopped the attempt".
    const resume = stopView({ type: "turn-stopped", stage: "approval-resume", sessionId: SESSION });
    const attempt = stopView({ type: "turn-stopped", stage: "attempt", sessionId: SESSION });
    expect(resume.stage).toBe("approval-resume");
    expect(resume.message).not.toBe(attempt.message);
    expect(resume.message).toContain("Freigabe-Karte");
  });

  it("names the billing consequence of a stop", () => {
    // `Plan.md` §5.4: the provider may still be generating and those tokens are
    // billed either way. A stop button that does not say so invites the belief
    // that pressing it saved something.
    expect(stopView({ type: "turn-stopped", stage: "attempt", sessionId: SESSION }).message).toContain("abrechnen");
  });

  it("wins over a classification in the banner", () => {
    // A stop carries no classification at all (`agent/loop.ts`), so a UI that
    // reached for the classification first would find nothing and fall through to a
    // generic message.
    const banner = turnBanner(
      stateWith({ outcome: "interrupted", classification: { kind: "no-response" } }),
      undefined,
      { ...EMPTY_LIVE_TURN, stopped: true, stopStage: "attempt" } satisfies LiveTurn,
    );
    expect(banner.stop).toBeDefined();
    expect(banner.message).toContain("Du hast den Turn abgebrochen");
  });
});

describe("a StallReport is a waiting state, never a verdict", () => {
  it("carries `isFailure: false` as a type, not a convention", () => {
    // `Plan.md` §5.4 and `runtime/watchdog.ts` both say the watchdog cannot end the
    // turn. `isFailure` is typed as the literal `false` so a component cannot widen
    // it to a boolean and start branching on it.
    const view = stallView(stallReport());
    expect(view.isFailure).toBe(false);
    expect(view.outcome).toBe("waiting");
  });

  it("names the measurement, not a cause", () => {
    // The report carries `silentForMs` and `lastEventType` and no
    // `Classification`, so this function must not invent a diagnosis. What it may
    // not contain is a verdict word: "kein Fehler" is a *denial* and reads
    // correctly, "Zeitüberschreitung" or "abgebrochen" would be a diagnosis the
    // report cannot support — and `turn-stopped` is the event that legitimately
    // says "abgebrochen".
    const view = stallView(stallReport({ silentForMs: 45_300 }));
    expect(view.silentSeconds).toBe(45.3);
    expect(view.message).toContain("45,3 s");
    expect(view.message).toContain("Warteanzeige");
    expect(view.message).not.toMatch(/Zeitüberschreitung|Timeout|abgebrochen|fehlgeschlagen/i);
  });

  it("says the turn keeps running", () => {
    expect(stallView(stallReport()).message).toContain("läuft weiter");
  });
});

describe("config-error / missing_api_key points at the key", () => {
  const missingKey: Classification = {
    kind: "config-error",
    code: "missing_api_key",
    message: "no apiKey was provided",
  };

  it("maps to its own outcome, not to `failed`", () => {
    // The mutation this kills: dropping the branch so a missing key falls through
    // to the generic error card. A user sent to the transcript finds nothing there
    // — the key is the fix, and it is a five-second one.
    const view = failureView(missingKey);
    expect(view.outcome).toBe("no-api-key");
    expect(view.outcome).not.toBe("failed");
    expect(view.pointsAtKey).toBe(true);
  });

  it("says there is no environment fallback, because there is not one", () => {
    // `Plan.md` §9: the SDK reads no environment in a browser. Without that
    // sentence a user looks for a `.env` file.
    expect(failureView(missingKey).message).toContain("Umgebungsvariable");
    expect(failureView(missingKey).message).toContain("Einstellungen");
  });

  it("sets `pointsAtKey` on the banner", () => {
    const banner = turnBanner(stateWith({ classification: missingKey, outcome: "failed" }), undefined);
    expect(banner.pointsAtKey).toBe(true);
  });

  it("does not claim the key is missing for an ordinary provider error", () => {
    // The other direction: `pointsAtKey` on every failure would send a user with a
    // rate limit to the settings instead of waiting.
    expect(failureView({ kind: "http-error", status: 429, retryable: true }).pointsAtKey).toBe(false);
  });

  it("does claim the key for a 401 and a 403", () => {
    expect(failureView({ kind: "http-error", status: 401, retryable: false }).pointsAtKey).toBe(true);
    expect(failureView({ kind: "http-error", status: 403, retryable: false }).pointsAtKey).toBe(true);
  });

  it("claims the key for a body error whose code names it", () => {
    expect(failureView({ kind: "body-error", code: "invalid_api_key", message: "x", retryable: false }).pointsAtKey).toBe(true);
  });
});

describe("a tool call with an unknown outcome is neither success nor failure", () => {
  const view = unknownOutcomeView(
    { type: "tool-outcome-unknown", toolCallId: "c1", toolName: "write", input: { path: "a.txt" }, sessionId: SESSION },
    stringer,
  );

  it("says baah does not know whether the effect happened", () => {
    // `Plan.md` §5.1. This is the honest state and the engine will not narrow it:
    // re-running risks a second write to the user's file, skipping silently hands
    // the model a result for work that may not have happened.
    expect(view.outcome).toBe("unknown");
    expect(view.message).toContain("weiß baah nicht");
  });

  it("says the call was neither repeated nor reported as failed", () => {
    expect(view.message).toContain("nicht");
    expect(view.message).toContain("wiederholt");
  });

  it("prescribes the action that is correct either way", () => {
    expect(view.advice).toContain("Prüfe das Ergebnis selbst");
  });

  it("names the tool and the call", () => {
    expect(view.toolName).toBe("write");
    expect(view.toolCallId).toBe("c1");
    expect(view.input).toContain("a.txt");
  });
});

describe("a storage-warning is a warning, not a turn failure", () => {
  it("distinguishes the two bookkeeping writes", () => {
    const heartbeat = storageWarningView({
      type: "storage-warning",
      operation: "heartbeat",
      attempt: 1,
      sessionId: SESSION,
      message: "database_closed",
    });
    const record = storageWarningView({
      type: "storage-warning",
      operation: "record-tool-call",
      attempt: 1,
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "write",
      message: "sql_error",
    });
    expect(heartbeat).toContain("Lebenserhaltungs-Puls");
    expect(record).toContain("write");
    // Both say the turn goes on. A storage warning rendered as a turn failure would
    // train the user to ignore the one warning that matters.
    expect(heartbeat).toContain("Turn läuft weiter");
    expect(record).toContain("Turn läuft weiter");
  });
});

describe("attempts and steps — Plan.md §5.4 requires the attempts to be visible", () => {
  it("renders the attempt counter", () => {
    expect(attemptsLabel(2, 3)).toBe("Versuch 2 von 3");
  });

  it("stays silent before the first attempt", () => {
    // Otherwise the bar flashes "Versuch 1 von 0" on an idle screen.
    expect(attemptsLabel(0, 0)).toBeUndefined();
  });

  it("says the answer is incomplete at the step ceiling", () => {
    // `Plan.md` §5.1: hitting `maxSteps` is a legitimate termination whose answer
    // is incomplete. Presenting it as finished is the lie.
    expect(stepsLabel(7, true)).toContain("unvollständig");
    expect(stepsLabel(7, false)).toBe("Schritt 7");
  });
});

describe("the boot report", () => {
  it("never promises a resume", () => {
    // `Plan.md` §14.4: `reconnectToStream()` always returns `null`. A "fortsetzen"
    // affordance would promise something the platform cannot deliver.
    const notice = bootNotice(
      stateWith({
        boot: {
          sessionId: "s",
          recovered: [{ turnId: "t1", heartbeatAt: "", startedAt: "" }],
          untouched: [],
          staleAfterMs: 30_000,
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    expect(notice?.message).toContain("kein fortgesetzter");
    expect(notice?.message).toContain("nicht möglich");
  });

  it("says nothing when nothing was recovered", () => {
    expect(
      bootNotice(
        stateWith({
          boot: { sessionId: "s", recovered: [], untouched: [], staleAfterMs: 30_000, checkedAt: "" },
        }),
      ),
    ).toBeUndefined();
  });
});
