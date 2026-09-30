/**
 * The generic, manifest-driven screenshot spec.
 *
 * ## What this file knows and what it deliberately does not
 *
 * It knows three things: how to start a fresh document, how to wait for the
 * pixels to be there, and how to write PNGs. It knows **nothing** about
 * onboarding, wizards, transcripts, approvals, settings or errors — every one of
 * those is a `prepare` in `manifest.ts`. Adding a state is therefore a manifest
 * edit and nothing else, which is the property the harness reference asks for.
 *
 * ## No assertions about behaviour
 *
 * The one `expect` below is the static `<title>` guard the harness reference
 * prescribes, and it exists so a foreign dev-server on the port can never be
 * silently screenshotted. Everything else is a *wait* — `waitFor` on an element,
 * `waitForLoadState`, a fixed settle — never a claim about what the app does.
 * The functional suite (`../scenarios.e2e.ts`) is where behaviour is proven.
 *
 * A consequence worth stating: **a screenshot test that fails is a finding, not
 * a flake to be worked around.** There is no retry (`retries: 0` in the config)
 * and no assertion here to weaken. If a state cannot be reached, the report says
 * so and the harness stops pretending it can.
 *
 * ## Why sections, and why the *inner* scroller
 *
 * A full-page PNG of a long page is downscaled to ~2000 px before a vision model
 * reads it, so everything below the fold becomes unreadable. `captureSections`
 * therefore also scrolls and re-shoots in 80 %-viewport steps (20 % overlap).
 *
 * `baah`'s shell is `flex h-screen` (`AppShell.tsx`), so the **window never
 * scrolls** — `document.scrollingElement.scrollHeight` equals the viewport and the
 * template's window-first heuristic would emit exactly one `sec0` for every
 * state and no content at all. The scrollable content is in inner containers:
 * `data-testid="baah-transcript"` (`overflow-y-auto`, the transcript), the
 * settings `<aside>` and the workspace panel. `captureSections` finds the
 * innermost scroller with the most hidden content and scrolls *that*.
 *
 * And a finding this harness cannot fix, only record: `Transcript.tsx` contains
 * no `scrollTop`/`scrollIntoView` call, so **the transcript never auto-scrolls.**
 * A streaming answer grows downwards out of view, and the approval card — which
 * the component's own comment says "must be impossible to scroll past" — is below
 * the fold exactly when it appears. The `-secN` files are what make that visible
 * to a reviewer; they do not make it invisible.
 */
import { expect, test } from "../support/fixtures.ts";
import type { Page, TestInfo } from "@playwright/test";

import { shots, type UiReviewShot, type UiReviewState, type UiReviewViewport } from "./manifest.ts";

/**
 * Mirrors `outputDir` in `playwright.config.ts`, **relative to the repository
 * root** — which is the directory Playwright resolves `outputDir` against.
 *
 * `page.screenshot({ path })` resolves a relative path against the process
 * working directory instead, which is `packages/baah-web` when the run is started
 * through `pnpm --filter`. So every path here is built absolute, from the config
 * file's own directory, rather than from `process.cwd()`.
 */
const OUTPUT_DIR = "packages/baah-web/test-results/ui-screenshots";

/** `index.html`'s static `<title>`. A guard, not a claim about the app. */
const EXPECTED_TITLE = "opencode-harness-web";

/**
 * How many `-secN` files one state may produce.
 *
 * 10 viewport-heights of scrolling is already far more content than this app can
 * produce: the transcript is read back through the store's limit. The cap exists
 * so that a change which suddenly makes one container scrollable by 400 screens
 * fails loudly as a file-count surprise in the report instead of quietly
 * producing four thousand PNGs.
 */
const MAX_SECTIONS = 10;

/** The directory every relative config path in this repo is resolved against. */
function configDirOf(testInfo: TestInfo): string {
  const configFile = testInfo.config.configFile;
  // `configFile` is `path.resolve(...)`'d by Playwright, so a `/` is enough to
  // strip the file name. `null`/empty means "no config file", which cannot happen
  // for this run (the script always passes `-c`); the `rootDir` fallback keeps the
  // type honest rather than asserting it.
  if (configFile === undefined || configFile === "") {
    return testInfo.config.rootDir;
  }
  return configFile.slice(0, configFile.lastIndexOf("/"));
}

function outFor(testInfo: TestInfo, state: UiReviewState, viewport: UiReviewViewport, file: string): string {
  return `${configDirOf(testInfo)}/${OUTPUT_DIR}/${state}/${viewport}/${file}`;
}

/** The manifest's viewport axis maps 1:1 onto this config's two projects. */
function viewportOfProject(projectName: string): UiReviewViewport {
  return projectName === "mobile" ? "mobile" : "desktop";
}

const viewportsOf = (shot: UiReviewShot): readonly UiReviewViewport[] =>
  shot.viewports ?? (["desktop", "mobile"] as const);

