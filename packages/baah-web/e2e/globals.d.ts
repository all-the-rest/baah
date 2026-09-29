/**
 * `@types/node` is not a dependency of this workspace and the E2E suite is
 * checked with `"types": []` (see `tsconfig.json` in this folder). The only
 * Node-shaped thing the suite touches is `process.env` in the Playwright config.
 * This declares exactly that — nothing else, and no `node:*` module, so a
 * `require("node:fs")` slipping into a spec is still a type error.
 *
 * AGENTS.md §2 forbids Node builtins in `src/`. This folder is not `src/`: it
 * is Playwright's process, and it is never bundled into the app.
 */
declare const process: {
  readonly env: {
    readonly CI?: string;
  };
};
