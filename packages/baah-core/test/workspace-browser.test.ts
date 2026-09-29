/**
 * Tests for the browser workspace implementations — in Node, without a browser.
 *
 * There is no OPFS and no File System Access API here, so the tests inject a
 * **fake `FileSystemDirectoryHandle`** that throws real `DOMException`s (Node
 * has `DOMException`, so the names are the ones the browser throws). That
 * covers everything that is *our* logic: the segment-by-segment handle walk,
 * the `NotFoundError` vs. `TypeMismatchError` distinction, the `writeText`
 * contract, the iterative walker, the permission state machine and the
 * `navigator.storage` wiring.
 *
 * What this file deliberately does **not** prove belongs to the manual
 * checklist in `Plan.md` §9: real handle behaviour, real `createWritable()`
 * atomicity, real eviction and the real permission prompt.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceError } from "../src/workspace.ts";
import { translateHandleError } from "../src/workspace/errors.ts";
import {
  createFileSystemAccessWorkspace,
  PERMISSION_REQUIRES_USER_GESTURE,
} from "../src/workspace/file-system-access.ts";
import { createOpfsWorkspace } from "../src/workspace/opfs.ts";
import { resolveDirectory, resolveFile, resolveWorkspacePath } from "../src/workspace/paths.ts";
import type { Workspace } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// A minimal in-memory File System Access API
// ---------------------------------------------------------------------------

interface FakeNode {
  kind: "file" | "directory";
  content: string;
  children: Map<string, FakeNode>;
}

function file(content: string): FakeNode {
  return { kind: "file", content, children: new Map() };
}

function directory(children: Record<string, FakeNode> = {}): FakeNode {
  return {
    kind: "directory",
    content: "",
    children: new Map(Object.entries(children)),
  };
}

function domError(name: string): DOMException {
  return new DOMException(`fake ${name}`, name);
}

/** Tracks how many file handles `getFile()` keeps open at the same time. */
const openFileTracker = { active: 0, peak: 0 };

class FakeFileHandle {
  readonly kind = "file" as const;

  constructor(
    readonly name: string,
    private readonly node: FakeNode,
  ) {}

  async getFile(): Promise<File> {
    openFileTracker.active += 1;
    openFileTracker.peak = Math.max(openFileTracker.peak, openFileTracker.active);
    // Yield so overlapping calls really do overlap.
    await Promise.resolve();
    openFileTracker.active -= 1;
    return {
      size: new TextEncoder().encode(this.node.content).length,
      lastModified: 1_700_000_000_000,
      text: async () => this.node.content,
    } as unknown as File;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    return {
      write: async (data: string) => {
        this.node.content = data;
      },
      close: async () => {},
      abort: async () => {},
    } as unknown as FileSystemWritableFileStream;
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;

  constructor(
    readonly name: string,
    private readonly node: FakeNode,
    private readonly permission?: {
      query?: () => Promise<"granted" | "denied" | "prompt">;
      request?: () => Promise<"granted" | "denied" | "prompt">;
    },
  ) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    const child = this.node.children.get(name);
    if (child === undefined) {
      if (options?.create !== true) throw domError("NotFoundError");
      const created = directory();
      this.node.children.set(name, created);
      return new FakeDirectoryHandle(name, created) as unknown as FileSystemDirectoryHandle;
    }
    if (child.kind !== "directory") throw domError("TypeMismatchError");
    return new FakeDirectoryHandle(name, child) as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle> {
    const child = this.node.children.get(name);
    if (child === undefined) {
      if (options?.create !== true) throw domError("NotFoundError");
      const created = file("");
      this.node.children.set(name, created);
      return new FakeFileHandle(name, created) as unknown as FileSystemFileHandle;
    }
    if (child.kind !== "file") throw domError("TypeMismatchError");
    return new FakeFileHandle(name, child) as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const child = this.node.children.get(name);
    if (child === undefined) throw domError("NotFoundError");
    if (child.kind === "directory" && child.children.size > 0 && options?.recursive !== true) {
      throw domError("InvalidModificationError");
    }
    this.node.children.delete(name);
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for (const [childName, child] of this.node.children) {
      yield (
        child.kind === "file"
          ? new FakeFileHandle(childName, child)
          : new FakeDirectoryHandle(childName, child)
      ) as unknown as FileSystemHandle;
    }
  }

  queryPermission(): Promise<"granted" | "denied" | "prompt"> {
    if (this.permission?.query === undefined) {
      return Promise.reject(new DOMException("no permission api", "NotAllowedError"));
    }
    return this.permission.query();
  }

  requestPermission(): Promise<"granted" | "denied" | "prompt"> {
    if (this.permission?.request === undefined) {
      return Promise.reject(new DOMException("no user activation", "SecurityError"));
    }
    return this.permission.request();
  }
}

function makeRoot(permission?: {
  query?: () => Promise<"granted" | "denied" | "prompt">;
  request?: () => Promise<"granted" | "denied" | "prompt">;
}): { handle: FileSystemDirectoryHandle; node: FakeNode } {
  const node = directory({
    "a.txt": file("hello"),
    "sub": directory({ "b.txt": file("world") }),
    "empty": directory(),
  });
  return {
    handle: new FakeDirectoryHandle("root", node, permission) as unknown as FileSystemDirectoryHandle,
    node,
  };
}

function makeWorkspace(permission?: {
  query?: () => Promise<"granted" | "denied" | "prompt">;
  request?: () => Promise<"granted" | "denied" | "prompt">;
}) {
  const { handle, node } = makeRoot(permission);
  return {
    node,
    workspace: createFileSystemAccessWorkspace(handle, { label: "project" }),
  };
}

async function captureError(run: () => Promise<unknown>): Promise<WorkspaceError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof WorkspaceError) return error;
    throw error;
  }
  throw new Error("expected a WorkspaceError, but the call resolved");
}

