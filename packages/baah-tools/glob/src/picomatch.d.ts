/**
 * Ambient types for `picomatch@4.0.7`, which ships no `.d.ts`.
 *
 * The package is a CommonJS module (`module.exports = picomatch`); bundlers
 * hand it to ESM as the default export, which is what we type here. Only the
 * surface this repo actually uses is declared — see
 * `https://github.com/micromatch/picomatch` for the full option list.
 */
declare module "picomatch" {
  interface PicomatchOptions {
    /** Match dotfiles. `false` by default, which is what a harness wants. */
    dot?: boolean;
    /** Case-insensitive matching. */
    nocase?: boolean;
    /** Treat `extglobs` (`!(a|b)`) as plain characters. */
    noext?: boolean;
    /** Only allow `/` as a separator (no Windows backslash handling). */
    posixSlashes?: boolean;
    /** Follow `*` across `/` — the "globstar" behaviour. */
    bash?: boolean;
  }

  type PicomatchMatcher = (input: string) => boolean;

  interface Picomatch {
    (glob: string | readonly string[], options?: PicomatchOptions): PicomatchMatcher;
  }

  const picomatch: Picomatch;
  export default picomatch;
}
