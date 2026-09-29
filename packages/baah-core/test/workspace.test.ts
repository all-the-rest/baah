import { describe, expect, it } from "vitest";

import { byteLength, createMemoryWorkspace, isWorkspaceRoot } from "../src/workspace.ts";

describe("createMemoryWorkspace — writeText contract", () => {
  it("creates missing parent directories", async () => {
    const ws = createMemoryWorkspace();
    await ws.writeText("a/b/c.txt", "x");

    expect(await ws.readText("a/b/c.txt")).toBe("x");
    expect((await ws.stat("a/b"))?.kind).toBe("directory");
  });

  it("overwrites an existing file", async () => {
    const ws = createMemoryWorkspace({ "a.txt": "old" });
    await ws.writeText("a.txt", "new");

    expect(await ws.readText("a.txt")).toBe("new");
  });

  it("rejects a target that is a directory", async () => {
    const ws = createMemoryWorkspace({ "sub/a.txt": "x" });
    await expect(ws.writeText("sub", "now a file")).rejects.toThrow(/Not a file/);

    expect((await ws.stat("sub"))?.kind).toBe("directory");
    expect(await ws.readText("sub/a.txt")).toBe("x");
  });

  it("rejects a path whose parent is a file", async () => {
    const ws = createMemoryWorkspace({ "a.txt": "file" });
    await expect(ws.writeText("a.txt/b.txt", "nested")).rejects.toThrow(
      /Not a directory/,
    );

    // The parent must still be a file — no half-applied state.
    expect((await ws.stat("a.txt"))?.kind).toBe("file");
    expect(await ws.stat("a.txt/b.txt")).toBeNull();
  });

  it("rejects the workspace root", async () => {
    const ws = createMemoryWorkspace();
    await expect(ws.writeText(".", "x")).rejects.toThrow(/workspace root/);
  });
});

describe("size is measured in UTF-8 bytes, not UTF-16 units", () => {
  it("counts multi-byte characters correctly", async () => {
    const ws = createMemoryWorkspace({ "u.txt": "ä" });
    expect(byteLength("ä")).toBe(2);
    expect((await ws.stat("u.txt"))?.size).toBe(2);
  });

  it("reports byte sizes in list()", async () => {
    const ws = createMemoryWorkspace({ "emoji.txt": "😀" });
    const entries = await ws.list(".");
    expect(entries.find((e) => e.name === "emoji.txt")?.size).toBe(4);
  });
});

describe("isWorkspaceRoot", () => {
  it("recognises every spelling of the root", () => {
    expect(isWorkspaceRoot(".")).toBe(true);
    expect(isWorkspaceRoot("")).toBe(true);
    expect(isWorkspaceRoot("/")).toBe(true);
    expect(isWorkspaceRoot("./a")).toBe(false);
    expect(isWorkspaceRoot("a")).toBe(false);
  });
});

describe("walk", () => {
  it("yields files and directories and honours the filter", async () => {
    const ws = createMemoryWorkspace({
      "src/a.ts": "a",
      "src/b.ts": "b",
      "README.md": "r",
    });
    const all: string[] = [];
    const walked = ws.walk(".");
    for await (const entry of walked.entries) all.push(entry.path);

    expect(all).toContain("src/a.ts");
    expect(all).toContain("README.md");
    expect(walked.truncated).toBe(false);
    expect(walked.visited).toBe(4);

    const onlyTs: string[] = [];
    const filtered = ws.walk(".", { filter: (e) => e.path.endsWith(".ts") });
    for await (const entry of filtered.entries) {
      onlyTs.push(entry.path);
    }
    expect(onlyTs.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // The filter runs *before* the cap is charged, so `visited` counts what was
    // yielded, not what was examined.
    expect(filtered.visited).toBe(2);
  });

  it("stops when the signal is aborted", async () => {
    const ws = createMemoryWorkspace({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    const controller = new AbortController();
    const seen: string[] = [];
    const walked = ws.walk(".", { signal: controller.signal });
    for await (const entry of walked.entries) {
      seen.push(entry.path);
      controller.abort();
    }
    expect(seen).toHaveLength(1);
    // An abort is not truncation: the caller aborted it and the walk did not
    // run out of tree. Reporting it as `truncated` would blame the cap for
    // something the caller's own signal did.
    expect(walked.truncated).toBe(false);
    expect(walked.visited).toBe(1);
  });

  it("produces a complete result object before anything is iterated", () => {
    // `DirectoryWorkspace.walk` resolves the root handle lazily, on the first
    // `next()`. The result is therefore usable — and honest about having seen
    // nothing — before the first entry exists.
    const ws = createMemoryWorkspace({ "a.txt": "a" });
    const walked = ws.walk(".");
    expect(walked.truncated).toBe(false);
    expect(walked.visited).toBe(0);
  });
});