// ---------------------------------------------------------------------------
// The path walk (paths.ts)
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath", () => {
  it("normalises the three spellings of the root", () => {
    expect(resolveWorkspacePath(".", ".")).toBe(".");
    expect(resolveWorkspacePath(".", "")).toBe(".");
    expect(resolveWorkspacePath(".", "/")).toBe(".");
  });

  it("collapses `.` and duplicate separators", () => {
    expect(resolveWorkspacePath(".", "sub//b.txt")).toBe("sub/b.txt");
    expect(resolveWorkspacePath(".", "./sub/./b.txt")).toBe("sub/b.txt");
  });

  it("refuses to escape the root", () => {
    const error = (() => {
      try {
        resolveWorkspacePath(".", "../secrets.txt");
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toMatch(/escapes the workspace root/);
    expect((error as WorkspaceError).code).toBe("unsupported");
  });

  it("refuses a deeper escape after normalisation", () => {
    expect(() => resolveWorkspacePath(".", "a/../../b.txt")).toThrow(/escapes the workspace root/);
  });
});

describe("resolveDirectory / resolveFile", () => {
  it("resolves a nested file and hands back its parent", async () => {
    const { handle } = makeRoot();
    const resolved = await resolveFile(handle, "sub/b.txt");

    expect(resolved.path).toBe("sub/b.txt");
    expect(resolved.name).toBe("b.txt");
    expect(await (await resolved.parent.getFileHandle("b.txt")).getFile()).toHaveProperty(
      "size",
      5,
    );
  });

  it("returns the root for the root path", async () => {
    const { handle } = makeRoot();
    expect(await resolveDirectory(handle, ".")).toBe(handle);
  });

  it("reports a missing file as not_found", async () => {
    const { handle } = makeRoot();
    const error = await captureError(() => resolveFile(handle, "missing.txt"));

    expect(error.code).toBe("not_found");
    expect(error.message).toBe("File not found: missing.txt");
  });

  it("reports a missing directory as not_found and names the directory", async () => {
    const { handle } = makeRoot();
    const error = await captureError(() => resolveDirectory(handle, "nope/deeper"));

    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Directory not found: nope");
  });

  it("reports a file where a directory is expected as not_a_directory", async () => {
    const { handle } = makeRoot();
    const error = await captureError(() => resolveDirectory(handle, "a.txt"));

    expect(error.code).toBe("not_a_directory");
    expect(error.message).toBe("Not a directory: a.txt");
  });

  it("reports a directory where a file is expected as not_a_file", async () => {
    const { handle } = makeRoot();
    const error = await captureError(() => resolveFile(handle, "sub"));

    expect(error.code).toBe("not_a_file");
    expect(error.message).toBe("Not a file: sub");
  });

  it("refuses to leave the root", async () => {
    const { handle } = makeRoot();
    await expect(resolveFile(handle, "../outside.txt")).rejects.toThrow(
      /escapes the workspace root/,
    );
    await expect(resolveDirectory(handle, "..")).rejects.toThrow(
      /escapes the workspace root/,
    );
  });

  it("resolves an inner `..` instead of looking it up as a name", async () => {
    const { handle } = makeRoot();
    const resolved = await resolveFile(handle, "sub/../a.txt");

    expect(resolved.path).toBe("a.txt");
    expect(await (await resolved.handle.getFile()).text()).toBe("hello");
  });

  it("never creates a parent implicitly", async () => {
    const { handle, node } = makeRoot();
    await expect(resolveFile(handle, "made/up.txt", { create: true })).rejects.toThrow(
      /Directory not found: made/,
    );
    expect(node.children.has("made")).toBe(false);
  });

  it("creates the file itself when asked to", async () => {
    const { handle, node } = makeRoot();
    await resolveFile(handle, "created.txt", { create: true });

    expect(node.children.get("created.txt")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// translateHandleError (errors.ts)
// ---------------------------------------------------------------------------

describe("translateHandleError", () => {
  it("maps NotFoundError to not_found and says what kind was missing", () => {
    expect(translateHandleError(domError("NotFoundError"), "a/b.ts", "file")).toMatchObject({
      code: "not_found",
      message: "File not found: a/b.ts",
    });
    expect(translateHandleError(domError("NotFoundError"), "a/b", "directory").message).toBe(
      "Directory not found: a/b",
    );
  });

  it("maps TypeMismatchError to not_a_directory / not_a_file depending on intent", () => {
    expect(translateHandleError(domError("TypeMismatchError"), "a.txt", "directory")).toMatchObject(
      { code: "not_a_directory", message: "Not a directory: a.txt" },
    );
    expect(translateHandleError(domError("TypeMismatchError"), "sub", "file")).toMatchObject({
      code: "not_a_file",
      message: "Not a file: sub",
    });
  });

  it("maps NotAllowedError to a message that names the permission fix", () => {
    const error = translateHandleError(domError("NotAllowedError"), "a.txt", "file");
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/Permission denied: a\.txt/);
    expect(error.message).toMatch(/requestPermission/);
  });

  it("maps SecurityError to a message that names the user-gesture requirement", () => {
    const error = translateHandleError(domError("SecurityError"), "a.txt", "file");
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/user gesture/);
  });

  it("maps QuotaExceededError to an actionable message", () => {
    const error = translateHandleError(domError("QuotaExceededError"), "big.bin", "file");
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/quota/i);
  });

  it("maps InvalidModificationError to exists for a non-empty directory", () => {
    const error = translateHandleError(domError("InvalidModificationError"), "sub", "directory");
    expect(error.code).toBe("exists");
    expect(error.message).toMatch(/Directory not empty: sub/);
  });

  it("maps AbortError to a message about the abort", () => {
    const error = translateHandleError(domError("AbortError"), "a.txt", "file");
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/aborted/i);
  });

  it("rethrows anything that is not a known platform error", () => {
    const bug = new TypeError("cannot read properties of undefined");
    expect(() => translateHandleError(bug, "a.txt", "file")).toThrow(bug);

    const existing = new WorkspaceError("already translated", "not_found");
    expect(() => translateHandleError(existing, "a.txt", "file")).toThrow(existing);
  });
});

// ---------------------------------------------------------------------------
// The shared Workspace contract on a picked directory
// ---------------------------------------------------------------------------

describe("createFileSystemAccessWorkspace — Workspace contract", () => {
  it("describes itself as a local directory", () => {
    const { workspace } = makeWorkspace();
    expect(workspace.describe()).toMatchObject({
      label: "project",
      kind: "local-directory",
    });
  });

  it("rejects a handle that is not a directory handle", () => {
    const notADirectory = { kind: "file", name: "x", getFile: () => undefined };
    expect(() =>
      createFileSystemAccessWorkspace(
        notADirectory as unknown as FileSystemDirectoryHandle,
      ),
    ).toThrow(/FileSystemDirectoryHandle/);
  });

  it("reads a nested file", async () => {
    const { workspace } = makeWorkspace();
    expect(await workspace.readText("sub/b.txt")).toBe("world");
  });

  it("rejects reading a missing file with a model-actionable message", async () => {
    const { workspace } = makeWorkspace();
    const error = await captureError(() => workspace.readText("sub/nope.txt"));
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("File not found: sub/nope.txt");
  });

  it("rejects reading a directory", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.readText("sub")).rejects.toThrow(/Not a file/);
  });

  it("stats files, directories and the root", async () => {
    const { workspace } = makeWorkspace();

    expect(await workspace.stat(".")).toEqual({
      kind: "directory",
      size: 0,
      lastModified: 0,
    });
    expect(await workspace.stat("a.txt")).toMatchObject({ kind: "file", size: 5 });
    expect(await workspace.stat("sub")).toMatchObject({ kind: "directory", size: 0 });
    expect(await workspace.stat("nope")).toBeNull();
  });

  it("exists() agrees with stat()", async () => {
    const { workspace } = makeWorkspace();
    expect(await workspace.exists(".")).toBe(true);
    expect(await workspace.exists("a.txt")).toBe(true);
    expect(await workspace.exists("nope.txt")).toBe(false);
  });

  it("lists a directory and reports byte sizes", async () => {
    const { workspace } = makeWorkspace();
    const entries = await workspace.list(".");

    expect(entries.map((entry) => entry.path)).toEqual(["a.txt", "empty", "sub"]);
    expect(entries.find((entry) => entry.name === "a.txt")?.size).toBe(5);
    expect(entries.find((entry) => entry.name === "sub")?.size).toBeUndefined();
  });

  it("refuses to escape the root", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.readText("../secrets.txt")).rejects.toThrow(
      /escapes the workspace root/,
    );
    await expect(workspace.list("../..")).rejects.toThrow(/escapes the workspace root/);
  });

  it("writes a file, creating parents like mkdir -p", async () => {
    const { workspace } = makeWorkspace();
    await workspace.writeText("new/deep/file.txt", "written");

    expect(await workspace.readText("new/deep/file.txt")).toBe("written");
    expect((await workspace.stat("new/deep"))?.kind).toBe("directory");
  });

  it("overwrites an existing file", async () => {
    const { workspace } = makeWorkspace();
    await workspace.writeText("a.txt", "replaced");
    expect(await workspace.readText("a.txt")).toBe("replaced");
  });

  it("refuses to replace a directory with a file", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.writeText("sub", "now a file")).rejects.toThrow(/Not a file/);
    expect((await workspace.stat("sub"))?.kind).toBe("directory");
  });

  it("refuses to write through a file, leaving no half-applied state", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.writeText("a.txt/nested.txt", "x")).rejects.toThrow(
      /Not a directory: a\.txt/,
    );

    expect(await workspace.readText("a.txt")).toBe("hello");
    expect(await workspace.stat("a.txt/nested.txt")).toBeNull();
  });

  it("refuses to write to the root", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.writeText(".", "x")).rejects.toThrow(/workspace root/);
  });

  it("removes a file", async () => {
    const { workspace } = makeWorkspace();
    await workspace.remove("a.txt");
    expect(await workspace.exists("a.txt")).toBe(false);
  });

  it("refuses to remove a non-empty directory without recursive", async () => {
    const { workspace } = makeWorkspace();
    const error = await captureError(() => workspace.remove("sub"));
    expect(error.code).toBe("exists");
    expect(error.message).toMatch(/Directory not empty/);

    await workspace.remove("sub", { recursive: true });
    expect(await workspace.exists("sub")).toBe(false);
  });

  it("refuses to remove something that is not there", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.remove("nope.txt")).rejects.toThrow(/Not found/);
  });

  it("refuses to remove the root", async () => {
    const { workspace } = makeWorkspace();
    await expect(workspace.remove(".")).rejects.toThrow(/workspace root/);
  });
});

