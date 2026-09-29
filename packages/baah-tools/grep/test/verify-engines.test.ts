/**
 * The engine of `grep`: there is one, and what it promises.
 *
 * This file used to pin down a two-engine design (grep-wasm preferred, JS
 * `RegExp` fallback) and contained six assertions that documented defects —
 * including two that overstated what they proved. The measurements those
 * comments record are the reason the WASM engine was removed; they are kept
 * here as the specification of what the single engine must and must not do.
 *
 * The abort/timeout characterisation moved to `verify-bounds.test.ts`, where
 * it is asserted as behaviour instead of as a gap.
 */
import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { grepInputSchema, grepTool, searchWithRegExp } from "../src/index.ts";

function context(files: Record<string, string>): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd: ".",
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
    // `ToolContext` requires these since baah-core grew replay bookkeeping;
    // no search tool reads them.
    toolCallId: "verify-call",
    attempt: 1,
  };
}

describe("there is exactly one engine", () => {
  // `grep-wasm@0.1.0` is gone. It was never equal to the JS scanner, it never
  // executed once in this repo, and the browser path it claimed was wrong by
  // default: `module.ripgrep.init()` with no argument derives the binary URL
  // from the module's own URL, and `packages/baah-web/vite.config.ts` sets no
  // `base`, so on a statically hosted app at a sub-path the fetch resolves to
  // the domain root and 404s. The schema exposed none of ripgrep's
  // capabilities — no `-v`, `-c`, `-m`, `-A/-B/-C`, `-o`, no multiline, no
  // binary search — so the only thing it bought was speed on a search this
  // tool caps at 16 MiB anyway.
  //
  // These tests assert the *absence*: no engine field to be wrong about, no
  // WASM to load, no note about an unavailable engine. The engine-metadata test
  // is not replaced with a weaker version — with one engine it has nothing to
  // assert (AGENTS.md §5: no dead abstractions).
  it("the result carries no engine field", async () => {
    const result = await grepTool.execute(context({ "a.ts": "needle\n" }), { pattern: "needle" });

    expect("engine" in result).toBe(false);
    expect(result.matches).toEqual([{ path: "a.ts", line: 1, text: "needle" }]);
  });

  it("no `GrepEngine` type is exported", async () => {
    const module = await import("../src/index.ts");
    expect(Object.keys(module)).not.toContain("GrepEngine");
  });

  it("a successful search carries no note about an engine", async () => {
    const result = await grepTool.execute(context({ "a.ts": "needle\n" }), { pattern: "needle" });

    expect(result.note).toBeUndefined();
  });

  it("an empty candidate list is a clean empty result", async () => {
    const result = await grepTool.execute(context({ "node_modules/x/i.js": "needle\n" }), {
      pattern: "needle",
    });

    expect(result.filesScanned).toBe(0);
    expect(result.total).toBe(0);
    expect(result.note).toBeUndefined();
    expect(result.hint).toMatch(/No line matches/);
  });
});

describe("the dialect is JavaScript's RegExp, and the description says so", () => {
  // The engine is the only engine, so the model has to be told what it is
  // writing for. Two patterns this engine accepts that ripgrep would have
  // rejected, and one the reference accepted that this engine does not: that
  // asymmetry is now the tool's documented contract rather than an accident of
  // which engine happened to be available.
  it("lookbehind works, and the description warns that it is not portable", async () => {
    const result = await grepTool.execute(context({ "a.ts": "const x = 1;\n$2 = 2\n" }), {
      pattern: "(?<=\\$)\\d",
    });

    expect(result.matches).toEqual([{ path: "a.ts", line: 2, text: "$2 = 2" }]);
    expect(grepTool.description).toMatch(/no lookaround/);
    expect(grepInputSchema.shape.pattern.description ?? "").toMatch(/no lookaround/);
  });

  it("backreferences work, and the description says they are not portable", async () => {
    const result = await grepTool.execute(context({ "a.ts": "hello\n" }), { pattern: "(\\w)\\1" });

    expect(result.matches.map((m) => m.line)).toEqual([1]);
    expect(grepTool.description).toMatch(/no backreferences/);
    expect(grepInputSchema.shape.pattern.description ?? "").toMatch(/no backreferences/);
  });

  it("inline flags are rejected, which the tool name in the error says how to escape", async () => {
    // `new RegExp("(?i)HELLO")` throws "Invalid group". The error has to point at
    // the two things a model can do: fix the pattern, or use `caseSensitive`.
    await expect(
      grepTool.execute(context({ "a.ts": "hello\n" }), { pattern: "(?i)HELLO" }),
    ).rejects.toThrow(/Invalid regular expression/);
    await expect(
      grepTool.execute(context({ "a.ts": "hello\n" }), { pattern: "(?i)HELLO" }),
    ).rejects.toThrow(/caseSensitive|literal/);
  });

  it("`\\p{…}` matches the literal `p` without the `u` flag — a stated limitation, not a silent one", async () => {
    // This was measured as a real divergence from ripgrep (6 matches there, 0
    // here). It is not fixed by adding `u` (which would break backreferences
    // and lookbehind, the two patterns the tool advertises), so it is
    // documented instead: the description names the dialect, and a caller who
    // needs Unicode property classes has to say so in a follow-up.
    const result = await grepTool.execute(context({ "a.ts": "p{L}xx\n", "b.ts": "hello\n" }), {
      pattern: "\\p{L}+",
    });

    expect(result.matches.map((m) => m.path)).toEqual(["a.ts"]);
    expect(grepInputSchema.shape.pattern.description ?? "").toMatch(/JavaScript/);
  });

  it("the ordinary patterns both engines agreed on still agree with the bare scanner", async () => {
    // The equivalence claim that survives: tool output == scanner output. It
    // used to assert `fallback == fallback` and read like a cross-engine proof;
    // now it is a genuine end-to-end-vs-unit check, which is what it always was.
    const FILES = [
      { path: "src/a.ts", content: "const alpha = 1;\nconst beta = 2;\nconst ALPHA = 3\n" },
      { path: "src/b.ts", content: "function gamma() {\n  return 'alpha';\n}\n" },
      { path: "c.txt", content: "alpha alpha alpha\n" },
    ];
    for (const pattern of ["alpha", "a.pha", "^const", "[a-z]+", "a+"]) {
      const byTool = await grepTool.execute(
        context(Object.fromEntries(FILES.map((f) => [f.path, f.content]))),
        { pattern },
      );
      const byEngine = searchWithRegExp({
        files: FILES,
        pattern,
        caseSensitive: true,
      });
      // `grepTool` sorts by path/line; the bare scanner keeps file order.
      const sort = (ms: readonly { path: string; line: number }[]) =>
        ms.map((m) => `${m.path}:${m.line}`).sort();
      expect(sort(byTool.matches), pattern).toEqual(sort(byEngine.matches));
    }
  });

  it("one match per line, not one per submatch", async () => {
    // The property the old two-engine docstring relied on, and the one the
    // result shape (`path`/`line`/`text`) actually promises.
    const result = await grepTool.execute(context({ "c.txt": "alpha alpha alpha\n" }), {
      pattern: "alpha",
    });

    expect(result.matches).toEqual([{ path: "c.txt", line: 1, text: "alpha alpha alpha" }]);
    expect(result.total).toBe(1);
  });
});
