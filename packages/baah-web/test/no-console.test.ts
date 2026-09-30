/**
 * `AGENTS.md` §5: "Fehler, die der Nutzer sehen muss … werden zu typisierten Events
 * im Agent-Loop, **nicht zu `console.error`**" — and in this package the clause has
 * no enforcement at all.
 *
 * ## Why this package needs it *more* than the other two, not less
 *
 * `no-console` already exists in `baah-core` and `baah-storage`. The obvious reading
 * is that a UI package is the least likely place to need it, and that is backwards.
 * `baah-core` turns errors into events, so a `console.error` there competes with a
 * mechanism that already exists. In `baah-web` there is no engine event for the user
 * to read: the error paths are React state — `AppShell`'s `liveError` banner,
 * `App.tsx`'s boot-failure screen, `WorkspacePanel`'s refusal note — and a
 * `console.error` is the path of least resistance exactly where the alternative
 * costs a line of JSX. `AGENTS.md` §6a's own argument applies with more force: a
 * rule with no gate reads as covered, which is worse than a rule with a failing
 * check.
 *
 * ## The stripper is now duplicated **five** times, and that is a cost
 *
 * The copies are in `baah-core/test/no-explicit-any.test.ts`,
 * `baah-core/test/no-bare-void.test.ts`, `baah-core/test/no-console.test.ts`,
 * `baah-storage/test/no-console.test.ts` (plus its own `no-bare-void` companion) and
 * now this file. **This is the fifth, and I am not pretending it was free.**
 *
 * The reason is `AGENTS.md` §4: a package may not import from another package's test
 * tree, and a shared scanner would have to live somewhere all three can reach. The
 * alternative — a new `test-utils` package — is a new package, which `AGENTS.md` §4
 * also forbids without an entry in `Plan.md`, and `Plan.md` is not this block's file.
 * So the duplication is a *consequence of the layering rule*, and it is named here
 * rather than quietly worked around, which is what the other four files do.
 *
 * What the duplication does **not** buy: the scanners are not kept in step by
 * anything. A limit fixed in one is still open in the others, and the list of limits
 * below is per file, not global.
 *
 * ## Known limits, stated rather than hidden
 *
 * Regex-level, not a parser. Comments and string literals are stripped, so the word
 * `console` in prose is not a hit and a `` `console.log(${x})` `` is treated as a
 * string and **is** missed; a template-literal interpolation counts as a string; and
 * a regex literal containing a quote character would end the string scan early. A
 * bare *reference* with no call (`const log = console.log;`) is not matched, because
 * the rule is about writing to the console — hoisting one into a variable evades it,
 * and that is a review concern rather than something a scanner that reads no
 * semantics can decide. The reader is exercised against **planted** input below, so
 * a scanner that silently finds nothing cannot pass.
 *
 * It scans `src/` — both `.ts` and `.tsx`, because this package's error paths live
 * in the components. `e2e/` is deliberately outside: a spec may legitimately print
 * diagnostics, and `AGENTS.md` §5 is about what the shipped app does.
 */
import { describe, expect, it } from "vitest";

/**
 * No `declare global { interface ImportMeta { glob … } }` here, and the difference
 * from the other four copies is worth a line: this package's `tsconfig.json` sets
 * `"types": ["vite/client"]`, and `vite@8`'s own `types/importGlob.d.ts` declares
 * `ImportMeta.glob` with a full generic signature. Re-declaring it here is a
 * `TS2300: Duplicate identifier 'glob'` — caught by `tsc`, and the reason the fifth
 * copy is not a byte-for-byte copy of the fourth.
 *
 * The result is cast to `Record<string, string>` because the glob returns a typed
 * map and the *scan* wants raw source text by path. The cast is the honest one: it
 * narrows a value whose type the compiler cannot express through an inline
 * `query: "?raw"`, and the first test below fails if the glob ever returns nothing.
 */
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
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
  /**
   * The **original** source line, for the failure message.
   *
   * The gate scans {@link stripCommentsAndStrings}'s output, and that output is
   * blanked exactly where a string literal or a comment was — which is to say
   * precisely where the interesting text is. A report built from it reads
   * `AppShell.tsx:56  console.error(   )`: file and line right, **content gone**, so
   * whoever reads the failure has to open the file to learn what was logged. The
   * blanked copy is what the pattern has to match; the original is what a human has
   * to read. Both are derived from the same offsets, so the line number is the same
   * one either way.
   */
  text: string;
}

