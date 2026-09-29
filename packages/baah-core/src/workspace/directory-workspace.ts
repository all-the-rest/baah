/**
 * The `Workspace` implementation that sits on top of *any* root
 * `FileSystemDirectoryHandle` — an OPFS sandbox directory or a folder the user
 * picked with `showDirectoryPicker()`.
 *
 * There is exactly one of these two: the platform difference is not "how do I
 * read a file" but "where does the root come from" and "may I ask for
 * permission". Splitting that out here means the FS semantics (mkdir -p on
 * write, the `writeText` rejections, the walk) are written and reviewed once,
 * and only the parts that genuinely differ live in `opfs.ts` and
 * `file-system-access.ts`.
 *
 * The walker is **iterative on purpose**: a recursive `async function*` would
 * put one frame per directory level on the stack, and a pathological tree must
 * not be able to take the tab down.
 *
 * The returned object has no `this` usage, so `file-system-access.ts` can
 * spread it and add the permission API without re-binding methods.
 */

import { dirnamePath } from "../path.ts";
import {
  isWorkspaceRoot,
  WorkspaceError,
  type DirEntry,
  type FileStat,
  type RemoveOptions,
  type WalkOptions,
  type Workspace,
} from "../workspace.ts";
import { guardHandle, isMissingError, translateHandleError } from "./errors.ts";
import {
  ensureDirectory,
  fileSize,
  isDirectoryHandle,
  isFileHandle,
  resolveDirectory,
  resolveFile,
  resolveWorkspacePath,
} from "./paths.ts";

/** Mirrors the `kind` recorded in the `workspaces` table (Plan.md §6.1). */
export type WorkspaceKind = "memory" | "opfs" | "local-directory";

/** What the UI needs to render a workspace card. */
export interface WorkspaceDescription {
  readonly label: string;
  readonly kind: WorkspaceKind;
  /**
   * Whether the workspace can be written to *right now*. Always `true` for
   * OPFS; for a picked directory it reflects the last permission check, which
   * is why `FileSystemAccessWorkspace` also exposes `refreshPermission()`.
   */
  readonly writable: boolean;
}

export interface DirectoryWorkspace extends Workspace {
  /** The directory every root-relative path is resolved against. */
  readonly root: FileSystemDirectoryHandle;
  describe(): WorkspaceDescription;
}

export interface DirectoryWorkspaceOptions {
  readonly id: string;
  readonly label: string;
  readonly kind: WorkspaceKind;
  /**
   * Upper bound on file handles held open at the same time while resolving
   * sizes in `list()`. Browsers run out of file handles; the tab must not be
   * the thing that hits the limit.
   */
  readonly maxOpenFileHandles?: number;
}

const DEFAULT_MAX_OPEN_FILE_HANDLES = 16;
/** Same default as `createMemoryWorkspace`, so both behave alike. */
const DEFAULT_MAX_ENTRIES = 50_000;

function toDirEntry(handle: FileSystemHandle, path: string): DirEntry {
  return { path, name: handle.name, kind: handle.kind };
}

