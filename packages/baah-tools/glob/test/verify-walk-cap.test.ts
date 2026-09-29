/**
 * The walk cap in `glob`.
 *
 * ## What changed, and what this file now measures
 *
 * `Workspace.walk` used to be an `AsyncIterable<DirEntry>` that stopped after
 * 50 000 entries **and said nothing**. `glob` therefore mirrored the constant,
 * counted the entries that came out, and treated "50 000 came out" as
 * "possibly incomplete".
 *
 * That guess was what made the bug invisible: a workspace of 50 051 files
 * reported `total: 50 000` and `searchTruncated: true` only because of a
 * counter that happened to hit a number. A workspace of *exactly* 50 000 files
 * was flagged too, and nobody could tell from the result which case it was.
 *
 * Now the walk reports it: `walkResult.truncated` is `true` only when the walk
 * **stopped at the cap with entries left over**. `glob` reads that flag, and
 * still adds the deliberately conservative bias through
 * `walkMayBeIncomplete(walk)` — a walk that consumed exactly the cap reports as
 * possibly-incomplete even though it saw everything. The tests below pin both
 * halves separately, because a change to either one alone is a regression in
 * opposite directions.
 */
import {
  createMemoryWorkspace,
  DEFAULT_MAX_ENTRIES,
  type ToolContext,
  type WalkResult,
} from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { globTool } from "../src/index.ts";

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

/** `count` files, none of which match `x`. */
function treeOf(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    files[`f${String(index).padStart(5, "0")}.ts`] = "nothing\n";
  }
  return files;
}

describe("glob walk cap", () => {
  it("the walk reports its own truncation, so `total` is not presented as the whole tree", async () => {
    const result = await globTool.execute(context(OVER_CAP), {
      pattern: "**/*.ts",
      limit: 1000,
    });

    // 50 051 files exist. Only 50 000 were visited, and `total` still counts
    // only what was visited — but now the result says so instead of claiming
    // to be the workspace's whole content.
    expect(result.total).toBe(50_000);
    expect(result.files).toHaveLength(1000);
    expect(result.files).not.toContain("zzz-tail.ts");
    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/entry cap/);
    expect(result.hint).toMatch(/not a complete answer/);
  });

  it("the walk's own flag distinguishes 'stopped' from 'finished'", async () => {
    // The assertion that replaced the "mirror constant" test. Read straight off
    // the walk result, with the cap the tool actually applies, so this is the
    // contract `glob` consumes rather than a copy of a number.
    const under = createMemoryWorkspace(treeOf(3)).walk(".");
    const exactly = createMemoryWorkspace(treeOf(3)).walk(".", { maxEntries: 3 });
    const over = createMemoryWorkspace(treeOf(3)).walk(".", { maxEntries: 2 });

    const drain = async (result: WalkResult): Promise<number> => {
      let count = 0;
      for await (const _entry of result.entries) count += 1;
      return count;
    };

    expect(await drain(under)).toBe(3);
    expect(under.truncated).toBe(false);
    expect(under.visited).toBe(3);

    // Three entries, a cap of three: the walk saw the whole tree.
    expect(await drain(exactly)).toBe(3);
    expect(exactly.truncated).toBe(false);
    expect(exactly.visited).toBe(3);

    // Three entries, a cap of two: one was refused.
    expect(await drain(over)).toBe(2);
    expect(over.truncated).toBe(true);
    expect(over.visited).toBe(2);
  });

  it("the conservative bias: a tree exactly at the cap is reported as possibly-incomplete", async () => {
    // The bias survives on purpose. The walk here *finished* — 50 000 entries
    // and nothing beyond — and the tool still refuses to call the answer
    // complete, because a consumer that landed exactly on the cap cannot rule
    // out that something else capped it. The error is one-way on purpose: a
    // model told "possibly incomplete" once too often learns to ignore the
    // field, and one told "complete" too often acts on a partial search.
    const files = treeOf(DEFAULT_MAX_ENTRIES);
    expect(Object.keys(files)).toHaveLength(DEFAULT_MAX_ENTRIES);

    const walked = createMemoryWorkspace(files).walk(".");
    const result = await globTool.execute(context(files), { pattern: "**/*.ts", limit: 1 });

    // The two halves, asserted apart. `truncated` is the exact fact …
    expect(walked.truncated).toBe(false);
    // … and the tool's answer is the biased one.
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

  it("one entry below the cap is complete, two above it is not", async () => {
    // The behavioural pin that replaced the "mirror constant" test: it holds
    // whatever `DEFAULT_MAX_ENTRIES` is, so a change in core shows up here as
    // a failure instead of as a silent divergence between two numbers.
    const below = treeOf(DEFAULT_MAX_ENTRIES - 1);
    const above = { ...below, "zz.ts": "nothing\n", "zy.ts": "nothing\n" };

    const walkBelow = createMemoryWorkspace(below).walk(".");
    const walkAbove = createMemoryWorkspace(above).walk(".");

    const drain = async (result: WalkResult): Promise<void> => {
      for await (const _entry of result.entries) {
        // Consume; the assertion is on the flags afterwards.
      }
    };
    await drain(walkBelow);
    await drain(walkAbove);

    expect(walkBelow.visited).toBe(DEFAULT_MAX_ENTRIES - 1);
    expect(walkBelow.truncated).toBe(false);
    // The old counter could not tell this case from the one above it: both
    // yield exactly 50 000 entries. The flag can.
    expect(walkAbove.visited).toBe(DEFAULT_MAX_ENTRIES);
    expect(walkAbove.truncated).toBe(true);
  });
});
