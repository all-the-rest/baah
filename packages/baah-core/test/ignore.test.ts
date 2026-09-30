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

  it("survives an unreadable .gitignore and names the failure's class, not its text", async () => {
    /**
     * A real failure mode: `.gitignore` is a directory, or the handle is gone.
     *
     * **This title used to say "and reports why", and its body asserted
     * `toContain("permission denied")`** — i.e. it *required* the workspace's
     * own `Error.message` to be forwarded into `gitignoreError`, which is
     * interpolated into the `note` of a `glob`/`grep` result and therefore
     * reaches the model, the transcript row and the tool card. That is the same
     * assertion shape the storage-failure block inverted, in a different module:
     * a foreign text pinned as a feature.
     *
     * The fixture is a `DOMException`-shaped rejection rather than a bare
     * `Error` on purpose. A `DOMException`'s *name* is the diagnosis — the File
     * System Access API says `NotAllowedError`, `NotFoundError` or
     * `SecurityError` — and `src/workspace/errors.ts` says so in this package.
     * So the class-name rule loses no diagnosis here; it drops only the
     * browser's prose. `toBe` rather than `not.toContain`, for the reason every
     * other assertion in this area uses: a constant passes an absence test, and
     * a field choice does not.
     */
    const base = createMemoryWorkspace({ ".gitignore": "*.log\n", "debug.log": "x" });
    const thrown = new Error("permission denied: /Users/…/.gitignore") as Error & { name: string };
    thrown.name = "NotAllowedError";
    const workspace = {
      ...base,
      async readText(path: string) {
        if (path === ".gitignore") throw thrown;
        return base.readText(path);
      },
    };
    const isIgnored = await createIgnoreFilter(workspace);

    expect(isIgnored("debug.log")).toBe(false);
    expect(isIgnored.gitignoreApplied).toBe(false);
    expect(isIgnored.gitignoreError).toBe("could not read .gitignore: NotAllowedError");
    expect(isIgnored.gitignoreError).not.toContain("permission denied");
    // The hard-coded rules keep working.
    expect(isIgnored("node_modules/x.js")).toBe(true);
  });

  it("the unreadable-.gitignore assertion is not vacuous", async () => {
    /**
     * The self-check, and the reason it is not folded into the test above.
     *
     * Every assertion in this area is of the form "the foreign text is not
     * there", and that shape is satisfied by a workspace that throws nothing, by
     * a filter that stopped reporting, and by a fixture whose message was never
     * the one in the note. So the planted material is verified here: the thrown
     * value really does carry the sentence the old implementation composed, and
     * that composition really would have reached the field.
     *
     * `AGENTS.md` §6a: every gate needs a self-test with planted material. This
     * is not a gate, but the failure mode is the same one the rule is about.
     */
    const thrown = new Error("permission denied: /Users/…/.gitignore") as Error & { name: string };
    thrown.name = "NotAllowedError";
    const base = createMemoryWorkspace({ ".gitignore": "*.log\n" });
    const workspace = {
      ...base,
      async readText(path: string) {
        if (path === ".gitignore") throw thrown;
        return base.readText(path);
      },
    };
    const isIgnored = await createIgnoreFilter(workspace);

    // What the implementation used to return, verbatim.
    expect(`could not read .gitignore: ${thrown.message}`).toContain("permission denied");
    // And the field really is populated, so the assertion above had something
    // to rule out.
    expect(isIgnored.gitignoreError).toBeDefined();
    expect(isIgnored.gitignoreError).not.toContain("permission denied");
  });

  it("a thrown non-Error is described by its shape, never by String(value)", async () => {
    /**
     * The second branch of the removed ternary, and the second path rather than
     * a repeat of the first: `String(value)` is the same leak with one fewer
     * ceremony, because the thrown value *is* the foreign text.
     *
     * A workspace implementation that rejects with a bare string is broken in a
     * way worth naming, and the name must not vary with what it threw — so this
     * is the pair the storage-failure block pinned, on a different seam.
     */
    const base = createMemoryWorkspace({ ".gitignore": "*.log\n", "debug.log": "x" });
    const workspace = {
      ...base,
      async readText(path: string) {
        if (path === ".gitignore") throw "the handle vanished mid-read";
        return base.readText(path);
      },
    };
    const isIgnored = await createIgnoreFilter(workspace);

    expect(isIgnored.gitignoreApplied).toBe(false);
    expect(isIgnored.gitignoreError).toBe("could not read .gitignore: non-Error value");
    expect(isIgnored.gitignoreError).not.toContain("the handle vanished mid-read");
  });

  it("an Error with an empty name still describes itself", async () => {
    /**
     * The degenerate case, and the reason the fallback exists: an empty class
     * name composes a sentence with a hole in it (`could not read .gitignore: `),
     * which no reader can tell apart from "no note arrived at all".
     *
     * Which case this is, stated so the next reader does not have to guess: a
     * subclass with **no** `name` of its own is *not* this case — it inherits
     * `Error.prototype.name`, so it already reads `"Error"`. `new Error("")` is
     * not this case either; its *message* is empty, its name is `"Error"`. The
     * case is an `Error` whose `name` was overwritten with the empty string,
     * which nothing in this repository does and a foreign `Workspace` might.
     */
    const base = createMemoryWorkspace({ ".gitignore": "*.log\n" });
    const nameless = new Error("permission denied");
    nameless.name = "";
    const workspace = {
      ...base,
      async readText(path: string) {
        if (path === ".gitignore") throw nameless;
        return base.readText(path);
      },
    };
    const isIgnored = await createIgnoreFilter(workspace);

    expect(isIgnored.gitignoreError).toBe("could not read .gitignore: Error");
  });

  it("a subclass with no name of its own keeps the name it inherits", async () => {
    // The case the test above says it is *not*, pinned as a fact rather than
    // left as a claim in a comment. Every `class X extends Error {}` in this
    // program is this shape, and it is what a second implementation of the
    // `Workspace` seam would most likely throw.
    class HandleGone extends Error {}
    const base = createMemoryWorkspace({ ".gitignore": "*.log\n" });
    const workspace = {
      ...base,
      async readText(path: string) {
        if (path === ".gitignore") throw new HandleGone("permission denied");
        return base.readText(path);
      },
    };
    const isIgnored = await createIgnoreFilter(workspace);

    expect(new HandleGone("x").name).toBe("Error");
    expect(isIgnored.gitignoreError).toBe("could not read .gitignore: Error");
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
