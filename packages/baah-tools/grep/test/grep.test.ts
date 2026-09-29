import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { grepTool, searchWithRegExp, type GrepFile } from "../src/index.ts";

/** A NUL byte marks binary content; the same marker the `read` tool uses. */
const NUL = String.fromCharCode(0);

function context(files: Record<string, string>, cwd = "."): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd,
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
  };
}

const TREE: Record<string, string> = {
  "src/a.ts": ["import { x } from './b';", "const NEEDLE = 1;", "export { x };"].join("\n") + "\n",
  "src/b.ts": ["// needle in a comment", "export const b = 2;"].join("\n") + "\n",
  "docs/guide.md": ["# Guide", "", "A needle in prose.", ""].join("\n") + "\n",
  "node_modules/pkg/index.js": ["const needle = 1;"].join("\n") + "\n",
  "dist/bundle.js": ["const needle = 1;"].join("\n") + "\n",
  ".env": ["NEEDLE=secret"].join("\n") + "\n",
  "assets/logo.png": "binary-ish\n",
  "data.bin": `a${NUL}b\n`,
};

describe("grep tool", () => {
  it("returns file:line matches", async () => {
    const result = await grepTool.execute(context(TREE), { pattern: "needle" });

    expect(result.matches).toEqual([
      { path: "docs/guide.md", line: 3, text: "A needle in prose." },
      { path: "src/b.ts", line: 1, text: "// needle in a comment" },
    ]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.path).toBe(".");
  });

  it("treats the pattern as a regex by default", async () => {
    const ctx = context({ "a.ts": ["foo1", "bar1", "foo2"].join("\n") });

    const regex = await grepTool.execute(ctx, { pattern: "foo\\d" });
    expect(regex.matches.map((m) => m.line)).toEqual([1, 3]);

    const anchor = await grepTool.execute(ctx, { pattern: "^bar" });
    expect(anchor.matches.map((m) => m.line)).toEqual([2]);
  });

  it("treats the pattern literally with `literal: true`", async () => {
    const ctx = context({ "a.ts": ["a+b", "aaab"].join("\n") });

    const regex = await grepTool.execute(ctx, { pattern: "a+b" });
    // `+` is a regex quantifier, so only `aaab` matches.
    expect(regex.matches.map((m) => m.line)).toEqual([2]);

    const literal = await grepTool.execute(ctx, { pattern: "a+b", literal: true });
    expect(literal.matches.map((m) => m.line)).toEqual([1]);
  });

  it("honours `caseSensitive: false`", async () => {
    const ctx = context({ "a.ts": ["Needle", "needle"].join("\n") });

    const sensitive = await grepTool.execute(ctx, { pattern: "needle" });
    expect(sensitive.matches.map((m) => m.line)).toEqual([2]);

    const insensitive = await grepTool.execute(ctx, { pattern: "needle", caseSensitive: false });
    expect(insensitive.matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it("filters files with `include`", async () => {
    const ctx = context({
      "src/a.ts": "needle\n",
      "src/b.tsx": "needle\n",
      "docs/guide.md": "needle\n",
    });

    const result = await grepTool.execute(ctx, { pattern: "needle", include: "*.{ts,tsx}" });
    expect(result.matches.map((m) => m.path)).toEqual(["src/a.ts", "src/b.tsx"]);

    const scoped = await grepTool.execute(ctx, { pattern: "needle", include: "src/*" });
    expect(scoped.matches.map((m) => m.path)).toEqual(["src/a.ts", "src/b.tsx"]);

    const single = await grepTool.execute(ctx, { pattern: "needle", include: "*.md" });
    expect(single.matches.map((m) => m.path)).toEqual(["docs/guide.md"]);
  });

  it("limits to a subtree with `path`", async () => {
    const result = await grepTool.execute(context(TREE), { pattern: "needle", path: "src" });

    expect(result.path).toBe("src");
    expect(result.matches.map((m) => m.path)).toEqual(["src/b.ts"]);
  });

  it("truncates at `limit` and reports the real total", async () => {
    const ctx = context({ "a.ts": ["hit", "hit", "hit", "hit"].join("\n") });

    const result = await grepTool.execute(ctx, { pattern: "hit", limit: 2 });

    expect(result.matches).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.hint).toMatch(/Showing 2 of 4/);
  });

  it("returns a readable result when nothing matches", async () => {
    const result = await grepTool.execute(context(TREE), { pattern: "zzz-not-here" });

    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.hint).toMatch(/No line matches/);
  });

  it("returns a model-actionable error for an invalid regular expression", async () => {
    const ctx = context(TREE);

    await expect(grepTool.execute(ctx, { pattern: "unclosed(" })).rejects.toThrow(
      /Invalid regular expression/,
    );
    await expect(grepTool.execute(ctx, { pattern: "[" })).rejects.toThrow(
      /Invalid regular expression/,
    );
    await expect(grepTool.execute(ctx, { pattern: "a{2,1}" })).rejects.toThrow(
      /literal: true/,
    );
  });

  it("accepts an invalid regex as literal text", async () => {
    const ctx = context({ "a.ts": "unclosed(\n" });

    const result = await grepTool.execute(ctx, { pattern: "unclosed(", literal: true });
    expect(result.matches).toHaveLength(1);
  });

  it("skips node_modules, build output, hidden and binary files", async () => {
    const result = await grepTool.execute(context(TREE), { pattern: "needle|secret" });

    expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.matches.map((m) => m.path)).not.toContain("node_modules/pkg/index.js");
    expect(result.matches.map((m) => m.path)).not.toContain("dist/bundle.js");
    expect(result.matches.map((m) => m.path)).not.toContain(".env");
  });

  it("counts a NUL-containing file as skipped", async () => {
    const ctx = context({ "a.ts": "b\n", "data.bin": `a${NUL}b\n` });

    const result = await grepTool.execute(ctx, { pattern: "b" });

    expect(result.filesScanned).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.matches.map((m) => m.path)).toEqual(["a.ts"]);
  });

  it("honours the workspace .gitignore", async () => {
    const ctx = context({ ...TREE, ".gitignore": "docs/\n" });

    const result = await grepTool.execute(ctx, { pattern: "needle" });
    expect(result.matches.map((m) => m.path)).not.toContain("docs/guide.md");
  });

  it("refuses to escape the workspace root", async () => {
    await expect(
      grepTool.execute(context(TREE), { pattern: "x", path: "../../etc" }),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  it("reports a missing or non-directory `path`", async () => {
    const ctx = context(TREE);

    await expect(grepTool.execute(ctx, { pattern: "x", path: "nope" })).rejects.toThrow(
      /Directory not found/,
    );
    await expect(grepTool.execute(ctx, { pattern: "x", path: "src/a.ts" })).rejects.toThrow(
      /Not a directory/,
    );
  });

  it("is a read-only tool with a stable contract", () => {
    expect(grepTool.access).toBe("read");
    expect(grepTool.id).toBe("grep");
    expect(grepTool.inputSchema.safeParse({}).success).toBe(false);
    expect(grepTool.inputSchema.safeParse({ pattern: "" }).success).toBe(false);
    expect(grepTool.inputSchema.safeParse({ pattern: "x" }).success).toBe(true);
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ToolContext = { ...context(TREE), signal: controller.signal };

    const result = await grepTool.execute(ctx, { pattern: "needle" });
    expect(result.matches).toEqual([]);
    expect(result.searchTruncated).toBe(true);
    expect(result.note).toMatch(/aborted/);
  });

  it("sorts matches deterministically by path and line", async () => {
    const ctx = context({
      "z.ts": ["hit", "hit"].join("\n"),
      "a.ts": ["hit", "hit", "hit"].join("\n"),
    });

    const result = await grepTool.execute(ctx, { pattern: "hit" });
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      "a.ts:1",
      "a.ts:2",
      "a.ts:3",
      "z.ts:1",
      "z.ts:2",
    ]);
  });
});

