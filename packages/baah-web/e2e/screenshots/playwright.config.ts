/**
 * The screenshot-only Playwright configuration.
 *
 * It lives here, next to the dependency that can be resolved, and is
 * re-exported by `playwright.screenshots.config.ts` in the repository root —
 * the same three-line trick `playwright.config.ts` uses, and for the same
 * reason: `@playwright/test` is a devDependency of `@all-the.rest/baah-web`,
 * pnpm keeps it out of the root `node_modules`, and Playwright resolves a
 * config's own `import()` from the config's directory. A root config that
 * writes `import { defineConfig } from "@playwright/test"` dies with
 * ERR_MODULE_NOT_FOUND before a single test runs.
 *
 * ## Why this is a separate config at all
 *
 * The screenshot set is a **review instrument**, not a test suite. It captures
 * pixels and asserts nothing about behaviour, so it must never be part of
 * `pnpm e2e` or of the CI pipeline that runs it (`AGENTS.md` §7 wave 3 asks for
 * "E2E grün, Screenshots geprüft" — checked, not gated). Therefore:
 *
 * - `testDir` points at this folder only, so the functional specs (`*.e2e.ts`,
 *   one directory up) cannot be reached from here;
 * - `testMatch` is one glob deep (`**` then `*.shot.ts`) — a filename shape
 *   **neither** other runner claims by default. `vitest`'s default glob ends in
 *   `.{test,spec}` , so a `*.spec.ts` file would be claimed by vitest, which
 *   cannot run Playwright specs; and the standard Playwright config's
 *   `*.e2e.ts` would claim it as a functional test. `.shot.ts` is claimed by
 *   exactly one runner: this one;
 * - there is no `if: process.env.CI` gate of any kind and none may be added.
 *
 * ⚠️ Paths below are resolved by Playwright relative to the **root** config file
 * (`<repo>/playwright.screenshots.config.ts`), not relative to this file — see the
 * header of `playwright.config.ts` at the repository root. They are root-relative
 * on purpose.
 */
import { defineConfig } from "@playwright/test";

/**
 * The preview server the screenshots are taken against.
 *
 * **Not port 4173.** `vite.config.ts` pins `preview.port: 4173` with
 * `strictPort: true`, and that is the port the functional suite's `webServer`
 * uses. Sharing it would make the two sets unable to run side by side — and,
 * worse, `reuseExistingServer` could hand the screenshot set a server that was
 * built by the other suite. 4174 is used instead and always started fresh
 * (`reuseExistingServer: false`): a screenshot must never be taken against an
 * artefact whose provenance nobody knows.
 */
const APP_URL = "http://127.0.0.1:4174";

/** Desktop: the review's primary form factor. `Plan.md` §15.5's "Desktop". */
const DESKTOP = { width: 1280, height: 800 } as const;

/**
 * Mobile: 390×844, `deviceScaleFactor: 2`.
 *
 * The double scale factor is deliberate. `ui-review`'s harness reference warns
 * that a full-page shot gets downscaled to ~2000 px before a vision model reads
 * it; a 390-px-wide native image is well under that and would be read at 1:1,
 * but daisyUI's `text-xs` is 12 CSS px and the trust notes the app puts above
 * every untrusted block are `text-xs` — unreadable at 1:1. At 2× the file is
 * 780×1688, still under the downscale threshold, so nothing is resampled and
 * the 12-px copy is legible.
 */
const MOBILE = { width: 390, height: 844 } as const;

