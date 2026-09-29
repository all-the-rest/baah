import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { listTool } from "../src/index.ts";

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

const TREE = {
  "b.txt": "b",
  "a.txt": "aa",
  "Zebra/z.txt": "z",
  "dir2/y.txt": "y",
  "Dir/x.txt": "x",
};

describe("list tool", () => {
  it("defaults to the workspace root", async () => {
    const ctx = context({ "a.txt": "x" });
    const result = await listTool.execute(ctx, {});

    expect(result.path).toBe(".");
    expect(result.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("orders directories first, then files, each alphabetically (case-insensitive)", async () => {
    const ctx = context(TREE);
    const result = await listTool.execute(ctx, {});

    expect(result.entries.map((entry) => entry.name)).toEqual([
      "Dir",
      "dir2",
      "Zebra",
      "a.txt",
      "b.txt",
    ]);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("caps entries at limit and reports total and truncated", async () => {
    const ctx = context(TREE);
    const result = await listTool.execute(ctx, { limit: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.name)).toEqual(["Dir", "dir2"]);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when limit covers every entry", async () => {
    const ctx = context(TREE);
    const result = await listTool.execute(ctx, { limit: 5 });

    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("carries size on files but never on directories", async () => {
    const ctx = context(TREE);
    const result = await listTool.execute(ctx, {});
    const directory = result.entries.find((entry) => entry.name === "Dir");
    const file = result.entries.find((entry) => entry.name === "a.txt");

    expect(directory).not.toHaveProperty("size");
    expect(file).toHaveProperty("size", 2);
  });

  it("rejects a missing directory", async () => {
    const ctx = context({});
    await expect(listTool.execute(ctx, { path: "nope" })).rejects.toThrow(
      /Directory not found/,
    );
  });

  it("rejects a path that is a file", async () => {
    const ctx = context({ "a.txt": "x" });
    await expect(listTool.execute(ctx, { path: "a.txt" })).rejects.toThrow(
      /Not a directory/,
    );
  });

  it("lists relative to the cwd", async () => {
    const ctx = context({ "src/a.ts": "x", "other/b.ts": "y" }, "src");
    const result = await listTool.execute(ctx, {});

    expect(result.path).toBe("src");
    expect(result.entries.map((entry) => entry.name)).toEqual(["a.ts"]);
  });

  it("refuses to escape the workspace root", async () => {
    const ctx = context({ "a.txt": "x" });
    await expect(listTool.execute(ctx, { path: "../../x" })).rejects.toThrow(
      /escapes the workspace root/,
    );
  });
});