describe("grep engines", () => {
  const FILES: GrepFile[] = [
    { path: "src/a.ts", content: "const alpha = 1;\nconst beta = 2;\nconst ALPHA = 3;\n" },
    { path: "src/b.ts", content: "function gamma() {\n  return 'alpha';\n}\n" },
  ];

  it("the JS RegExp engine finds regex matches with file and line", () => {
    const matches = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: true,
    });

    expect(matches).toEqual([
      { path: "src/a.ts", line: 1, text: "const alpha = 1;" },
      { path: "src/b.ts", line: 2, text: "  return 'alpha';" },
    ]);
  });

  it("the JS RegExp engine honours case sensitivity", () => {
    const matches = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: false,
    });

    expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(["src/a.ts:1", "src/a.ts:3", "src/b.ts:2"]);
  });

  it("the JS RegExp engine rejects an invalid pattern with a clear error", () => {
    expect(() =>
      searchWithRegExp({ files: FILES, pattern: "(", caseSensitive: true }),
    ).toThrow(/Invalid regular expression/);
  });

  it("the tool result equals the JS engine for the same case", async () => {
    const ctx = context({
      "src/a.ts": FILES[0]!.content,
      "src/b.ts": FILES[1]!.content,
    });

    const result = await grepTool.execute(ctx, { pattern: "alpha" });
    const expected = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: true,
    });

    expect(result.matches).toEqual(expected);
  });

  it("reports which engine ran", async () => {
    const ctx = context({ "a.ts": "needle\n" });
    const result = await grepTool.execute(ctx, { pattern: "needle" });

    expect(["grep-wasm", "javascript"]).toContain(result.engine);
    if (result.engine === "javascript") {
      expect(result.note).toMatch(/grep-wasm unavailable/);
    }
  });

  it("does not fetch the WASM module when there is nothing to scan", async () => {
    // Every file is filtered out, so no engine is even attempted and no
    // "grep-wasm unavailable" noise is attached to a legitimate empty result.
    const ctx = context({ "node_modules/pkg/index.js": "needle\n" });

    const result = await grepTool.execute(ctx, { pattern: "needle" });

    expect(result.filesScanned).toBe(0);
    expect(result.engine).toBe("javascript");
    expect(result.note).toBeUndefined();
    expect(result.hint).toMatch(/No line matches/);
  });
});

