import { createMemoryWorkspace, type ToolContext, type Workspace } from "@all-the.rest/baah-core";
import { describe, expect, it, vi } from "vitest";

import { globTool } from "../src/index.ts";

function context(files: Record<string, string>, cwd = "."): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd,
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
    // `ToolContext` carries replay bookkeeping (baah-core grew it while this
    // package was being written); no search tool reads either field.
    toolCallId: "test-call",
    attempt: 1,
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
    // `truncated` is about `limit`; the search itself looked at everything.
    expect(result.searchTruncated).toBe(false);
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

  it("walks in directory order, not workspace order, and sorts what it returns", async () => {
    // The workspace enumerates in insertion order, which is not a contract
    // (`createMemoryWorkspace` sorts, a `FileSystemDirectoryHandle` does not).
    // The tool must produce the same list either way, and it must be sorted.
    const insertionOrdered: Record<string, string> = {
      "z/last.ts": "x\n",
      "a/first.ts": "x\n",
      "m/middle.ts": "x\n",
    };
    const shuffled: Record<string, string> = {
      "m/middle.ts": "x\n",
      "z/last.ts": "x\n",
      "a/first.ts": "x\n",
    };

    const one = await globTool.execute(context(insertionOrdered), { pattern: "**/*.ts" });
    const two = await globTool.execute(context(shuffled), { pattern: "**/*.ts" });

    expect(one.files).toEqual(["a/first.ts", "m/middle.ts", "z/last.ts"]);
    expect(two.files).toEqual(one.files);
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

  it("declares itself read-only, and the permission layer believes it", () => {
    expect(globTool.access).toBe("read");
    // Not a restatement of the literal: a read tool must run without an
    // approval request. `read` is what `PermissionEngine` keys off.
    const controller = new AbortController();
    const approve = vi.fn(async () => "deny" as const);
    const ctx: ToolContext = { ...context(TREE), approve, signal: controller.signal };

    const gate = async () => {
      const result = await globTool.execute(ctx, { pattern: "**/*.ts" });
      return result;
    };

    // The tool never calls `approve`; the assertion is that a denying approver
    // cannot make the tool fail, i.e. nothing in the read path is gated.
    return gate().then((result) => {
      expect(approve).not.toHaveBeenCalled();
      expect(result.files).toContain("src/a.ts");
    });
  });

  it("stops when the abort signal fires, and says the result is partial", async () => {
    const controller = new AbortController();
    const ctx: ToolContext = { ...context(TREE), signal: controller.signal };
    controller.abort();

    const result = await globTool.execute(ctx, { pattern: "**/*" });
    expect(result.files).toEqual([]);
    expect(result.total).toBe(0);
    // An aborted walk visited nothing. Reporting `total: 0` without this flag
    // would claim "the workspace has no matching files".
    expect(result.searchTruncated).toBe(true);
    // The flag alone is not enough: the model also has to be told *why*, and
    // `note` is the only field that carries the reason. A truncation flag with
    // no explanation is a flag the model learns to skim.
    expect(result.note).toMatch(/aborted/i);
    expect(result.hint).toMatch(/not a complete answer/);
  });

  it("an abort that lands mid-walk is reported, not just one that precedes it", async () => {
    // A signal that is already aborted on entry is the easy case. This one
    // fires after the third entry, so the walk yields a few matches and then
    // stops — the result is non-empty *and* partial, and the flag is the only
    // thing that says so. Without it the model reads `total: 3` as the number
    // of matching files in the workspace.
    const controller = new AbortController();
    const tree: Record<string, string> = {
      "a.ts": "x\n",
      "b.ts": "x\n",
      "c.ts": "x\n",
      "d.ts": "x\n",
      "e.ts": "x\n",
    };
    const base = createMemoryWorkspace(tree);
    let seen = 0;
    const workspace: Workspace = {
      ...base,
      walk(directory = ".", options = {}) {
        const inner = base.walk(directory, options);
        return {
          entries: {
            async *[Symbol.asyncIterator]() {
              for await (const entry of inner.entries) {
                seen += 1;
                if (seen === 3) controller.abort();
                yield entry;
              }
            },
          },
          get truncated() {
            return inner.truncated;
          },
          get visited() {
            return inner.visited;
          },
        };
      },
    };

    const result = await globTool.execute(
      { ...context(tree), workspace, signal: controller.signal },
      { pattern: "**/*.ts" },
    );

    expect(seen).toBeGreaterThanOrEqual(3);
    expect(result.total).toBeLessThan(5);
    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/entry cap|complete answer/);
    expect(result.note).toMatch(/aborted/i);
  });

  it("the walk-cap truncation is explained, not just flagged", async () => {
    // The `note` names the cap and its size, so a model reading a partial
    // result knows the ceiling it hit and can search a subtree instead of
    // re-running the same glob.
    const result = await globTool.execute(context(TREE), { pattern: "**/*", limit: 1 });

    expect(result.searchTruncated).toBe(false);
    expect(result.hint).not.toMatch(/complete answer/);

    // Now the same tool over a tree that is past the cap.
    const big: Record<string, string> = {};
    for (let index = 0; index < 50_001; index += 1) {
      big[`f${String(index).padStart(5, "0")}.ts`] = "x\n";
    }
    const capped = await globTool.execute(context(big), { pattern: "**/*.ts", limit: 1 });

    expect(capped.searchTruncated).toBe(true);
    expect(capped.note).toMatch(/50000/);
    expect(capped.hint).toMatch(/not a complete answer/);
    // `note` and `hint` must not contradict each other: one says an abort, the
    // other blames the cap, and the model has no way to pick between them.
    expect(capped.note).not.toMatch(/aborted/i);
  });

  it("reports searchTruncated: false for a complete search", async () => {
    const result = await globTool.execute(context(TREE), { pattern: "**/*" });
    expect(result.searchTruncated).toBe(false);
  });
});
