/**
 * `patch` — the behaviour a model acts on.
 *
 * The claim under test throughout: **all or nothing.** A patch is a list of
 * hunks applied to one file, and the dangerous property is not that a hunk can
 * fail — it is what the file looks like *after* one fails. Every "Nothing was
 * written" assertion in this file is paired with a read-back of the file, so a
 * message that claims atomicity without delivering it fails here.
 */
import { createMemoryWorkspace, type ToolContext, type Workspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { applyHunks, MAX_RESULT_BYTES, patchTool } from "../src/index.ts";

const FILE = ["one", "two", "three", "four", ""].join("\n");

function context(
  files: Record<string, string>,
  signal = new AbortController().signal,
): { ctx: ToolContext; base: Workspace } {
  const base = createMemoryWorkspace(files);
  return {
    ctx: {
      workspace: base,
      cwd: ".",
      signal,
      approve: async () => "allow-once",
      emit: () => {},
      toolCallId: "test-patch",
      attempt: 1,
    },
    base,
  };
}

describe("applying hunks", () => {
  it("applies every hunk in order and reports where each landed", async () => {
    const { ctx, base } = context({ "a.txt": FILE });
    const result = await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [
        { before: "one", after: "ONE" },
        { before: "four", after: "FOUR" },
      ],
    });

    expect(result.hunksApplied).toBe(2);
    expect(result.appliedAt).toEqual([1, 4]);
    await expect(base.readText("a.txt")).resolves.toBe("ONE\ntwo\nthree\nFOUR\n");
  });

  it("applies each hunk against the text the previous ones produced", async () => {
    const { ctx, base } = context({ "a.txt": FILE });
    await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [
        { before: "two", after: "TWO\ninserted" },
        { before: "inserted", after: "inserted, then rewritten" },
      ],
    });
    await expect(base.readText("a.txt")).resolves.toBe(
      "one\nTWO\ninserted, then rewritten\nthree\nfour\n",
    );
  });

  it("keeps `after` literal when it contains $ sequences", async () => {
    const { ctx, base } = context({ "a.txt": "price: AMOUNT\n" });
    await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "AMOUNT", after: "$&100" }],
    });
    await expect(base.readText("a.txt")).resolves.toBe("price: $&100\n");
  });

  it("deletes a region with an empty `after`", async () => {
    const { ctx, base } = context({ "a.txt": FILE });
    await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "two\nthree\n", after: "" }],
    });
    await expect(base.readText("a.txt")).resolves.toBe("one\nfour\n");
  });

  it("reports the byte length of the result", async () => {
    const { ctx } = context({ "a.txt": FILE });
    const result = await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "one", after: "1" }],
    });
    // "1\ntwo\nthree\nfour\n"
    expect(result.bytesWritten).toBe(17);
  });
});

describe("a failing hunk leaves the file exactly as it was", () => {
  it("hunk 3 failing means hunks 1 and 2 never reached the disk", async () => {
    const { ctx, base } = context({ "a.txt": FILE });

    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "one", after: "ONE" },
          { before: "two", after: "TWO" },
          { before: "absent", after: "x" },
        ],
      }),
    ).rejects.toThrow(/hunk 3 of 3 does not match/);

    await expect(base.readText("a.txt")).resolves.toBe(FILE);
  });

  it("the failure names the hunk and the file, so the model can fix that hunk", async () => {
    const { ctx } = context({ "a.txt": FILE });
    const message = await patchTool
      .execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "one", after: "ONE" },
          { before: "absent", after: "x" },
        ],
      })
      .then(() => "", (error: unknown) => (error as Error).message);

    expect(message).toMatch(/hunk 2 of 2/);
    expect(message).toMatch(/a\.txt/);
    expect(message).toMatch(/Nothing was written/);
    // Evidence, not fuzzy matching — and evidence about the file **as it is on
    // disk**, not about the half-patched text. Hunk 1 succeeded, so the
    // in-memory text now starts "ONE"; quoting that would send the model to
    // compare against a version of the file that does not exist.
    expect(message).toMatch(/as it is on disk has 4 line\(s\) and ends with a newline/);
    expect(message).toMatch(/its first line is "one"/);
    expect(message).toMatch(/its last non-empty line is "four"/);
    expect(message).toMatch(/`before` begins with "absent"/);
  });

  it("says the file has no trailing newline — the commonest single cause", async () => {
    const { ctx } = context({ "a.txt": "a\nb" });
    const message = await patchTool
      .execute(ctx, { path: "a.txt", hunks: [{ before: "b\n", after: "b" }] })
      .then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toMatch(/2 line\(s\) and does not end with a newline/);
  });
});

