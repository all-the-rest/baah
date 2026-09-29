/**
 * CHARACTERISATION TESTS — the hand-written `include` glob converter.
 *
 * `grep` does not depend on picomatch, so `src/index.ts` contains
 * `globToSource` / `buildIncludeMatcher`. picomatch@4.0.7 *is* installed (the
 * `glob` tool uses it), so the supported subset is asserted against the real
 * picomatch rather than against a guess. The reference implementation
 * (opencode v2.0.19, `packages/core/src/ripgrep.ts`) forwards `include`
 * straight to `rg --glob=<include>`, i.e. ripgrep's full globset syntax —
 * including `!` negation, extglobs and POSIX classes.
 */
import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";
// Ground-truth oracle only. picomatch is a dependency of the sibling `glob`
// package, not of this one, so it is reached by relative path.
import picomatch from "../../glob/node_modules/picomatch/index.js";

import { grepInputSchema, grepTool } from "../src/index.ts";

/** Every path in the corpus, at several depths. */
const PATHS = [
  "a.ts",
  "x.ts",
  "README.md",
  "src/a.ts",
  "src/b.tsx",
  "src/nested/b.ts",
  "src/nested/b.test.ts",
  "src/nested/deep/c.ts",
  "a/b",
  "a/x/b",
  "x/b",
  // A file name that is not a valid pattern, to prove it is not treated as one.
  "a+b.ts",
] as const;

const FILES: Record<string, string> = Object.fromEntries(PATHS.map((p) => [p, "hit\n"]));

