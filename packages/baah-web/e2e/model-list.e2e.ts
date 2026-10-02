/**
 * The model list, through the app.
 *
 * ## Why this file exists, and what it changes about the block
 *
 * The loader (`src/providers/models.ts`) arrived correct and fully unit-tested, and
 * **nothing could call it**. `AppShell` did not pass `onListModels`, so the wizard's
 * "Modelle laden" button was never rendered and every user was told
 * „Es ist kein Modellkatalog eingebunden" — while `ModelList.complete`, the field
 * whose entire reason for existing is *an incomplete list must not look like a
 * complete one*, was a return value no screen ever read.
 *
 * Measured before the fix: deleting the entire
 * `data-baah-model-list-incomplete` paragraph left `pnpm check` at 486 tests green
 * **and** `pnpm e2e` at 56 passed. A promise kept in a return value is not a
 * promise; it is a branch nobody walks.
 *
 * So the assertions here are the ones that were unwitnessed:
 *
 * 1. **A list is offered.** The wizard offers the provider's own `/models` and
 *    renders the models it serves. The `scenarios.e2e.ts` case that pinned the
 *    *absence* is replaced rather than left to contradict this.
 * 2. **The provider's `display_name` reaches the screen.** Driven on the
 *    `anthropic-compatible` row, whose fake body carries `Claude Fake`. A loader
 *    that read only `data[].id` passes every unit test in the repo and shows
 *    `claude-fake` to the user; only a rendered `<option>` tells the two apart.
 * 3. **An incomplete list says so, and a complete one does not.** Scripted
 *    `has_more: true` with no cursor, then the same list without it — same wizard,
 *    same button, opposite notices. This is the assertion that makes the paragraph
 *    undeletable.
 * 4. **A failure is a named failure.** A `501` becomes a rendered error naming the
 *    loader's own class, not an empty list and not a silent nothing.
 */
import { expect, test } from "./support/fixtures.ts";
import { completeWizard, waitForApp } from "./support/app.ts";
import { TEST_IDS } from "../src/lib/testids.ts";

/** The path suffix the model list is served at. */
const MODELS_PATH = "/models";

