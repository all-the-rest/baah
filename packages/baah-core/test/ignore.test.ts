import { createMemoryWorkspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { createIgnoreFilter, DEFAULT_IGNORE_RULES, isHiddenPath } from "../src/ignore.ts";

async function filter(
  files: Record<string, string>,
  options?: Parameters<typeof createIgnoreFilter>[1],
) {
  return createIgnoreFilter(createMemoryWorkspace(files), options);
}

describe("createIgnoreFilter", () => {
  it("ignores dependency trees, build output and lockfiles by default", async () => {
    const isIgnored = await filter({
      "node_modules/pkg/index.js": "x",
      "dist/bundle.js": "x",
      "build/out.js": "x",
      ".next/server.js": "x",
      "coverage/lcov.info": "x",
      "pnpm-lock.yaml": "x",
      "package-lock.json": "x",
      "src/index.ts": "x",
    });

    expect(isIgnored("node_modules/pkg/index.js")).toBe(true);
    expect(isIgnored("node_modules", "directory")).toBe(true);
    expect(isIgnored("dist/bundle.js")).toBe(true);
    expect(isIgnored("dist", "directory")).toBe(true);
    expect(isIgnored("build/out.js")).toBe(true);
    expect(isIgnored(".next/server.js")).toBe(true);
    expect(isIgnored("coverage/lcov.info")).toBe(true);
    expect(isIgnored("pnpm-lock.yaml")).toBe(true);
    expect(isIgnored("package-lock.json")).toBe(true);
    // Nested occurrences count too.
    expect(isIgnored("packages/app/node_modules/x.js")).toBe(true);
    // Real sources stay.
    expect(isIgnored("src/index.ts")).toBe(false);
    expect(isIgnored("README.md")).toBe(false);
  });

  it("ignores common binary extensions anywhere in the tree", async () => {
    const isIgnored = await filter({ "a.png": "x" });

    for (const name of [
      "logo.png",
      "logo.jpg",
      "logo.jpeg",
      "logo.gif",
      "logo.webp",
      "favicon.ico",
      "docs.pdf",
      "out.zip",
      "out.gz",
      "out.tar",
      "font.woff",
      "font.woff2",
      "font.ttf",
      "font.eot",
      "clip.mp4",
      "clip.mov",
    ]) {
      expect(isIgnored(name), name).toBe(true);
      expect(isIgnored(`assets/icons/${name}`), name).toBe(true);
    }
    expect(isIgnored("src/png.ts")).toBe(false);
  });

  it("does not apply a `dir/` rule to a file of the same name", async () => {
    const isIgnored = await filter({ "build": "a file called build\n" });

    expect(isIgnored("build", "file")).toBe(false);
    expect(isIgnored("build", "directory")).toBe(true);
    // Unknown kind: both spellings are probed, so a walk prunes the subtree.
    expect(isIgnored("build")).toBe(true);
  });

  it("honours the workspace .gitignore", async () => {
    const isIgnored = await filter({
      ".gitignore": "secret-notes.md\ntmp/\n",
      "secret-notes.md": "x",
      "tmp/scratch.ts": "x",
      "keep.ts": "x",
    });

    expect(isIgnored("secret-notes.md")).toBe(true);
    expect(isIgnored("tmp/scratch.ts")).toBe(true);
    expect(isIgnored("tmp", "directory")).toBe(true);
    expect(isIgnored("keep.ts")).toBe(false);
  });

  it("supports negation rules in .gitignore", async () => {
    const isIgnored = await filter({
      ".gitignore": "*.log\n!keep.log\n",
      "debug.log": "x",
      "keep.log": "x",
      "logs/nested.log": "x",
      "logs/nested-keep.log": "x",
    });

    expect(isIgnored("debug.log")).toBe(true);
    expect(isIgnored("keep.log")).toBe(false);
    expect(isIgnored("logs/nested.log")).toBe(true);
  });

  it("keeps the default rules as a floor the .gitignore cannot lift", async () => {
    const isIgnored = await filter({
      ".gitignore": "!node_modules\n!*.png\n",
      "node_modules/pkg/index.js": "x",
      "logo.png": "x",
    });

    expect(isIgnored("node_modules/pkg/index.js")).toBe(true);
    expect(isIgnored("logo.png")).toBe(true);
  });

  it("can be told to ignore the .gitignore entirely", async () => {
    const isIgnored = await filter(
      { ".gitignore": "*.log\n", "debug.log": "x" },
      { respectGitignore: false },
    );

    expect(isIgnored("debug.log")).toBe(false);
  });

  it("excludes hidden files and directories by default", async () => {
    const isIgnored = await filter({ ".env": "SECRET=1\n", ".github/workflows/ci.yml": "x" });

    expect(isIgnored(".env")).toBe(true);
    expect(isIgnored(".github/workflows/ci.yml")).toBe(true);
    expect(isIgnored(".github", "directory")).toBe(true);
    expect(isIgnored("src/index.ts")).toBe(false);
    // A dot inside a name is not a hidden segment.
    expect(isIgnored("src/index.test.ts")).toBe(false);
  });

  it("includes hidden entries on request", async () => {
    const isIgnored = await filter(
      { ".env": "SECRET=1\n", ".github/workflows/ci.yml": "x" },
      { includeHidden: true },
    );

    expect(isIgnored(".env")).toBe(false);
    expect(isIgnored(".github/workflows/ci.yml")).toBe(false);
  });

  it("survives a missing .gitignore", async () => {
    const isIgnored = await filter({ "src/index.ts": "x" });

    expect(isIgnored("src/index.ts")).toBe(false);
    expect(isIgnored.gitignoreApplied).toBe(false);
    expect(isIgnored.gitignoreError).toBeUndefined();
  });

  it("survives an unreadable .gitignore and reports why", async () => {
    // A real failure mode: `.gitignore` is a directory, or the handle is gone.
    const base = createMemoryWorkspace({ ".gitignore": "*.log\n", "debug.log": "x" });
    const workspace = {
      ...base,
      async readText(path: string) {
        if (path === ".gitignore") throw new Error("permission denied");
        return base.readText(path);
      },
    };
    const isIgnored = await createIgnoreFilter(workspace);

    expect(isIgnored("debug.log")).toBe(false);
    expect(isIgnored.gitignoreApplied).toBe(false);
    expect(isIgnored.gitignoreError).toContain("permission denied");
    // The hard-coded rules keep working.
    expect(isIgnored("node_modules/x.js")).toBe(true);
  });

  it("applies a weird but parseable .gitignore without throwing", async () => {
    // `ignore@7.0.10` accepts these; the point is that no input throws.
    const isIgnored = await filter({
      ".gitignore": "![\n\\a\na\\0000b\n",
      "weird.md": "x",
    });

    expect(isIgnored("weird.md")).toBe(false);
  });

  it("never throws on odd input paths", async () => {
    const isIgnored = await filter({ "src/index.ts": "x" });

    expect(isIgnored(".")).toBe(false);
    expect(isIgnored("")).toBe(false);
    expect(isIgnored("/")).toBe(false);
    expect(isIgnored("./src/index.ts")).toBe(false);
    expect(isIgnored("/src/index.ts")).toBe(false);
    expect(isIgnored("src//./index.ts")).toBe(false);
    // Outside the workspace.
    expect(isIgnored("../secrets")).toBe(true);
    expect(isIgnored("../../etc/passwd")).toBe(true);
  });

  it("exposes the default rule set in gitignore syntax", () => {
    expect(DEFAULT_IGNORE_RULES).toContain("node_modules/");
    expect(DEFAULT_IGNORE_RULES).toContain("*.png");
    expect(DEFAULT_IGNORE_RULES).toContain("pnpm-lock.yaml");
  });

  it("detects hidden segments", () => {
    expect(isHiddenPath(".env")).toBe(true);
    expect(isHiddenPath("a/.b/c")).toBe(true);
    expect(isHiddenPath("a/b")).toBe(false);
    expect(isHiddenPath("a.b/c")).toBe(false);
  });
});
