/**
 * `AGENTS.md` §5: a failure the user must see becomes a typed error, not a log
 * line — and this package has no gate for it.
 *
 * ## Why this package needs its own copy
 *
 * The gate in `@all-the.rest/baah-core` reads **its own** `src/` through Vite's
 * `import.meta.glob`, and a glob is rooted at the package that calls it. So the
 * rule that keeps `console.error` out of the engine says nothing here, and this
 * package has the same pressure on it: `worker.ts` builds typed `StorageError`s
 * precisely so a failure crosses the `postMessage` boundary with its class intact,
 * and a `console.log` on the way out is the same mistake with fewer bytes.
 *
 * Two copies, one rule, no shared helper — a module both packages could import
 * for a test would have to live in one of their `src/` trees, and `AGENTS.md` §4
 * puts that dependency in the wrong direction. The duplication is the cost of the
 * layering rule.
 *
 * ## Known limits, stated rather than hidden
 *
 * Regex-level, not a parser: comments and string literals are stripped, so prose
 * and string values are not hits while a template-literal interpolation counts as
 * a string and is missed. The reader is exercised against planted input, so a
 * scanner that silently finds nothing cannot pass every other test here.
 */

import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query?: string; import?: string; eager?: boolean },
    ): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Assembled so this file does not trip its own scan. */
const CONSOLE = ["cons", "ole"].join("");

function stripCommentsAndStrings(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", index);
      const stop = lineEnd === -1 ? source.length : lineEnd;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      const stop = commentEnd === -1 ? source.length : commentEnd + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        const inner = source[cursor] ?? "";
        if (inner === "\\") {
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (inner === char) break;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }

    index += 1;
  }

  return out.join("");
}

interface Use {
  file: string;
  line: number;
  text: string;
}

function usesOfConsole(file: string, source: string): Use[] {
  const code = stripCommentsAndStrings(source);
  const lines = code.split("\n");
  const uses: Use[] = [];
  const pattern = new RegExp(`\\b${CONSOLE}\\s*\\.\\s*[A-Za-z]+\\s*\\(`, "g");

  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    const lineNumber = code.slice(0, index).split("\n").length;
    uses.push({ file, line: lineNumber, text: (lines[lineNumber - 1] ?? "").trim() });
  }

  return uses;
}

const ALL_USES: Use[] = Object.entries(SOURCES)
  .flatMap(([file, source]) => usesOfConsole(file, source))
  .sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file),
  );

describe("no source writes to the console", () => {
  it("the scan really reads the sources — a glob that matches nothing passes vacuously", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(8);
    for (const known of ["/src/worker.ts", "/src/operations.ts", "/src/client.ts"]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("finds no console call in `src/`", () => {
    expect(
      ALL_USES.map((use) => `${use.file}:${use.line}  ${use.text}`),
      "A storage failure crosses the worker boundary as a typed StorageError " +
        "(AGENTS.md §5). A console call is invisible to the client and to the user.",
    ).toEqual([]);
  });

  it("the reader sees what it is meant to catch", () => {
    const planted = [
      `catch (error) { ${CONSOLE}.error(error); }`,
      `${CONSOLE}\n  .warn("rejected");`,
    ].join("\n");
    expect(usesOfConsole("planted", planted)).toHaveLength(2);

    const innocent = [
      "// the console is not where a storage failure goes",
      'const note = "console.error in a string";',
      "interface Scope { postMessage(data: unknown): void }",
      // A bare *reference* with no call is out of the gate's reach: the rule is
      // about writing to the console, and hoisting one into a variable would evade
      // it. Named here rather than left as a silent gap.
      `const report = ${CONSOLE}.log;`,
    ].join("\n");
    expect(usesOfConsole("innocent", innocent)).toEqual([]);
  });
});
