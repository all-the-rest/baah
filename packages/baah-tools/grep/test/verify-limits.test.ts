/**
 * The size and completeness limits of `grep`.
 *
 * The claim under test: "a 1 MB per-file cap and a 16 MB total, both *surfaced
 * in the result*". Three of these assertions documented behaviour that was
 * wrong. They are kept and flipped to what the tool must do — a deleted test
 * proves nothing about the fix, and these are the tests that would catch its
 * undoing.
 */
import { createMemoryWorkspace, type ToolContext, type Workspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, WALK_ENTRY_LIMIT, grepTool } from "../src/index.ts";

/**
 * A workspace whose `walk` does NOT report sizes.
 *
 * This is not a synthetic edge case — it is the production shape. The memory
 * workspace fills `DirEntry.size` in, but `toDirEntry` in
 * `packages/baah-core/src/workspace/directory-workspace.ts:50` does not:
 * `({ path, name: handle.name, kind: handle.kind })`. A real
 * `FileSystemDirectoryHandle` walk therefore hands the tool no size at all.
 *
 * Without this, the two byte-budget checks in `scanCandidates` shadow each
 * other in tests — the pre-read one always fires, so deleting the post-read one
 * is invisible. M1, M2 and M3 of the mutation run survived exactly that way.
 * Against a size-less workspace only the post-read check can enforce the cap.
 */
function sizelessWorkspace(files: Record<string, string>): Workspace {
  const base = createMemoryWorkspace(files);
  return {
    ...base,
    async *walk(directory = ".", options = {}) {
      for await (const entry of base.walk(directory, options)) {
        const { size: _size, ...rest } = entry;
        yield rest;
      }
    },
  };
}

const MIB = 1024 * 1024;

function context(
  files: Record<string, string>,
  overrides: Partial<ToolContext> = {},
): ToolContext {
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
    ...overrides,
  };
}

/** A file of exactly `bytes` UTF-8 bytes whose last line contains `hit`. */
function fileOf(bytes: number): string {
  const tail = "hit\n";
  return `${"x".repeat(bytes - tail.length - 1)}\n${tail}`;
}

describe("per-file cap (1 MiB)", () => {
  it("scans a file of exactly 1 MiB — the boundary is exclusive", async () => {
    const exact = fileOf(MAX_FILE_BYTES);
    expect(new TextEncoder().encode(exact).length).toBe(MAX_FILE_BYTES);

    const result = await grepTool.execute(context({ "exact.ts": exact }), { pattern: "hit" });

    expect(result.filesScanned).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.matches).toHaveLength(1);
  });

  it("skips a file of 1 MiB + 1 byte", async () => {
    const over = fileOf(MAX_FILE_BYTES + 1);
    expect(new TextEncoder().encode(over).length).toBe(MAX_FILE_BYTES + 1);

    const result = await grepTool.execute(context({ "over.ts": over }), { pattern: "hit" });

    expect(result.filesScanned).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.maxFileBytes).toBe(MAX_FILE_BYTES);
  });

  it("FIXED: a skipped file produces a hint that names the cause and the remedy", async () => {
    // The skip was surfaced (`filesSkipped`/`maxFileBytes`) but the model-facing
    // hint told the model to widen `path`, set `include`, drop `literal` or
    // retry case-insensitively. None of that would ever surface a file that was
    // skipped for being over 1 MiB. The hint now names the cap and the two
    // remedies that actually work.
    const result = await grepTool.execute(
      context({ "big.ts": fileOf(MAX_FILE_BYTES + 1), "small.ts": "nothing here\n" }),
      { pattern: "hit" },
    );

    expect(result.total).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.hint).toMatch(/No line matches/);
    expect(result.hint).toMatch(/skipped/);
    expect(result.hint).toMatch(/1 MiB per-file cap/);
    expect(result.hint).toMatch(/Narrow `path`\/`include`/);
    // The advice that could never have applied is gone.
    expect(result.hint).not.toMatch(/Widen `path`, set `include`/);
    expect(result.hint).not.toMatch(/drop `literal`/);
  });

  it("a skipped file does not poison the hint when something else did match", async () => {
    // The size hint is about *why the list may be short*. When there are
    // matches, the "Showing N of M" hint is the useful one — but the skip still
    // has to be visible somewhere, and `filesSkipped` is where it lives.
    const result = await grepTool.execute(
      context({ "big.ts": fileOf(MAX_FILE_BYTES + 1) + "hit\n", "small.ts": "hit\nhit\n" }),
      { pattern: "hit", limit: 1 },
    );

    expect(result.total).toBe(2);
    expect(result.filesSkipped).toBe(1);
    expect(result.hint).toMatch(/Showing 1 of 2/);
  });
});

