/**
 * The repository-root screenshot config.
 *
 * The same three-line re-export `playwright.config.ts` is, for the same reason:
 * `@playwright/test` is installed in `packages/baah-web/node_modules` and pnpm
 * keeps it out of the root `node_modules`, so a root config cannot write
 * `import { defineConfig } from "@playwright/test"` — it fails with
 * ERR_MODULE_NOT_FOUND before a single test runs.
 *
 * Because Playwright resolves every path against *this* file's directory, paths
 * in the re-exported config are root-relative.
 *
 * Never wire this config into `pnpm check`, `pnpm e2e` or CI. The set captures
 * pixels and asserts nothing; it is a review instrument, and the only command
 * that runs it is `pnpm --filter @all-the.rest/baah-web test:screenshots`.
 */
export { default } from "./packages/baah-web/e2e/screenshots/playwright.config.ts";
