import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { globTool } from "../src/index.ts";

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
  "index.ts": "export const root = 1;\n",
  "src/a.ts": "export const a = 1;\n",
  "src/b.tsx": "export const b = 1;\n",
  "src/deep/c.ts": "export const c = 1;\n",
  "src/deep/deeper/d.ts": "export const d = 1;\n",
  "docs/guide.md": "# guide\n",
  "node_modules/pkg/index.js": "module.exports = 1;\n",
  "dist/bundle.js": "console.log(1);\n",
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "assets/logo.png": "not really a png\n",
  ".git/config": "[core]\n",
  ".env": "SECRET=1\n",
  ".config/settings.json": "{}\n",
};

describe("glob tool", () => {
  it("matches across subdirectories", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "**/*.ts" });

    expect(result.files).toEqual([
      "index.ts",
      "src/a.ts",
      "src/deep/c.ts",
      "src/deep/deeper/d.ts",
    ]);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it("distinguishes `*` from `**`", async () => {
    const ctx = context(TREE);

    const single = await globTool.execute(ctx, { pattern: "src/*" });
    expect(single.files).toEqual(["src/a.ts", "src/b.tsx"]);

    const deep = await globTool.execute(ctx, { pattern: "src/**" });
    expect(deep.files).toEqual([
      "src/a.ts",
      "src/b.tsx",
      "src/deep/c.ts",
      "src/deep/deeper/d.ts",
    ]);
  });

  it("matches braces", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "src/*.{ts,tsx}" });

    expect(result.files).toEqual(["src/a.ts", "src/b.tsx"]);
  });

  it("scopes the pattern to `path`", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "*.ts", path: "src" });

    expect(result.path).toBe("src");
    // Patterns are relative to `path`, so `*` matches directly inside it.
    expect(result.files).toEqual(["src/a.ts"]);
  });

  it("keeps results workspace-relative when scoped", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "**/*.ts", path: "src" });

    expect(result.path).toBe("src");
    expect(result.files).toEqual(["src/a.ts", "src/deep/c.ts", "src/deep/deeper/d.ts"]);
  });

  it("resolves `path` against the session cwd", async () => {
    const ctx = context(TREE, "src");

    const result = await globTool.execute(ctx, { pattern: "**/*.ts" });
    expect(result.path).toBe("src");
    expect(result.files).toEqual(["src/a.ts", "src/deep/c.ts", "src/deep/deeper/d.ts"]);
  });

  it("excludes hidden files by default and includes them on request", async () => {
    const ctx = context(TREE);

    const without = await globTool.execute(ctx, { pattern: "**/*" });
    expect(without.files).toEqual([
      "docs/guide.md",
      "index.ts",
      "src/a.ts",
      "src/b.tsx",
      "src/deep/c.ts",
      "src/deep/deeper/d.ts",
    ]);

    const withHidden = await globTool.execute(ctx, { pattern: "**/*", hidden: true });
    expect(withHidden.files).toContain(".env");
    expect(withHidden.files).toContain(".config/settings.json");
    // `.git` stays ignored even then: it is not a "hidden" entry, it is noise.
    expect(withHidden.files).not.toContain(".git/config");
  });

  it("skips node_modules, build output, lockfiles and binary files", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "**/*" });

    expect(result.files).not.toContain("node_modules/pkg/index.js");
    expect(result.files).not.toContain("dist/bundle.js");
    expect(result.files).not.toContain("pnpm-lock.yaml");
    expect(result.files).not.toContain("assets/logo.png");
  });

  it("honours the workspace .gitignore", async () => {
    const result = await globTool.execute(
      context({ ...TREE, ".gitignore": "docs/\n*.md\n" }),
      { pattern: "**/*" },
    );

    expect(result.files).not.toContain("docs/guide.md");
    expect(result.files).toContain("index.ts");
  });

  it("reports truncation and tells the model to narrow the pattern", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "**/*.ts", limit: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.hint).toMatch(/Narrow the pattern/);
    expect(result.hint).toContain("2 of 4");
  });

  it("returns a readable result instead of throwing when nothing matches", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "**/*.rs" });

    expect(result.files).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.hint).toMatch(/No file matches/);
  });

  it("sorts deterministically", async () => {
    const ctx = context(TREE);

    const first = await globTool.execute(ctx, { pattern: "**/*" });
    const second = await globTool.execute(ctx, { pattern: "**/*" });

    expect(first.files).toEqual(second.files);
    expect(first.files).toEqual([...first.files].sort((a, b) => a.localeCompare(b)));
  });

  it("refuses to escape the workspace root", async () => {
    await expect(
      globTool.execute(context(TREE), { pattern: "*", path: "../.." }),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  it("reports a missing or non-directory `path`", async () => {
    const ctx = context(TREE);

    await expect(globTool.execute(ctx, { pattern: "*", path: "nope" })).rejects.toThrow(
      /Directory not found/,
    );
    await expect(globTool.execute(ctx, { pattern: "*", path: "index.ts" })).rejects.toThrow(
      /Not a directory/,
    );
  });

  it("rejects an empty pattern through the schema", () => {
    expect(globTool.inputSchema.safeParse({ pattern: "" }).success).toBe(false);
    expect(globTool.inputSchema.safeParse({}).success).toBe(false);
    expect(globTool.inputSchema.safeParse({ pattern: "*" }).success).toBe(true);
  });

  it("is a read-only tool", () => {
    expect(globTool.access).toBe("read");
    expect(globTool.id).toBe("glob");
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    const ctx: ToolContext = { ...context(TREE), signal: controller.signal };
    controller.abort();

    const result = await globTool.execute(ctx, { pattern: "**/*" });
    expect(result.files).toEqual([]);
  });
});