describe("total byte cap (16 MiB)", () => {
  it("FIXED: `bytesRead` never exceeds the `maxBytes` it reports", async () => {
    // The budget used to be checked only BEFORE each read, so the file that
    // crossed the line was read in full and the total overshot: the result
    // claimed `bytesRead: 17,510,495` next to `maxBytes: 16,777,216` — a
    // budget contradicting itself. The invariant is now absolute and is
    // asserted, not assumed.
    const chunk = fileOf(900 * 1024);
    const files: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) files[`f${index}.ts`] = chunk;

    const result = await grepTool.execute(context(files), { pattern: "hit" });

    expect(result.searchTruncated).toBe(true);
    expect(result.maxBytes).toBe(MAX_TOTAL_BYTES);
    expect(result.bytesRead).toBeLessThanOrEqual(result.maxBytes);
    // And it stops at the cap rather than merely under it: 18 whole files fit.
    expect(result.bytesRead).toBe(18 * 900 * 1024);
    expect(result.filesScanned).toBe(18);
  });

  it("FIXED: a file that would cross the cap is not scanned either", async () => {
    // Stopping the *byte counter* while still matching the file would make the
    // budget a fiction in the other direction: `filesScanned` would claim a
    // file was read that the result does not account for. 19 files of 900 KiB
    // each: 18 fit under the 16 MiB cap, the 19th does not — and every one of
    // them contains the needle, so the match count proves exactly which files
    // were read.
    const chunk = fileOf(900 * 1024);
    const files: Record<string, string> = {};
    for (let index = 0; index < 19; index += 1) files[`f${String(index).padStart(2, "0")}.ts`] = chunk;

    const result = await grepTool.execute(context(files), { pattern: "hit" });

    expect(result.bytesRead).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(result.filesScanned).toBe(18);
    expect(result.total).toBe(18);
    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/byte cap/);
  });

  it("an exact multiple of the cap stops cleanly", async () => {
    const chunk = fileOf(MIB);
    const files: Record<string, string> = {};
    for (let index = 0; index < 17; index += 1) files[`f${index}.ts`] = chunk;

    const result = await grepTool.execute(context(files), { pattern: "hit" });

    expect(result.bytesRead).toBe(MAX_TOTAL_BYTES);
    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/byte cap/);
  });

  it("the cap holds when the workspace reports no file sizes — the real one", async () => {
    // `DirectoryWorkspace.toDirEntry` does not fill `DirEntry.size`, so in the
    // browser the pre-read check is inert and the post-read check is the only
    // thing standing between the result and `bytesRead > maxBytes`. This is the
    // test that makes deleting that check a visible failure.
    const chunk = fileOf(900 * 1024);
    const files: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) files[`f${index}.ts`] = chunk;

    const result = await grepTool.execute(
      context({}, { workspace: sizelessWorkspace(files) }),
      { pattern: "hit" },
    );

    expect(result.bytesRead).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(result.searchTruncated).toBe(true);
    // 18 files of 900 KiB fit under 16 MiB; the 19th would cross the line.
    expect(result.filesScanned).toBe(18);
    expect(result.total).toBe(18);
    expect(result.hint).toMatch(/byte cap/);
  });

  it("a size-less workspace still skips an oversized file", async () => {
    // Same shape, per-file cap: with no reported size the only defence is the
    // post-read check, so this is the test that pins *that* one.
    const result = await grepTool.execute(
      context({}, { workspace: sizelessWorkspace({ "big.ts": fileOf(MAX_FILE_BYTES + 1) }) }),
      { pattern: "hit" },
    );

    expect(result.filesScanned).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.bytesRead).toBe(0);
    expect(result.hint).toMatch(/1 MiB per-file cap/);
  });

  it("a file already known to be over the per-file cap is never read at all", async () => {
    // The pre-read size check is not a performance nicety, it is the only
    // reason a big file in the workspace does not have to be pulled into the
    // tab's memory before being thrown away. `readText` is a spy here: the
    // assertion is on the *side effect*, not on the counters, which the
    // post-read check would produce anyway.
    //
    // The file is one byte over the cap on purpose. The counters alone cannot
    // distinguish "skipped before reading" from "read, then dropped" — a
    // mutation that doubles the pre-read threshold produces the same counters
    // and is only visible here, because the file's size sits between the two
    // thresholds.
    const over = "x".repeat(MAX_FILE_BYTES + 1);
    const files: Record<string, string> = { "big.txt": over, "small.ts": "hit\n" };
    const base = createMemoryWorkspace(files);
    const readPaths: string[] = [];
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        readPaths.push(path);
        return base.readText(path);
      },
    };

    const result = await grepTool.execute(context({}, { workspace }), { pattern: "hit" });

    expect(readPaths).toEqual(["small.ts"]);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesScanned).toBe(1);
    expect(result.bytesRead).toBe(4);
  });

  it("a file far over the per-file cap is also never read", async () => {
    // The 4 MiB case, for the reason the tool actually cares about: this is
    // the shape that would exhaust a tab's memory if it were read first.
    const over = "x".repeat(MAX_FILE_BYTES * 4);
    const base = createMemoryWorkspace({ "huge.bin.txt": over, "small.ts": "hit\n" });
    const readPaths: string[] = [];
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        readPaths.push(path);
        return base.readText(path);
      },
    };

    const result = await grepTool.execute(context({}, { workspace }), { pattern: "hit" });

    expect(readPaths).toEqual(["small.ts"]);
    expect(result.filesSkipped).toBe(1);
    expect(result.bytesRead).toBe(4);
  });

  it("a file that would cross the total cap is never read either", async () => {
    // The pre-read budget check is the same story: 19 files of 900 KiB, and the
    // 19th must not be pulled into memory only to be discarded after the fact.
    // A spy on `readText` is the only way to see the difference — the counters
    // come out the same either way.
    const chunk = fileOf(900 * 1024);
    const files: Record<string, string> = {};
    for (let index = 0; index < 19; index += 1) files[`f${String(index).padStart(2, "0")}.ts`] = chunk;
    const base = createMemoryWorkspace(files);
    const readPaths: string[] = [];
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        readPaths.push(path);
        return base.readText(path);
      },
    };

    const result = await grepTool.execute(context({}, { workspace }), { pattern: "hit" });

    expect(readPaths).toHaveLength(18);
    expect(readPaths).not.toContain("f18.ts");
    expect(result.bytesRead).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(result.searchTruncated).toBe(true);
  });
});

