/**
 * `AGENTS.md` §5 forbids silent `catch` blocks — and the same silence has a
 * second spelling no compiler catches.
 *
 * ## Why this package needs its own copy
 *
 * The gate in `@all-the.rest/baah-core` reads **its own** `src/` through Vite's
 * `import.meta.glob`, and a glob is rooted at the package that calls it. So the
 * rule that caught `void store.heartbeat(…)` in the engine says nothing about
 * this package, and this package has the same shape waiting: the worker's
 * `addEventListener` entry point fires one message per request without awaiting
 * it, which is correct — every request is answered with one correlated response
 * — and which is *also* the exact place a rejection would be dropped.
 *
 * Two copies, one rule, and no shared helper: a module that both packages import
 * for a test would have to live in one of their `src/` trees, and `AGENTS.md` §4
 * puts the dependency in the wrong direction. The duplication is the cost of the
 * layering rule, and it is named here rather than worked around.
 *
 * ## The rule
 *
 * **A statement-level `void` in `src/` may not discard a call that nobody
 * handles.** `Promise<void>`, `(): void =>` and `void someIdentifier;` are not
 * this rule; `void p.catch(…)` is the rule satisfied.
 *
 * ## Known limits, stated rather than hidden
 *
 * Regex-level, not a parser: comments and string literals are stripped and the
 * operand is read to the next top-level `;`, so a template-literal interpolation
 * counts as a string and a regex literal containing a quote character would end
 * the string scan early. The reader is exercised against planted input below,
 * because a scanner that silently finds nothing passes every other test here.
 */

import { describe, expect, it } from "vitest";

/**
 * `import.meta.glob`, which is how the sources are read — `readFileSync` would
 * need `@types/node`, which this package does not have (`AGENTS.md` §2 keeps the
 * runtime free of Node, and the test tree is only half exempt).
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

/** The members that make a discarded promise handled. */
const HANDLERS = [".catch(", ".then(", ".finally("];

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

function isStatementStart(code: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (code[cursor] === " " || code[cursor] === "\t" || code[cursor] === "\n")) {
    cursor -= 1;
  }
  if (cursor < 0) return true;
  const previous = code[cursor] ?? "";
  return previous === ";" || previous === "{" || previous === "}";
}

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
    expect(files.length).toBeGreaterThan(8);
    for (const known of ["/src/worker.ts", "/src/operations.ts", "/src/client.ts"]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("finds no bare `void` in `src/`", () => {
    expect(
      ALL_OFFENCES.map((offence) => `${offence.file}:${offence.line}  ${offence.text}`),
      "A discarded promise with no rejection handler is an unhandled promise " +
        "rejection, not a silent no-op (AGENTS.md §5). Attach a handler that reports " +
        "the failure, or await it.",
    ).toEqual([]);
  });

  it("the reader sees the shape it is meant to catch", () => {
    const planted = [
      "void worker.handleMessage(event.data);",
      "void database.renewHeartbeat(input);",
      "const a = 1; void flush();",
      ["void store", "  .heartbeat({ turnId })", "  ;"].join("\n"),
    ].join("\n");
    expect(bareVoids("planted", planted)).toHaveLength(4);

    const innocent = [
      "async close(): Promise<void> { this.#closed = true; }",
      "const post = (response: RpcResponse): void => { scope.postMessage(response); };",
      "void reasoning;",
      "void worker.handleMessage(data).catch(report);",
      "// void worker.handleMessage(event.data);",
      'const note = "void worker.handleMessage(event.data);";',
    ].join("\n");
    expect(bareVoids("innocent", innocent)).toEqual([]);
  });
});