test.describe("§8.1 step 4 — the model list is offered", () => {
  test("the wizard loads the provider's own models and lists them", async ({ app, provider }) => {
    // A configured app, then the wizard re-opened through the settings screen —
    // the same route `scenarios.e2e.ts` uses for the connection test, and the one
    // `Plan.md` §8.1 asks for ("später aus den Settings erneut aufrufbar").
    await app.goto("/");
    await waitForApp(app);
    await completeWizard(app);
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();

    // **The button is the wiring.** Before this block `onListModels` was passed by
    // nobody, so this node did not exist and neither did the "no catalogue" message
    // a user actually saw.
    const load = app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`);
    await expect(load).toBeVisible();
    // The old „Es ist kein Modellkatalog eingebunden" paragraph must be **gone**,
    // not merely outranked. It was the truth while the prop had no caller and a
    // lie the moment `AppShell` passed one — and a screen that says both at once
    // is worse than either. `toHaveCount(0)` rather than "not visible": a node
    // hidden by CSS is a node a user can still be shown by a theme.
    await expect(app.locator('[data-baah-model-catalog="absent"]')).toHaveCount(0);
    await expect(app.locator("text=Es ist kein Modellkatalog eingebunden")).toHaveCount(0);

    await load.click();

    const panel = app.locator(`[data-testid="${TEST_IDS.modelListPanel}"]`);
    await expect(panel).toBeVisible();
    // Complete, and it says so in its own attribute rather than in prose.
    await expect(panel).toHaveAttribute("data-baah-model-list", "complete");
    // The model the fake serves. Asserted on the **option**, not on the request:
    // a loader that fetched the list and rendered nothing would satisfy neither.
    await expect(
      app.locator(`[data-testid="${TEST_IDS.modelListSelect}"] option[value="gpt-fake"]`),
    ).toHaveText(/gpt-fake/);
    // Exactly one request for the list, and it carried the key as a header.
    expect(provider.countFor(MODELS_PATH)).toBe(1);
    const request = provider.last();
    expect(request?.headers["authorization"]).toBe("Bearer sk-e2e-not-a-real-key");
  });

  test("the provider's own display_name is what the user reads", async ({ app, provider }) => {
    // The `anthropic-compatible` row, whose `/models` body is Anthropic's: the same
    // `data[]` envelope plus `display_name` and the cursor fields. This is what
    // `ANTHROPIC_MODELS_BODY` in `support/provider.ts` is for, and what the fixture's
    // comment used to *claim* it was for while nothing read it.
    await app.goto("/");
    await waitForApp(app);
    await completeWizard(app, { vendor: "anthropic-compatible", model: "claude-fake" });
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();

    await app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`).click();

    // The label the **provider** sent, with the id kept alongside it. A loader
    // reading only `data[].id` would show `claude-fake` and pass everything else in
    // this file.
    await expect(
      app.locator(`[data-testid="${TEST_IDS.modelListSelect}"] option[value="claude-fake"]`),
    ).toHaveText("Claude Fake (claude-fake)");

    // And the shape came from the **request**, not from a guess: `models.ts` sends
    // `anthropic-version` for the `anthropic-compatible` row (it is a parameter of
    // the dialect, not the operator claim), and the fake keys the body off it. A
    // `modelsBodyFor` that fell back to the OpenAI shape would render `gpt-fake`
    // here and fail the assertion above — which is why the fixture's comment can
    // claim this body is consumed by a real test again.
    expect(provider.countFor(MODELS_PATH)).toBe(1);
    expect(provider.last()?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("a PICKED model lands in the free-text field", async ({ app, provider }) => {
    // The list is only a convenience if choosing from it changes something. The
    // field below it stays for the case the list cannot cover — an incomplete list,
    // or a model the provider did not report.
    //
    // **`provider` is requested even though only one line below uses it**, and that
    // is not tidiness: the fixture *installs the route interception*. A test that
    // omits it sends `GET /v1/models` to a host that does not resolve, gets
    // `unreachable`, and renders an error instead of a list — which looks exactly
    // like a broken feature and is not one. (This test failed that way once.)
    await app.goto("/");
    await waitForApp(app);
    await completeWizard(app, { vendor: "anthropic-compatible", model: "claude-fake" });
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`).click();

    // Wait for the list to be **on screen** before touching the control in it.
    // `selectOption` on a not-yet-rendered `<select>` waits out the whole test
    // budget and then reports a timeout, which reads like a broken feature rather
    // than a click that landed one frame early.
    await expect(app.locator(`[data-testid="${TEST_IDS.modelListSelect}"]`)).toBeVisible();
    await app.locator(`[data-testid="${TEST_IDS.modelListSelect}"]`).selectOption("claude-fake");

    // The provider's id, not the label — a pick that filled the `<option>`'s text
    // would put `Claude Fake (claude-fake)` into the model field and the next turn
    // would ask the model for a model that does not exist.
    await expect(app.locator('[data-testid="baah-wizard-model"]')).toHaveValue("claude-fake");
    // Exactly one request for the list, and it was the fake's.
    expect(provider.countFor(MODELS_PATH)).toBe(1);
  });
});

test.describe("an incomplete list says so", () => {
  test("a cursor the provider never resolved renders the incomplete notice", async ({ app, provider }) => {
    // `has_more: true` with no `last_id` is the endpoint that would otherwise spin:
    // it says there is more and sends nothing to fetch it with. The loader stops
    // after one page and **says so** — which is the promise the block's own header
    // makes: an incomplete list presented as a complete one is the same lie as a
    // truncated `grep`.
    provider.script([
      {
        path: MODELS_PATH,
        reply: {
          kind: "json",
          status: 200,
          body: JSON.stringify({ data: [{ id: "gpt-fake" }], has_more: true }),
        },
      },
    ]);
    await app.goto("/");
    await waitForApp(app);
    await completeWizard(app);
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`).click();

    const panel = app.locator(`[data-testid="${TEST_IDS.modelListPanel}"]`);
    await expect(panel).toHaveAttribute("data-baah-model-list", "incomplete");
    // **The assertion the block did not have.** Deleting this paragraph used to
    // leave `pnpm check` and `pnpm e2e` both green.
    const notice = app.locator('[data-baah-model-list-incomplete]');
    await expect(notice).toBeVisible();
    // …and it says what is missing, not merely that something is.
    await expect(notice).toContainText("Unvollständig");
    await expect(notice).toContainText("kann es sehr wohl geben");
    // The model it *did* see is still offered — an honest partial list is usable.
    await expect(
      app.locator(`[data-testid="${TEST_IDS.modelListSelect}"] option[value="gpt-fake"]`),
    ).toHaveCount(1);
  });

  test("a COMPLETE list shows no incomplete notice — the same screen, the opposite verdict", async ({ app, provider }) => {
    // The other half, and it is not the optional half: a notice that renders for a
    // complete list trains the user to ignore it, which is the same failure as
    // never rendering it. Same wizard, same button, one scripted field different.
    provider.script([
      {
        path: MODELS_PATH,
        reply: {
          kind: "json",
          status: 200,
          body: JSON.stringify({ data: [{ id: "gpt-fake" }], has_more: false }),
        },
      },
    ]);
    await app.goto("/");
    await waitForApp(app);
    await completeWizard(app);
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`).click();

    await expect(app.locator(`[data-testid="${TEST_IDS.modelListPanel}"]`)).toHaveAttribute(
      "data-baah-model-list",
      "complete",
    );
    // Zero, not "not visible": a hidden-by-CSS notice is a notice nobody reads.
    await expect(app.locator('[data-baah-model-list-incomplete]')).toHaveCount(0);
  });

  test("a provider that refuses is a NAMED error, not an empty list", async ({ app, provider }) => {
    // The six codes exist so the wizard can react to each. Rendering "0 Modelle" for
    // a 401 says the provider serves no models, which is a different fact and one
    // the user cannot act on.
    provider.script([
      {
        path: MODELS_PATH,
        reply: {
          kind: "json",
          status: 401,
          body: JSON.stringify({ error: { type: "invalid_request_error" } }),
        },
      },
    ]);
    await app.goto("/");
    await waitForApp(app);
    await completeWizard(app);
    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`).click();

    const error = app.locator('[data-baah-model-list="error"]');
    await expect(error).toBeVisible();
    // **The loader's own code, and the assertion is a negative on both wrong
    // answers.** Before this block every `ModelListError` fell through
    // `toRuntimeError`'s generic branch to
    // `RuntimeError("provider-unresolved", "ModelListError: the provider could not
    // be reached")`, and this component rendered `error.name` — so the user read
    // the literal string **„RuntimeError"** on all six codes.
    //
    // Asserted as `not.toContain` rather than positively, because the failure mode
    // is a *fallback*: a mapping that produced a code but fell through on the text
    // would satisfy a weaker assertion and still tell the user nothing.
    await expect(error).toContainText("model-list-http-error");
    await expect(error).not.toContainText("RuntimeError");
    await expect(error).not.toContainText("provider-unresolved");
    // And no panel: a failed read is not an empty list.
    await expect(app.locator(`[data-testid="${TEST_IDS.modelListPanel}"]`)).toHaveCount(0);
  });

  test("a MISSING base URL says which field to fill — a different code from a 401", async ({ app, provider }) => {
    // A **different** one of the six, and the reason they are separate codes. This
    // entry has no base URL, so the loader refuses before any request goes out —
    // and the answer is a user action, not a subsystem label.
    //
    // The field is emptied on purpose: `defaultBaseUrl` for `openai-compatible` is
    // `""` (the catalog marks the row `needsEndpoint`), and `Weiter` writes whatever
    // is in the field. A user who clears it lands exactly here.
    //
    // A key **is** saved first, because the loader checks it before the endpoint
    // (`missing_api_key` is the nearer code and the wizard would say that instead).
    // So the walk is provider → model → key, then out to the workbench and back in
    // through the settings screen — the same re-open route every other case here
    // uses, and the one `Plan.md` §8.1 asks for.
    await app.goto("/");
    await waitForApp(app);
    await app.locator('[data-testid="baah-wizard-provider-openai-compatible"]').click();
    await app.locator('[data-testid="baah-wizard-provider-label"]').fill("e2e");
    await app.locator('[data-testid="baah-wizard-provider-baseurl"]').fill("");
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator('[data-testid="baah-wizard-next-model"]').click();
    await app.locator('[data-testid="baah-wizard-api-key"]').fill("sk-e2e-not-a-real-key");
    await app.locator('[data-testid="baah-wizard-save-key"]').click();
    await app.locator('[data-testid="baah-wizard-skip"]').click();

    await app.locator('[data-testid="baah-open-settings"]').click();
    await app.locator('[data-testid="baah-settings-open-wizard"]').click();
    await app.locator('[data-testid="baah-wizard-next-provider"]').click();
    await app.locator(`[data-testid="${TEST_IDS.modelListLoad}"]`).click();

    const error = app.locator('[data-baah-model-list="error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText("model-list-missing-endpoint");
    // **Not** the code the 401 case produced. Two different failures, two different
    // codes — which is the whole reason the six exist and the whole thing a single
    // `model-list-failed` would have destroyed.
    await expect(error).not.toContainText("model-list-http-error");
    // And nothing was requested: there is no URL to address, so a request here
    // would mean the check ran in the wrong order.
    expect(provider.countFor(MODELS_PATH)).toBe(0);
  });
});
