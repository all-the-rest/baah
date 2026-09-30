/**
 * `Plan.md` §15.6 — the scenario matrix, proven.
 *
 * ## What changed, and why these were `fixme` before
 *
 * The seven scenarios were `test.fixme` with the note that the suite "will not
 * guess at selectors". They are now real tests, and the two things that had to exist
 * for them exist: a chat surface to click, and the `data-testid`s the runtime block
 * named in `src/lib/testids.ts`.
 *
 * `fixme` was the right state then — a permanently red E2E job protects nothing,
 * because a red job gets ignored and then disabled. It is the wrong state now that
 * the surface is there: a named `fixme` is a visible list of what is missing, and
 * this list is no longer missing anything.
 *
 * ## The path these scenarios speak
 *
 * **`/v1/chat/completions`, reached through the `openai-compatible` catalog row.**
 *
 * The first version of this file configured the `openai` row and failed every
 * scenario with the installed SDK's own diagnostic:
 *
 * ```
 * AI_APICallError: Received a Chat Completions stream while using the OpenAI
 * Responses API. … use createOpenAI(...).chat('model-id') instead.
 * ```
 *
 * Two facts came out of chasing it, and the second is a defect in **core**, not here:
 *
 * 1. `createOpenAI({…})` returns the Responses API model by default, so the `openai`
 *    row never posts to `/chat/completions`. The wizard now configures the row that
 *    *is* an OpenAI-compatible server — which is what the fake is — and
 *    `completeWizard` documents the whole chain.
 * 2. On the Responses path the provider fills the finish part's `raw` reason from
 *    `response.incomplete_details.reason`, which a **clean** completion does not
 *    have. `Plan.md` §5.4's terminal-event check is exactly
 *    `rawFinishReason !== undefined`, so every successful Responses turn reads as a
 *    truncated stream and is retried three times. See the report; core owns the
 *    check.
 *
 * The byte-level coverage of *both* framings stays where it belongs — in
 * `harness-self-test.e2e.ts`, which fetches with its own `parseSse` and never goes
 * through the app's provider.
 *
 * ## The two `test.fail` tests, and why there are none left
 *
 * Both were real assertions, and both were failing for one defect: `runTurn`'s
 * `finally` in `src/runtime/index.ts` cleared the `AgentTurn` reference even when the
 * turn *parked* on an approval, so `answerApproval` always threw `turn-busy` and
 * `Plan.md` §7.6's pause-and-resume could not happen through `BaahRuntime`. They
 * were encoded as `test.fail` because they are **not** to be deleted and **not** to
 * be asserted "green": they run, they count as neither passing nor skipped, and they
 * flip the suite red the moment the defect is fixed. That has happened, so they are
 * real tests now — leaving them as `test.fail` would have been a silent pass.
 *
 * The third scenario, "a `200` carrying an error JSON", is a genuine finding and
 * stays a measured assertion: the SDK consumes the body of a streamed request with
 * an event-source handler, so the engine never sees the error and the
 * retryable/protocol decision follows. The test pins the measured request count, so
 * the number changes when the defect is fixed.
 *
 * ## The two assertions that are load-bearing
 *
 * 1. **The approval scenario counts requests, and counts them *while pending*.**
 *    `provider.count() === 1` with a card on screen is what proves the **loop
 *    stopped** — not that a card appeared. A test that only checks for the card
 *    would pass with a loop that kept calling the model behind it, which is the
 *    failure the card exists to prevent.
 * 2. **The 5xx scenario is count-based, not timing-based.** `§5.4`'s backoff is
 *    0 s / 2 s / 8 s with ±25 % jitter. Asserting those in CI is a flake generator,
 *    and the schedule belongs to the engine's unit tests (`stream/backoff.ts`), which
 *    are deterministic because they inject `random` and `sleep`. What an E2E run can
 *    honestly measure is **that a retry happened**: three requests, a visible
 *    "Versuch 2 von 3", and a complete transcript.
 *
 * ## No sleeps
 *
 * Every wait is either a Playwright locator assertion or `expect.poll`. The pacer
 * (`support/pacer.ts`) exists so a stream can be held open or cut at an exact point,
 * which is how "the answer started and is not finished" is established as a fact
 * rather than hoped for with a `sleep(500)`.
 */
