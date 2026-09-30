/**
 * A pointer to `baah-tools/glob`'s own ambient declaration.
 *
 * ## Why this file exists
 *
 * `@all-the.rest/baah-tools/glob` imports `picomatch@4.0.7`, which ships no
 * `.d.ts`. That package declares the module itself in
 * `packages/baah-tools/glob/src/picomatch.d.ts` — and `tsconfig.base.json` sets
 * `"types": []`, so an ambient declaration is only in a program if something in
 * it is **included**.
 *
 * Inside the glob package that is automatic: its own `tsconfig.json` includes
 * `src`. From `baah-web` it is not, because this app reaches glob's source
 * through a **relative import** (see `components/lib/runtime.ts` for why, and for
 * the fact that the correct fix is a `package.json` dependency this block was not
 * allowed to add) and `packages/baah-web/tsconfig.json` includes only `src` and
 * `e2e`. A relative import pulls in the module's own `.ts` files and not its
 * sibling `.d.ts`, so `import picomatch from "picomatch"` is untyped here and `tsc`
 * reports `TS7016` with a suggested `@types/picomatch` that does not exist.
 *
 * ## What this is and is not
 *
 * A `/// <reference path>` — a reference to glob's **own** declaration, not a copy
 * and not a new one. The surface stays owned by the package that uses it, and a
 * change to `PicomatchOptions` there fixes this file automatically. Writing a
 * second `declare module "picomatch"` here would be a second truth about a
 * third-party API, which is the mistake `AGENTS.md` §4's "ein Tool = ein Package"
 * exists to prevent.
 *
 * ## When this file should be deleted
 *
 * With the `package.json` entry. Then glob is a real dependency, its own
 * `tsconfig` is the one that compiles it, and this reference is dead weight that
 * would keep working while being meaningless.
 */

/// <reference path="../../../baah-tools/glob/src/picomatch.d.ts" />
export {};