export default defineConfig({
  // Only this folder. The functional specs live one level up.
  testDir: "packages/baah-web/e2e/screenshots",

  testMatch: "**/*.shot.ts",

  // Two machines, two budgets — and the difference is deliberate, not an oversight:
  //
  //   CI    4   GitHub-hosted, no self-hosted runners, its own machine.
  //   local 2   `code-dev` is SHARED. Two subagents are already the documented
  //                ceiling in the host's Agents.headless.md, because the
  //                OOM-killer on that host hits `mariadbd`, not us.
  //
  // This is the only parallelism knob that actually exists here. GitHub's
  // workflow `concurrency` CANNOT express "at most N runs": a concurrency group
  // is exclusive, so `cancel-in-progress: true` means one running plus one
  // cancelled pending, and `false` means one running plus a queue. And
  // `strategy.max-parallel` needs a matrix, which this workflow does not have.
  workers: process.env.CI ? 4 : 2,

  // `true`, and it has to be, or the `workers` above is a lie.
  //
  // Playwright distributes **files** across workers. This suite is ONE spec file
  // (`ui-screenshots.shot.ts`) under TWO projects, so with `fullyParallel: false`
  // it has exactly two units of work — and `CI=1` measured:
  //
  //     Running 92 tests using 2 workers
  //
  // Two, with `workers: 4` in the file. The setting was unreachable, and an
  // unreachable setting is worse than no setting: it reads like the suite is
  // parallel and it is not. That is the `grep-wasm` fault — a configuration that
  // appears to do something and does not.
  //
  // `true` is safe here by construction: every test prepares its own state from
  // its own `app` fixture (own page, own BrowserContext — the faked provider is
  // `context.route()` on that context, so nothing is shared) and writes to its
  // own path. Nothing in a test observes another test.
  fullyParallel: true,

  /**
   * Zero retries. A screenshot either happened or it did not, and a retried run
   * silently replaces a bad picture with a good one — which is precisely the
   * failure mode a visual review cannot detect. Anything that flakes here is a
   * finding about the harness or the page, and it is reported, not smoothed.
   */
  retries: 0,

  /**
   * 180 s. Two states are legitimately slow and both are *designed* slowness,
   * not harness flakiness:
   *
   * - `error-stream-cut` / `error-retry-attempts` spend `Plan.md` §5.4's real
   *   backoff (2 s + 8 s) before the third attempt goes out;
   * - `chat-stall` waits out `DEFAULT_STALL_TIMEOUT_MS` (20 s) on purpose, so
   *   the stall affordance is the thing on screen.
   */
  timeout: 180_000,
  expect: { timeout: 15_000 },

  /**
   * No CI gate, and none may be added — see the header. `forbidOnly` is kept
   * only so a stray `test.only` cannot quietly shrink the review set either
   * outside CI.
   */
  forbidOnly: true,

  reporter: [["list"]],

  /** Own output dir, so this set never writes into the functional suite's. */
  outputDir: "packages/baah-web/test-results/ui-screenshots",

  use: {
    baseURL: APP_URL,
    // The set captures pixels; a trace or a video is 100+ MB of noise nobody
    // reads. On failure the failing test's *name* and the manifest entry are
    // the diagnostic — the name is in the list reporter.
    trace: "off",
    video: "off",
    screenshot: "off",
  },

  projects: [
    {
      name: "desktop",
      use: {
        viewport: DESKTOP,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: "mobile",
      use: {
        viewport: MOBILE,
        // See the header: 12 CSS px of copy must stay legible.
        deviceScaleFactor: 2,
      },
    },
  ],

  webServer: {
    /**
     * `vite build --mode e2e` **directly**, not `pnpm build --mode e2e`.
     *
     * `package.json`'s `build` script is `tsc --noEmit && vite build`, and
     * `tsc` follows the app's imports into every workspace package it touches —
     * `packages/baah-tools/*` and `packages/baah-storage` included. That was
     * measured, not assumed: while this harness was being written,
     * `packages/baah-tools/grep/src/index.ts` was mid-edit by another agent and
     * `tsc --noEmit` failed, which made **this** suite unable to start for a
     * reason that had nothing to do with screenshots.
     *
     * A review instrument should not be gated by an unrelated package's
     * typecheck. The artefact under review is the bundle `vite build` emits, and
     * `tsc` gates `pnpm check` and CI — where it belongs, and where the
     * functional suite keeps it too. The screenshot config asserts the document
     * title below, so a mis-built or foreign bundle is caught by the pixels'
     * owner rather than by a compiler the reviewer never runs.
     */
    command: "vite build --mode e2e && vite preview --port 4174",
    // `vite` needs the web app as its root: its `index.html`, `vite.config.ts`
    // and `public/` all live there. Playwright spawns `command` in the **config
    // file's** directory (the repository root) and resolves this `cwd` against
    // it, so without it `vite build` reports
    // `[UNRESOLVED_ENTRY] Cannot resolve entry module index.html`.
    cwd: "packages/baah-web",
    url: APP_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
