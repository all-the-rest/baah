/**
 * The app, driven from a spec.
 *
 * ## Why this file exists rather than a fixture
 *
 * Every `§15.6` scenario needs the same three things before it can assert anything:
 * the app booted, the wizard configured, and a prompt sent. Written per test that
 * is eight copies of a procedure that has to stay in step with the wizard's steps —
 * and a wizard that gains a step would then break seven tests in seven places, with
 * seven different failure messages.
 *
 * The selectors come from `src/lib/testids.ts`, imported as constants. That is the
 * contract the runtime block wrote and the reason this suite does not reverse-engineer
 * anything: a typo is a type error, and a component that renames a testid breaks the
 * build rather than making a spec fail on a class name.
 */
import type { Locator, Page } from "@playwright/test";

import { TEST_IDS } from "../../src/lib/testids.ts";
// `fixtures.ts` re-exports Playwright's `expect`; importing it from here rather
// than from `@playwright/test` keeps the fixtures module the single import point for
// the suite's shared setup.
import { expect as playwrightExpect } from "./fixtures.ts";
import { PROVIDER_BASE_URL } from "./provider.ts";

/** Wait for the boot screen to be gone and a real screen to be up. */
export async function waitForApp(app: Page): Promise<void> {
  await playwrightExpect(app.locator("#root")).toBeVisible();
  // Either the wizard or the workbench. Both are a real screen; `baah-boot` is
  // neither, and neither is a boot failure.
  await playwrightExpect(app.locator('[data-testid="baah-wizard-skip"], [data-testid="baah-composer"]').first()).toBeVisible();
  await playwrightExpect(app.locator('[data-testid="baah-boot-failure"]')).toHaveCount(0);
}

/**
 * Walk the wizard to a configured state.
 *
 * ## The provider row is `openai-compatible`, and that is not incidental
 *
 * The E2E fake **is** an OpenAI-compatible server: `support/provider.ts` answers
 * `/v1/chat/completions` and `/v1/responses`, and the builders in `support/turns.ts`
 * emit the chat-completions framing. The wizard therefore configures the catalog row
 * that *is* "an OpenAI-compatible provider with a base URL" — which is also the
 * honest description of what the fake is.
 *
 * The `openai` row is **not** usable here, and the reason is a finding rather than a
 * preference. `@ai-sdk/openai@4`'s `createOpenAI({…})` returns the **Responses API**
 * model by default (the SDK says so itself when the bytes disagree), and on that path
 * it fills the finish part's `raw` reason from `response.incomplete_details.reason` —
 * a field that is absent for a **clean** completion. `Plan.md` §5.4's terminal-event
 * check is exactly `rawFinishReason !== undefined`
 * (`packages/baah-core/src/agent/loop.ts`), so on the Responses path a perfectly good
 * answer reads as a truncated stream and the loop retries it three times. Measured;
 * the report names it as the one cross-block defect this block found.
 *
 * `@ai-sdk/openai-compatible@3` sets `raw: choice.finish_reason`, so the check
 * passes — and that is the path `turns.ts` was built for in the first place.
 *
 * ## `vendor` exists for the Messages row, and it is the same fake
 *
 * `anthropic-compatible` is the other shape this fake can be, and it matters that
 * it needs **no new origin**: the E2E base URL is `https://e2e.invalid/v1`, so
 * `buildRequestUrl` produces `https://e2e.invalid/v1/messages`, which this
 * module already intercepts. The Anthropic turn therefore runs against the same
 * deny-by-default fake as every other scenario, and its assertion about the
 * browser header is made on a request the app really made.
 *
 * Every value is a **fake**: the key is not a credential, the base URL is the E2E
 * origin (`vite.config.ts` defines it only under `--mode e2e`, and
 * `support/provider.ts` intercepts it), and the workspace is the in-memory one. No
 * byte of a real provider is contacted and no secret is in the repository
 * (`AGENTS.md` §2).
 */
export async function completeWizard(
  app: Page,
  options: {
    readonly model?: string;
    readonly probe?: boolean;
    /** Which catalog row to select. Defaults to the OpenAI-compatible one. */
    readonly vendor?: string;
  } = {},
): Promise<void> {
  const vendor = options.vendor ?? "openai-compatible";
  // provider → model → key → workspace. The order is the wizard's, not §8.1's
  // letter-for-letter: the connection test addresses a model, so asking for the
  // key first would make the probe impossible on a first run. See `WIZARD_STEPS`.
  await app.locator(`[data-testid="baah-wizard-provider-${vendor}"]`).click();
  // Only the two template rows render these fields, and every row that needs an
  // endpoint needs both: the label names the entry (and its key slot), the URL is
  // the only thing that decides where requests go.
  if (await app.locator('[data-testid="baah-wizard-provider-label"]').count() > 0) {
    await app.locator('[data-testid="baah-wizard-provider-label"]').fill("e2e");
    await app.locator('[data-testid="baah-wizard-provider-baseurl"]').fill(PROVIDER_BASE_URL);
  }
  await app.locator('[data-testid="baah-wizard-next-provider"]').click();

  await app.locator('[data-testid="baah-wizard-model"]').fill(options.model ?? "gpt-fake");
  await app.locator('[data-testid="baah-wizard-next-model"]').click();

  await app.locator('[data-testid="baah-wizard-api-key"]').fill("sk-e2e-not-a-real-key");
  await app.locator('[data-testid="baah-wizard-save-key"]').click();

  if (options.probe === true) {
    await app.locator('[data-testid="baah-wizard-probe"]').click();
    await playwrightExpect(app.locator(`[data-testid="${TEST_IDS.providerProbeResult}"]`)).toBeVisible();
  }

  await app.locator('[data-testid="baah-wizard-next-key"]').click();
  await app.locator('[data-testid="baah-wizard-workspace-memory"]').click();
  await app.locator('[data-testid="baah-wizard-finish"]').click();

  await playwrightExpect(app.locator(`[data-testid="${TEST_IDS.transcript}"]`)).toBeVisible();
}