/** Every `console.<method>(` in the *code* of a source, with its line. */
function usesOfConsole(file: string, source: string): Use[] {
  const code = stripCommentsAndStrings(source);
  const sourceLines = source.split("\n");
  const uses: Use[] = [];
  const pattern = new RegExp(`\\b${CONSOLE}\\s*\\.\\s*[A-Za-z]+\\s*\\(`, "g");

  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    const lineNumber = code.slice(0, index).split("\n").length;
    // The original line, trimmed — never the blanked one.
    uses.push({ file, line: lineNumber, text: (sourceLines[lineNumber - 1] ?? "").trim() });
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
    // Named files, so a glob that quietly stopped covering `.tsx` — where this
    // package's error paths live — fails here instead of passing.
    for (const known of [
      "/src/App.tsx",
      "/src/main.tsx",
      "/src/components/AppShell.tsx",
      "/src/components/Transcript.tsx",
      "/src/runtime/index.ts",
      "/src/lib/settings.ts",
    ]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("covers the `.tsx` sources too, not only the `.ts` ones", () => {
    // The reason this file is not a copy of the other two. `AppShell.tsx` is where
    // `liveError` lives, and a console call there is the mistake the rule names.
    const tsx = Object.keys(SOURCES).filter((file) => file.endsWith(".tsx"));
    expect(tsx.length).toBeGreaterThan(3);
    expect(usesOfConsole("planted.tsx", `const a = 1;\n${CONSOLE}.error("x");\n`)).toHaveLength(1);
  });

  it("finds no console call in `src/`", () => {
    expect(
      ALL_USES.map((use) => `${use.file}:${use.line}  ${use.text}`),
      "AGENTS.md §5: a failure the user must see becomes a banner or a typed event, not a " +
        "log line. A console call in this package is invisible in the browser, and the paths it " +
        "would be used on — a refused workspace, a failed settings write, a turn that could not " +
        "start — are exactly the ones the user has to be told about.",
    ).toEqual([]);
  });

  it("the reader sees what it is meant to catch", () => {
    // The self-check. `AppShell.tsx` claims in its own header that a refused write is
    // reported rather than logged; without this test, deleting that report and leaving
    // a log line behind would be a green run.
    const planted = [
      `if (x) ${CONSOLE}.error("boom");`,
      `${CONSOLE}   .warn("careful");`,
      `try { run(); } catch (e) { ${CONSOLE}\n  .log(e); }`,
    ].join("\n");
    expect(usesOfConsole("planted", planted)).toHaveLength(3);

    // …and it does not fire on prose, a string, or a type name.
    const innocent = [
      `// the console is not where a user-visible failure goes`,
      "/* nothing here writes to the console either */",
      `const message = "${CONSOLE}.error in a string";`,
      "interface Reporter { console: (text: string) => void }",
      "const concordance = 3; const console2 = 4;",
      // **Out of the gate's reach, and said so:** a bare *reference* with no call is
      // not matched, because the rule is about writing to the console.
      `const report = ${CONSOLE}.log;`,
    ].join("\n");
    expect(usesOfConsole("innocent", innocent)).toEqual([]);
  });

  it("reports the line a human has to read, not the line the stripper blanked", () => {
    /**
     * The failure message is built from {@link Use.text}, so if that were the
     * **blanked** line, every report would read `console.error(   )` — file and line
     * right, content gone — and the person looking at it would have to open the file to
     * learn what was logged. This is the assertion that keeps the report honest, and it
     * is deliberately about the *message*: the stripper is unchanged, the pattern still
     * has to match the code, and no gate is loosened.
     */
    const [use] = usesOfConsole("planted.ts", `${CONSOLE}.error("geheim: sk-live-abc")`);
    expect(use?.line).toBe(1);
    expect(use?.text).toBe(`${CONSOLE}.error("geheim: sk-live-abc")`);
  });
});