describe("`limit` boundary", () => {
  it("is not truncated when total equals limit", async () => {
    const result = await grepTool.execute(context({ "a.ts": "h\nh\nh\n" }), {
      pattern: "h",
      limit: 3,
    });

    expect(result.total).toBe(3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it("is truncated at total = limit + 1", async () => {
    const result = await grepTool.execute(context({ "a.ts": "h\nh\nh\nh\n" }), {
      pattern: "h",
      limit: 3,
    });

    expect(result.total).toBe(4);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.hint).toMatch(/Showing 3 of 4/);
  });
});

describe("the walk cap (50 000 entries) — now reported", () => {
  const BIG: Record<string, string> = (() => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 50_050; index += 1) {
      files[`f${String(index).padStart(5, "0")}.ts`] = "nothing\n";
    }
    // The only file in the workspace that contains the needle, and it sorts
    // last — i.e. it is only reachable if the walk is not cut short.
    files["zzz-needle.ts"] = "hit\n";
    return files;
  })();

  it("FIXED: a truncated search no longer claims the needle is absent", async () => {
    // `Workspace.walk` stops after 50 000 visited entries
    // (`DEFAULT_MAX_ENTRIES`, packages/baah-core/src/workspace.ts:214 and
    // workspace/directory-workspace.ts:77) and cannot report that it did.
    // `grep` counts the entries it received and treats reaching
    // `WALK_ENTRY_LIMIT` as "possibly incomplete", which is the only thing a
    // caller can do without a change in core. The result is still empty — the
    // tail genuinely was not searched — but it no longer says the pattern does
    // not match anywhere.
    const result = await grepTool.execute(context(BIG), { pattern: "hit" });

    expect(result.filesScanned).toBe(50_000);
    expect(result.total).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.searchTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.hint).not.toMatch(/No line matches/);
    expect(result.hint).toMatch(/entry cap/);
    expect(result.hint).toMatch(/not a complete answer/);
    expect(result.note).toMatch(/entry cap/);
  });

  it("a tree under the cap reports a complete search", async () => {
    const files: Record<string, string> = { "a.ts": "hit\n", "src/b.ts": "hit\n" };
    const result = await grepTool.execute(context(files), { pattern: "hit" });

    expect(result.total).toBe(2);
    expect(result.searchTruncated).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it("an abort during the walk is reported, and distinguished from the walk cap", async () => {
    // The two walk-level causes look identical from the outside — the walk
    // stopped early either way — so the note has to say which. A model that
    // knows it was aborted can retry; a model that hit the cap has to narrow
    // `path` instead, and retrying would produce the same answer.
    const controller = new AbortController();
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`f${index}.ts`] = "hit\n";
    const base = createMemoryWorkspace(files);
    let seen = 0;
    const workspace: Workspace = {
      ...base,
      async *walk(directory = ".", options = {}) {
        for await (const entry of base.walk(directory, options)) {
          seen += 1;
          if (seen === 3) controller.abort();
          yield entry;
        }
      },
    };

    const result = await grepTool.execute(context({}, { workspace, signal: controller.signal }), {
      pattern: "hit",
    });

    expect(seen).toBeGreaterThanOrEqual(3);
    expect(result.searchTruncated).toBe(true);
    // The *walk's* wording, specifically. "aborted" alone is not enough: the
    // read loop and the match loop also say "aborted", and the three mean
    // different amounts of work having happened. Deleting the walk's note
    // (mutation M27) must be visible here.
    expect(result.note).toMatch(/the walk stopped before it had seen every entry/);
    // Not the cap: this workspace has ten files.
    expect(result.note).not.toMatch(/50000/);
  });

  it("an already-aborted signal is reported before the walk even starts", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await grepTool.execute(
      context({ "a.ts": "hit\n" }, { signal: controller.signal }),
      { pattern: "hit" },
    );

    expect(result.total).toBe(0);
    expect(result.searchTruncated).toBe(true);
    // Three separate notes, all true: the walk saw nothing, the read loop read
    // nothing, and the matcher had no lines. A single "no matches" would be a
    // lie about a search that never ran.
    expect(result.note).toMatch(/aborted/i);
    expect(result.filesScanned).toBe(0);
  });

  it("the mirror constant tracks baah-core's, by construction", async () => {
    // `WALK_ENTRY_LIMIT` duplicates a constant in core. Pinned behaviourally:
    // one file below the cap is complete, one above it is not. If core changes
    // `DEFAULT_MAX_ENTRIES`, this is the test that has to move with it — and
    // the signal that the duplication has become wrong.
    const below: Record<string, string> = {};
    for (let index = 0; index < WALK_ENTRY_LIMIT - 1; index += 1) {
      below[`f${String(index).padStart(5, "0")}.ts`] = "nothing\n";
    }
    const above: Record<string, string> = { ...below, "zzz.ts": "nothing\n" };

    const complete = await grepTool.execute(context(below), { pattern: "hit" });
    const capped = await grepTool.execute(context(above), { pattern: "hit" });

    expect(complete.filesScanned).toBe(WALK_ENTRY_LIMIT - 1);
    expect(complete.searchTruncated).toBe(false);
    expect(capped.filesScanned).toBe(WALK_ENTRY_LIMIT);
    expect(capped.searchTruncated).toBe(true);
  });
});