describe("list caps concurrently open file handles", () => {
  it("never exceeds maxOpenFileHandles", async () => {
    const node = directory(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`f${index}.txt`, file("x")]),
      ),
    );
    const handle = new FakeDirectoryHandle(
      "root",
      node,
    ) as unknown as FileSystemDirectoryHandle;
    const workspace = createFileSystemAccessWorkspace(handle, { maxOpenFileHandles: 3 });

    openFileTracker.active = 0;
    openFileTracker.peak = 0;
    const entries = await workspace.list(".");

    expect(entries).toHaveLength(12);
    expect(openFileTracker.peak).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// walk
// ---------------------------------------------------------------------------

describe("walk", () => {
  const tree = () =>
    directory({
      "a.txt": file("a"),
      "sub": directory({ "b.txt": file("b"), "deep": directory({ "c.txt": file("c") }) }),
    });

  function walkWorkspace() {
    const handle = new FakeDirectoryHandle(
      "root",
      tree(),
    ) as unknown as FileSystemDirectoryHandle;
    return createFileSystemAccessWorkspace(handle);
  }

  it("yields the whole tree, depth first", async () => {
    const workspace = walkWorkspace();
    const seen: string[] = [];
    for await (const entry of workspace.walk(".")) seen.push(entry.path);

    expect(seen).toEqual(["a.txt", "sub", "sub/b.txt", "sub/deep", "sub/deep/c.txt"]);
  });

  it("starts at a subdirectory", async () => {
    const workspace = walkWorkspace();
    const seen: string[] = [];
    for await (const entry of workspace.walk("sub")) seen.push(entry.path);

    expect(seen).toEqual(["sub/b.txt", "sub/deep", "sub/deep/c.txt"]);
  });

  it("honours maxEntries", async () => {
    const workspace = walkWorkspace();
    const seen: string[] = [];
    for await (const entry of workspace.walk(".", { maxEntries: 2 })) seen.push(entry.path);

    expect(seen).toHaveLength(2);
  });

  it("honours the filter and prunes a rejected directory", async () => {
    const workspace = walkWorkspace();
    const seen: string[] = [];
    for await (const entry of workspace.walk(".", { filter: (e) => e.name !== "sub" })) {
      seen.push(entry.path);
    }

    expect(seen).toEqual(["a.txt"]);
  });

  it("stops when the signal is aborted", async () => {
    const workspace = walkWorkspace();
    const controller = new AbortController();
    const seen: string[] = [];

    for await (const entry of workspace.walk(".", { signal: controller.signal })) {
      seen.push(entry.path);
      controller.abort();
    }

    expect(seen).toHaveLength(1);
  });

  it("survives a tree deeper than the call stack would", async () => {
    // 2000 levels: a recursive `async function*` would blow up here, the
    // iterative walker must not.
    const deep = directory();
    let cursor = deep;
    for (let index = 0; index < 2000; index += 1) {
      const child = directory();
      cursor.children.set("d", child);
      cursor = child;
    }
    cursor.children.set("leaf.txt", file("bottom"));

    const handle = new FakeDirectoryHandle(
      "root",
      directory({ deep }),
    ) as unknown as FileSystemDirectoryHandle;
    const workspace = createFileSystemAccessWorkspace(handle);

    let count = 0;
    for await (const entry of workspace.walk(".")) {
      if (entry.path.endsWith("leaf.txt")) count += 1;
    }

    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Permission state machine (file-system-access.ts)
// ---------------------------------------------------------------------------

describe("ensurePermission", () => {
  it("returns granted without prompting when it already is", async () => {
    const request = vi.fn(async () => "granted" as const);
    const { workspace } = makeWorkspace({ query: async () => "granted", request });

    expect(await workspace.ensurePermission(true)).toEqual({ state: "granted" });
    expect(request).not.toHaveBeenCalled();
    expect(workspace.describe().writable).toBe(true);
  });

  it("prompts when the state is prompt, and reports the grant", async () => {
    const request = vi.fn(async () => "granted" as const);
    const { workspace } = makeWorkspace({ query: async () => "prompt", request });

    expect(await workspace.ensurePermission(false)).toEqual({ state: "granted" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal without throwing", async () => {
    const { workspace } = makeWorkspace({ query: async () => "prompt", request: async () => "denied" });

    const result = await workspace.ensurePermission(true);
    expect(result.state).toBe("denied");
    expect(result.reason).toBeTruthy();
    expect(workspace.describe().writable).toBe(false);
  });

  it("surfaces a SecurityError as unsupported with the user-gesture hint", async () => {
    // A Worker cannot prompt: requestPermission() throws SecurityError.
    const { workspace } = makeWorkspace({
      query: async () => "prompt",
      request: async () => {
        throw new DOMException("no activation", "SecurityError");
      },
    });

    const result = await workspace.ensurePermission(true);
    expect(result.state).toBe("unsupported");
    expect(result.reason).toBe(PERMISSION_REQUIRES_USER_GESTURE);
  });

  it("refreshPermission() reads the state without prompting", async () => {
    const request = vi.fn(async () => "granted" as const);
    const { workspace } = makeWorkspace({ query: async () => "prompt", request });

    expect(await workspace.refreshPermission(true)).toMatchObject({ state: "prompt" });
    expect(request).not.toHaveBeenCalled();
    expect(workspace.describe().writable).toBe(false);
  });

  it("describes itself as unwritable until the permission is known", () => {
    const { workspace } = makeWorkspace({ query: async () => "granted" });
    expect(workspace.describe().writable).toBe(false);
    expect(workspace.describe().kind).toBe("local-directory");
  });
});

// ---------------------------------------------------------------------------
// OPFS (opfs.ts)
// ---------------------------------------------------------------------------

describe("createOpfsWorkspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(overrides: Partial<StorageManager> = {}): {
    persist: ReturnType<typeof vi.fn>;
    getDirectory: ReturnType<typeof vi.fn>;
  } {
    const node = directory();
    const opfsRoot = new FakeDirectoryHandle(
      "opfs",
      node,
    ) as unknown as FileSystemDirectoryHandle;
    const persist = vi.fn(async () => true);
    const getDirectory = vi.fn(async () => opfsRoot);

    vi.stubGlobal("navigator", {
      storage: {
        getDirectory,
        persist,
        persisted: async () => false,
        estimate: async () => ({ usage: 10, quota: 1000 }),
        ...overrides,
      },
    });

    return { persist, getDirectory };
  }

  it("uses navigator.storage.getDirectory() and a per-workspace subdirectory", async () => {
    const { getDirectory } = stubStorage();
    const workspace = await createOpfsWorkspace({ directoryName: "proj-1" });

    expect(getDirectory).toHaveBeenCalledTimes(1);
    expect(workspace.describe()).toMatchObject({
      label: "proj-1",
      kind: "opfs",
      writable: true,
    });
    expect(workspace.id).toBe("opfs:proj-1");
  });

  it("asks for persistent storage and reports the answer", async () => {
    const { persist } = stubStorage();
    const workspace = await createOpfsWorkspace();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(workspace.describe().persisted).toBe(true);
  });

  it("does not ask again when the origin is already persistent", async () => {
    const { persist } = stubStorage({ persisted: async () => true });
    const workspace = await createOpfsWorkspace();

    expect(persist).not.toHaveBeenCalled();
    expect(workspace.describe().persisted).toBe(true);
  });

  it("can skip the persistence request", async () => {
    const { persist } = stubStorage();
    const workspace = await createOpfsWorkspace({ requestPersistence: false });

    expect(persist).not.toHaveBeenCalled();
    expect(workspace.describe().persisted).toBe(false);
  });

  it("honours a refused persistence request", async () => {
    stubStorage({ persist: async () => false });
    const workspace = await createOpfsWorkspace();

    expect(workspace.describe().persisted).toBe(false);
  });

  it("works as a real Workspace", async () => {
    stubStorage();
    const workspace: Workspace = await createOpfsWorkspace();

    await workspace.writeText("src/app.ts", "export const a = 1;\n");
    expect(await workspace.readText("src/app.ts")).toBe("export const a = 1;\n");
    expect((await workspace.stat("src"))?.kind).toBe("directory");
    expect(await workspace.exists("nope")).toBe(false);
  });

  it("reports the storage estimate for the eviction warning", async () => {
    stubStorage();
    const workspace = await createOpfsWorkspace();

    expect(await workspace.estimate()).toEqual({ usage: 10, quota: 1000 });
  });

  it("explains itself when the browser has no OPFS", async () => {
    vi.stubGlobal("navigator", {});
    await expect(createOpfsWorkspace()).rejects.toThrow(/Origin Private File System/);
  });
});