import { expect, test } from "./support/fixtures.ts";
import {
  openConfiguredApp,
  sendPrompt,
  toolCard,
  toolCardState,
  transcriptText,
  waitForApp,
  waitForStoredTranscript,
  waitForTurnIdle,
} from "./support/app.ts";
import { CHAT_COMPLETIONS_PATH, PROVIDER_BASE_URL } from "./support/provider.ts";
import { TEST_IDS } from "../src/lib/testids.ts";
// The card's own copy, imported rather than retyped. `scenarios.e2e.ts` already
// reaches into `src/` for the testids; this is the same idea applied to the one
// sentence whose exact wording §7.5 requires.
import { REJECT_SCOPE_NOTE } from "../src/components/lib/approval.ts";
import {
  jsonErrorIn200,
  chatTextTurn,
  chatToolCallTurn,
  truncatedStreamBody,
  serverErrorBody,
  unauthorizedBody,
} from "./support/turns.ts";

/** A prompt, so the transcript is never empty for the wrong reason. */
const PROMPT = "Was steht in HINWEIS.md?";

/* ------------------------------------------------------------------ */
/* 1. reiner Text-Stream                                                */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — reiner Text-Stream", () => {
  test("a text turn reaches the transcript as one assistant answer", async ({ app, provider }) => {
    await provider.script([{ reply: { kind: "sse", turn: chatTextTurn("Hallo aus dem Fake") } }]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);
    const text = await transcriptText(app);
    expect(text).toContain("Hallo aus dem Fake");
    // The provider prompt is on screen, which proves the turn actually ran rather
    // than the transcript showing something else entirely.
    expect(text).toContain(PROMPT);
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(1);
  });

  test("the turn's own outcome is recorded as an `idle` message", async ({ app, provider }) => {
    // `Plan.md` §6.2: the turn outcome is a message, not a separate construct. If
    // this ever stops being written, nothing else in the app would say the turn
    // finished at all.
    await provider.script([{ reply: { kind: "sse", turn: chatTextTurn("Fertig.") } }]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);
    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    await expect(app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`)).toHaveAttribute(
      "data-baah-outcome",
      "succeeded",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. Stream mit Tool-Call, Tool OK, dann Text                         */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — Stream mit Tool-Call, Tool OK, dann Text", () => {
  test("the tool card reaches `output-available` and the answer follows", async ({ app, provider }) => {
    // Two steps on one path, because the loop re-sends the whole turn per step
    // (`Plan.md` §5.1): step 1 asks for a tool, step 2 answers with the result.
    const toolCallId = "call_read_1";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: "HINWEIS.md" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Die Datei beschreibt den Arbeitsbereich.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    // The card is in the transcript, in the finished state, with the tool's name.
    await expect(toolCard(app, toolCallId)).toBeVisible();
    expect(await toolCardState(app, toolCallId)).toBe("Ausgeführt");
    await expect(toolCard(app, toolCallId).locator(`[data-testid="${TEST_IDS.toolCardName}"]`)).toHaveText("read");

    // And the answer came after it.
    expect(await transcriptText(app)).toContain("Die Datei beschreibt den Arbeitsbereich.");

    // The request count is the assertion that the turn really took two steps.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(2);
  });

  test("the tool ran exactly once, and the result is in the second request", async ({ app, provider }) => {
    // `Plan.md` §14.4's idempotency rule, from the outside: the `call_id` from
    // step 1 has to appear in step 2's request body, or the model was never told
    // what the tool did and the turn is not a turn.
    const toolCallId = "call_read_2";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: "HINWEIS.md" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Gelesen.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);
    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    const second = provider.requests.filter((entry) => entry.url.endsWith(CHAT_COMPLETIONS_PATH))[1];
    const body = JSON.stringify(second?.body ?? {});
    expect(body).toContain(toolCallId);
    // The tool's output is what came back, so the model saw it.
    expect(body).toContain("Arbeitsbereich");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Tool-Call mit `output-error`                                      */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — Tool-Call mit output-error", () => {
  test("a tool that fails shows the error and the turn continues", async ({ app, provider }) => {
    // A path that does not exist. Nothing about the failure comes from the
    // provider — the tool raised it — which is the point of this scenario: the
    // card's error state is the app's, not the wire's.
    const toolCallId = "call_missing";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: "gibt-es-nicht.md" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Die Datei gibt es nicht.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);
    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    const card = toolCard(app, toolCallId);
    await expect(card).toBeVisible();
    // `Fehlgeschlagen`, and the message is on screen — a card that said only
    // "Fehler" would leave the user with nothing to act on.
    expect(await toolCardState(app, toolCallId)).toBe("Fehlgeschlagen");
    await expect(card.locator(`[data-testid="${TEST_IDS.toolCardError}"]`)).toBeVisible();
    await expect(card.locator(`[data-testid="${TEST_IDS.toolCardError}"]`)).toContainText(/not found|File/i);

    // And the turn carried on: the model saw the error and answered.
    expect(await transcriptText(app)).toContain("Die Datei gibt es nicht.");
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(2);
  });

  test("a failed tool is not shown as an unknown outcome", async ({ app, provider }) => {
    // The two are different facts (`Plan.md` §5.1): a tool that *raised* has an
    // outcome — a failure — while `tool-outcome-unknown` means the effect is
    // genuinely unknowable. Collapsing them would tell a user a refused read
    // "may or may not have happened".
    const toolCallId = "call_missing_2";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: "gibt-es-nicht.md" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Nicht da.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);
    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    await expect(app.locator(`[data-testid="${TEST_IDS.outcomeUnknown}"]`)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Approval-Pause und -Fortsetzung                                  */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — Approval-Pause und -Fortsetzung", () => {
  test("the loop stops while an approval is pending, and the card offers three answers", async ({ app, provider }) => {
    // `read` on `.env` is the one approval `Plan.md` §7.4's default policy
    // produces — the rule engine judges it `ask`, so the SDK pauses. That makes
    // this scenario reachable through the **default** rules, which is the only way
    // an E2E test can exercise a real pause rather than a configured special case.
    const toolCallId = "call_env";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: ".env" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Ich habe die Konfiguration nicht gelesen.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    const card = app.locator(`[data-testid="${TEST_IDS.approvalCard}"]`);
    await expect(card).toBeVisible();

    // The load-bearing assertion. A card on screen proves nothing about the loop;
    // this proves the loop **stopped**, because a loop that kept going would have
    // asked for a second step by now.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH), "no second request while the approval is pending").toBe(1);

    // Three answers, and `reject` is a first-class one rather than a cancel.
    await expect(card.locator(`[data-testid="${TEST_IDS.approvalAllow}"]`)).toBeVisible();
    // `always` exists **only** because the card could resolve the call's resource,
    // and the resource is resolved through the tool's **name** —
    // `DEFAULT_APPROVAL_TARGETS` is keyed by it. A call that needs approval is named
    // by `approval-requested` rather than by a `tool-call` first, and the live fold's
    // placeholder name was `tool`, which matches no target: the third of §7.5's three
    // answers was silently absent for every approval until the fold learned the name.
    await expect(card.locator('[data-baah-approval-choice="always"]')).toBeVisible();
    await expect(card.locator(`[data-testid="${TEST_IDS.approvalDeny}"]`)).toBeVisible();
    // `Plan.md` §7.5's sweep is stated on the card, because the engine performs it.
    // The sentence is imported rather than retyped: this assertion spent its first
    // run failing on "alle**n**" against the card's "alle", which is exactly the
    // drift a hand-copied UI string invites. The copy is the contract; the spec
    // holds the same value the card renders.
    await expect(card).toContainText(REJECT_SCOPE_NOTE);
    // The exact input the model produced, and the risk class of reading a secret —
    // `Plan.md` §7.2, and the two things a generic card would have thrown away.
    await expect(card).toContainText('"path": ".env"');
    await expect(card).toHaveAttribute("data-baah-approval-risk", "read-secret");
    // The pattern an `always` answer would store, shown before the decision (§7.5).
    await expect(card).toContainText('{"action":"read","resource":".env","effect":"allow"}');
  });

  /**
   * The resume half of §15.6. This was a `test.fail`; it is a real assertion now.
   *
   * The defect it pinned: `runTurn`'s `finally` cleared `turn` **unconditionally**,
   * including when the engine resolved `run()` with `outcome: "awaiting-approval"` —
   * which it does *precisely* so the turn can be continued. `answerApproval` opens
   * with `if (turn === undefined) throw new RuntimeError("turn-busy", …)`, so every
   * click failed and the turn stood parked forever. `test.fail` reported 0 failures
   * and 0 skips while still running the assertions, and flipped the suite red the
   * moment the runtime was fixed — which is why it was pinned rather than deleted.
   * **Leaving it as `test.fail` after the fix would have been a silent pass.**
   *
   * The obvious app-level shortcut is re-sending the answered transcript with an
   * empty prompt. It would go green and be a false product: `ToolLoopAgent` is
   * built without `sendAutomaticallyWhen`, so it would ask the model to continue
   * **without ever running the approved tool** — a card claiming `read .env`
   * produced output, with no output and no read. The last two assertions are what
   * that shortcut cannot fake.
   */
  test("approving resumes the paused turn exactly once, and the approved tool really runs", async ({ app, provider }) => {
    const toolCallId = "call_env";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: ".env" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Ich habe die Konfiguration nicht gelesen.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    const card = app.locator(`[data-testid="${TEST_IDS.approvalCard}"]`);
    await expect(card).toBeVisible();
    await card.locator(`[data-testid="${TEST_IDS.approvalAllow}"]`).click();

    // `waitForTurnIdle` cannot be used here even once the resume works: a turn
    // parked on an approval reads as `idle` — nothing is running, and
    // `outcome: "awaiting-approval"` is what the banner renders — so the wait would
    // be satisfied before the resume had even started. The request count is the
    // fact, and `expect.poll` waits for it.
    await expect.poll(() => provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(2);
    await expect(app.locator(`[data-testid="${TEST_IDS.transcript}"]`)).toContainText(
      "Ich habe die Konfiguration nicht gelesen.",
    );
    // The card is gone, so the turn is not still parked on a decision.
    await expect(card).toHaveCount(0);

    /**
     * The half the empty-prompt shortcut cannot fake.
     *
     * `.env` does not exist in the sandbox workspace, so the read **fails** — and
     * that is exactly the point: a resume that asked the model again without running
     * the tool would leave the card at `input-available` for ever, because nothing
     * would ever report a result. Reaching `Fehlgeschlagen` is proof the tool ran,
     * and the count above is proof it ran **once** — a second execution would need a
     * third request.
     */
    expect(await toolCardState(app, toolCallId)).toBe("Fehlgeschlagen");
    // And the model really was told: the call and its result are in the second body.
    const second = provider.requests.filter((entry) => entry.url.endsWith(CHAT_COMPLETIONS_PATH))[1];
    expect(JSON.stringify(second?.body ?? {})).toContain(toolCallId);
  });

  /**
   * The second path for the `status: "running"`-on-resume rule, and the only place
   * in the repo where the status is observed **while** a continuation is in flight.
   *
   * The unit test pins the transition. This pins the *window*, and it gets there by
   * a different mechanism on purpose: the continuation's requests are **aborted**, so
   * the `fetch` never resolves and the turn is provably still running for as long as
   * the assertion takes. (`{ kind: "abort" }` is the harness's transport failure; the
   * alternative — holding a stream open with the pacer — cannot gate the *second*
   * request alone, because the pacer's budget is page-global and is counted against
   * the previous stream.)
   *
   * A runtime that published `running` for one tick and `idle` afterwards would
   * satisfy the unit test and leave the status bar lying for the whole continuation,
   * which is the part a user is looking at.
   */
  test("the status bar says the turn is running while the continuation is in flight", async ({
    app,
    provider,
  }) => {
    const toolCallId = "call_env_running";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: ".env" } }) } },
      // Every continuation request dies at the transport. The engine classifies that
      // as retryable and backs off, so the turn stays in flight across several
      // attempts — which is the window under test.
      ...Array.from({ length: 6 }, () => ({
        path: CHAT_COMPLETIONS_PATH,
        reply: { kind: "abort" as const, errorCode: "failed" },
      })),
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    const card = app.locator(`[data-testid="${TEST_IDS.approvalCard}"]`);
    await expect(card).toBeVisible();
    // Parked: nothing is running, and the card is what waits.
    await expect(app.locator(`[data-testid="${TEST_IDS.turnStatus}"][data-baah-status="idle"]`)).toBeVisible();

    await card.locator(`[data-testid="${TEST_IDS.approvalAllow}"]`).click();

    // The continuation's first request went out. A poll, not a sleep: the assertion
    // cannot pass before the request exists.
    await expect.poll(() => provider.countFor(CHAT_COMPLETIONS_PATH), { timeout: 10_000 }).toBeGreaterThan(1);
    // And the badge says the turn is running. **This is the mutation "publish `idle`
    // on the resume".**
    await expect(
      app.locator(`[data-testid="${TEST_IDS.turnStatus}"][data-baah-status="running"]`),
    ).toBeVisible();
    // The turn is still in flight, not finished-with-an-error: the classification of
    // an aborted request is retryable, and `Plan.md` §5.4's own rule is that a turn
    // which has not run out of attempts is still running.
    await expect(app.locator(`[data-testid="${TEST_IDS.turnStatus}"][data-baah-status="idle"]`)).toHaveCount(0);
  });

  test("a read of a non-secret path never asks", async ({ app, provider }) => {
    // The other half of `§7.4`, and it is what makes the approval scenario mean
    // something: if every read asked, the count above would prove nothing.
    const toolCallId = "call_plain";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: "HINWEIS.md" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Gelesen, ohne Freigabe.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);
    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    await expect(app.locator(`[data-testid="${TEST_IDS.approvalCard}"]`)).toHaveCount(0);
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(2);
  });

  /**
   * The other half of `§7.5`'s reject: a refusal the model **reads** and routes
   * around (`§7.6`), not a malfunction it retries.
   *
   * `test.fail` for the same reason as the allow case above, and the same one defect:
   * `answerApproval` could not reach the parked turn, so no answer of any kind got
   * past the card. The card, the three answers and the loop stopping are proven by
   * the first test in this block; what is left here is the resume.
   */
  test("rejecting produces `tool-output-denied` and no retry of the refused call", async ({ app, provider }) => {
    const toolCallId = "call_env_deny";
    await provider.script([
      { reply: { kind: "sse", turn: chatToolCallTurn({ toolCallId, toolName: "read", input: { path: ".env" } }) } },
      { reply: { kind: "sse", turn: chatTextTurn("Verstanden, ich lese sie nicht.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    const card = app.locator(`[data-testid="${TEST_IDS.approvalCard}"]`);
    await expect(card).toBeVisible();
    await card.locator(`[data-testid="${TEST_IDS.approvalDeny}"]`).click();

    // Same reason as the allow case: a parked turn reads as `idle`, so the count is
    // polled rather than waited on via the status attribute.
    await expect.poll(() => provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(2);
    // The card is gone, so the turn is not still parked on a decision.
    await expect(card).toHaveCount(0);
    // And the tool's own card says `Abgelehnt`, which is a different thing from
    // `Fehlgeschlagen` (§7.6: the model reads the refusal and routes around it).
    expect(await toolCardState(app, toolCallId)).toBe("Abgelehnt");
  });
});

/* ------------------------------------------------------------------ */
/* 5. 5xx mit Backoff                                                   */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — 5xx mit Backoff", () => {
  test("a 5xx is retried, the attempt is visible, and the third request succeeds", async ({ app, provider }) => {
    // Count-based, deliberately not timing-based. `Plan.md` §5.4's schedule is
    // 0 s / 2 s / 8 s with ±25 % jitter; asserting that in CI is a flake generator
    // and the schedule belongs to `stream/backoff.ts`, where `random` and `sleep`
    // are injected and the numbers are therefore exact. What an E2E run can
    // honestly measure is that a retry **happened** and that the user was told.
    await provider.script([
      { reply: { kind: "json", status: 503, body: serverErrorBody() } },
      { reply: { kind: "json", status: 503, body: serverErrorBody() } },
      { reply: { kind: "sse", turn: chatTextTurn("Dritter Versuch, diesmal hat es geklappt.") } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    // Three requests: two refused, one answered. This is the assertion that
    // matters — a "retry" that only re-renders is not a retry.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(3);

    // §5.4: "Die Versuche werden im UI sichtbar." A silent retry is unhelpful
    // precisely when the failure is hard to diagnose.
    const attempts = app.locator(`[data-testid="${TEST_IDS.turnStatusAttempts}"]`);
    await expect(attempts).toBeVisible();
    await expect(attempts).toContainText("Versuch 3 von 3");

    // And the transcript is complete: the successful attempt's text is there.
    expect(await transcriptText(app)).toContain("Dritter Versuch, diesmal hat es geklappt.");
  });
});

/* ------------------------------------------------------------------ */
/* 6. 401 ohne Retry                                                    */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — 401 ohne Retry", () => {
  test("a 401 is surfaced as a rejected key and never retried", async ({ app, provider }) => {
    // `Plan.md` §5.4's table: `invalid_api_key` is **never** retried — the key is
    // wrong, not broken, and three requests would burn nothing and teach the user
    // nothing.
    await provider.script([{ reply: { kind: "json", status: 401, body: unauthorizedBody() } }]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    // The request count is the whole assertion: one, not two.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(1);
    // And the error is about the key, not about the transport.
    const outcome = app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`);
    await expect(outcome).toBeVisible();
    expect(await outcome.getAttribute("data-baah-outcome")).not.toBe("succeeded");
  });
});