/** Boot and configure in one step. */
export async function openConfiguredApp(
  app: Page,
  options: { readonly model?: string; readonly probe?: boolean; readonly vendor?: string } = {},
): Promise<void> {
  await app.goto("/");
  await waitForApp(app);
  await completeWizard(app, options);
}

/** Type a prompt and send it. */
export async function sendPrompt(app: Page, prompt: string): Promise<void> {
  await app.locator('[data-testid="baah-composer-input"]').fill(prompt);
  await app.locator('[data-testid="baah-composer-send"]').click();
}

/** The transcript's visible text, concatenated. */
export async function transcriptText(app: Page): Promise<string> {
  return app.locator(`[data-testid="${TEST_IDS.transcript}"]`).innerText();
}

/** One tool card, addressed by the call id the provider used. */
export function toolCard(app: Page, toolCallId: string): Locator {
  return app.locator(`[data-testid="${TEST_IDS.toolCard}"][data-baah-tool-card-id="${toolCallId}"]`);
}

/**
 * Wait until the turn is not running.
 *
 * A poll on the runtime's own status attribute, not a sleep. A sleep would make the
 * test's outcome depend on the machine's load, and the "no request happened while
 * pending" assertion in the approval scenario is precisely the one that must not be a
 * race.
 *
 * The attribute is `data-baah-status` and it mirrors `RuntimeState.status`, which is
 * the fact the engine owns — it is set to `running` synchronously on entry to `send`
 * and back to `idle` in the `finally`, so a turn that has finished its work but not
 * yet flushed its transcript is still `running` here.
 *
 * ## The default timeout, and why it is 20 s
 *
 * A turn that spends all three of `Plan.md` §5.4's attempts waits **2 s + 8 s** of real
 * backoff before the third request goes out, so a scenario that scripts two failures
 * cannot finish inside the config's 5 s `expect` timeout. 20 s covers the longest
 * honest case and stays under Playwright's 30 s test timeout.
 *
 * This is a *budget*, not an assertion about timing: nothing in the suite asserts that
 * a retry took 2 s. The schedule belongs to `stream/backoff.ts`'s unit test, where
 * `random` and `sleep` are injected and the numbers are exact.
 *
 * ## Why the outcome badge is part of the wait, and why this was a real race
 *
 * `idle` on its own is satisfied **before the turn starts**: `AppShell` sets
 * `setRead(undefined)` and then calls `runtime.send`, and the runtime takes
 * `inFlight` synchronously on entry but only publishes `status: "running"` after
 * `await resolveModel()`. So there is a window in which the badge reads `idle` and no
 * turn is in flight at all, and this helper used to return immediately after
 * `sendPrompt` — every assertion after it was racing the turn.
 *
 * The in-memory store hid that: the turn and the read-back finished so fast that the
 * following assertion usually saw a settled page. Real SQLite does not go that fast,
 * and the hidden race turned into a ten-second `pending` wait. So the wait now
 * requires the **turn's outcome** as well, and `settle` publishes that only once a
 * `TurnResult` exists — a state the pre-send page cannot be in.
 */
export async function waitForTurnIdle(app: Page, timeoutMs = 20_000): Promise<void> {
  await playwrightExpect(
    app.locator(`[data-testid="${TEST_IDS.turnStatus}"][data-baah-status="idle"]`),
  ).toBeVisible({ timeout: timeoutMs });
  // And that a turn actually ran. See the header: `idle` alone is true before the
  // turn begins, and an outcome badge only exists once a `TurnResult` has settled.
  await playwrightExpect(
    app.locator(`[data-testid="${TEST_IDS.turnStatusOutcome}"]`),
  ).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait until the **stored** transcript has been read back.
 *
 * ## Why this is a separate wait, and why it exists at all
 *
 * `data-baah-status="idle"` says the turn stopped. It does not say the transcript
 * has been re-read: the shell kicks a `readTranscript()` off in the turn's
 * `finally` and installs the result when it lands, so a turn can be `idle` for a few
 * milliseconds before the view is authoritative. With the in-memory store the read
 * was a resolved promise and won that race for free; with real SQLite it is a
 * `postMessage` round trip to the worker and it does not.
 *
 * So this waits for the *pending* marker to clear **and** for the *absence of a
 * failure*. Waiting only for "not pending" would also be satisfied by a read that
 * refused, which is the one thing this must not accept — `Plan.md` §16.1 is explicit
 * that a failed read is not an answer.
 */
export async function waitForStoredTranscript(app: Page, timeoutMs = 10_000): Promise<void> {
  await playwrightExpect(app.locator('[data-baah-read="pending"]')).toHaveCount(0, { timeout: timeoutMs });
  await playwrightExpect(app.locator('[data-baah-read="problem"]')).toHaveCount(0, { timeout: timeoutMs });
}

/** The state text of one tool card. */
export async function toolCardState(app: Page, toolCallId: string): Promise<string> {
  return app
    .locator(`[data-testid="${TEST_IDS.toolCard}"][data-baah-tool-card-id="${toolCallId}"] [data-testid="${TEST_IDS.toolCardState}"]`)
    .innerText();
}
