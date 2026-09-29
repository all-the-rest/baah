/**
 * Plan.md §15.6 — the scenario matrix, and what is actually proven today.
 *
 * §15.6 asks for eight provider scenarios. Six of the eight need a chat UI that
 * does not exist yet, so they are recorded as `test.fixme` holes: a skipped
 * test with a name, so they appear in the HTML report as an explicit list of
 * what is missing, rather than as nothing at all. They do not fail the run — a
 * permanently red E2E job protects nothing, because a red job gets ignored and
 * then disabled.
 *
 * What IS covered today, and where:
 *
 * | §15.6 scenario                            | status    | covered by                                 |
 * | ----------------------------------------- | --------- | ------------------------------------------ |
 * | reiner Text-Stream                        | DONE      | `harness-self-test.e2e.ts`, chat + responses |
 * | 200 mit Fehler-JSON                       | wire only | `support/turns.ts` → `jsonErrorIn200`       |
 * | Abbruch mitten im Stream                   | DONE      | `harness-self-test.e2e.ts` → pacer `errorAt` |
 * | Stream mit Tool-Call, Tool OK, dann Text  | Wave 2    | below                                       |
 * | Tool-Call mit `output-error`               | Wave 2    | below                                       |
 * | Approval-Pause und -Fortsetzung           | Wave 2    | below                                       |
 * | 5xx mit Backoff                            | Wave 2    | below                                       |
 * | 401 ohne Retry                             | Wave 2    | below                                       |
 *
 * "wire only" means the bytes for that scenario exist and are asserted, but the
 * assertion is on the provider side of the boundary. §15.6 is about what the
 * *app does* with them, so that row is not done either — the `fixme` entry
 * below names what is still missing.
 *
 * Two seams have to exist before the deferred rows can be written:
 *
 * 1. a way to reach the model from a test — the app has no chat surface, so
 *    there is nothing to click. Wave 2's transcript plus the test-only provider
 *    base URL (already wired: `import.meta.env.BAAH_E2E_PROVIDER_BASE_URL`, set
 *    by `--mode e2e`) covers it.
 * 2. stable `data-testid`s for the transcript, the tool card and the approval
 *    card. Wave 2 owns those; this suite will not guess at them.
 */
import { test } from "./support/fixtures.ts";

test.describe("Plan.md §15.6 — deferred until the Wave 2 chat UI exists", () => {
  test.fixme(
    "TODO(wave-2) text → tool call → tool result → text renders as one turn",
    () => {
      // Script: [chatToolCallTurn(read), chatTextTurn] — two steps on
      // /chat/completions, because the loop re-sends the whole turn per step.
      // Assert: the transcript shows the tool card in `output-available` and
      // then the assistant text; `provider.count()` is 2; the tool ran exactly
      // once — the `toolCallId` from step 1 appears in step 2's request body,
      // which is the idempotency rule of Plan.md §14.4.
    },
  );

  test.fixme(
    "TODO(wave-2) a tool call that fails shows `output-error`",
    () => {
      // Script: [chatToolCallTurn]. The tool itself throws; nothing about that
      // comes from the provider.
      // Assert: the tool card reaches `output-error` with the message visible,
      // and the turn continues (the loop feeds the error back to the model).
      // Relevant: the loop's `tool-outcome-unknown` event with
      // `outcome: "unknown"` is what tells a free result set apart from a
      // failure — a card must claim neither when the event says "unknown".
    },
  );

  test.fixme(
    "TODO(wave-2) an approval pauses the turn and only resumes after a decision",
    () => {
      // Script: [chatToolCallTurn(write)] and then NOTHING.
      // Assert, in order: the approval card appears; the model is not called
      // again while it is pending (`provider.count()` stays 1); approving
      // causes exactly one more request, whose body carries the tool result;
      // denying produces `tool-output-denied` and no new request.
      // This is the scenario that needs a real gate — the request count is the
      // assertion that the loop really stopped, not just that a card appeared.
    },
  );

  test.fixme(
    "TODO(wave-2) a 5xx is retried with the §5.4 backoff",
    () => {
      // Script: [5xx serverErrorBody(), 5xx serverErrorBody(), text turn].
      // Assert: `provider.count()` is 3; the UI shows "attempt 2 of 3" and
      // "3 of 3"; the third request succeeds and the transcript is complete.
      // The request count is the load-bearing assertion. The backoff *timing*
      // (0 s / 2 s / 8 s with ±25 % jitter) is deliberately not asserted: a
      // timing assertion in CI is a flake generator, and the timing belongs to
      // the engine's unit tests, not to an end-to-end run.
    },
  );

  test.fixme(
    "TODO(wave-2) a 401 is not retried",
    () => {
      // Script: [401 unauthorizedBody()].
      // Assert: `provider.count()` is 1 — exactly one request, no second
      // attempt; the error is surfaced as "the key is wrong", not as a
      // transport failure.
    },
  );

  test.fixme(
    "TODO(wave-2) a 200 carrying an error JSON is treated as a failure",
    () => {
      // Script: [200 with jsonErrorIn200()].
      // Assert: the turn fails; the error text comes from the JSON body, not
      // from a status line; the partial output of the failed attempt is kept
      // and marked, not silently replaced.
    },
  );

  test.fixme(
    "TODO(wave-2) a stream cut mid-flight is interrupted, not resumed",
    () => {
      // Script: [truncatedStreamBody()] — no terminal event, no [DONE].
      // Assert: the turn ends as `interrupted` with its partial text still
      // visible; a "retry" button re-sends the turn as a new attempt;
      // `reconnectToStream()` is never called (it always returns null —
      // Plan.md §14.4), so "resume" must not appear anywhere in the UI.
    },
  );
});
