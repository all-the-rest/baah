import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { MAX_CONTENT_BYTES, writeTool } from "../src/index.ts";

function context(files: Record<string, string>, cwd = "."): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd,
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
    // Required since baah-core grew the call identity: a tool cannot be
    // replay-safe without knowing which call it is (AGENTS.md 3.1).
    toolCallId: `test-${Object.keys(files).join("-")}`,
    attempt: 1,
  };
}

describe("write tool", () => {
  it("creates a new file and reports created: true", async () => {
    const ctx = context({});
    const result = await writeTool.execute(ctx, { path: "a.txt", content: "hello" });

    expect(result).toEqual({ path: "a.txt", bytesWritten: 5, created: true });
    await expect(ctx.workspace.readText("a.txt")).resolves.toBe("hello");
  });

  it("overwrites an existing file and reports created: false", async () => {
    const ctx = context({ "a.txt": "old" });
    const result = await writeTool.execute(ctx, { path: "a.txt", content: "new" });

    expect(result.created).toBe(false);
    expect(result.bytesWritten).toBe(3);
    await expect(ctx.workspace.readText("a.txt")).resolves.toBe("new");
  });

  it("creates missing parent directories for a nested path", async () => {
    const ctx = context({});
    const result = await writeTool.execute(ctx, {
      path: "src/deep/nested/a.ts",
      content: "export const a = 1;",
    });

    expect(result.path).toBe("src/deep/nested/a.ts");
    await expect(ctx.workspace.readText("src/deep/nested/a.ts")).resolves.toBe(
      "export const a = 1;",
    );
    const stat = await ctx.workspace.stat("src/deep/nested");
    expect(stat?.kind).toBe("directory");
  });

  it("counts UTF-8 bytes, not UTF-16 code units", async () => {
    const ctx = context({});
    const result = await writeTool.execute(ctx, { path: "u.txt", content: "ä" });

    expect(result.bytesWritten).toBe(2);
  });

  it("refuses content above the size guard", async () => {
    const ctx = context({});
    const content = "x".repeat(MAX_CONTENT_BYTES + 1);

    await expect(writeTool.execute(ctx, { path: "big.txt", content })).rejects.toThrow(
      /too large/i,
    );
    await expect(ctx.workspace.exists("big.txt")).resolves.toBe(false);
  });

  it("allows content exactly at the size guard", async () => {
    const ctx = context({});
    const content = "x".repeat(MAX_CONTENT_BYTES);
    const result = await writeTool.execute(ctx, { path: "big.txt", content });

    expect(result.bytesWritten).toBe(MAX_CONTENT_BYTES);
  });

  it("refuses to escape the workspace root", async () => {
    const ctx = context({});
    await expect(
      writeTool.execute(ctx, { path: "../../x.txt", content: "nope" }),
    ).rejects.toThrow(/escapes the workspace root/);
  });
});