/**
 * Let the frame settle.
 *
 * `load` rather than `networkidle`, and this is load-bearing: four of the states
 * below are *held open by construction* — an approval waiting for a decision, a
 * question waiting for an answer, a stream the pacer has gated, a provider that
 * has gone quiet for 20 s. `networkidle` would wait for a quiescence those states
 * deliberately never reach, and every one of them would time out.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  // Long enough for React to commit a click handler's state change and for the
  // browser to lay the frame out. Not a race: everything the state needs has
  // already been awaited by `prepare`.
  await page.waitForTimeout(500);
}

type ScrollPlan =
  | { readonly kind: "window"; readonly max: number; readonly step: number }
  | { readonly kind: "element"; readonly max: number; readonly step: number };

/**
 * Where the content actually is.
 *
 * Window first (the honest default), then **every** element that scrolls on the
 * vertical axis, picking the one with the most content below its fold. The
 * chosen element is tagged `data-baa-shot-scroller` so the scroll steps can
 * address it again from a later `page.evaluate` — an element handle cannot cross
 * the boundary, and the attribute is removed on the next call.
 */
async function findScrollPlan(page: Page): Promise<ScrollPlan> {
  return page.evaluate(() => {
    for (const stale of Array.from(document.querySelectorAll("[data-baa-shot-scroller]"))) {
      stale.removeAttribute("data-baa-shot-scroller");
    }
    const windowHeight = window.innerHeight;
    const windowStep = Math.max(1, Math.round(windowHeight * 0.8));
    const doc = document.scrollingElement;
    if (doc !== null && doc.scrollHeight > windowHeight + 4) {
      return { kind: "window" as const, max: doc.scrollHeight - windowHeight, step: windowStep };
    }

    let best: { readonly element: HTMLElement; readonly overflow: number; readonly step: number } | undefined;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") continue;
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow <= 4) continue;
      if (best === undefined || overflow > best.overflow) {
        best = { element, overflow, step: Math.max(1, Math.round(element.clientHeight * 0.8)) };
      }
    }
    if (best === undefined) return { kind: "window" as const, max: 0, step: windowStep };

    best.element.setAttribute("data-baa-shot-scroller", "1");
    return { kind: "element" as const, max: best.overflow, step: best.step };
  });
}

async function scrollTo(page: Page, plan: ScrollPlan, offset: number): Promise<void> {
  await page.evaluate(
    ({ kind, top }: { kind: ScrollPlan["kind"]; top: number }) => {
      if (kind === "window") {
        window.scrollTo(0, top);
        return;
      }
      document.querySelector<HTMLElement>("[data-baa-shot-scroller]")?.scrollTo(0, top);
    },
    { kind: plan.kind, top: offset },
  );
}

/**
 * Viewport-height sections covering the whole state, then back to the top.
 *
 * `animations: "disabled"` and `caret: "hide"` are not decoration. The app marks
 * every live part with a pulsing dot (`animate-pulse`) and the composer holds a
 * blinking caret; left running, two captures of the same state differ, and a
 * reviewer cannot tell a rendering change from a frame of an animation.
 */
async function captureSections(
  page: Page,
  testInfo: TestInfo,
  shot: UiReviewShot,
  state: UiReviewState,
  viewport: UiReviewViewport,
): Promise<void> {
  const plan = await findScrollPlan(page);
  let index = 0;
  for (let offset = 0; ; index += 1) {
    await scrollTo(page, plan, offset);
    await page.waitForTimeout(150);
    await page.screenshot({
      path: outFor(testInfo, state, viewport, `${shot.name}-sec${String(index)}.png`),
      fullPage: false,
      animations: "disabled",
      caret: "hide",
    });
    if (offset >= plan.max || index + 1 >= MAX_SECTIONS) break;
    offset = Math.min(plan.max, offset + plan.step);
  }
  await scrollTo(page, plan, 0);
}

for (const shot of shots) {
  for (const state of shot.states) {
    for (const viewport of viewportsOf(shot)) {
      test(
        `screenshot ${shot.name} (${state}, ${viewport})`,
        // Every test carries the tag, so one state can be re-shot with
        // `--grep "screenshot chat-approval"`.
        { tag: ["@screenshot"] },
        async ({ app, provider, pacer }, testInfo) => {
          test.skip(
            viewportOfProject(testInfo.project.name) !== viewport,
            `project ${testInfo.project.name} renders the ${viewportOfProject(testInfo.project.name)} viewport`,
          );

          await shot.prepare({ page: app, provider, pacer });
          await settle(app);

          // The foreign-server guard. Exact, because a mismatch means the port
          // is somebody else's app and every PNG from here on would be fiction.
          await expect(app).toHaveTitle(EXPECTED_TITLE);

          await app.screenshot({
            path: outFor(testInfo, state, viewport, `${shot.name}.png`),
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
          await captureSections(app, testInfo, shot, state, viewport);
        },
      );
    }
  }
}
