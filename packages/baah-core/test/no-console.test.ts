/**
 * `AGENTS.md` §5: failures the user must see become typed events in the agent
 * loop, **not `console.error`** — and that clause has no enforcement at all.
 *
 * ## Why this file exists
 *
 * A mutation of the heartbeat's failure handler that swapped the emitted
 * `storage-warning` for a `console.error` was caught by four behavioural
 * assertions — and by nothing else. Which means: delete the report and the
 * console call goes with it, and the *type* of the surviving mistake changes.
 * A `console.error` in a browser is invisible in the product; the only reason the
 * mutation was caught at all is that four tests happened to look at the event
 * stream. A failure path that no test happens to cover would have shipped as a
 * log line, and `loop.ts` carries a whole section of prose claiming the opposite.
 *
 * The claim is worth more than the check. `no-explicit-any.test.ts` is the
 * precedent: a rule with no gate reads as covered, which is worse than a rule
 * with a failing check.
 *
 * ## Why a source scan
 *
 * `--noExplicitAny` does not exist in `typescript@7.0.2` (measured, see
 * `test/no-explicit-any.test.ts`), and a lint rule is a new dependency and a new
 * config surface — which `AGENTS.md` §3 fixes. What is left needs no new tool:
 * read the sources and fail, in the build that already runs.
 *
 * ## Known limits, stated rather than hidden
 *
 * Regex-level, not a parser, and the same three limits as the other two scanners
 * in this package: comments and string literals are stripped (so the word
 * `console` in prose is not a hit, and a `` `console.log(${x})` `` is treated as
 * a string and *is* missed), a template-literal interpolation counts as a string,
 * and a regex literal containing a quote character would end the string scan
 * early. It scans `src/` only. The reader is exercised against planted input, so
 * a scanner that silently finds nothing cannot pass.
 *
 * The third copy of the comment/string stripper in this package's test tree. One
 * shared helper would have to live in a place both `src/` trees could import, and
 * `AGENTS.md` §4 puts that dependency in the wrong direction for a test utility.
 * The duplication is the cost of the layering rule, and it is stated rather than
 * quietly worked around.
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

/**
 * Assembled so this file does not trip its own scan: every *code* occurrence of
 * the word is a hit, and every occurrence in a comment or a string is not.
 */
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

/** Every `console.<method>(` in the *code* of a source, with its line. */
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
    expect(files.length).toBeGreaterThan(10);
    for (const known of ["/src/agent/loop.ts", "/src/agent/tools.ts", "/src/tool.ts"]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("finds no console call in `src/`", () => {
    expect(
      ALL_USES.map((use) => `${use.file}:${use.line}  ${use.text}`),
      "AGENTS.md §5: a failure the user must see becomes a typed event, not a log line. " +
        "A console call here is invisible in the browser and would only be caught by a test " +
        "that happens to look at the event stream.",
    ).toEqual([]);
  });

  it("the reader sees what it is meant to catch", () => {
    // The self-check. `loop.ts` says in its own header that nothing here writes to
    // the console; without this test, deleting that handler's event and leaving a
    // log line behind would be a green run.
    const planted = [
      `if (x) ${CONSOLE}.error("boom");`,
      `${CONSOLE}   .warn("careful");`,
      `try { run(); } catch (e) { ${CONSOLE}\n  .log(e); }`,
    ].join("\n");
    expect(usesOfConsole("planted", planted)).toHaveLength(3);

    // …and it does not fire on prose, a string, or the type name.
    const innocent = [
      `// the console is not where a user-visible failure goes`,
      "/* nothing here writes to the console either */",
      `const message = "${CONSOLE}.error in a string";`,
      "interface Reporter { console: (text: string) => void }",
      "const concordance = 3; const console2 = 4;",
      // **Out of the gate's reach, and said so:** a bare *reference* with no call
      // is not matched, because the rule is about writing to the console. Hoisting
      // one into a variable would evade it, and that is a review concern rather
      // than something a scanner that reads no semantics can decide.
      `const report = ${CONSOLE}.log;`,
    ].join("\n");
    expect(usesOfConsole("innocent", innocent)).toEqual([]);
  });
});
