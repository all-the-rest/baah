/**
 * CHARACTERISATION TESTS — `glob`'s input schema against the reference.
 *
 * Reference: opencode v2.0.19, fetched from
 *   https://raw.githubusercontent.com/sst/opencode/v2.0.19/packages/core/src/tool/plugin/glob.ts
 *   https://raw.githubusercontent.com/sst/opencode/v2.0.19/packages/core/src/filesystem.ts
 * (the `packages/opencode/src/tool/` path in the brief does not exist at that
 * tag; `packages/core/…` is the real location at v2.0.19. It is not vendored in
 * node_modules, so the reference is inlined below verbatim.)
 *
 *   filesystem.ts:45  export const DEFAULT_SEARCH_LIMIT = 100
 *   filesystem.ts:46  export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000
 *   filesystem.ts:48  class GlobInput { pattern: String; path: optionalKey(RelativePath);
 *                                          hidden: optionalKey(Boolean); limit: optionalKey(PositiveInt) }
 *   glob.ts:21        pattern: GlobInput.fields.pattern  (NO min-length check)
 *
 * The `grep` half of the schema comparison lives in
 * `packages/baah-tools/grep/test/verify-schema.test.ts`; it is split across the
 * two packages so neither test file has to import the other's `src/`.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_GLOB_LIMIT, globInputSchema } from "../src/index.ts";
import { DEFAULT_MAX_ENTRIES } from "@all-the.rest/baah-core";

describe("parameter names and required/optional status match the reference", () => {
  it("glob: pattern required; path, hidden, limit optional", () => {
    expect(Object.keys(globInputSchema.shape).sort()).toEqual([
      "hidden",
      "limit",
      "path",
      "pattern",
    ]);

    expect(globInputSchema.safeParse({}).success).toBe(false);
    expect(globInputSchema.safeParse({ pattern: "*" }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*", path: "src" }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*", hidden: true }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*", limit: 10 }).success).toBe(true);
  });

  it("every parameter has the reference's type", () => {
    for (const [name, field] of Object.entries(globInputSchema.shape)) {
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
    expect(DEFAULT_GLOB_LIMIT).toBe(100);
  });

  it("the default is applied in execute, not baked into the schema", () => {
    // `.optional()` with no `.default()` — correct, because the tool must see
    // "absent" to tell `undefined` from an explicit value.
    expect((globInputSchema.shape.limit as { _def: { defaultValue?: unknown } })._def.defaultValue)
      .toBeUndefined();
  });

  it("ALIGNED: `limit` has no upper bound, like the reference's `PositiveInt`", () => {
    // Was: `.max(1000)`, an invention of this repo with no counterpart in the
    // reference. A model asking for `limit: 5000` got a hard validation error
    // here and a result there. The cap is gone; the bounds that actually limit
    // the work are the walk's entry cap and `limit` itself.
    expect(globInputSchema.safeParse({ pattern: "*", limit: 1001 }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*", limit: 5000 }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*", limit: 1_000_000 }).success).toBe(true);
    // The lower bound stays, and it is justified in the schema comment: a limit
    // of 0 is not a question, it is a no-op.
    expect(globInputSchema.safeParse({ pattern: "*", limit: 0 }).success).toBe(false);
    expect(globInputSchema.safeParse({ pattern: "*", limit: 1.5 }).success).toBe(false);
  });

  it("no `MAX_GLOB_LIMIT` constant is exported any more", async () => {
    // A ceiling that nothing enforces is a dead abstraction (AGENTS.md §5).
    const exported = Object.keys(await import("../src/index.ts"));
    expect(exported).not.toContain("MAX_GLOB_LIMIT");
  });
});

describe("validation the reference does not have", () => {
  it("DELIBERATE DIVERGENCE: `pattern` has min(1), the reference has no length check", () => {
    // glob.ts annotates the field but adds no `isMinLength`. Kept anyway: an
    // empty glob matches every file under `path`, so it is a user error rather
    // than a query, and returning the whole tree is not a useful answer. The
    // reason is recorded at the `.min(1)` in `src/index.ts` so the next reader
    // does not "fix" it back — this test is here to make that decision visible
    // rather than accidental.
    expect(globInputSchema.safeParse({ pattern: "" }).success).toBe(false);
  });

  it("DIVERGENCE: `path` is a bare string; the reference types it as RelativePath", () => {
    // Ours defers the escape check to `assertInsideRoot` at execute time, so the
    // model sees a thrown ToolError where the reference would see a
    // schema-level validation failure.
    expect(globInputSchema.safeParse({ pattern: "*", path: "../../etc" }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*", path: "/etc/passwd" }).success).toBe(true);
  });
});

describe("the walk is bounded, but not by a wall clock", () => {
  it("DIVERGENCE: the reference wraps its search in a 30 s timeout; this has none", () => {
    // The reference: `Effect.timeoutOrElse({ duration: DEFAULT_SEARCH_TIMEOUT_MS,
    // … })` around `ripgrep.glob`. Here there is no timeout, and the
    // justification is that there is nothing to time out: the walk is async and
    // yields between entries, so unlike `grep`'s synchronous regex scan it
    // cannot block the main thread in one step. It is bounded instead by
    // the walk's own entry cap and by `signal` — both covered in
    // verify-walk-cap.test.ts and glob.test.ts. A directory-handle walk that
    // stalls on a single slow `values()` is the case this leaves open.
    expect(globInputSchema.safeParse({ pattern: "*" }).success).toBe(true);
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0);
  });
});
