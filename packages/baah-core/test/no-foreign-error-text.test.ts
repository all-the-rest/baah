/**
 * A caught error's **text** is not this package's to render — and the rule is
 * enforced where it can be, not only in prose.
 *
 * ## The rule
 *
 * `AGENTS.md` §2: an arbitrary `Error.message` is the one shape in this program
 * that can carry a key. Two defects in this package read one:
 *
 * 1. `describeStorageFailure` in `agent/loop.ts` — the measured one. A store
 *    rejection's message became a `Classification.reason`, and the app renders a
 *    `protocol-error`'s `reason` **verbatim** in the status bar.
 * 2. `describe` in `ignore.ts` — the same ternary, byte for byte, in a different
 *    module. A workspace rejection's message became `gitignoreError`, which both
 *    search tools interpolate into the `note` of their result, and a tool result
 *    is rendered (the tool card), persisted (the transcript row) and read by the
 *    model.
 *
 * Both were fixed by the same *field choice* — `error.name`, a class name by
 * contract — and the reasoning is at each call site. What neither fix gives is
 * **coverage of the next one**: nothing failed when the second was written, and
 * nothing would fail if a fifth were written tomorrow. That is the failure mode
 * `AGENTS.md` §6a names for every unenforced rule, and the reason this file
 * exists.
 *
 * ## What this gate is, precisely
 *
 * A **permit list of foreign-text reads in `src/`**, keyed by file, with a
 * required reason per entry. Every read of a caught value's `message` — however
 * it is spelled — must be in the list, and the declared count per file must
 * match the measured count.
 *
 * Keying by *count* rather than by line number is the load-bearing detail. A
 * line-numbered list rots the first time an unrelated line is inserted above it,
 * and `AGENTS.md` §6a records what that costs: a gate that silently stops
 * matching is worse than no gate, because it reads as coverage. With counts, a
 * **new** read in an already-allowlisted file fails (the count rose) and a
 * **removed** one fails too (it fell) — so the list can only be changed
 * deliberately, which is the entire point.
 *
 * ## It is a spelling rule, and the spellings it misses are named
 *
 * The scan reads the *code* of a file — comments and string literals are
 * stripped first, as in the other three gates — with one deliberate exception:
 * a second pass that strips only comments, because the bracket form
 * `error["message"]` lives *inside* a string literal and the full stripper would
 * erase the very token being looked for. That pass is why
 * `stream/classify.ts` is on the list at all.
 *
 * What it still misses, stated rather than hidden:
 *
 * - a **destructured** read (`const { message } = error`) — a different token
 *   shape, and a gate that grew to catch it would be a parser, not a gate;
 * - a read through an **alias** (`const e = error; e.message`) — the allowlist is
 *   keyed on the spelling, so the first read is the one that is reviewed;
 * - a **cast** (`(error as { message: string }).message`) — `AGENTS.md` §5's
 *   "no blind casts" rule is what catches that one, in review.
 *
 * None of those is a reason to skip the gate: they are the documented boundary
 * of what a regex over sources can promise, and `AGENTS.md` §9 asks for
 * unverified claims to be marked rather than asserted. What the gate *does*
 * guarantee is that the two shapes this package actually used — the dotted read
 * and `String(error)` — cannot come back unnoticed.
 *
 * ## Why `src/` only
 *
 * A test has to be able to build the leaking message in order to prove the fix,
 * so `test/` is out of scope by construction: every fixture in
 * `agent/storage-failure-text.test.ts` composes a `401 from Google: key … is
 * invalid` string on purpose. A gate that failed on those would be a gate that
 * had to be defeated to write the test that proves the rule.
 *
 * ## The fourth copy of the stripper
 *
 * The same `stripCommentsAndStrings` as `no-explicit-any`, `no-bare-void` and
 * `no-console`. `AGENTS.md` §6a names the duplication as the price of §4's
 * layering rule (a package may not import from another package's test tree) and
 * the three existing gates already carry their own copy inside this one package,
 * so this follows the house pattern rather than inventing a shared module for
 * four callers — which is a refactor of files this change does not own.
 */

import { describe, expect, it } from "vitest";