describe("refusing rather than guessing", () => {
  it("a context that appears twice fails instead of picking one", async () => {
    const { ctx, base } = context({ "a.txt": "x\nx\n" });
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "x", after: "y" }] }),
    ).rejects.toThrow(/matches 2 places/);
    await expect(base.readText("a.txt")).resolves.toBe("x\nx\n");
  });

  it("a context that becomes ambiguous only *after* an earlier hunk is still refused", async () => {
    // This is the case a "count occurrences against the original text"
    // implementation misses entirely: unique before, duplicated by hunk 1.
    const { ctx, base } = context({ "a.txt": "alpha\nbeta\n" });
    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "alpha", after: "dup\ndup" },
          { before: "dup", after: "X" },
        ],
      }),
    ).rejects.toThrow(/hunk 2 of 2 matches 2 places/);
    await expect(base.readText("a.txt")).resolves.toBe("alpha\nbeta\n");
  });

  it("overlapping hunks fail rather than being reconciled", async () => {
    // Hunk 1 replaces the region hunk 2 was written against, so hunk 2 no
    // longer finds its text. That is the sequential rule doing the work — no
    // overlap detection is needed, and none is implemented.
    const { ctx, base } = context({ "a.txt": "aaa\nbbb\n" });
    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "aaa\nbbb", after: "zzz" },
          { before: "bbb", after: "y" },
        ],
      }),
    ).rejects.toThrow(/hunk 2 of 2 does not match/);
    await expect(base.readText("a.txt")).resolves.toBe("aaa\nbbb\n");
  });

  it("a hunk with identical before and after is a mistake, not a no-op to write", async () => {
    const { ctx, base } = context({ "a.txt": FILE });
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "two", after: "two" }] }),
    ).rejects.toThrow(/identical/);
    await expect(base.readText("a.txt")).resolves.toBe(FILE);
  });

  it("an empty hunk list is refused, so a no-op patch never touches the file", async () => {
    // The schema refuses it for the model; `applyHunks` refuses it for a direct
    // call on the public `execute`, because an empty list would otherwise write
    // the file back unchanged and report `hunksApplied: 0` as work done.
    const { ctx, base } = context({ "a.txt": FILE });
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [] }),
    ).rejects.toThrow(/no hunks for a\.txt/);
    await expect(base.readText("a.txt")).resolves.toBe(FILE);
  });
});

describe("a hunk that would empty the file", () => {
  it("is refused and nothing is written", async () => {
    const { ctx, base } = context({ "a.txt": FILE });
    await expect(
      patchTool.execute(ctx, {
        path: "a.txt",
        hunks: [
          { before: "one", after: "1" },
          { before: "1\ntwo\nthree\nfour\n", after: "" },
        ],
      }),
    ).rejects.toThrow(/would leave the file empty/);
    await expect(base.readText("a.txt")).resolves.toBe(FILE);
  });

  it("an empty file is not left behind as a success", async () => {
    const { ctx, base } = context({ "a.txt": "only" });
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "only", after: "" }] }),
    ).rejects.toThrow(/Narrow the last hunk/);
    await expect(base.readText("a.txt")).resolves.toBe("only");
  });

  it("a file that is one line shorter is still allowed", async () => {
    // The guard is emptiness, not shrinkage. Refusing every large deletion
    // would make the tool useless for the thing it is for.
    const { ctx, base } = context({ "a.txt": "a\nb\n" });
    await patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "a\nb\n", after: "b\n" }] });
    await expect(base.readText("a.txt")).resolves.toBe("b\n");
  });
});

