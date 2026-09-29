/**
 * The walk cap in `glob`.
 *
 * `Workspace.walk` stops after 50 000 visited entries
 * (`DEFAULT_MAX_ENTRIES` in packages/baah-core/src/workspace.ts:214 and
 * workspace/directory-workspace.ts:77). Neither search tool passes
 * `maxEntries` and neither can *observe* that the walk ended early — the flag
 * does not exist on the `AsyncIterable`.
 *
 * For `grep` this was a correctness bug: a match in the never-visited tail made
 * the tool report "No line matches" with `searchTruncated: false`
 * (see ../grep/test/verify-limits.test.ts). For `glob` the damage was milder
 * but still real — `total` counted *visited* matches and was presented as the
 * number of matches.
 *
 * Both tools now apply a **stopgap**: they count the entries the walk yields
 * and treat reaching `WALK_ENTRY_LIMIT` as "possibly incomplete". The tests
 * below pin that behaviour, including its conservative edge (a tree of exactly
 * `WALK_ENTRY_LIMIT` entries is flagged even though its walk finished). The
 * real fix is a truncation flag on `Workspace.walk` itself; that is a change in
 * `baah-core` and is scheduled separately.
 */
import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { WALK_ENTRY_LIMIT, globTool } from "../src/index.ts";

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

const OVER_CAP: Record<string, string> = (() => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 50_050; index += 1) {
    files[`f${String(index).padStart(5, "0")}.ts`] = "x\n";
  }
  // Sorts last, so it is only reachable if the walk is not cut short.
  files["zzz-tail.ts"] = "x\n";
  return files;
})();

describe("glob walk cap", () => {
  it("FIXED: the walk cap is reported, so `total` is not presented as the whole tree", async () => {
    const result = await globTool.execute(context(OVER_CAP), {
      pattern: "**/*.ts",
      limit: 1000,
    });

    // 50 050 files exist. Only 50 000 were visited, and `total` still counts
    // only what was visited — but now the result says so instead of claiming
    // to be the workspace's whole content.
    expect(result.total).toBe(50_000);
    expect(result.files).toHaveLength(1000);
    expect(result.files).not.toContain("zzz-tail.ts");
    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/entry cap/);
    expect(result.hint).toMatch(/not a complete answer/);
  });

  it("a tree exactly at the cap is reported as possibly-incomplete (conservative)", async () => {
    // The stopgap counts entries, because `Workspace.walk` cannot report that
    // it stopped early. A workspace with *exactly* WALK_ENTRY_LIMIT entries is
    // therefore flagged even though its walk completed. The error is in the
    // safe direction — "maybe incomplete" instead of "definitely complete".
    const files: Record<string, string> = {};
    for (let index = 0; index < 50_000; index += 1) {
      files[`f${String(index).padStart(5, "0")}.ts`] = "x\n";
    }

    const result = await globTool.execute(context(files), { pattern: "**/*.ts", limit: 1 });

    expect(result.searchTruncated).toBe(true);
  });

  it("a tree under the cap is unaffected", async () => {
    const files: Record<string, string> = { "a.ts": "x\n", "src/b.ts": "x\n" };
    const result = await globTool.execute(context(files), { pattern: "**/*.ts" });

    expect(result.total).toBe(2);
    expect(result.files).toEqual(["a.ts", "src/b.ts"]);
    expect(result.truncated).toBe(false);
    expect(result.searchTruncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it("the mirror constant is the one baah-core actually applies, by construction", async () => {
    // `WALK_ENTRY_LIMIT` duplicates `DEFAULT_MAX_ENTRIES` in baah-core — a
    // stopgap until `walk` reports its own truncation. Pinned behaviourally
    // rather than by reading core's source: one file *below* the limit is
    // complete, one above it is not. If core changes the cap, this test is the
    // one that has to move with it.
    const below: Record<string, string> = {};
    for (let index = 0; index < WALK_ENTRY_LIMIT - 1; index += 1) {
      below[`f${String(index).padStart(5, "0")}.ts`] = "x\n";
    }
    const above: Record<string, string> = { ...below, "zz.ts": "x\n" };

    const complete = await globTool.execute(context(below), { pattern: "**/*.ts", limit: 1 });
    const capped = await globTool.execute(context(above), { pattern: "**/*.ts", limit: 1 });

    expect(complete.total).toBe(WALK_ENTRY_LIMIT - 1);
    expect(complete.searchTruncated).toBe(false);
    expect(capped.total).toBe(WALK_ENTRY_LIMIT);
    expect(capped.searchTruncated).toBe(true);
  });
});