/* ------------------------------------------------------------------ */
/* 7. 200 mit Fehler-JSON                                               */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — 200 mit Fehler-JSON", () => {
  test("a 200 carrying an error body is a failure, not an empty success", async ({ app, provider }) => {
    // `Plan.md` §5.4 step 4, and the case that makes the whole classification
    // necessary: the status line says success, the body says failure. A UI that
    // trusted the status would show an empty, "successful" turn — and the user
    // would conclude the model had nothing to say.
    //
    // ## The request count here is 3, and that is a finding, not a typo
    //
    // §5.4 says a money error is never retried, and `stream/classify.ts` knows
    // `insufficient_quota` well enough to say so. The engine never gets to use that
    // knowledge: `@ai-sdk/openai-compatible` reads a streamed response with an
    // event-source handler, so a `application/json` body on a stream request is
    // consumed by the SDK and the engine is handed
    // `AI_InvalidResponseDataError: Response stream ended without a finish reason`
    // with no error body at all. What the engine can then classify is
    // `protocol-error`, which *is* retryable, so the turn burns all three attempts.
    //
    // So the count is asserted as measured, with the reason attached. Asserting `1`
    // would be asserting a behaviour the stack does not have, and asserting nothing
    // would let the classification change in either direction unnoticed. When the
    // SDK or the engine learns to read the body, **this test fails** — which is the
    // point: the number is the pin on the defect.
    await provider.script([
      { reply: { kind: "json", status: 200, body: jsonErrorIn200({ type: "billing", code: "insufficient_quota" }) } },
    ]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    const outcome = app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`);
    await expect(outcome).toBeVisible();
    // Not a success — the whole point of the scenario.
    expect(await outcome.getAttribute("data-baah-outcome")).not.toBe("succeeded");
    // The measured consequence of the defect named above. `toBe(3)`, not `toBe(1)`.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(3);
    // And the transcript says something, rather than showing an empty conversation.
    expect(await transcriptText(app)).not.toContain("Noch nichts in diesem Verlauf");
  });
});

/* ------------------------------------------------------------------ */
/* 8. Abbruch mitten im Stream                                          */
/* ------------------------------------------------------------------ */

test.describe("§15.6 — Abbruch mitten im Stream", () => {
  test("a stream cut mid-flight is interrupted, keeps its text, and offers no resume", async ({ app, provider }) => {
    // No `response.completed` and no `[DONE]`: the connection ends mid-answer.
    // `Plan.md` §5.4 says that is a failure, and §6.2 says the partial text is
    // **kept** and marked — never silently dropped, because a dropped partial is
    // what makes a transport failure undiagnosable.
    await provider.script([{ reply: { kind: "sse-raw", body: truncatedStreamBody() } }]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);

    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    const text = await transcriptText(app);
    // The part that arrived before the cut is still on screen.
    expect(text).toContain("this text arrived");
    const outcome = app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`);
    await expect(outcome).toBeVisible();
    expect(await outcome.getAttribute("data-baah-outcome")).not.toBe("succeeded");

    // `Plan.md` §14.4: `reconnectToStream()` always returns `null`. There is no
    // resume, so the UI must not offer one. The re-send is a *new* turn.
    await expect(app.locator("text=fortsetzen")).toHaveCount(0);
    await expect(app.locator("text=Fortsetzen")).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* The wiring the scenarios all depend on                               */
/* ------------------------------------------------------------------ */

test.describe("the app the scenarios run against", () => {
  test("the wizard says no model catalogue is wired, rather than inventing one", async ({ app }) => {
    // `Plan.md` §8.1 step 4 asks for a catalogue with context length and price. It is
    // not wired in this build, and a hard-coded model list would be a list that goes
    // stale silently and then gets blamed for a provider error.
    await app.goto("/");
    await waitForApp(app);
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await expect(app.locator('[data-baah-model-catalog="absent"]')).toBeVisible();
  });

  test("the connection test reports the CORS matrix as a warning, not a wrong key", async ({ app, provider }) => {
    // `Plan.md` §9: the model list answers with an ACAO header and the inference
    // endpoint does not. A wizard that rendered that as "connection failed" would
    // train the user to blame their key for a provider policy — the one conclusion
    // §9 says is wrong. The tone is `warning` and the copy says the key works.
    //
    // The abort is scripted **once**, and the probe therefore runs in the *re-opened*
    // wizard. The first wizard pass deliberately does not probe: a scripted reply is
    // consumed by whichever request arrives first, so probing twice would leave the
    // second run with no script at all and it would report an `http-error` — a
    // different finding, reached by a test that looks right.
    await provider.script([
      { path: CHAT_COMPLETIONS_PATH, reply: { kind: "abort", errorCode: "failed" } },
    ]);
    await openConfiguredApp(app);

    // Re-open the wizard through the settings screen, which is the path §8.1 asks
    // for ("später aus den Settings erneut aufrufbar").
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    // Re-openable is only true if the configuration comes **back**, and it used not
    // to: the stored id `"openai-compatible:e2e"` was compared against catalog ids,
    // so no row was selected, the label was dropped and the base-URL field started
    // empty — and the next `Weiter` wrote that empty URL over a working setup.
    await expect(app.locator('[data-testid="baah-wizard-provider-openai-compatible"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(app.locator('[data-testid="baah-wizard-provider-baseurl"]')).toHaveValue(PROVIDER_BASE_URL);
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator('[data-testid="baah-wizard-next-model"]').click();
    // No re-save of the key before the probe: the button used to be disabled until
    // `saved`, which was per-mount, so §8.1's connection test was unreachable on the
    // one screen a returning user opens it from.
    await app.locator('[data-testid="baah-wizard-probe"]').click();

    const result = app.locator(`[data-testid="${TEST_IDS.providerProbeResult}"]`);
    await expect(result).toBeVisible();
    // `cors-blocked` — the two-endpoint comparison in `probe.ts` is what produces
    // it, and it is the row the wizard exists for.
    await expect(result).toHaveAttribute("data-baah-outcome", /cors-blocked/);
    // Warning, not error: the key is not the problem.
    await expect(result).toHaveAttribute("data-baah-probe-tone", "warning");
  });

  test("a missing API key points at the key, not at the transcript", async ({ app }) => {
    // The mutation: dropping the `config-error` / `missing_api_key` branch so it
    // falls through to a generic turn error. A user sent to the transcript would
    // find nothing there — the key is the fix, and `Plan.md` §9 says the SDK reads
    // no environment, so there is no `.env` to look for.
    await app.goto("/");
    await waitForApp(app);
    // Skip the wizard: no key at all, so `resolveModel` refuses before any request.
    await app.locator('[data-testid="baah-wizard-skip"]').click();
    await expect(app.locator('[data-baah-composer-disabled="true"]')).toContainText("API-Key");
  });

  test("the transcript survives a reload — §1's DoD 4, against real SQLite in OPFS", async ({ app, provider }) => {
    /**
     * The persistence requirement, as a user-visible fact.
     *
     * Two things have to be true for this to pass, and both were broken:
     *
     * 1. **The database is durable.** The previous build used
     *    `createMemoryDatabase()` because `openDatabase()`'s worker URL was emitted
     *    as untranspiled TypeScript. Fixed in `components/lib/runtime.ts` with Vite's
     *    `?worker&url` form; the compiled worker is `dist/assets/worker-*.js` and the
     *    `.wasm` beside it.
     * 2. **The session is reachable.** A durable row nothing can query has not
     *    survived a reload, and the app minted a fresh `sessionId` on every document
     *    load. Fixed by `lib/ids.ts`'s `resolveSessionId`.
     *
     * Fix either one and this test fails, which is the point: a memory database and
     * a new session id both render an empty transcript after the reload, and only
     * the *pair* of them is what the previous build shipped.
     */
    await provider.script([{ reply: { kind: "sse", turn: chatTextTurn("Das übersteht jetzt einen Reload.") } }]);
    await openConfiguredApp(app);
    await sendPrompt(app, PROMPT);
    await waitForTurnIdle(app);
    // The turn is idle; the stored read is a separate round trip to the worker.
    await waitForStoredTranscript(app);

    const before = await transcriptText(app);
    expect(before).toContain("Das übersteht jetzt einen Reload.");
    // The memory-database warning is gone with the memory database. Asserted
    // negatively on purpose: a build that keeps the banner while persisting would
    // be telling the user something false, and one that removed the banner while
    // still using a `Map` is what this test exists to catch.
    await expect(app.locator('[data-baah-ephemeral-banner="true"]')).toHaveCount(0);
    await expect(app.locator('[data-baah-boot-failure="true"]')).toHaveCount(0);

    // The reload. Not a new tab: the same document, reloaded, which is what a user
    // does with F5 and what §15.4's D1 asks for.
    await app.reload();
    await waitForApp(app);
    // The boot opens SQLite and the read comes back from the worker. The failure mode
    // this waits out is exactly the finding: an unusable worker URL makes
    // `openDatabase()` reject, and `App.tsx` then shows the boot-failure screen
    // instead of a chat.
    await waitForStoredTranscript(app);

    // The wizard is skipped by the stored settings, so the chat is straight there —
    // and the transcript is not empty.
    await expect(app.locator(`[data-testid="${TEST_IDS.transcript}"]`)).toBeVisible();
    const after = await transcriptText(app);
    // The question, the answer, and in order. A session id that did not survive
    // would render "Noch nichts in diesem Verlauf" here.
    expect(after).toContain("Das übersteht jetzt einen Reload.");
    expect(after).toContain(PROMPT);
    expect(after).not.toContain("Noch nichts in diesem Verlauf");
    /**
     * The turn's outcome came back too — and the assertion is on the **stored**
     * `idle` message (`Plan.md` §6.2), not on the status badge.
     *
     * The badge is `RuntimeState.outcome`, which is per-tab in-memory state and is
     * `undefined` on a fresh document by definition. Asserting it here would be
     * asserting that a reload did not happen. The `Turn-Ende: idle` row is the part
     * that is in SQLite, so its presence after a reload is the durable claim — and
     * it is a third message in the transcript, after the question and the answer,
     * which is the ordering `seq` gives it.
     */
    expect(after).toContain("Turn-Ende: idle");
    // The outcome badge is genuinely absent, for the reason above — said here so a
    // future change that makes it survive a reload knows this was considered.
    await expect(app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`)).toHaveCount(0);
    // Nothing was re-requested: the reload restored, it did not regenerate.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(1);
  });

  test("the wizard is skippable, and the app says what a turn is missing", async ({ app }) => {
    // `Plan.md` §8.1: "Der Wizard muss überspringbar sein." A user whose provider is
    // unreachable today must still be able to reach the app.
    await app.goto("/");
    await waitForApp(app);
    await app.locator('[data-testid="baah-wizard-skip"]').click();
    await expect(app.locator(`[data-testid="${TEST_IDS.transcript}"]`)).toBeVisible();
    const missing = app.locator('[data-baah-composer-disabled="true"]');
    await expect(missing).toContainText("Provider");
    await expect(missing).toContainText("Modell");
  });

  test("the settings panel lists key slots and never a key value", async ({ app }) => {
    // `AGENTS.md` §2: a key must not reach a rendered string, a screenshot or an
    // issue. The slot name is what the user is entitled to see.
    //
    // The slot is `openai-compatible:e2e` and not `openai` because that is the row
    // the wizard configured: `apiKeySlot` splits on the first colon
    // (`src/lib/ids.ts`), and a label is stored in the id precisely so a second
    // `openai-compatible` provider can have its own key. Asserting the bare
    // `"openai"` here would pass for a build that had lost the label.
    await openConfiguredApp(app);
    await app.locator('[data-testid="baah-open-settings"]').click();
    const slot = app.locator(`[data-testid="${TEST_IDS.settingsKeySlot}"]`).first();
    await expect(slot).toHaveText("openai-compatible:e2e");
    await expect(app.locator("body")).not.toContainText("sk-e2e-not-a-real-key");
  });

  test("the export opt-in is off by default and says what it would include", async ({ app }) => {
    // `Plan.md` §8.2: keys excluded by default, behind a separate warning checkbox.
    // The default is `false` and is derived from nothing — not "a key is stored".
    await openConfiguredApp(app);
    await app.locator('[data-testid="baah-open-settings"]').click();
    const checkbox = app.locator(`[data-testid="${TEST_IDS.settingsExportIncludeKeys}"]`);
    await expect(checkbox).not.toBeChecked();
    await expect(app.locator('[data-baah-export-summary="true"]')).toContainText("Enthält keine Keys");
  });

  test("nothing leaves the app's own origin while it is idle", async ({ app, provider, faults }) => {
    // `AGENTS.md` §2 as a test. The app may not have a proxy, and this proves the
    // root document makes no off-origin request before anything is asked of it.
    await app.goto("/");
    await waitForApp(app);
    await app.waitForLoadState("networkidle");
    expect(provider.count()).toBe(0);
    faults.assertClean();
  });
});