describe("the file itself", () => {
  it("a missing file is named as missing, and patch never creates one", async () => {
    const { ctx, base } = context({});
    await expect(
      patchTool.execute(ctx, { path: "nope.txt", hunks: [{ before: "a", after: "b" }] }),
    ).rejects.toThrow(/file not found: nope\.txt/);
    await expect(base.exists("nope.txt")).resolves.toBe(false);
  });

  it("a missing file is reported before any hunk is examined", async () => {
    const { ctx } = context({});
    // Hunk 1 would never match an empty file. If the hunks were checked first,
    // the model would be told to fix its hunk instead of the real problem.
    const message = await patchTool
      .execute(ctx, { path: "nope.txt", hunks: [{ before: "a", after: "b" }] })
      .then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toMatch(/file not found/);
    expect(message).not.toMatch(/does not match/);
  });

  it("a directory is refused", async () => {
    const { ctx } = context({ "dir/a.txt": "x" });
    await expect(
      patchTool.execute(ctx, { path: "dir", hunks: [{ before: "a", after: "b" }] }),
    ).rejects.toThrow(/not a file: dir/);
  });

  it("refuses to escape the workspace root", async () => {
    const { ctx } = context({ "a.txt": FILE });
    await expect(
      patchTool.execute(ctx, {
        path: "../outside.txt",
        hunks: [{ before: "one", after: "1" }],
      }),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  it("refuses a result over the size limit, before writing", async () => {
    const { ctx, base } = context({ "a.txt": "x" });
    const huge = "y".repeat(MAX_RESULT_BYTES + 1);
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "x", after: huge }] }),
    ).rejects.toThrow(/over the 5000000-byte limit/);
    await expect(base.readText("a.txt")).resolves.toBe("x");
  });
});

describe("the end of the file", () => {
  it("matches a hunk on the last line when the file ends with a newline", async () => {
    const { ctx, base } = context({ "a.txt": "a\nb\n" });
    const result = await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "b\n", after: "b\nc\n" }],
    });
    expect(result.appliedAt).toEqual([2]);
    await expect(base.readText("a.txt")).resolves.toBe("a\nb\nc\n");
  });

  it("matches a hunk on the last line when the file has no trailing newline", async () => {
    const { ctx, base } = context({ "a.txt": "a\nb" });
    await patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "b", after: "b\n" }] });
    await expect(base.readText("a.txt")).resolves.toBe("a\nb\n");
  });

  it("a hunk spanning the end of the file applies", async () => {
    const { ctx, base } = context({ "a.txt": "keep\ndrop\ndrop\n" });
    await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "drop\ndrop\n", after: "" }],
    });
    await expect(base.readText("a.txt")).resolves.toBe("keep\n");
  });

  it("a hunk anchored at the very end cannot be followed past it", async () => {
    const { ctx, base } = context({ "a.txt": "a\n" });
    await expect(
      patchTool.execute(ctx, { path: "a.txt", hunks: [{ before: "a\nb\n", after: "x" }] }),
    ).rejects.toThrow(/does not match/);
    await expect(base.readText("a.txt")).resolves.toBe("a\n");
  });

  it("reports line 1 for a hunk at the start of the file", async () => {
    const { ctx } = context({ "a.txt": FILE });
    const result = await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "one", after: "1" }],
    });
    expect(result.appliedAt).toEqual([1]);
  });

  it("a hunk spanning several lines reports its first line", async () => {
    const { ctx } = context({ "a.txt": FILE });
    const result = await patchTool.execute(ctx, {
      path: "a.txt",
      hunks: [{ before: "two\nthree", after: "T" }],
    });
    expect(result.appliedAt).toEqual([2]);
  });
});

describe("applyHunks as a pure function", () => {
  it("does not mutate the string it was given, and has no side effects", () => {
    const result = applyHunks(FILE, [{ before: "one", after: "1" }], "a.txt");
    expect(result.text).toBe("1\ntwo\nthree\nfour\n");
    expect(FILE).toBe("one\ntwo\nthree\nfour\n");
  });

  it("throws rather than returning a partial result", () => {
    expect(() =>
      applyHunks(FILE, [{ before: "one", after: "1" }, { before: "nope", after: "x" }], "a.txt"),
    ).toThrow(/hunk 2 of 2/);
  });
});
