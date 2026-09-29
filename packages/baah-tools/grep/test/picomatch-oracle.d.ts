/**
 * Ambient types for the picomatch oracle used by `verify-include.test.ts`.
 *
 * `picomatch@4.0.7` ships no `.d.ts` (the sibling `glob` package has its own
 * ambient declaration in `src/picomatch.d.ts`; it is not visible from here).
 * Only the surface the test uses is declared. This is a TEST-ONLY dependency
 * reached by relative path — `grep` itself must not depend on picomatch.
 */
declare module "*/node_modules/picomatch/index.js" {
  interface PicomatchMatcher {
    (input: string): boolean;
  }
  interface Picomatch {
    (glob: string | readonly string[], options?: { dot?: boolean; posixSlashes?: boolean }): PicomatchMatcher;
  }
  const picomatch: Picomatch;
  export default picomatch;
}