describe("include matcher", () => {
  const ctx = context({
    "src/a.ts": "hit\n",
    "src/nested/b.ts": "hit\n",
    "src/nested/deep/c.ts": "hit\n",
    "test/a.test.ts": "hit\n",
    "README.md": "hit\n",
  });

  it("supports `*`, `**`, `?` and braces", async () => {
    const cases: [string, string[]][] = [
      ["*.ts", ["src/a.ts", "src/nested/b.ts", "src/nested/deep/c.ts", "test/a.test.ts"]],
      ["src/**", ["src/a.ts", "src/nested/b.ts", "src/nested/deep/c.ts"]],
      ["src/**/*.ts", ["src/a.ts", "src/nested/b.ts", "src/nested/deep/c.ts"]],
      ["src/nested/*", ["src/nested/b.ts"]],
      ["src/?.ts", ["src/a.ts"]],
      ["*.{ts,md}", ["README.md", "src/a.ts", "src/nested/b.ts", "src/nested/deep/c.ts", "test/a.test.ts"]],
      ["**/b.ts", ["src/nested/b.ts"]],
      ["nomatch", []],
    ];

    for (const [include, expected] of cases) {
      const result = await grepTool.execute(ctx, { pattern: "hit", include });
      expect(result.matches.map((m) => m.path), include).toEqual(expected);
    }
  });

  it("does not treat regex metacharacters in a file name as a pattern", async () => {
    const result = await grepTool.execute(
      context({ "a+b.ts": "hit\n", "aab.ts": "hit\n" }),
      { pattern: "hit", include: "a+b.ts" },
    );

    expect(result.matches.map((m) => m.path)).toEqual(["a+b.ts"]);
  });
});

describe("grep output shape", () => {
  it("truncates a very long matching line", async () => {
    const result = await grepTool.execute(context({ "a.ts": `hit ${"x".repeat(4000)}\n` }), {
      pattern: "hit",
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.text).toContain("[line truncated]");
  });

  it("reports the byte budget it used", async () => {
    const result = await grepTool.execute(context({ "a.ts": "hit\n" }), { pattern: "hit" });

    expect(result.bytesRead).toBe(4);
    expect(result.maxBytes).toBe(16 * 1024 * 1024);
    expect(result.maxFileBytes).toBe(1024 * 1024);
    expect(result.searchTruncated).toBe(false);
  });

  it("skips a file over the per-file byte cap without reading it", async () => {
    const chunk = "x".repeat(1024 * 1024);
    const ctx = context({ "big.ts": `${chunk}\nhit\n`, "small.ts": "hit\n" });

    const result = await grepTool.execute(ctx, { pattern: "hit" });

    expect(result.filesScanned).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.matches.map((m) => m.path)).toEqual(["small.ts"]);
  });

  it("stops at the total byte cap and says so", async () => {
    // 17 files of exactly 1 MB each: the 16 MB cap must stop the scan at 16.
    const chunk = `${"x".repeat(1024 * 1024 - 5)}\nhit\n`;
    const files: Record<string, string> = {};
    for (let index = 0; index < 17; index += 1) {
      files[`f${String(index).padStart(2, "0")}.ts`] = chunk;
    }
    const ctx = context(files);

    const result = await grepTool.execute(ctx, { pattern: "hit" });

    expect(result.searchTruncated).toBe(true);
    expect(result.bytesRead).toBe(16 * 1024 * 1024);
    expect(result.total).toBe(16);
    expect(result.hint).toMatch(/byte cap/);
  });
});