function joinChild(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/** `map` with a hard cap on how many promises are in flight at once. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/** `stat` for one child of an already-resolved parent directory. */
async function statIn(
  parent: FileSystemDirectoryHandle,
  name: string,
  path: string,
): Promise<FileStat | null> {
  try {
    const handle = await guardHandle(path, "file", () => parent.getFileHandle(name));
    if (isFileHandle(handle)) {
      const file = await guardHandle(path, "file", () => handle.getFile());
      return { kind: "file", size: file.size, lastModified: file.lastModified };
    }
  } catch (error) {
    // `not_a_file` here only means "it is a directory" — keep probing.
    if (!isMissingError(error)) throw error;
  }

  try {
    const handle = await guardHandle(path, "directory", () => parent.getDirectoryHandle(name));
    if (isDirectoryHandle(handle)) return { kind: "directory", size: 0, lastModified: 0 };
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  return null;
}

interface WalkFrame {
  readonly handle: FileSystemDirectoryHandle;
  /** `""` for the root, otherwise `"<dir path>/"`. */
  readonly prefix: string;
  iterator?: AsyncIterator<FileSystemHandle>;
}

export function createDirectoryWorkspace(
  root: FileSystemDirectoryHandle,
  options: DirectoryWorkspaceOptions,
): DirectoryWorkspace {
  const maxOpenFileHandles = options.maxOpenFileHandles ?? DEFAULT_MAX_OPEN_FILE_HANDLES;

  const stat = async (path: string): Promise<FileStat | null> => {
    const target = resolveWorkspacePath(".", path);
    if (isWorkspaceRoot(target)) return { kind: "directory", size: 0, lastModified: 0 };

    const segments = segmentsOf(target);
    const name = segments.pop();
    if (name === undefined) return null;

    // A missing *parent* is as much "not found" as a missing leaf.
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await resolveDirectory(root, segments.join("/"));
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
    return statIn(parent, name, target);
  };

  const list = async (path: string): Promise<DirEntry[]> => {
    const target = resolveWorkspacePath(".", path);
    const handle = await resolveDirectory(root, target);

    const children: FileSystemHandle[] = [];
    await guardHandle(target, "directory", async () => {
      for await (const child of handle.values()) children.push(child);
    });
    children.sort((a, b) => a.name.localeCompare(b.name));

    return mapWithLimit(children, maxOpenFileHandles, async (child) => {
      const entry = toDirEntry(child, joinChild(target, child.name));
      if (!isFileHandle(child)) return entry;
      return { ...entry, size: await fileSize(child, entry.path) };
    });
  };

  const readText = async (path: string): Promise<string> => {
    const target = resolveWorkspacePath(".", path);
    if (isWorkspaceRoot(target)) {
      throw new WorkspaceError(`Not a file: ${target}`, "not_a_file");
    }
    const { handle } = await resolveFile(root, target);
    const file = await guardHandle(target, "file", () => handle.getFile());
    return guardHandle(target, "file", () => file.text());
  };

  const writeText = async (path: string, content: string): Promise<void> => {
    const target = resolveWorkspacePath(".", path);
    if (isWorkspaceRoot(target)) {
      throw new WorkspaceError(`Cannot write to the workspace root: ${target}`, "unsupported");
    }

    // Contract: an existing directory is never replaced by a file.
    const existing = await stat(target);
    if (existing?.kind === "directory") {
      throw new WorkspaceError(`Not a file: ${target}`, "not_a_file");
    }

    // `mkdir -p` for the parents. OPFS does *not* create them implicitly.
    await ensureDirectory(root, dirnamePath(target));
    const { handle } = await resolveFile(root, target, { create: true });

    const writable = await guardHandle(target, "file", () => handle.createWritable());
    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort?.(String(error));
      } catch {
        // The original failure is the one worth reporting; the abort is best
        // effort so the platform does not keep a temp file around.
      }
      throw translateHandleError(error, target, "file");
    }
  };

  const remove = async (path: string, removeOptions?: RemoveOptions): Promise<void> => {
    const target = resolveWorkspacePath(".", path);
    if (isWorkspaceRoot(target)) {
      throw new WorkspaceError(`Cannot remove the workspace root: ${target}`, "unsupported");
    }

    const segments = segmentsOf(target);
    const name = segments.pop();
    if (name === undefined) return;

    const parent = await resolveDirectory(root, segments.join("/"));
    const found = await statIn(parent, name, target);
    if (found === null) throw new WorkspaceError(`Not found: ${target}`, "not_found");

    await guardHandle(target, found.kind === "directory" ? "directory" : "file", () =>
      parent.removeEntry(name, removeOptions?.recursive ? { recursive: true } : undefined),
    );
  };

  const walk = async function* (
    directory = ".",
    walkOptions: WalkOptions = {},
  ): AsyncGenerator<DirEntry> {
    const maxEntries = walkOptions.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const start = resolveWorkspacePath(".", directory);
    const startHandle = await resolveDirectory(root, start);

    const stack: WalkFrame[] = [
      { handle: startHandle, prefix: isWorkspaceRoot(start) ? "" : `${start}/` },
    ];
    let visited = 0;

    try {
      while (stack.length > 0) {
        if (walkOptions.signal?.aborted) return;

        const frame = stack[stack.length - 1];
        if (frame === undefined) return;
        frame.iterator ??= frame.handle.values();

        const next = await frame.iterator.next();
        if (next.done === true) {
          stack.pop();
          continue;
        }

        const handle = next.value;
        const path = `${frame.prefix}${handle.name}`;
        const entry = toDirEntry(handle, path);

        // Documented contract of `WalkOptions.filter`: `false` on a directory
        // skips its whole subtree. (Ignore-filtering lives in the search
        // tools — they pass the filter in, we only honour it.)
        if (walkOptions.filter !== undefined && !walkOptions.filter(entry)) continue;

        visited += 1;
        if (visited > maxEntries) return;
        yield entry;

        if (isDirectoryHandle(handle)) stack.push({ handle, prefix: `${path}/` });
      }
    } finally {
      // Release the cursors of every directory we descended into.
      while (stack.length > 0) {
        const frame = stack.pop();
        await frame?.iterator?.return?.();
      }
    }
  };

  return {
    id: options.id,
    label: options.label,
    root,
    describe: () => ({ label: options.label, kind: options.kind, writable: true }),

    stat,
    exists: async (path) => (await stat(path)) !== null,
    readText,
    writeText,
    list,
    remove,
    walk,
  };
}
