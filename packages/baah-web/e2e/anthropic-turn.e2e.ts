/**
 * An Anthropic turn, end to end, against the fake.
 *
 * ## Why this file exists at all
 *
 * Until now the suite drove `openai-compatible` **only**
 * (`e2e/support/app.ts:72`). The `anthropic` path was declared, its header was
 * computed in three places, it was documented in `catalog.ts` and
 * `factories.ts` — and it had **never executed once**. "Anthropic is supported"
 * was a claim, not a fact.
 *
 * That is the same error class as the `rawFinishReason` bug this repo already
 * paid for: a better signal that does not exist everywhere. The `@ai-sdk/openai`
 * Responses path was correct in the source and wrong on the wire for a reason
 * only a real request could have shown. So this file drives one complete turn
 * through the app on Anthropic's Messages format and asserts what actually went
 * out and what actually came back.
 *
 * ## It drives `anthropic-compatible`, and that is the harder row
 *
 * The Messages turn is the same for both rows; what differs is the operator. The
 * `anthropic-compatible` row is the one that (a) proves a Messages-format
 * endpoint at a third party's address works at all, and (b) is the row that must
 * **not** carry `anthropic-dangerous-direct-browser-access`. Asserting the
 * header's absence on a request the app really made is worth more than asserting
 * its presence in a unit test — and both are asserted here, because a suite that
 * only ever sees one direction cannot tell a correct implementation from a
 * constant.
 *
 * ## What the assertions are, one by one
 *
 * 1. **The request goes to `/messages`.** The failure this whole block fixes was
 *    a `chat/completions` POST to a Messages server, which fails *silently*.
 * 2. **No Anthropic browser header.** The negative, on the wire.
 * 3. **The turn completes with the assistant's text in the transcript.** Not a
 *    "no error" assertion — the text itself, because a Messages stream can be
 *    consumed and still lose the answer.
 * 4. **Exactly one request.** The loop's retry budget is three; a turn that had
 *    to be retried would show up here, and it is the only assertion that catches
 *    the `stop_reason`-missing case this fake could so easily have shipped.
 */
import { expect, test } from "./support/fixtures.ts";
import {
  openConfiguredApp,
  sendPrompt,
  transcriptText,
  waitForStoredTranscript,
  waitForTurnIdle,
} from "./support/app.ts";
import { CHAT_COMPLETIONS_PATH, MESSAGES_PATH, PROVIDER_BASE_URL } from "./support/provider.ts";
import { anthropicTextTurn } from "./support/turns.ts";
import { TEST_IDS } from "../src/lib/testids.ts";

/** The header that must not go to a third party. */
const ANTHROPIC_BROWSER_HEADER = "anthropic-dangerous-direct-browser-access";

