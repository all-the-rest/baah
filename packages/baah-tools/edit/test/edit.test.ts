import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { editTool } from "../src/index.ts";

function context(files: Record<string, string>, cwd = "."): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd,
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
  };
}

describe("edit tool", () => {
  it("replaces a single occurrence and writes the file back", async () => {
    const ctx = context({ "a.txt": "hello world\n" });
    const result = await editTool.execute(ctx, {
      path: "a.txt",
      oldString: "world",
      newString: "there",
    });

    expect(result).toEqual({ path: "a.txt", replacements: 1 });
    await expect(ctx.workspace.readText("a.txt")).resolves.toBe("hello there\n");
  });

  it("rejects identical oldString and newString", async () => {
    const ctx = context({ "a.txt": "hello\n" });
    await expect(
      editTool.execute(ctx, { path: "a.txt", oldString: "x", newString: "x" }),
    ).rejects.toThrow(/identical/);
  });

  it("rejects a missing file", async () => {
    const ctx = context({});
    await expect(
      editTool.execute(ctx, { path: "nope.txt", oldString: "a", newString: "b" }),
    ).rejects.toThrow(/File not found/);
  });

  it("rejects a string that is not present", async () => {
    const ctx = context({ "a.txt": "hello\n" });
    await expect(
      editTool.execute(ctx, { path: "a.txt", oldString: "absent", newString: "x" }),
    ).rejects.toThrow(/String not found/);
  });

  it("reports the exact count when multiple occurrences need replaceAll", async () => {
    const ctx = context({ "a.txt": "x x x\n" });
    await expect(
      editTool.execute(ctx, { path: "a.txt", oldString: "x", newString: "y" }),
    ).rejects.toThrow(/3 occurrences/);
    // Nothing was written on the rejected path.
    await expect(ctx.workspace.readText("a.txt")).resolves.toBe("x x x\n");
  });

  it("replaces every occurrence with replaceAll: true", async () => {
    const ctx = context({ "a.txt": "x x x\n" });
    const result = await editTool.execute(ctx, {
      path: "a.txt",
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });

    expect(result.replacements).toBe(3);
    await expect(ctx.workspace.readText("a.txt")).resolves.toBe("y y y\n");
  });

  it("keeps replacement text literal when it contains $ sequences", async () => {
    const ctx = context({ "a.txt": "price: AMOUNT\n" });
    await editTool.execute(ctx, {
      path: "a.txt",
      oldString: "AMOUNT",
      newString: "$&100",
    });

    await expect(ctx.workspace.readText("a.txt")).resolves.toBe("price: $&100\n");
  });

  it("refuses to escape the workspace root", async () => {
    const ctx = context({ "a.txt": "hello\n" });
    await expect(
      editTool.execute(ctx, { path: "../../a.txt", oldString: "a", newString: "b" }),
    ).rejects.toThrow(/escapes the workspace root/);
  });
});
