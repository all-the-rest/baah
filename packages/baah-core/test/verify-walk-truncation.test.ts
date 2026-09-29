/**
 * `Workspace.walk` reports its own truncation.
 *
 * ## What was broken
 *
 * `walk()` used to return `AsyncIterable<DirEntry>` and cap itself at 50 000
 * entries **without saying so**. A consumer could count the entries that came
 * out, but "50 000 came out" cannot distinguish a walk that stopped from a walk
 * that finished, so both search tools mirrored the constant and guessed. The
 * measured consequence, from the verify round that found it: a workspace of
 * 50 051 files with the needle in the alphabetically last one produced
 * `grep` → `{ total: 0, matches: [], searchTruncated: false }` with the hint
 * *"No line matches … widen path"*. The tool asserted a completeness it had
 * not earned.
 *
 * ## What is pinned here
 *
 * 1. `truncated` is a fact about the **tree**, not about a counter: it is true
 *    only when the walk refused an entry it could have yielded.
 * 2. Both implementations of the interface (memory, directory) agree on it,
 *    because a caller must not have to know which workspace it was handed.
 * 3. A consumer that `break`s out of the `for await` still gets every cursor
 *    released — the generator's `finally` is the only thing standing between an
 *    early exit and a leaked `FileSystemDirectoryHandle` cursor.
 * 4. The conservative bias is explicit and lives in **one** function.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ENTRIES,
  createMemoryWorkspace,
  walkMayBeIncomplete,
  type DirEntry,
  type WalkResult,
  type Workspace,
} from "../src/workspace.ts";
import { createDirectoryWorkspace } from "../src/workspace/directory-workspace.ts";

/* ------------------------------------------------------------------ */
/* A File System Access API fake that counts its cursor releases       */
/* ------------------------------------------------------------------ */

interface FakeNode {
  kind: "file" | "directory";
  children: Map<string, FakeNode>;
}

function file(): FakeNode {
  return { kind: "file", children: new Map() };
}

function directory(children: Record<string, FakeNode> = {}): FakeNode {
  return { kind: "directory", children: new Map(Object.entries(children)) };
}

function domError(name: string): DOMException {
  return new DOMException(`fake ${name}`, name);
}

/** Per-directory bookkeeping: how often `values()` was opened and closed. */
interface CursorLedger {
  opened: number;
  released: number;
}

class FakeFileHandle {
  readonly kind = "file" as const;
  constructor(readonly name: string) {}
  async getFile(): Promise<File> {
    return { size: 1, lastModified: 0, text: async () => "x" } as unknown as File;
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;

  constructor(
    readonly name: string,
    private readonly node: FakeNode,
    readonly ledger: CursorLedger,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    const child = this.node.children.get(name);
    if (child === undefined) {
      if (options?.create !== true) throw domError("NotFoundError");
      const created = directory();
      this.node.children.set(name, created);
      return new FakeDirectoryHandle(name, created, this.ledger) as unknown as FileSystemDirectoryHandle;
    }
    if (child.kind !== "directory") throw domError("TypeMismatchError");
    return new FakeDirectoryHandle(name, child, this.ledger) as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string): Promise<FileSystemFileHandle> {
    const child = this.node.children.get(name);
    if (child === undefined) throw domError("NotFoundError");
    if (child.kind !== "file") throw domError("TypeMismatchError");
    return new FakeFileHandle(name) as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.node.children.delete(name)) throw domError("NotFoundError");
  }

  /**
   * A real cursor, not a generator: the `release` counter only moves when the
   * *caller* calls `return()`, which is exactly the property under test. An
   * async generator would report its own cleanup and make the assertion pass
   * for the wrong reason.
   */
  values(): AsyncIterableIterator<FileSystemHandle> {
    this.ledger.opened += 1;
    const children = [...this.node.children.entries()];
    let index = 0;
    let closed = false;
    const handle = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<FileSystemHandle>> {
        if (closed) return Promise.resolve({ done: true, value: undefined });
        const entry = children[index];
        index += 1;
        if (entry === undefined) {
          closed = true;
          return Promise.resolve({ done: true, value: undefined });
        }
        const [childName, child] = entry;
        const value =
          child.kind === "file"
            ? (new FakeFileHandle(childName) as unknown as FileSystemHandle)
            : (new FakeDirectoryHandle(childName, child, handle.ledger) as unknown as FileSystemDirectoryHandle);
        return Promise.resolve({ done: false, value });
      },
      async return(): Promise<IteratorResult<FileSystemHandle>> {
        // Counted even when the cursor already ran dry: what is under test is
        // "the walk asked to close every cursor it opened", and the walker
        // releases an exhausted cursor too.
        closed = true;
        handle.ledger.released += 1;
        return { done: true, value: undefined };
      },
    };
  }
}

/** `a.txt`, `sub/b.txt`, `sub/deep/c.txt` — five entries including the dirs. */
const TREE = directory({
  "a.txt": file(),
  sub: directory({ "b.txt": file(), deep: directory({ "c.txt": file() }) }),
});

