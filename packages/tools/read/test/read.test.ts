import { createMemoryWorkspace, type ToolContext } from "@ohw/core";
import { describe, expect, it } from "vitest";

import { readTool } from "../src/index.ts";

function context(files: Record<string, string>, cwd = "."): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd,
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
  };
}

describe("read tool", () => {
  it("returns line-numbered content", async () => {
    const ctx = context({ "a.txt": "one\ntwo\nthree\n" });
    const result = await readTool.execute(ctx, { path: "a.txt" });

    expect(result.content).toBe("1: one\n2: two\n3: three");
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("honours offset and limit", async () => {
    const ctx = context({ "a.txt": "1\n2\n3\n4\n5\n" });
    const result = await readTool.execute(ctx, { path: "a.txt", offset: 2, limit: 2 });

    expect(result.content).toBe("2: 2\n3: 3");
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects a missing file with a model-visible message", async () => {
    const ctx = context({});
    await expect(readTool.execute(ctx, { path: "nope.txt" })).rejects.toThrow(
      /File not found/,
    );
  });

  it("rejects a directory", async () => {
    const ctx = context({ "src/a.ts": "x\n" });
    await expect(readTool.execute(ctx, { path: "src" })).rejects.toThrow(/Not a file/);
  });

  it("rejects binary content", async () => {
    const ctx = context({ "bin.dat": "abc\u0000def" });
    await expect(readTool.execute(ctx, { path: "bin.dat" })).rejects.toThrow(/binary/);
  });

  it("refuses to escape the workspace root", async () => {
    const ctx = context({ "a.txt": "x\n" });
    await expect(readTool.execute(ctx, { path: "../../etc/passwd" })).rejects.toThrow(
      /escapes the workspace root/,
    );
  });

  it("truncates very long lines instead of blowing up the context", async () => {
    const long = "x".repeat(5000);
    const ctx = context({ "a.txt": `${long}\n` });
    const result = await readTool.execute(ctx, { path: "a.txt" });

    expect(result.content).toContain("[line truncated]");
    expect(result.content.length).toBeLessThan(2200);
  });

  it("does not invent a phantom line for a trailing newline", async () => {
    const ctx = context({ "a.txt": "single\n" });
    const result = await readTool.execute(ctx, { path: "a.txt" });

    expect(result.totalLines).toBe(1);
    expect(result.content).toBe("1: single");
  });
});
