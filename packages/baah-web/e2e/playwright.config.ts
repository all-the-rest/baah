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
    /**
     * `vite build --mode e2e` **directly**, and then `vite preview` — the same *shape*
     * the screenshot config runs (`vite build --mode e2e && vite preview --port 4174`),
     * and for the same reason. It is written out rather than as `pnpm build` because
     * that script is `tsc --noEmit && vite build && node ../../scripts/build-sw.mjs`, and
     * a **type error anywhere it can reach stops the whole suite from starting.**
     *
     * Measured, not theorised: with a single wrong property name in one throwaway
     * probe file under `e2e/` (which has nothing to do with the app),
     *
     * ```
     * e2e/u8-probe.e2e.ts(81,13): error TS2339: Property 'stdout' does not exist on
     *   type '{ readonly env: { readonly CI?: string; }; }'.
     * [WebServer] $ tsc --noEmit && vite build && node ../../scripts/build-sw.mjs --mode e2e
     * [WebServer] Command failed with exit code 1.
     * Error: Process from config.webServer was not able to start. Exit code: 1
     * ```
     *
     * and all 44 app tests refused to run. The failure surfaces three ways and none of
     * them says the truth: a `TS2552` in a file unrelated to the app,
     * `[WebServer] Command failed with exit code 1`, and — in an earlier run, with the
     * `dist/` from before — `GET / → 404`, which reads exactly like a broken product.
     * It is an environment defect wearing a product defect's clothes, and the cost of
     * the fix is one duplicated `tsc` invocation that already runs elsewhere.
     *
     * ## Typecheck coverage is not lost. Do not "restore" it here.
     *
     * `tsc` still gates the app, in the job that owns typechecking:
     *
     * - the root `package.json`'s `check` is
     *   `pnpm check:browser-only && pnpm typecheck && pnpm test`, and `typecheck` runs
     *   `tsc --noEmit` per package;
     * - `packages/baah-web/tsconfig.json` has `"include": ["src", "e2e", "test", …]`,
     *   so `pnpm typecheck` covers the e2e tree too, with Vite's client types;
     * - CI's `e2e` job runs
     *   `pnpm --filter @all-the.rest/baah-web exec tsc -p e2e/tsconfig.json` as its own
     *   step, before Playwright starts. That is the **stricter** of the two typechecks —
     *   `e2e/tsconfig.json` sets `"types": []`, so the e2e tree is checked without Vite's
     *   client globals — and it is the only gate that would still catch a `window` /
     *   `import.meta.env` reach-in if the web config's `types` ever widened. It is not
     *   redundant and must stay.
     *
     * ⚠️ **What the e2e job does NOT do — the claim this file used to make, measured
     * false.** The old comment here said "`quality` runs before the `e2e` job starts, so a
     * type error cannot reach a Playwright run in CI at all". `.github/workflows/ci.yml`
     * has **no `needs:` on the `e2e` job** — the file says so itself, on the job's own
     * "no `needs:`, no `if:`, no `continue-on-error`" comment — so the two jobs run
     * **concurrently** and a type error in `src/` does reach a Playwright run.
     *
     * What is still true, and is what the split rests on:
     *
     * - **A type error cannot make the pipeline green.** The aggregate `ci` job has
     *   `needs: [quality, e2e]` and fails unless *both* report `success`, so `quality`
     *   failing red always reddens the run.
     * - **It does fail the `e2e` job's own run** — not always: `vite build` strips types
     *   without checking them, so a `src/` type error that does not break the bundle lets
     *   `e2e` go *green* while `quality` goes red. That is acceptable and is the point of
     *   the aggregate; it is only unacceptable if `e2e` is read as "the tree typechecks".
     * - The e2e job's own `tsc -p e2e/tsconfig.json` step means a type error **in this
     *   suite** still stops the suite before a single test runs.
     *
     * ⚠️ **Why `needs: [quality]` is deliberately NOT added.** It would serialise the two
     * jobs: the e2e job could not start its ~3-minute install, browser download and suite
     * until `quality` had finished its own install, typecheck, unit tests and build, and
     * the pipeline's wall clock would roughly double. The correctness it would buy is
     * already bought by the aggregate, and the failure it would prevent — a Playwright run
     * against a bundle that does not typecheck — is a run whose **result is still
     * trustworthy**, because the layout and behaviour it asserts do not depend on the type
     * system. Do not add it without a measurement that a red `e2e` job on a type error is
     * costing anybody anything.
     *
     * So the split is: **`tsc` decides whether code is allowed to exist; `vite build`
     * decides whether there is something to test.** A job that boots a server needs
     * the second, and only the second.
     *
     * The `build-sw.mjs` step is kept, and it is the service worker's precache list —
     * `AGENTS.md` §2a makes offline capability part of the target, so a `dist/` without
     * `sw.js` is not the artefact CI builds either. (`scripts/build-sw.mjs` resolves
     * `dist/` from its own file location, so `cwd` does not affect it.) That is also the
     * one place where this command and the screenshot config differ: three commands here,
     * two there, because the screenshots review the pixels and the functional suite also
     * asserts on the app working offline.
     *
     * ## ⚠️ This is a **behaviour change**, and it is deliberate
     *
     * The command used to be `pnpm build --mode e2e && vite preview`, and the `--mode
     * e2e` **never reached `vite build`**. pnpm appends a pass-through argument to the
     * **end** of a script chain, so what actually ran was
     *
     * ```
     * tsc --noEmit && vite build && node ../../scripts/build-sw.mjs --mode e2e
     * ```
     *
     * `vite build` therefore ran in **production** mode and the functional suite tested a
     * production bundle. Measured on this host: `pnpm --filter … build --mode e2e` emits
     * a `dist/assets/index-*.js` with **no** `e2e.invalid` in it (byte-identical to a
     * plain `pnpm build`, 1 263 676 B), while `vite build --mode e2e` emits one that
     * **does** (1 263 698 B). That was an accident of argument pass-through, not a
     * decision — and the branch in `vite.config.ts` (`isE2E ? E2E_PROVIDER_BASE_URL :
     * ""`) exists for this suite and nothing else.
     *
     * So the new behaviour is the intended one and the old one was the accident. **No
     * test changed result**: the suite installs the fake provider with
     * `context.route()` in `e2e/support/provider.ts`, so it intercepts the provider
     * origin whether or not the bundle was told about it. Measured on this host, the two
     * bundles differ by **22 bytes** (1 263 676 B production, 1 263 698 B e2e mode) —
     * the seam string and nothing else, so React is not being pulled into a development
     * build and there is no behaviour difference to find. What changed is that the
     * artefact under test is now the one this configuration says it is.
     *
     * **And CI builds the same artefact.** `.github/workflows/ci.yml`'s `e2e` job runs
     * `pnpm e2e` → `playwright test --config ../../playwright.config.ts` → this
     * `webServer.command` with this `cwd`, so local and CI run the *same* e2e-mode
     * bundle. CI's `quality` job separately runs `pnpm build` (production) and uploads
     * that as `baah-web-dist`; that is a different artefact for a different purpose and
     * was always so — it is the thing a human downloads, not the thing the suite drives.
     */
    command: "vite build --mode e2e && node ../../scripts/build-sw.mjs && vite preview",
    /**
     * `packages/baah-web`, because `vite` needs the app as its root: `index.html`,
     * `vite.config.ts` and `public/` all live there. Playwright spawns `command` in the
     * **config file's** directory (the repository root) and resolves `cwd` against it,
     * so without this `vite build` reports
     * `[UNRESOLVED_ENTRY] Cannot resolve entry module index.html`.
     */
    cwd: "packages/baah-web",
    url: APP_URL,
    /**
     * `false` **always**, not `!process.env.CI`.
     *
     * ⚠️ The measured reason. `reuseExistingServer: true` does not mean "reuse a server
     * that is serving the right thing" — Playwright checks **only the URL**: if
     * anything answers on 4173, the `command` above is **not run at all**, so no build
     * happens and every test runs against a `dist/` of unknown provenance. That is not
     * hypothetical here: a `vite preview` left over from an older build answered 4173,
     * the suite reused it, and reported `44/44` with **no build having run at all** —
     * including the runs that reported `GET / → 404` as if the app were broken.
     *
     * So the local cost is a rebuild per run, and the rebuild is the thing being
     * bought. Measured on this host, three consecutive `vite build --mode e2e`:
     * **3.32 s / 3.13 s / 2.73 s** — so ~3 s against a 49-test suite that takes
     * minutes. Paying 3 s to make "the artefact under test was built for this run" a
     * fact rather than an assumption is a good trade against a suite that has twice
     * reported a stale environment as a product defect.
     *
     * ## What this costs, stated plainly
     *
     * `reuseExistingServer: false` is a **hard stop for the whole run**, not a
     * fallback. With anything already listening on 4173 — including a `pnpm preview`
     * someone left open — Playwright does not run the tests and does not fall back:
     *
     * ```
     * Error: http://127.0.0.1:4173 is already used, make sure that nothing is running
     *        on the port/url or set reuseExistingServer:false in your config
     * ```
     *
     * **zero tests run**, and the exit code is non-zero, so the price is a developer's
     * afternoon ("why did nothing run?") rather than a silent wrong answer. A developer
     * can no longer keep a preview server on 4173 while running e2e; the preview belongs
     * on another port, and `vite.config.ts`'s `preview.port` is what makes 4173 a bad
     * choice for one anyway.
     *
     * ## Consistency with the screenshot config — and ⚠️ where it does **not** hold
     *
     * `e2e/screenshots/playwright.config.ts` already says `reuseExistingServer: false`
     * for the same reason, and the two are identical in the property that matters:
     * **neither suite will ever be handed a server it did not start.**
     *
     * ⚠️ **The ports differ but the build output does not, so "side by side" is not
     * actually safe.** Both configs run `vite build --mode e2e` with
     * `cwd: packages/baah-web` — the same app root — and both therefore write the same
     * `dist/`, which Vite **empties** before it writes. Different ports on 4173 and 4174
     * do not make two artefacts; they make two servers that race over one directory. Run
     * both at once and a screenshot can be taken against a bundle that is being
     * rewritten under the server that is serving it.
     *
     * Resolving it is not this file's to do — `e2e/screenshots/playwright.config.ts`
     * belongs to the review instrument, not to `pnpm e2e`. What it would take, stated so
     * the next reader does not have to rediscover it:
     *
     * 1. give one of the two builds its own output directory (`vite build --outDir
     *    dist-screenshots`, plus `vite preview --outDir dist-screenshots`), or
     * 2. build once in a step both configs assume and drop `vite build` from one of
     *    them — which reintroduces the provenance problem `reuseExistingServer: false`
     *    exists to solve, so only with a build that is itself the job's first step, or
     * 3. accept that the two run **sequentially**, and say so in both files.
     *
     * Until one of those lands: do not run them at the same time. That was true before
     * this change too — the change made this config match the screenshot config's
     * decision, and both already shared the output directory.
     */
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
