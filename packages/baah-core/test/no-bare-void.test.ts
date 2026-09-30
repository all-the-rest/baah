/**
 * `AGENTS.md` §5 forbids silent `catch` blocks — and the *same* silence has a
 * second spelling that no compiler and no reviewer reliably catches.
 *
 * ## Why this file exists
 *
 * `void store.heartbeat({ … })` compiled clean, typechecked clean, and every
 * behavioural test in the suite passed with it in place. `void` is not a discard
 * a reader registers: it reads like "I do not need the result", which is what the
 * author meant, and the rejection it silently produces is **not** a silent
 * failure — it is an *unhandled promise rejection*, which the browser routes to
 * `unhandledrejection` and vitest turns into a fatal error for the whole run. The
 * difference matters: a `catch {}` is a decision somebody can review, a bare
 * `void` is one nobody can see.
 *
 * The cost was concrete. `store.heartbeat` is the reload anchor (§6.1), so a
 * rejection means the turn stopped being provably alive, and the only reader is
 * `recoverStaleTurns` on the *next* start-up. The turn that lost the anchor
 * said nothing, wrote nothing and finished `succeeded`.
 *
 * ## The rule this file enforces
 *
 * **A statement-level `void` in `src/` may not discard a call that nobody
 * handles.** The qualifier is doing real work:
 *
 * - `void` in a **type** position (`Promise<void>`, `(): void =>`, `=> void`) is
 *   the language's own marker and is not this rule.
 * - `void someIdentifier;` with no call is the `noUnusedLocals` idiom and is not
 *   this rule either — `loop.ts` has one, on a value it deliberately accumulates
 *   and never reads.
 * - `void p.catch(…)` **is** the rule satisfied: the promise is still discarded,
 *   but its rejection is not.
 *
 * ## Why it is a source scan and not a rule somewhere else
 *
 * `--noExplicitAny` does not exist in `typescript@7.0.2` (see
 * `test/no-explicit-any.test.ts`), a lint rule is a new dependency and a new
 * config surface, and `AGENTS.md` §3 fixes both. What is left needs no new tool:
 * read the sources and fail, in the build that already runs.
 *
 * ## Known limits, stated rather than hidden
 *
 * - The reader is a **regex-level scanner, not a parser.** It strips comments
 *   and string literals, then looks for a statement-position `void` and reads
 *   the operand to the next top-level `;`. The stripper is duplicated from
 *   `no-explicit-any.test.ts` rather than shared: extracting it would edit a
 *   file whose self-test is load-bearing, for a scanner that answers a different
 *   question. Both scanners carry the same known limits — a template-literal
 *   interpolation counts as a string, and a regex literal containing a quote
 *   character would end the string scan early.
 * - It scans **`src/` only.** The rule is about shipped code, and a test that
 *   discards a promise is caught by vitest's own unhandled-rejection handling
 *   anyway — with one deliberate exception, named in the build report:
 *   `test/verify/verify-replay-window.test.ts` and
 *   `test/agent/approval.test.ts` use the `void x;` idiom, which this rule does
 *   not flag, and `test/worker-guards.test.ts` in `baah-storage` fires a worker
 *   message to *prove* it answers, where a `.catch` would be the silent catch
 *   this file is about.
 * - It cannot see a **cross-package** caller. `packages/baah-storage` has its own
 *   copy of this gate, and `packages/baah-web` has none — a gap the report
 *   states rather than hides.
 */

import { describe, expect, it } from "vitest";

/**
 * `import.meta.glob`, which is how the sources are read.
 *
 * `readFileSync` would need `@types/node`, which this package deliberately does
 * not have — `test/verify/raw.d.ts` makes the same trade, once.
 */
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
 * The members that make a discarded promise handled.
 *
 * `.catch` is the ordinary one and the other two are the two-argument shapes
 * (`p.then(undefined, onRejected)`, `p.finally(…)`). Listed rather than inferred
 * because a scanner that guesses here is a scanner that has to be trusted.
 */
const HANDLERS = [".catch(", ".then(", ".finally("];

/** Replace every comment and string literal with spaces, keeping the line count. */
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

interface Offence {
  file: string;
  line: number;
  text: string;
}

