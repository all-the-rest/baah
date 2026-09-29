/**
 * Smoke: the built app boots, serves a real document, and stays quiet.
 *
 * The point of this file is what it asserts about *behaviour*, not about the
 * placeholder markup. Wave 2 replaces `packages/baah-web/src/App.tsx` with the
 * real UI, so nothing here may depend on today's text, class names or element
 * counts — every assertion below has to survive that replacement, and the
 * assertions that would not survive it were left out on purpose.
 *
 * The one thing that is deliberately state-independent and load-bearing: the app
 * may not talk to anything but its own origin. That is AGENTS.md §2 (browser
 * only, no provider proxy) expressed as a test rather than as a review note, and
 * it keeps holding once the provider code lands.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { isProviderUrl, PROVIDER_ORIGINS } from "./support/provider.ts";

/** Load the app and wait for the document to be interactive. */
async function openApp(app: Page): Promise<void> {
  const response = await app.goto("/");
  expect(response, "the static server answered /").not.toBeNull();
  expect(response?.status(), "GET / is served").toBe(200);
  // The JS bundle is the thing that can fail to parse; wait for it to run.
  await expect(app.locator("#root")).toBeVisible();
}

test.describe("smoke", () => {
  test("the app boots, renders a document, and logs nothing", async ({ app, faults }) => {
    await openApp(app);

    // A rendered document, not an empty shell: there is a title, a lang, and
    // the mount point has children. None of that is Wave-2-specific.
    await expect(app).toHaveTitle(/\S/);
    expect(await app.evaluate(() => document.documentElement.lang)).toBeTruthy();
    expect(
      await app.evaluate(() => document.getElementById("root")?.childElementCount ?? 0),
      "#root has rendered children",
    ).toBeGreaterThan(0);

    // The load-bearing assertion: no uncaught exception (a failed import or a
    // hydration error shows up here) and nothing logged at error level. This is
    // what fails when Wave 2 lands a broken slice.
    faults.assertClean();
  });

  test("the app stays quiet after a reload, not just on first paint", async ({ app, faults }) => {
    await openApp(app);
    await app.reload();
    await expect(app.locator("#root")).toBeVisible();
    // A second module evaluation is where StrictMode double-invocation and
    // duplicate-init bugs surface.
    await expect(app.locator("#root")).toBeVisible();
    faults.assertClean();
  });

  test("nothing leaves the app except its own origin (AGENTS.md §2)", async ({ app, provider }) => {
    /** Every request the page made, as `origin + pathname`. */
    const origins: string[] = [];
    app.on("request", (request) => {
      origins.push(new URL(request.url()).origin);
    });

    await openApp(app);
    // The deterministic signal, not a sleep: the network has no requests in
    // flight, so everything the app was going to send, it has sent.
    await app.waitForLoadState("networkidle");

    const appOrigin = new URL(app.url()).origin;
    const offOrigin = [...new Set(origins)].filter((origin) => origin !== appOrigin);

    expect(
      offOrigin,
      `every request must stay on ${appOrigin}; known provider origins: ${PROVIDER_ORIGINS.join(", ")}`,
    ).toEqual([]);

    // And nothing reached a provider, which the fake would otherwise have
    // answered. An unscripted request would show up in the log as a 501.
    expect(provider.count(), "the app made no provider call while idling").toBe(0);
    expect(provider.unscripted).toEqual([]);
  });

  test("a request to a known provider origin never reaches the network", async ({
    app,
    provider,
  }) => {
    // The guard above only proves the app stayed quiet. This proves the
    // interception is real: a request the app does not make is still answered
    // locally, and counted.
    await openApp(app);
    const result = await app.evaluate(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-fake", stream: true }),
      });
      return { status: response.status, type: response.headers.get("content-type") };
    }, "https://e2e.invalid/v1");

    expect(provider.count()).toBe(1);
    // 501 = the fake answered, and nothing was scripted for it.
    expect(result.status).toBe(501);
    expect(provider.unscripted).toHaveLength(1);
    expect(isProviderUrl(provider.last()?.url ?? "")).toBe(true);
  });
});