function directoryWorkspace(ledger: CursorLedger): Workspace {
  const handle = new FakeDirectoryHandle("root", TREE, ledger) as unknown as FileSystemDirectoryHandle;
  return createDirectoryWorkspace(handle, { id: "fake", label: "fake", kind: "opfs" });
}

async function drain(walk: WalkResult): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walk.entries) paths.push(entry.path);
  return paths;
}

/** A tree of `count` files, the shape the cap tests need. */
function manyFiles(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    files[`f${String(index).padStart(5, "0")}.ts`] = "x\n";
  }
  return files;
}

/* ------------------------------------------------------------------ */

describe("truncated is a fact about the tree", () => {
  it("is false when the walk saw everything", async () => {
    const ws = createMemoryWorkspace(manyFiles(3));
    const walk = ws.walk(".");
    expect(await drain(walk)).toHaveLength(3);
    expect(walk.truncated).toBe(false);
    expect(walk.visited).toBe(3);
  });

  it("is true when the walk refused an entry it could have yielded", async () => {
    const ws = createMemoryWorkspace(manyFiles(3));
    const walk = ws.walk(".", { maxEntries: 2 });
    expect(await drain(walk)).toHaveLength(2);
    // This is the assertion a `truncated: false` constant would fail: the flag
    // is the whole point of the change.
    expect(walk.truncated).toBe(true);
    expect(walk.visited).toBe(2);
  });

  it("is false for a tree of exactly maxEntries — the walk did finish", async () => {
    // The boundary that a counter cannot get right. Three entries, a cap of
    // three: nothing was left behind, so this is not truncation.
    const ws = createMemoryWorkspace(manyFiles(3));
    const walk = ws.walk(".", { maxEntries: 3 });
    expect(await drain(walk)).toHaveLength(3);
    expect(walk.truncated).toBe(false);
  });

  it("is false when the cap is zero and the tree is empty", async () => {
    const walk = createMemoryWorkspace().walk(".", { maxEntries: 0 });
    expect(await drain(walk)).toEqual([]);
    expect(walk.truncated).toBe(false);
  });

  it("is true when the cap is zero and one entry exists", async () => {
    const walk = createMemoryWorkspace({ "a.ts": "x" }).walk(".", { maxEntries: 0 });
    expect(await drain(walk)).toEqual([]);
    expect(walk.truncated).toBe(true);
  });

  it("is false on an abort — the caller's signal stopped it, not the cap", async () => {
    const controller = new AbortController();
    const walk = createMemoryWorkspace(manyFiles(5)).walk(".", { signal: controller.signal });
    const paths: string[] = [];
    for await (const entry of walk.entries) {
      paths.push(entry.path);
      controller.abort();
    }
    expect(paths).toHaveLength(1);
    // Blaming the cap for the caller's own abort would be a different lie: it
    // would tell the model to narrow `path` when retrying is what it wanted.
    expect(walk.truncated).toBe(false);
  });

  it("the directory walk reports the same thing as the memory walk", async () => {
    // The contract belongs to the interface, not to one implementation. If the
    // two disagreed, every consumer would need to know which workspace it had.
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const whole = directoryWorkspace(ledger).walk(".");
    expect(await drain(whole)).toEqual(["a.txt", "sub", "sub/b.txt", "sub/deep", "sub/deep/c.txt"]);
    expect(whole.truncated).toBe(false);
    expect(whole.visited).toBe(5);

    const cut = directoryWorkspace(ledger).walk(".", { maxEntries: 3 });
    expect(await drain(cut)).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    expect(cut.visited).toBe(3);
  });

  it("charges the cap only for entries that pass the filter", async () => {
    const ws = createMemoryWorkspace(manyFiles(4));
    const walk = ws.walk(".", { maxEntries: 2, filter: (entry: DirEntry) => entry.path.endsWith(".ts") });
    expect(await drain(walk)).toHaveLength(2);
    expect(walk.truncated).toBe(true);
    expect(walk.visited).toBe(2);
  });
});

describe("the walk stays lazy", () => {
  it("resolves no directory handle until the entries are iterated", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const walk = directoryWorkspace(ledger).walk(".");
    // `walk()` is synchronous and total: it touched nothing.
    expect(ledger.opened).toBe(0);
    expect(walk.visited).toBe(0);
    await drain(walk);
    expect(ledger.opened).toBeGreaterThan(0);
  });
});

