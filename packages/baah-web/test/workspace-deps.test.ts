/**
 * `AGENTS.md` §4: `baah-web → baah-tools/* + baah-storage → baah-core`, and
 * "Abhängigkeiten zeigen **nie** zurück".
 *
 * ## What this is for
 *
 * A build once imported `@all-the.rest/baah-storage` and the eight
 * `@all-the.rest/baah-tool-*` packages **through relative paths** into their
 * siblings' `src/` directories, because `pnpm install` was not available to the
 * block that needed them. It compiled, it bundled, and the app worked — which is
 * exactly why it survived: a dependency that is not declared cannot break a
 * `pnpm install`, because nothing in the graph refers to it. It can only be
 * found by reading the source.
 *
 * So this is a **source** gate, like the three `no-console` copies and the
 * `no-explicit-any` gate. `AGENTS.md` §6a's argument is the whole reason: a rule
 * with no gate reads as covered, and this one was covered for two blocks and was
 * still violated in both.
 *
 * ## What counts as a violation
 *
 * A relative import whose resolved path leaves this package and lands in a
 * **sibling workspace package's source**: `../../baah-core/…`,
 * `../../baah-storage/…`, `../../baah-tools/…`. Those are the three shapes
 * `AGENTS.md` §4's layout makes possible from `src/components/lib/`, which is
 * where the violation was.
 *
 * Two things are deliberately **not** violations:
 *
 * - A **bare specifier** for a workspace package, whether or not it resolves. The
 *   graph is what decides that, `package.json` is where it is declared, and
 *   `pnpm install` is what enforces it. This gate only rules out the *silent*
 *   path, where a package is used and nothing in the graph knows.
 * - A relative import **inside** this package (`../lib/ids.ts`,
 *   `./parts.ts`). That is the normal way to import a sibling module, and
 *   `allowImportingTsExtensions` in `tsconfig.base.json` is built for it.
 *
 * ## Known limits, stated rather than hidden
 *
 * Regex-level, like the other scanners in the repo: it reads import and
 * `export … from` specifiers, and it cannot see a specifier built at runtime by
 * string concatenation or a variable. It scans `src/` and `e2e/` — `e2e/`
 * included, because a spec that reached into a sibling package's source to reach a
 * helper would be the same defect with a smaller blast radius. The reader is
 * exercised against **planted** material, so a scanner that finds nothing cannot
 * pass vacuously.
 */
import { describe, expect, it } from "vitest";

/** `src/**` and `e2e/**`, the two trees the gate reads. */
const SOURCES = import.meta.glob(["/src/**/*.{ts,tsx}", "/e2e/**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * A sibling package's source directory, as it appears after a relative `../…`.
 *
 * Split so this file does not match its own pattern, which is the same trick the
 * `no-console` copies use for the word they are looking for.
 */
const SIBLING = ["baah", "(core|storage|tools)"].join("-");

/** `import … from "x"`, `export … from "x"`, and the dynamic `import("x")`. */
const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

interface Offence {
  file: string;
  specifier: string;
}

/**
 * Every relative specifier that leaves the package for a sibling's source.
 *
 * Comments and strings are **not** stripped, and the reason is that this pattern
 * is narrow enough not to need it: a specifier only appears inside quotes, and the
 * regex requires them. A mention of `../../baah-core` in prose is not quoted as an
 * import specifier, so it is not a match. What that buys is a much smaller
 * duplicate of the comment/string stripper the other four gates carry.
 */
function siblingSourceImports(file: string, source: string): Offence[] {
  const offences: Offence[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) continue;
    // A bare or absolute specifier is the *declared* path. A `node:` or a URL is
    // not ours to judge.
    if (!specifier.startsWith(".")) continue;
    // A relative import that does not climb out of this package is an ordinary
    // sibling import.
    if (!specifier.startsWith("../")) continue;
    if (!new RegExp(`\\.\\./\\.\\./${SIBLING}(?:/|$)`).test(specifier)) continue;
    offences.push({ file, specifier });
  }
  return offences;
}

const ALL_OFFENCES: Offence[] = Object.entries(SOURCES)
  .flatMap(([file, source]) => siblingSourceImports(file, source))
  .sort((left, right) => left.file.localeCompare(right.file));

describe("no source reaches into a sibling package's src/", () => {
  it("the scan really reads the sources — a glob that matches nothing passes vacuously", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(20);
    for (const known of [
      "/src/components/lib/runtime.ts",
      "/src/components/lib/turn-store.ts",
      "/src/components/AppShell.tsx",
      "/src/runtime/index.ts",
      "/e2e/scenarios.e2e.ts",
    ]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("finds no relative import into a sibling package", () => {
    expect(
      ALL_OFFENCES.map((offence) => `${offence.file} → ${offence.specifier}`),
      "AGENTS.md §4: a workspace dependency is declared in package.json and resolved by " +
        "the graph. Importing a sibling's source by relative path is invisible to that graph — " +
        "it cannot break an install, which is why it survives review — and it silently makes " +
        "the layering rule unenforced. Use the bare specifier; if it does not resolve, the " +
        "package is not declared yet and that is a one-line package.json fix, not a second way " +
        "in.",
    ).toEqual([]);
  });

  it("the reader sees what it is meant to catch", () => {
    // The self-check, on the three shapes the violation actually took. Without it a
    // scanner that silently matched nothing would pass every test above.
    const planted = [
      `import { createMemoryDatabase } from "../../../../baah-storage/src/index.ts";`,
      `const mod = await import("../../baah-tools/read/src/index.ts");`,
      `export { thing } from "../../../baah-core/src/tool.ts";`,
    ].join("\n");
    expect(siblingSourceImports("planted", planted)).toHaveLength(3);

    // …and it does not fire on a bare specifier, on a sibling import inside this
    // package, or on prose that merely mentions the path.
    const innocent = [
      `import { createMemoryWorkspace } from "@all-the.rest/baah-core";`,
      `import { openDatabase } from "@all-the.rest/baah-storage";`,
      `import { newId } from "../../lib/ids.ts";`,
      `import { withTranscriptRows } from "./turn-store.ts";`,
      `// it used to import ../../baah-storage/src/index.ts before package.json declared it`,
      `const described = "a relative path into ../../baah-core/src is what we no longer do";`,
      `import fs from "node:fs";`,
    ].join("\n");
    expect(siblingSourceImports("innocent", innocent)).toEqual([]);
  });
});