/**
 * `import.meta.glob`, which is how the sources are read — `readFileSync` would
 * need `@types/node`, which this package deliberately does not have
 * (`test/verify/raw.d.ts` says the same trade, made once).
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query?: string; import?: string; eager?: boolean },
    ): Record<string, unknown>;
  }
}

const SOURCES: Record<string, string> = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * The bindings a caught value is read through.
 *
 * Deliberately a *name* list and not a type analysis: the point is to catch the
 * spelling a human writes at a `catch` site, which is one of these six words.
 * A call that reads `error.message` from a parameter it did not catch is a false
 * positive, and the count-based allowlist is what makes that affordable — the
 * file is named, the count is declared and the reason is on the record.
 */
const ERROR_BINDINGS = ["error", "err", "caught", "cause", "thrown", "e"] as const;

/** Blank a span, keeping newlines so a reported line number stays right. */
function blank(out: string[], from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    if (out[index] !== "\n") out[index] = " ";
  }
}

/** Comments only. Strings survive, because the bracket form lives in one. */
function stripComments(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? "";
    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", index);
      const stop = lineEnd === -1 ? source.length : lineEnd;
      blank(out, index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      const stop = commentEnd === -1 ? source.length : commentEnd + 2;
      blank(out, index, stop);
      index = stop;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** Comments **and** string literals, as the other three gates do it. */
function stripCommentsAndStrings(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", index);
      const stop = lineEnd === -1 ? source.length : lineEnd;
      blank(out, index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      const stop = commentEnd === -1 ? source.length : commentEnd + 2;
      blank(out, index, stop);
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
      blank(out, index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** One read of a caught value's text. */
interface Read {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly spelling: string;
}

function matching(line: string, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(line);
}

/**
 * Every foreign-text read in one file, with the line it is on.
 *
 * Two passes, and the second one exists for a concrete reason:
 *
 * - the dotted read and `String(error)` are found on the comment- **and**
 *   string-stripped code, so prose about them ("`error.message` is the one
 *   shape…") is not a hit;
 * - the bracket read is found on the comment-stripped code only, because
 *   `error["message"]` *is* a string literal and the full stripper would replace
 *   it with spaces — which would have left the one shape in this package that
 *   reads a provider's body text unlisted.
 */
function readsIn(file: string, source: string): Read[] {
  const code = stripCommentsAndStrings(source);
  const commentFree = stripComments(source);
  const lines = code.split("\n");
  const reads: Read[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    for (const binding of ERROR_BINDINGS) {
      const dotted = new RegExp(`\\b${binding}\\s*\\.\\s*message\\b`);
      const stringified = new RegExp(`\\bString\\(\\s*${binding}\\s*\\)`);
      // Two `if`s, not `if / else if`: the original defect is one line carrying
      // *both* spellings (`error instanceof Error ? error.message :
      // String(error)`), and reporting one read per line would undercount the
      // exact line this gate exists for.
      if (matching(line, dotted)) {
        reads.push({ file, line: lineNumber, text: trimmed, spelling: `${binding}.message` });
      }
      if (matching(line, stringified)) {
        reads.push({ file, line: lineNumber, text: trimmed, spelling: `String(${binding})` });
      }
    }

    const bracketed = (commentFree.split("\n")[lineNumber - 1] ?? "").match(
      /\b[A-Za-z_$][\w$]*\s*\[\s*['"]message['"]\s*\]/g,
    );
    for (const hit of bracketed ?? []) {
      reads.push({ file, line: lineNumber, text: trimmed, spelling: hit });
    }
  }

  return reads;
}

const ALL_READS: Read[] = Object.entries(SOURCES)
  .flatMap(([file, source]) => readsIn(file, source))
  .sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file),
  );

/**
 * The permit list.
 *
 * **Every entry is a decision, and the reason is part of the decision.** An
 * entry without one fails the last test in this file, so "I needed an exception"
 * cannot become a bare number in a list.
 */
const PERMITTED: readonly { readonly file: string; readonly count: number; readonly reason: string }[] = [
  {
    file: "/src/tool.ts",
    count: 3,
    reason:
      "The one place a foreign text is forwarded on purpose: `toToolErrorResult` puts it in the " +
      "tool **result**, and a tool result is model context. The model has to be able to read why " +
      "its call failed — a tool error it cannot read is an error it retries blind. This is not " +
      "the status bar: the app renders a tool result inside the tool card, which is a different " +
      "surface, and the failure a tool reports is one this package's own tools raised " +
      "(`ToolError` carries text we wrote).",
  },
  {
    file: "/src/stream/classify.ts",
    count: 3,
    reason:
      "The provider's **response body** message, read on purpose and deliberately not rendered: " +
      "it becomes `Classification.message`, and the app's `failureView` shows `code` only (" +
      "`packages/baah-web/src/components/lib/turn.ts`). Its one other consumer is " +
      "`describe(classification)` in `agent/loop.ts`, which reaches the persisted turn row — " +
      "`transcriptModel` drops that column, so it is never rendered. This is a field of the " +
      "provider's, so the next reader of this list must check that claim rather than assume it.",
  },
  {
    file: "/src/workspace/directory-workspace.ts",
    count: 1,
    reason:
      "`FileSystemWritableFileStream.abort(reason)`: the platform's own diagnostic reason for a " +
      "failed write. Nothing in this program reads it back, and the value is a File System Access " +
      "rejection — the browser's text about a handle, not anybody's provider sentence. It can " +
      "reach the browser's developer console, which is a developer surface and not a rendered one.",
  },
];

describe("no caught error's text is read outside the permit list", () => {
  it("the scan really reads the sources — a glob that matches nothing passes vacuously", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(10);
    for (const known of ["/src/tool.ts", "/src/ignore.ts", "/src/agent/loop.ts", "/src/stream/classify.ts"]) {
      expect(files, known).toContain(known);
    }
    expect(Object.values(SOURCES).every((source) => source.length > 0)).toBe(true);
  });

  it("reads only in files the permit list names", () => {
    const permitted = PERMITTED.map((entry) => entry.file);
    const unlisted = ALL_READS.filter((read) => !permitted.includes(read.file)).map(
      (read) => `${read.file}:${read.line}  [${read.spelling}]  ${read.text}`,
    );

    expect(
      unlisted,
      "AGENTS.md §2: a caught value's text is not this package's to render. Use `error.name` " +
        "(the class name) and name the operation yourself — `describeStorageFailure` in " +
        "`agent/loop.ts` and `describeFailure` in `ignore.ts` are the two precedents, and both " +
        "keep the diagnosis. If this read is deliberate, add the file to PERMITTED with a reason.",
    ).toEqual([]);
  });

  it("reads exactly as often as the permit list declares, per file", () => {
    // The count is what makes the list survive an edit. Without it, a new read
    // inside an already-permitted file would be invisible — and `agent/loop.ts`
    // is precisely the file a fifth one would land in.
    const declared = PERMITTED.map(
      (entry) =>
        `${entry.file}  declared ${entry.count}, measured ${
          ALL_READS.filter((read) => read.file === entry.file).length
        }`,
    );

    expect(declared).toEqual(
      PERMITTED.map(
        (entry) => `${entry.file}  declared ${entry.count}, measured ${entry.count}`,
      ),
    );
  });

  it("every permitted file has a reason, so an exception cannot become a bare number", () => {
    for (const entry of PERMITTED) {
      expect(entry.reason.trim().length, entry.file).toBeGreaterThan(80);
    }
  });

  it("the reader sees what it is meant to catch", () => {
    /**
     * The self-check, and the one a reader should check first.
     *
     * Two defects were fixed in this package and a scanner that stopped working
     * would leave both of them invisible while every other test here passed.
     */
    const planted = [
      // The exact shape `describeStorageFailure` used to have.
      "function old(error: unknown): string {",
      "  return error instanceof Error ? error.message : String(error);",
      "}",
      // The bracket form, which the comment-only pass exists for.
      'const body = asNonEmptyString(error["message"]);',
      // A different binding name, so the list of six is doing something.
      "const also = String(caught);",
    ].join("\n");
    expect(readsIn("/planted.ts", planted)).toHaveLength(4);

    // …and it does not fire on prose, on a string, or on our own field names.
    const innocent = [
      "// a comment about error.message and String(error) in a sentence",
      "/* another one: error[\"message\"] */",
      'const sentence = "an Error.message is the one shape that can carry a key";',
      "const reason = classification.reason;",
      "const message = classification.message;",
      "const issue = zodIssue.message;",
      "const projection = textProjection(value);",
    ].join("\n");
    expect(readsIn("/innocent.ts", innocent)).toEqual([]);
  });
});