describe("cursors are released — including on an early break", () => {
  it("releases every cursor when the walk runs to the end", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    await drain(directoryWorkspace(ledger).walk("."));

    expect(ledger.opened).toBe(3);
    expect(ledger.released).toBe(3);
  });

  it("releases the cursor of the directory the consumer stopped in", async () => {
    // The `break` path. The generator is suspended at `yield`; the `for await`
    // protocol resumes it with a return completion, the `finally` runs, and the
    // stack is unwound. Without that, a search tool that stops after the tenth
    // match would leave a directory cursor open for the lifetime of the tab.
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const walk = directoryWorkspace(ledger).walk(".");

    for await (const entry of walk.entries) {
      if (entry.path === "a.txt") break;
    }

    expect(ledger.opened).toBe(1);
    expect(ledger.released).toBe(1);
  });

  it("releases the cursors of every directory it descended into on a break", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const walk = directoryWorkspace(ledger).walk(".");

    // Break on the fourth entry. The root's cursor has already run dry (and
    // was closed on the way out), `sub`'s is still open and suspended at the
    // `yield`; `sub/deep` has not been opened yet, because the walker pushes a
    // directory only *after* the consumer comes back for the next entry.
    const seen: string[] = [];
    for await (const entry of walk.entries) {
      seen.push(entry.path);
      if (entry.path === "sub/deep") break;
    }

    expect(seen).toEqual(["a.txt", "sub", "sub/b.txt", "sub/deep"]);
    expect(ledger.opened).toBe(2);
    expect(ledger.released).toBe(2);
  });

  it("releases on a throw out of the loop as well", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const walk = directoryWorkspace(ledger).walk(".");

    await expect(
      (async () => {
        for await (const entry of walk.entries) {
          if (entry.path === "sub") throw new Error("consumer gave up");
        }
      })(),
    ).rejects.toThrow(/consumer gave up/);

    // The root cursor was open and suspended at the yield of `sub`.
    expect(ledger.opened).toBe(1);
    expect(ledger.released).toBe(1);
  });

  it("releases the cursors when the cap stops the walk", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const walk = directoryWorkspace(ledger).walk(".", { maxEntries: 1 });
    await drain(walk);

    expect(walk.truncated).toBe(true);
    expect(ledger.released).toBe(ledger.opened);
  });

  it("releases the cursors on an abort", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const controller = new AbortController();
    const walk = directoryWorkspace(ledger).walk(".", { signal: controller.signal });
    for await (const entry of walk.entries) {
      void entry;
      controller.abort();
    }

    expect(ledger.released).toBe(ledger.opened);
  });

  it("a rejected root resolution is a rejection of the iteration, not of walk()", async () => {
    const ledger: CursorLedger = { opened: 0, released: 0 };
    const handle = new FakeDirectoryHandle(
      "root",
      directory(),
      ledger,
    ) as unknown as FileSystemDirectoryHandle;
    const workspace = createDirectoryWorkspace(handle, { id: "fake", label: "fake", kind: "opfs" });

    // `walk()` itself cannot reject — it is synchronous and touches nothing.
    const walk = workspace.walk("does-not-exist");
    await expect(drain(walk)).rejects.toThrow(/does-not-exist/);
    expect(ledger.opened).toBe(0);
  });
});

describe("the conservative bias, and where it lives", () => {
  it("flags a finished walk that consumed exactly maxEntries", async () => {
    // THE bias. The walk is honest — three entries, a cap of three, nothing
    // left behind — and a search tool still has to say "possibly incomplete",
    // because a consumer that landed exactly on the cap cannot rule out that
    // something else capped it. Over-reporting is the safe direction; the
    // opposite error trains a model to ignore the field.
    const walk = createMemoryWorkspace(manyFiles(3)).walk(".", { maxEntries: 3 });
    expect(await drain(walk)).toHaveLength(3);
    expect(walk.truncated).toBe(false);
    expect(walkMayBeIncomplete(walk, 3)).toBe(true);
  });

  it("does not flag a walk that finished below the cap", async () => {
    const walk = createMemoryWorkspace(manyFiles(2)).walk(".", { maxEntries: 3 });
    await drain(walk);
    expect(walk.truncated).toBe(false);
    expect(walkMayBeIncomplete(walk, 3)).toBe(false);
  });

  it("flags a truncated walk whatever the count says", async () => {
    const walk = createMemoryWorkspace(manyFiles(5)).walk(".", { maxEntries: 2 });
    await drain(walk);
    expect(walkMayBeIncomplete(walk, 2)).toBe(true);
  });

  it("reads the cap the walk actually applied, not a constant of its own", () => {
    // The reason this lives in the walk's module: a tool that re-derived the
    // cap here would be a third copy of a number that already drifted twice.
    const walk = createMemoryWorkspace(manyFiles(2)).walk(".");
    expect(walkMayBeIncomplete(walk)).toBe(false);
    expect(walkMayBeIncomplete(walk, DEFAULT_MAX_ENTRIES)).toBe(false);
  });

  it("an un-iterated walk is not incomplete", () => {
    // Nothing was looked at, so nothing can be missing *because of the walk*.
    // A tool that reports this as truncated would claim a partial search for a
    // search it never performed.
    const walk = createMemoryWorkspace(manyFiles(3)).walk(".");
    expect(walkMayBeIncomplete(walk)).toBe(false);
  });
});

describe("the cap has exactly one home in the package", () => {
  it("DEFAULT_MAX_ENTRIES is the value the walks apply", async () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(50_000);

    const below = createMemoryWorkspace(manyFiles(3));
    const walkBelow = below.walk(".");
    await drain(walkBelow);
    expect(walkBelow.truncated).toBe(false);

    // A workspace that fits under the default cap is never truncated by it,
    // however the cap is reached in the test.
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(3);
  });
});