test.describe("an Anthropic turn runs through the app", () => {
  test("user message → assistant text → turn end, on the Messages wire format", async ({ app, provider }) => {
    provider.script([{ path: MESSAGES_PATH, reply: { kind: "sse", turn: anthropicTextTurn("hallo vom fake") } }]);

    await openConfiguredApp(app, { vendor: "anthropic-compatible", model: "claude-fake" });

    await sendPrompt(app, "sag hallo");

    await waitForTurnIdle(app);
    await waitForStoredTranscript(app);

    // 1. The request went to the Messages endpoint. `countFor` counts *suffix*
    //    matches, so this also proves nothing else answered.
    expect(provider.countFor(MESSAGES_PATH)).toBe(1);
    // …and explicitly not to the endpoint this row used to be forced through.
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(0);
    expect(provider.unscripted).toEqual([]);

    // 4. One request, so the turn was never retried. §5.4's budget is three and
    //    a `message_delta` without `stop_reason` would have consumed it: the
    //    engine reads `rawFinishReason` from exactly that field, and a clean
    //    Messages turn missing it looks like a truncated stream.
    expect(provider.count()).toBe(1);
    await expect(
      app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`),
    ).toHaveText("succeeded");

    // 3. The answer is on screen, not merely un-errored.
    const transcript = await transcriptText(app);
    expect(transcript).toContain("sag hallo");
    expect(transcript).toContain("hallo vom fake");
  });

  test("the request carries x-api-key and anthropic-version, but NOT the browser header", async ({ app, provider }) => {
    provider.script([{ path: MESSAGES_PATH, reply: { kind: "sse", turn: anthropicTextTurn("hallo") } }]);

    await openConfiguredApp(app, { vendor: "anthropic-compatible", model: "claude-fake" });
    await sendPrompt(app, "hallo");
    await waitForTurnIdle(app);

    const request = provider.last();
    expect(request).toBeDefined();

    // Dialect parameters. Both must be present: a Messages server rejects a
    // request without `anthropic-version`, so "no Anthropic headers" would be
    // the wrong way to pass this test.
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request?.headers["x-api-key"]).toBeTruthy();

    // 2. The negative, on a request the app really made. `undefined` is what
    //    Playwright's `request.headers()` reports for an absent header; the
    //    membership check is there because `undefined` would also satisfy a
    //    `toBeUndefined()` written by someone who never checked the other one.
    expect(request?.headers[ANTHROPIC_BROWSER_HEADER]).toBeUndefined();
    expect(Object.keys(request?.headers ?? {})).not.toContain(ANTHROPIC_BROWSER_HEADER);
  });

  test("the label never reaches the URL — the endpoint is the one the user typed", async ({ app, provider }) => {
    provider.script([{ path: MESSAGES_PATH, reply: { kind: "sse", turn: anthropicTextTurn("hallo") } }]);

    await openConfiguredApp(app, { vendor: "anthropic-compatible", model: "claude-fake" });
    await sendPrompt(app, "hallo");
    await waitForTurnIdle(app);

    // The wizard labels this entry `e2e`. `https://e2e/…` was the original bug —
    // a label handed to a vendor SDK as a base URL, which cannot resolve and
    // says nothing about why.
    const url = provider.last()?.url ?? "";
    expect(url.startsWith(`${PROVIDER_BASE_URL}${MESSAGES_PATH}`)).toBe(true);
    expect(url).not.toContain("/e2e/");
  });

  test("the first-party Anthropic row DOES send the browser header, from the same fake", async ({ app, provider }) => {
    // The other direction, on the same wire, from the same fake. Without it the
    // suite cannot distinguish a correct implementation from a constant that
    // always omits the header — which is the failure the two rows exist to
    // prevent between them.
    //
    // No base-URL field is filled here, and that is deliberate rather than
    // convenient: the `anthropic` row keeps its **catalog** URL,
    // `https://api.anthropic.com/v1`, and `defaultBaseUrl()` substitutes the E2E
    // origin for `openai` only (`components/lib/onboarding.ts`). So this turn
    // goes to `https://api.anthropic.com/v1/messages` — an origin
    // `PROVIDER_ORIGINS` already lists, so the deny-by-default fake answers it
    // and the assertion is made on a request addressed the way a real one would
    // be. (Checked, not assumed: an earlier draft of this comment claimed the E2E
    // override applied here too. It does not, and the run is what showed it.)
    provider.script([{ path: MESSAGES_PATH, reply: { kind: "sse", turn: anthropicTextTurn("hallo") } }]);

    await app.goto("/");
    await app.locator('[data-testid="baah-wizard-provider-anthropic"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator('[data-testid="baah-wizard-model"]').fill("claude-fake");
    await app.locator('[data-testid="baah-wizard-next-model"]').click();
    await app.locator('[data-testid="baah-wizard-api-key"]').fill("sk-e2e-not-a-real-key");
    await app.locator('[data-testid="baah-wizard-save-key"]').click();
    await app.locator('[data-testid="baah-wizard-next-key"]').click();
    await app.locator('[data-testid="baah-wizard-workspace-memory"]').click();
    await app.locator('[data-testid="baah-wizard-finish"]').click();

    await sendPrompt(app, "hallo");
    await waitForTurnIdle(app);

    expect(provider.countFor(MESSAGES_PATH)).toBe(1);
    expect(provider.last()?.headers[ANTHROPIC_BROWSER_HEADER]).toBe("true");
  });

  test("the wizard offers the row and says its CORS story is unmeasured", async ({ app }) => {
    await app.goto("/");
    const row = app.locator('[data-testid="baah-wizard-provider-anthropic-compatible"]');

    await expect(row).toBeVisible();
    // Three states, and the third one is the new one: §9 measured no
    // Messages-compatible third party, so „CORS bestätigt" here would be a
    // string comparison dressed as a measurement.
    await expect(row.locator('[data-baah-cors-state]')).toHaveAttribute("data-baah-cors-state", "unmeasured");
    await expect(row.locator("text=CORS ungemessen")).toBeVisible();
    // …and it is NOT the row that claims Anthropic's header.
    await expect(row.locator("text=Sonderheader nötig")).toHaveCount(0);
    await expect(
      app.locator('[data-testid="baah-wizard-provider-anthropic"] [data-baah-cors-state]'),
    ).toHaveAttribute("data-baah-cors-state", "verified");
  });
});
