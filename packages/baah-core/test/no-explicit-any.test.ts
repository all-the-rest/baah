/**
 * `AGENTS.md` §5: "`any` ist verboten" — and a rule nothing checks is a rule
 * that does not exist.
 *
 * ## Why this file exists
 *
 * A mutation to the `TurnStore` adapter, `getToolCall: (key: any)`, left `tsc`
 * **clean** and **369/369 green**. The reason is not exotic: `any` on a
 * *parameter* widens nothing that the declared return type constrains, so the
 * compiler has nothing to complain about. That is a rule with no enforcement,
 * which is worse than a rule with a failing check — it reads as covered.
 *
 * ## What cannot enforce it, measured
 *
 * The one-line fix everyone reaches for first does not work in this repo:
 *
 * ```
 * $ tsc --noEmit --noExplicitAny
 * error TS5023: Unknown compiler option '--noExplicitAny'.
 * ```
 *
 * The toolchain is `typescript@7.0.2` — the native port — and it does not
 * implement `noExplicitAny` (checked against `tsc --all`: the flag is absent,
 * not merely unset). So "add the flag to `tsconfig.base.json`" is not an
 * answer here; it is an error. The next-best compiler answer, a lint rule, is a
 * new dependency and a new config surface, which `AGENTS.md` §3 fixes and this
 * change is not the place for.
 *
 * What is left is the thing that needs no dependency, no config and no new
 * tool: read the sources and fail. That is not a linter — it is one rule, one
 * file, and it fails the build that already runs.
 *
 * ## Why it is not a regex over the raw file
 *
 * `any` is a common English word in this package's comments, and `AbortSignal`
 * has a static method literally named `any` (`tools.ts`). A regex would either
 * fire on the prose — training everyone to route around the gate — or need an
 * allowlist, which rots. So the scan strips comments and string literals first
 * and then looks at what is left. The reader is exercised against planted input
 * in the last test, because a scanner that silently finds nothing passes every
 * other test in this file.
 *
 * ## Known limits, stated rather than hidden
 *
 * - A **template-literal interpolation** (`` `${x as any}` ``) is inside a string
 *   as far as the scanner is concerned and is not seen. `AGENTS.md` §5's
 *   companion rule ("no blind casts") is what catches that case in review.
 * - A **regex literal** containing a quote character would end the string scan
 *   early. There is none in this package, and the planted-input test would
 *   surface it if there were.
 */

import { describe, expect, it } from "vitest";

/**
 * `import.meta.glob`, which is how the sources are read.
 *
 * `readFileSync` would need `@types/node`, which this package deliberately does
 * not have — see `test/verify/raw.d.ts` for the same trade, made once. Vite's
 * own glob is the browser-compatible way to do it, and it needs no new
 * dependency (`vitest` is already the test runner).
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query?: string; import?: string; eager?: boolean },
    ): Record<string, unknown>;
  }
}

// Vite's `import.meta.glob` parses an inline object literal only, so the two
// calls repeat the options rather than sharing a constant.
const SOURCES: Record<string, string> = {
  ...(import.meta.glob("/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >),
  ...(import.meta.glob("/test/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >),
};

/**
 * The banned keyword, assembled so that this file does not trip its own scan.
 *
 * Every *code* occurrence of the word is a hit; every occurrence in a comment or
 * a string is not. Writing the pattern as a literal in a comment would be fine,
 * but writing it in code would be a hit in this very file.
 */
const BANNED = ["an", "y"].join("");

const isWordChar = (char: string): boolean => {
  if (char === "") return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    char === "_" ||
    char === "$"
  );
};

/**
 * Replace every comment and string literal with spaces, keeping the line count.
 *
 * Newlines survive so that a reported column still points at the right line; a
 * comment containing the keyword must not shift the diagnosis.
 */
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

/** One reported use of the banned type keyword. */
interface Use {
  file: string;
  line: number;
  text: string;
}

/**
 * Every use of the banned keyword in the *code* of a source, with its line.
 *
 * Three shapes are not uses and are skipped, each for a concrete reason:
 * a member access (`AbortSignal.any` — a method name, not a type), a property
 * declaration (`{ any?: (…) }` — the *name* is `any`, the type is not), and an
 * object key (`{ any: 1 }`).
 */
function usesOfBannedType(file: string, source: string): Use[] {
  const code = stripCommentsAndStrings(source);
  const lines = code.split("\n");
  const uses: Use[] = [];

  for (let index = 0; index < code.length; index += 1) {
    if (code.slice(index, index + BANNED.length) !== BANNED) continue;
    const before = index === 0 ? "" : (code[index - 1] ?? "");
    const after = code[index + BANNED.length] ?? "";
    if (isWordChar(before) || isWordChar(after)) continue;
    if (before === "." || after === "?" || after === ":") continue;

    const lineNumber = code.slice(0, index).split("\n").length;
    uses.push({ file, line: lineNumber, text: (lines[lineNumber - 1] ?? "").trim() });
  }

  return uses;
}

const ALL_USES: Use[] = Object.entries(SOURCES)
  .flatMap(([file, source]) => usesOfBannedType(file, source))
  .sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file),
  );

describe("no source uses the type keyword AGENTS.md §5 bans", () => {
  it("the scan really reads the sources — a glob that matches nothing passes vacuously", () => {
    const files = Object.keys(SOURCES);
    // A floor, not an exact count: a new module must not have to update a
    // number, but an empty or truncated scan must fail.
    expect(files.length).toBeGreaterThan(20);
    for (const known of ["/src/agent/loop.ts", "/src/agent/tools.ts", "/src/tool.ts"]) {
      expect(files, known).toContain(known);
    }
    // And the scan is not reading empty strings.
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("finds no use of it in `src/` or `test/`", () => {
    expect(
      ALL_USES.map((use) => `${use.file}:${use.line}  ${use.text}`),
      "AGENTS.md §5 bans `any`. Use `unknown` and narrow it, or write the narrow interface. (A hit inside a comment or a string is a false positive in the scanner, not in the code.)",
    ).toEqual([]);
  });

  it("the reader sees what it is meant to catch", () => {
    // The self-check. If the scanner stopped working — a missed escape, a glob
    // that resolved to raw text — the test above would pass while proving
    // nothing, which is the failure mode this file exists to prevent.
    expect(BANNED.length).toBe(3);
    const planted = [
      `const a: ${BANNED} = 1;`,
      `function f(b: ${BANNED}[]): ${BANNED} { return b; }`,
      `const c = value as ${BANNED};`,
      `type D = { e: ${BANNED} };`,
    ].join("\n");
    expect(usesOfBannedType("planted", planted)).toHaveLength(planted.split(BANNED).length - 1);

    // …and it does not fire on the three things that are not uses: prose, a
    // string, and a property *named* like the keyword.
    const innocent = [
      "// a comment mentioning the keyword in a sentence",
      "/* a block comment about it */",
      'const message = "a string about it";',
      "const signal = AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal };",
      "const holder = { any: 1 };",
      "const many = 2; const company = 3;",
    ].join("\n");
    expect(usesOfBannedType("innocent", innocent)).toEqual([]);
  });
});
