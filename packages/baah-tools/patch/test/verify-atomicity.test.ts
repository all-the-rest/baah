/**
 * `patch` — atomicity, proved the hard way.
 *
 * A content read-back after a failed patch is **not** sufficient proof of
 * atomicity, and this file exists because of that. Three implementations leave
 * the file byte-identical when a hunk fails, and only one of them is atomic:
 *
 * | implementation | content after a failure | `writeText` calls |
 * |---|---|---|
 * | build in memory, write once (this one) | unchanged | **0** |
 * | write after each hunk | partially patched | n |
 * | write on failure to roll back | unchanged | **2** |
 *
 * The rollback variant is the one a content check cannot see, and it is not
 * atomic in any meaningful sense: a second failure, a tab closed mid-rollback,
 * or a `createWritable` that throws leaves the partial file on disk, which is
 * the exact state the tool promises never produces. So the assertions here are
 * about **how many times the workspace was written to**, not only about what it
 * ended up containing — and the counting workspace is checked first, so a
 * broken counter cannot make the rest of the file pass vacuously.
 *
 * ## Measured, not assumed
 *
 * The rollback variant was written as a mutation and run against this suite
 * twice: once whole, and once with all eleven `expect(writes…)` assertions
 * removed from this file and nothing else changed.
 *
 * - whole suite: killed, by this file;
 * - with the write-count assertions removed: **survives**, 51 tests green.
 *
 * So the content read-backs — every one of which reads the file back and
 * compares it — have **zero** power against the one mutant that matters most,
 * and the counter assertions are the only thing standing there. That is the
 * measurement the "both kinds of assertion" rule above rests on, and it is the
 * reason removing them is not a tempting simplification. It is also the second
 * half of the lesson `Plan.md` §14.5 records for `grep`: a green run is not a
 * proof, and the question worth asking is *which* test killed *which* mutant.
 */
import { createMemoryWorkspace, type ToolContext, type Workspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { patchTool } from "../src/index.ts";

const FILE = ["one", "two", "three", "four", ""].join("\n");
const THREE_HUNKS = [
  { before: "one", after: "ONE" },
  { before: "two", after: "TWO" },
  { before: "absent", after: "x" },
];

interface Counted {
  ctx: ToolContext;
  /** Every `writeText` the tool made, in order. */
  writes: { path: string; content: string }[];
  read: (path: string) => Promise<string>;
}

function counted(files: Record<string, string>, signal = new AbortController().signal): Counted {
  const base = createMemoryWorkspace(files);
  const writes: { path: string; content: string }[] = [];
  const workspace: Workspace = {
    ...base,
    writeText(path, content) {
      writes.push({ path, content });
      return base.writeText(path, content);
    },
  };
  return {
    ctx: {
      workspace,
      cwd: ".",
      signal,
      approve: async () => "allow-once",
      emit: () => {},
      toolCallId: "test-atomicity",
      attempt: 1,
    },
    writes,
    read: (path) => base.readText(path),
  };
}

describe("the counting workspace itself", () => {
  it("records a write when one happens — otherwise every test below is vacuous", async () => {
    const { ctx, writes, read } = counted({ "a.txt": "x" });
    await patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "x", after: "y" }] });
    expect(writes).toEqual([{ path: "a.txt", content: "y" }]);
    await expect(read("a.txt")).resolves.toBe("y");
  });
});

describe("a failed patch performs no write at all", () => {
  it("hunk 3 of 3 failing: zero writes, not two", async () => {
    const { ctx, writes, read } = counted({ "a.txt": FILE });

    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: THREE_HUNKS }),
    ).rejects.toThrow(/hunk 3 of 3/);

    // The assertion that separates "atomic" from "rolled back".
    expect(writes).toEqual([]);
    await expect(read("a.txt")).resolves.toBe(FILE);
  });

  it("a context that became ambiguous mid-patch: zero writes", async () => {
    const { ctx, writes, read } = counted({ "a.txt": "alpha\nbeta\n" });
    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "alpha", after: "dup\ndup" },
          { before: "dup", after: "X" },
        ],
      }),
    ).rejects.toThrow(/matches 2 places/);
    expect(writes).toEqual([]);
    await expect(read("a.txt")).resolves.toBe("alpha\nbeta\n");
  });

  it("a patch that would empty the file: zero writes", async () => {
    const { ctx, writes, read } = counted({ "a.txt": "only" });
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "only", after: "" }] }),
    ).rejects.toThrow(/would leave the file empty/);
    expect(writes).toEqual([]);
    await expect(read("a.txt")).resolves.toBe("only");
  });

  it("a result over the size limit: zero writes", async () => {
    const { ctx, writes, read } = counted({ "a.txt": "x" });
    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [{ before: "x", after: "y".repeat(5_000_001) }],
      }),
    ).rejects.toThrow(/over the 5000000-byte limit/);
    expect(writes).toEqual([]);
    await expect(read("a.txt")).resolves.toBe("x");
  });

  it("an abort between matching and writing: zero writes", async () => {
    const controller = new AbortController();
    const { ctx, writes, read } = counted({ "a.txt": FILE }, controller.signal);
    // Aborted before the call; the hunks would all have matched.
    controller.abort();
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "one", after: "1" }] }),
    ).rejects.toThrow(/aborted/);
    expect(writes).toEqual([]);
    await expect(read("a.txt")).resolves.toBe(FILE);
  });

  it("a missing file: zero writes, and no file is conjured up", async () => {
    const { ctx, writes } = counted({});
    await expect(
      patchTool.execute(ctx, { path: "nope.txt", hunks: [{ before: "a", after: "b" }] }),
    ).rejects.toThrow(/file not found/);
    expect(writes).toEqual([]);
  });
});

describe("a successful patch writes exactly once", () => {
  it("ten hunks, one write", async () => {
    // Zero-padded so no `before` is a prefix of another: `l1` is a substring of
    // `l10`, and the ambiguity guard would fire before the write count could.
    const lines = Array.from({ length: 11 }, (_unused, index) => `l${String(index).padStart(2, "0")}`);
    const { ctx, writes, read } = counted({ "a.txt": `${lines.join("\n")}\n` });
    const result = await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: lines.slice(0, 10).map((line) => ({ before: line, after: line.toUpperCase() })),
    });

    expect(result.hunksApplied).toBe(10);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe(
      [...lines.slice(0, 10).map((line) => line.toUpperCase()), lines[10], ""].join("\n"),
    );
    await expect(read("a.txt")).resolves.toBe(writes[0]?.content ?? "");
  });

  it("the single write carries the finished file, not an intermediate state", async () => {
    const { ctx, writes } = counted({ "a.txt": FILE });
    await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [
        { before: "one", after: "ONE" },
        { before: "two", after: "TWO" },
      ],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe("ONE\nTWO\nthree\nfour\n");
  });

  it("a retried attempt that fails after one succeeded leaves the first result in place", async () => {
    // The realistic sequence in an agent loop: attempt 1 patches, attempt 2
    // (a different `toolCallId`) patches again from a model that still believes
    // the old text. Attempt 2 must not undo or half-apply attempt 1.
    const { ctx, writes, read } = counted({ "a.txt": FILE });
    await patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "one", after: "ONE" }] });
    expect(writes).toHaveLength(1);

    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "one", after: "STALE" },
          { before: "three", after: "THREE" },
        ],
      }),
    ).rejects.toThrow(/hunk 1 of 2/);

    expect(writes).toHaveLength(1);
    await expect(read("a.txt")).resolves.toBe("ONE\ntwo\nthree\nfour\n");
  });
});
