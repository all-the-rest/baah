/**
 * The real Playwright configuration.
 *
 * The repository root has to carry a `playwright.config.ts`, but
 * `@playwright/test` is a devDependency of `@all-the.rest/baah-web` and pnpm
 * keeps it out of the root `node_modules`. Playwright loads a config with a
 * dynamic `import()` resolved *from the config file*, so a root config cannot
 * write `import { defineConfig } from "@playwright/test"` — it fails with
 * ERR_MODULE_NOT_FOUND before a single test runs. The root file is therefore a
 * three-line re-export of this one, which sits next to the dependency that can
 * be resolved.
 *
 * ⚠️ Paths below are resolved by Playwright relative to the ROOT config file
 * (`<repo>/playwright.config.ts`), not relative to this file. `testDir` is
 * root-relative on purpose.
 */
import { defineConfig, devices } from "@playwright/test";

/** Where `vite preview` serves `dist/` (see `vite.config.ts` → `preview`). */
const APP_URL = "http://127.0.0.1:4173";

export default defineConfig({
  // The suite lives in the web app, not at the repository root.
  testDir: "packages/baah-web/e2e",

  // `*.e2e.ts`, not the Playwright default `*.spec.ts` / `*.test.ts`:
  // `pnpm test` runs `vitest run` over the whole `baah-web` package, and vitest's
  // default glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) has no `e2e/` exclude. A
  // `*.spec.ts` file would be claimed by vitest, which cannot run Playwright
  // specs, and `pnpm check` would fail. This glob is the only thing keeping the
  // two runners apart.
  testMatch: "**/*.e2e.ts",

  // One worker: the suite is small, timing-sensitive and asserts exact request
  // counts. Serial execution removes shared-machine scheduling as a flake
  // source, which is what Playwright's own CI docs recommend.
  // `workers: 1`, and that is a MEASURED value, not caution. Three full-suite
  // runs at `workers: 2` and one at `1`:
  //
  //   1  whole suite   44/44
  //   2  whole suite   42/44   waitForTurnIdle timeouts
  //   2  whole suite   43/44   the pacer race
  //   2  only the 2 named failures, 3x   6/6
  //
  // The failures need the WHOLE suite's load; they do not appear when the same
  // tests run alone. So this is not "workers: 2 is broken" — it is that this
  // suite is not yet independent of how much CPU it gets.
  //
  // That is the SAME fault as the `grep` timeout test, whose expectation was
  // quoted from "~14 ms on this machine" and which CI failed on a FASTER runner.
  // Both are tests that measure the host. A flaky suite is worse than a slow
  // one: an unprotected `main` with an intermittently red CI teaches everyone to
  // ignore red.
  //
  // So the parallelism goes where the work is order-independent, which is the
  // screenshot suite — it captures pixels and asserts no timing at all. That one
  // runs `process.env.CI ? 4 : 2` in `e2e/screenshots/playwright.config.ts`.
  //
  // Raise this to `2` only together with the fix: no E2E test may depend on how
  // much of the machine it got. Recorded in agents.todo.md, with the numbers.
  workers: 1,

  // The scenarios are deterministic (no network, no API key, explicit gates
  // instead of sleeps), so a retry can only ever hide a real defect. Zero
  // everywhere, CI included.
  retries: 0,

  // A stray `test.only` must fail the run rather than silently shrink it.
  forbidOnly: Boolean(process.env.CI),

  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },

  reporter: [
    ["list"],
    // Written to test-results/playwright-report, uploaded by CI on failure.
    ["html", { open: "never", outputFolder: "test-results/playwright-report" }],
  ],
  outputDir: "test-results/artifacts",

  use: {
    baseURL: APP_URL,
    // Retain-on-failure, not on-first-retry: retries are 0, so
    // `on-first-retry` would never produce a trace at all.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  // Chromium only. Plan.md §15 exercises File System Access API, which is
  // Chromium-only by design (Plan.md §14.1); a Firefox/WebKit lane would
  // report failures that are documented facts, not regressions.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // `vite preview` and not a hand-rolled static server: it is already a
    // dependency, it serves exactly the `dist/` that CI builds, and it has no
    // proxy and no rewrite table, so it cannot smuggle a server into the
    // browser-only architecture of AGENTS.md §2. The build runs here (not in a
    // separate step) so the tested artefact is the artefact.
    command:
      "pnpm --filter @all-the.rest/baah-web build --mode e2e && pnpm --filter @all-the.rest/baah-web preview",
    url: APP_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