function context(): ToolContext {
  return {
    workspace: createMemoryWorkspace(FILES),
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

/** What picomatch says, including the basename fallback `grep` also applies. */
function picomatchVerdict(pattern: string): string[] {
  return picomatchVerdictFor(PATHS, pattern);
}

function picomatchVerdictFor(paths: readonly string[], pattern: string): string[] {
  const isMatch = picomatch(pattern, { dot: false, posixSlashes: true });
  return paths.filter((p) => isMatch(p) || isMatch(p.slice(p.lastIndexOf("/") + 1))).sort();
}

async function grepVerdict(pattern: string): Promise<string[]> {
  const result = await grepTool.execute(context(), { pattern: "hit", include: pattern });
  return result.matches.map((m) => m.path).sort();
}

describe("include converter agrees with picomatch on the documented subset", () => {
  const SUPPORTED = [
    // `**` at the start, at the end, and bare in the middle
    "**/*.ts",
    "**/b.ts",
    "src/**",
    "a/**/b",
    "a/*/b",
    "**",
    "**/*",
    // `*` vs `**` across separators
    "*.ts",
    "src/*",
    "**/*.test.ts",
    "src/**/*.ts",
    "src/**/b.ts",
    "**/nested/**",
    // `?`, classes, braces
    "?rc/a.ts",
    "[ab].ts",
    "src/[ab]*",
    "*.{ts,tsx}",
    "{src,x}/*.ts",
    // a path with no wildcard, a leading `/`, a trailing `/`, no match at all
    "src/a.ts",
    "/src/a.ts",
    "src/",
    "nomatch",
    // a metacharacter that is a literal in a file name
    "a+b.ts",
  ];

  it.each(SUPPORTED)("%s", async (pattern) => {
    expect(await grepVerdict(pattern)).toEqual(picomatchVerdict(pattern));
  });
});

describe("unsupported syntax is rejected, not silently swallowed", () => {
  // All of these used to return an empty result — indistinguishable from "no
  // file matches", which is the one answer a model must never get wrong. The
  // scope of the converter was never the problem; the silence was.
  it.each([
    // `!` is negation in picomatch and in ripgrep's globset. `grep` used to
    // escape it as a literal, so the query inverted from "everything except"
    // to "only".
    "!a.ts",
    "!*.ts",
    // extglobs: picomatch and ripgrep both support them.
    "@(a|x).ts",
    "+(a|x).ts",
    "?(a|x).ts",
    "*(a).ts",
    "!(a|x).ts",
    // POSIX bracket classes.
    "[[:alpha:]].ts",
  ])("%s is rejected with an error naming the syntax", async (pattern) => {
    // picomatch does match files with these patterns …
    expect(picomatchVerdict(pattern).length).toBeGreaterThan(0);

    // … `grep` refuses, so the model is told instead of receiving "no matches".
    await expect(grepTool.execute(context(), { pattern: "hit", include: pattern })).rejects.toThrow(
      /does not support/,
    );
  });

  it("the error names what IS supported, so the model can rewrite the pattern", async () => {
    const error = await grepTool
      .execute(context(), { pattern: "hit", include: "@(a|x).ts" })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/extglob/);
    expect(message).toMatch(/POSIX/);
    expect(message).toMatch(/negation/);
    // The remedy has to be actionable, not just a refusal.
    expect(message).toMatch(/\*\.\{ts,tsx\}/);
  });

  it("an empty `include` is rejected rather than compiling to a regex that matches nothing", async () => {
    // The schema allows it (aligned with the reference's plain `String`); the
    // converter would turn `""` into `^$`, which matches no path. That is the
    // silent-empty-result defect wearing a different hat.
    expect(grepInputSchema.safeParse({ pattern: "hit", include: "" }).success).toBe(true);

    await expect(
      grepTool.execute(context(), { pattern: "hit", include: "" }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("omitting `include` is still the way to search every file", async () => {
    const result = await grepTool.execute(context(), { pattern: "hit" });
    expect(result.matches).toHaveLength(PATHS.length);
  });
});

describe("converter divergences that are fixed, not rejected", () => {
  it("a brace group with no comma is the literal text, like picomatch", async () => {
    // picomatch reads `{a}` as the literal "{a}". The converter used to drop the
    // braces and match "a" — a false positive in the *opposite* direction.
    const result = await grepTool.execute(context(), { pattern: "hit", include: "{a}.ts" });

    expect(result.matches).toEqual([]);
    expect(picomatchVerdict("{a}.ts")).toEqual([]);
  });

  it("a backslash escape is an escape, like picomatch", async () => {
    // `a\*b.ts` means the literal name "a*b.ts" in picomatch and in ripgrep's
    // globset. The converter used to escape the backslash and then treat `*` as
    // a wildcard, so the pattern was `a\\[^/]*b\.ts` — matchable only by a file
    // name that literally contains a backslash.
    const withStar: ToolContext = {
      ...context(),
      workspace: createMemoryWorkspace({ "a*b.ts": "hit\n", "aXb.ts": "hit\n" }),
    };

    const result = await grepTool.execute(withStar, { pattern: "hit", include: "a\\*b.ts" });

    expect(result.matches.map((m) => m.path)).toEqual(["a*b.ts"]);
    expect(picomatch("a\\*b.ts")("a*b.ts")).toBe(true);
  });

  it("a trailing backslash is a literal backslash, like picomatch", async () => {
    // `a\` in picomatch matches the file name `a\` and nothing else. The
    // converter must not throw and must not silently match a different name.
    const withBackslash: ToolContext = {
      ...context(),
      workspace: createMemoryWorkspace({ "a\\": "hit\n", "a\\b": "hit\n", "a.ts": "hit\n" }),
    };

    const result = await grepTool.execute(withBackslash, { pattern: "hit", include: "a\\" });

    expect(result.matches.map((m) => m.path)).toEqual(["a\\"]);
    expect(picomatchVerdictFor(["a\\", "a\\b", "a.ts"], "a\\")).toEqual(["a\\"]);
  });
});

describe("the model is told which glob syntax is supported", () => {
  it("the `include` description names the supported subset and the rejections", () => {
    // The only model-facing description of `include` is the schema `.describe`
    // text. It used to advertise `*.{ts,tsx}` and name no limitation, so a
    // model had no way to know that extglobs, `!` and POSIX classes returned
    // nothing.
    const described = String(grepInputSchema.shape.include.description ?? "");
    expect(described).toMatch(/\*\.\{ts,tsx\}/);
    expect(described).toMatch(/extglob/);
    expect(described).toMatch(/negation/);
    expect(described).toMatch(/POSIX/);
    expect(described).toMatch(/rejected/);
  });
});
