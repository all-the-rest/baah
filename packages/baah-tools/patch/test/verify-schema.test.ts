/**
 * `patch` — the contract, pinned.
 *
 * The design decision this file exists to defend: **hunks match on text, never
 * on line numbers.** The decision is argued in the module comment of
 * `src/index.ts`; what is pinned here is the observable consequence, so that a
 * later "let us also accept a line number" cannot be slipped in as a convenience
 * without a test failing.
 */
import { describe, expect, it } from "vitest";

import { patchHunkSchema, patchInputSchema, patchTool } from "../src/index.ts";

describe("the input schema", () => {
  it("has exactly `path` and `hunks`", () => {
    expect(Object.keys(patchInputSchema.shape).sort()).toEqual(["hunks", "path"]);
  });

  it("a hunk has exactly `before` and `after`", () => {
    expect(Object.keys(patchHunkSchema.shape).sort()).toEqual(["after", "before"]);
  });

  it("has no parameter for a line number, a line range or a regex", () => {
    // The refusal to match by position is the whole reason this tool is not a
    // corruption vector. If any of these ever appears in the schema, the
    // argument in `src/index.ts` has been overruled and this test says so.
    const forbidden = ["startLine", "line", "lines", "start", "end", "range", "pattern", "regex", "mode", "fuzz"];
    for (const name of Object.keys(patchInputSchema.shape)) expect(forbidden).not.toContain(name);
    for (const name of Object.keys(patchHunkSchema.shape)) expect(forbidden).not.toContain(name);
  });

  it("strips a line-number-ish key a model invents rather than acting on it", () => {
    const parsed = patchInputSchema.safeParse({
      path: "a.txt",
      startLine: 12,
      hunks: [{ before: "x", after: "y", line: 3 }],
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {})).toEqual(["path", "hunks"]);
    const hunks = (parsed.data as { hunks: Record<string, unknown>[] }).hunks;
    expect(Object.keys(hunks[0] ?? {})).toEqual(["before", "after"]);
  });

  it("`before` may not be empty — an unanchored insert has no honest match", () => {
    expect(patchHunkSchema.safeParse({ before: "", after: "x" }).success).toBe(false);
    expect(patchHunkSchema.safeParse({ before: "x", after: "" }).success).toBe(true);
  });

  it("an empty hunk list is refused by the schema", () => {
    expect(patchInputSchema.safeParse({ path: "a.txt", hunks: [] }).success).toBe(false);
  });

  it("`path` may not be empty", () => {
    expect(patchInputSchema.safeParse({ path: "", hunks: [{ before: "a", after: "b" }] }).success).toBe(
      false,
    );
  });

  it("there is no per-hunk replaceAll: ambiguity is always an error", () => {
    const parsed = patchHunkSchema.safeParse({ before: "x", after: "y", replaceAll: true });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {})).toEqual(["before", "after"]);
  });
});

describe("the tool", () => {
  it("is a write tool, so it is gated", () => {
    expect(patchTool.access).toBe("write");
    expect(patchTool.id).toBe("patch");
  });

  it("tells the model, in the description, to match on text and not to compute line numbers", () => {
    expect(patchTool.description).toMatch(/never on line numbers/);
    expect(patchTool.description).toMatch(/do not compute one/);
  });

  it("promises atomicity in the description, because the tests prove it", () => {
    expect(patchTool.description).toMatch(/All or nothing/);
    expect(patchTool.description).toMatch(/left exactly as it was/);
  });

  it("names the hunk in its errors, and points at the neighbouring tools", () => {
    expect(patchTool.description).toMatch(/error names the hunk/);
    expect(patchTool.description).toMatch(/Use `edit` for a single replacement/);
  });
});
