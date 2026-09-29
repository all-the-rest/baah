/**
 * CHARACTERISATION TESTS — `grep`'s input schema against the reference.
 *
 * Reference: opencode v2.0.19, fetched from
 *   https://raw.githubusercontent.com/sst/opencode/v2.0.19/packages/core/src/tool/plugin/grep.ts
 *   https://raw.githubusercontent.com/sst/opencode/v2.0.19/packages/core/src/ripgrep.ts
 *   https://raw.githubusercontent.com/sst/opencode/v2.0.19/packages/core/src/filesystem.ts
 * (the `packages/opencode/src/tool/` path in the brief does not exist at that
 * tag; `packages/core/…` is the real location at v2.0.19. It is not vendored in
 * node_modules, so the reference is inlined below verbatim.)
 *
 *   filesystem.ts:45  export const DEFAULT_SEARCH_LIMIT = 100
 *   filesystem.ts:46  export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000
 *   filesystem.ts:55  class GrepInput { pattern: String; path: optionalKey(RelativePath);
 *                                          include: optionalKey(String); literal: optionalKey(Boolean);
 *                                          caseSensitive: optionalKey(Boolean); limit: optionalKey(PositiveInt) }
 *   grep.ts:22        pattern: …check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
 *   ripgrep.ts:221    grep args: ["--no-config", "--json", "--hidden", "--no-messages", …]
 *
 * The `glob` half lives in `packages/baah-tools/glob/test/verify-schema.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_GREP_LIMIT, SEARCH_TIMEOUT_MS, grepInputSchema } from "../src/index.ts";

describe("parameter names and required/optional status match the reference", () => {
  it("grep: pattern required; path, include, literal, caseSensitive, limit optional", () => {
    expect(Object.keys(grepInputSchema.shape).sort()).toEqual([
      "caseSensitive",
      "include",
      "limit",
      "literal",
      "path",
      "pattern",
    ]);

    expect(grepInputSchema.safeParse({}).success).toBe(false);
    for (const value of [
      { path: "src" },
      { include: "*.ts" },
      { literal: true },
      { caseSensitive: false },
      { limit: 10 },
    ]) {
      expect(
        grepInputSchema.safeParse({ pattern: "x", ...value }).success,
        JSON.stringify(value),
      ).toBe(true);
    }
  });

  it("every parameter has the reference's type", () => {
    for (const [name, field] of Object.entries(grepInputSchema.shape)) {
      const def = (field as { _def: { type: string; innerType?: { _def: { type: string } } } })._def;
      const type = def.type === "optional" ? def.innerType?._def.type : def.type;
      if (name === "limit") {
        expect(type, name).toBe("number");
        continue;
      }
      expect(["string", "boolean"], name).toContain(type);
    }
  });
});

describe("defaults", () => {
  it("the default limit is 100, like DEFAULT_SEARCH_LIMIT", () => {
    expect(DEFAULT_GREP_LIMIT).toBe(100);
  });

  it("the default is applied in execute, not baked into the schema", () => {
    expect((grepInputSchema.shape.limit as { _def: { defaultValue?: unknown } })._def.defaultValue)
      .toBeUndefined();
  });

  it("ALIGNED: `limit` has no upper bound, like the reference's `PositiveInt`", () => {
    // Was: `.max(1000)`, an invention of this repo. A model asking for
    // `limit: 5000` got a hard validation error here and a result there.
    expect(grepInputSchema.safeParse({ pattern: "x", limit: 1001 }).success).toBe(true);
    expect(grepInputSchema.safeParse({ pattern: "x", limit: 5000 }).success).toBe(true);
    expect(grepInputSchema.safeParse({ pattern: "x", limit: 1_000_000 }).success).toBe(true);
    // The lower bound stays and is justified in the schema comment: a limit of
    // 0 is a no-op, not a question.
    expect(grepInputSchema.safeParse({ pattern: "x", limit: 0 }).success).toBe(false);
    expect(grepInputSchema.safeParse({ pattern: "x", limit: 1.5 }).success).toBe(false);
  });

  it("no `MAX_GREP_LIMIT` constant is exported any more", async () => {
    // A ceiling that nothing enforces is a dead abstraction (AGENTS.md §5).
    const exported = Object.keys(await import("../src/index.ts"));
    expect(exported).not.toContain("MAX_GREP_LIMIT");
  });
});

describe("validation the reference does not have", () => {
  it("`pattern` has min(1), which the reference also has", () => {
    expect(grepInputSchema.safeParse({ pattern: "" }).success).toBe(false);
  });

  it("ALIGNED: `include` has no min-length, the reference accepts an empty string", () => {
    // Was `.min(1)`, an invention of this repo. The reference types `include`
    // as a plain `Schema.String` and forwards it to `rg --glob=`, so the
    // schema no longer rejects it.
    expect(grepInputSchema.safeParse({ pattern: "x", include: "" }).success).toBe(true);
    expect(grepInputSchema.safeParse({ pattern: "x", include: "*" }).success).toBe(true);
    // Aligned at the schema, but not silently swallowed at execution: an
    // empty glob compiles to `^$`, which matches no path, so it is rejected
    // with a model-readable error instead of returning "no matches".
    // See verify-include.test.ts.
  });

  it("DIVERGENCE: `path` is a bare string; the reference types it as RelativePath", () => {
    // Ours defers the escape check to `assertInsideRoot` at execute time, so the
    // model sees a thrown ToolError where the reference would see a
    // schema-level validation failure.
    expect(grepInputSchema.safeParse({ pattern: "x", path: "../../etc" }).success).toBe(true);
    expect(grepInputSchema.safeParse({ pattern: "x", path: "/etc/passwd" }).success).toBe(true);
  });
});

describe("hidden files are searched, and there is still no `hidden` parameter", () => {
  it("ALIGNED: `grep` searches dotfiles without a parameter, like `--hidden`", async () => {
    // Reference ripgrep args (ripgrep.ts, `grep:`): `"--hidden"` is
    // unconditional — grep has no `hidden` flag in the reference schema either,
    // and none here. The functional gap was in the *filter*, not the schema:
    // `createIgnoreFilter(workspace)` defaulted `includeHidden` to false, so
    // `.github/workflows/*.yml` was unreachable. Now `includeHidden: true`.
    // Behaviour is asserted in verify-include.test.ts and grep.test.ts.
    const { grepTool } = await import("../src/index.ts");
    const { createMemoryWorkspace } = await import("@all-the.rest/baah-core");

    const result = await grepTool.execute(
      {
        workspace: createMemoryWorkspace({ ".github/workflows/ci.yml": "runs: on push\n" }),
        cwd: ".",
        signal: new AbortController().signal,
        approve: async () => "allow-once",
        emit: () => {},
        toolCallId: "verify-call",
        attempt: 1,
      },
      { pattern: "runs" },
    );

    expect(Object.keys(grepInputSchema.shape)).not.toContain("hidden");
    expect(result.matches.map((m) => m.path)).toEqual([".github/workflows/ci.yml"]);
  });
});

describe("the match timeout", () => {
  it("is 5 s, a deliberate deviation from the reference's 30 s", () => {
    // Reference: `Effect.timeoutOrElse({ duration: DEFAULT_SEARCH_TIMEOUT_MS,
    // … })` with 30 000 ms around a *native ripgrep process* in a server. Here
    // the scan is a synchronous, backtracking `RegExp.test` per line on the
    // browser main thread: 30 s of that is 30 s of frozen tab. The measured
    // worst legitimate scan (16 MiB of real source, 207 121 lines, through
    // `\w+\s*=\s*\w+;?$`) is 502 ms, so 5 s is an order of magnitude of
    // headroom over real work while still bounding the pathological case.
    // A cut is always reported — see verify-bounds.test.ts.
    expect(SEARCH_TIMEOUT_MS).toBe(5_000);
    // Not a schema parameter: the model does not get to raise its own bound.
    expect(Object.keys(grepInputSchema.shape)).not.toContain("timeoutMs");
    expect(grepInputSchema.safeParse({ pattern: "x" }).success).toBe(true);
  });
});
