/**
 * The repository-root Playwright config.
 *
 * It re-exports the real configuration from `packages/baah-web/e2e/`. See that
 * file for why the typed config cannot live here: Playwright resolves the
 * config's own `import()` from the config's directory, and `@playwright/test`
 * is installed in `packages/baah-web/node_modules`, not in the root
 * `node_modules`.
 *
 * Because Playwright resolves every path against *this* file's directory, paths
 * in the re-exported config are root-relative.
 */
export { default } from "./packages/baah-web/e2e/playwright.config.ts";