/** Is `index` at the start of a statement rather than inside a type? */
function isStatementStart(code: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (code[cursor] === " " || code[cursor] === "\t" || code[cursor] === "\n")) {
    cursor -= 1;
  }
  if (cursor < 0) return true;
  const previous = code[cursor] ?? "";
  return previous === ";" || previous === "{" || previous === "}";
}

/** The operand of a statement-level `void`, up to the next top-level `;`. */
function operandOf(code: string, afterVoid: number): string {
  let depth = 0;
  let cursor = afterVoid;
  while (cursor < code.length) {
    const char = code[cursor];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === ";" && depth === 0) return code.slice(afterVoid, cursor);
    cursor += 1;
  }
  return code.slice(afterVoid);
}

/**
 * Every statement-level `void` that discards a call with no rejection handler.
 *
 * A `(` in the operand is what separates "discards a promise" from the
 * `void someIdentifier;` idiom; a handler in the operand is what separates
 * "discards a promise" from "discards a promise whose failure is reported".
 */
function bareVoids(file: string, source: string): Offence[] {
  const code = stripCommentsAndStrings(source);
  const lines = code.split("\n");
  const found: Offence[] = [];
  const marker = "void";

  for (let index = 0; index + marker.length <= code.length; index += 1) {
    if (code.slice(index, index + marker.length) !== marker) continue;
    const before = index === 0 ? "" : (code[index - 1] ?? "");
    const after = code[index + marker.length] ?? "";
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;
    if (!isStatementStart(code, index)) continue;

    const operand = operandOf(code, index + marker.length);
    if (!operand.includes("(")) continue;
    if (HANDLERS.some((handler) => operand.includes(handler))) continue;

    const lineNumber = code.slice(0, index).split("\n").length;
    found.push({ file, line: lineNumber, text: (lines[lineNumber - 1] ?? "").trim() });
  }

  return found;
}

const ALL_OFFENCES: Offence[] = Object.entries(SOURCES)
  .flatMap(([file, source]) => bareVoids(file, source))
  .sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file),
  );

describe("no source discards a promise with a bare `void`", () => {
  it("the scan really reads the sources — a glob that matches nothing passes vacuously", () => {
    const files = Object.keys(SOURCES);
    // A floor, not an exact count: a new module must not have to update a number,
    // but an empty or truncated scan must fail.
    expect(files.length).toBeGreaterThan(10);
    for (const known of ["/src/agent/loop.ts", "/src/agent/tools.ts", "/src/tool.ts"]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("finds no bare `void` in `src/`", () => {
    expect(
      ALL_OFFENCES.map((offence) => `${offence.file}:${offence.line}  ${offence.text}`),
      "A discarded promise with no rejection handler is not a silent failure — it is an " +
        "unhandled promise rejection, which is invisible in the product and fatal to a " +
        "vitest run (AGENTS.md §5). Attach a handler that reports a typed event, or await it.",
    ).toEqual([]);
  });

  it("the reader sees the shape it is meant to catch", () => {
    // The self-check. If the scanner stopped working, the test above would pass
    // while proving nothing — which is the failure mode this file exists to
    // prevent, and the reason `no-explicit-any.test.ts` has one too.
    const planted = [
      "void store.heartbeat({ turnId });",
      "void worker.handleMessage(event.data);",
      "const a = 1; void flush();",
    ].join("\n");
    expect(bareVoids("planted", planted)).toHaveLength(3);

    // …and it does not fire on the four things that are not this rule.
    const innocent = [
      "export function f(): Promise<void> { return Promise.resolve(); }",
      "const g = (): void => { /* nothing */ };",
      "let h: (x: number) => void;",
      "void reasoning;",
      "void store.heartbeat({ turnId }).catch(report);",
      "void worker.handleMessage(data).then(undefined, report);",
      "// void store.heartbeat({ turnId });",
      'const message = "void store.heartbeat({ turnId });";',
    ].join("\n");
    expect(bareVoids("innocent", innocent)).toEqual([]);
  });

  it("finds one across a line break — the operand is read, not the line", () => {
    // The scanner that only looked at a single line would miss exactly the shape
    // a formatter produces: `void store` on one line and `.heartbeat(…)` on the
    // next. This is the case a whitespace-sensitive regex gets wrong.
    const wrapped = ["void store", "  .heartbeat({ turnId })", "  ;", "const after = 1;"].join("\n");
    expect(bareVoids("wrapped", wrapped)).toHaveLength(1);
  });
});
