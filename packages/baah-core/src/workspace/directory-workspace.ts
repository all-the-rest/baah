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
  DEFAULT_MAX_ENTRIES,
  isWorkspaceRoot,
  WorkspaceError,
  type DirEntry,
  type FileStat,
  type RemoveOptions,
  type WalkOptions,
  type WalkResult,
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
  /**
   * `true` once the cursor has been closed, so the release path can never run
   * `return()` twice on the same cursor. A double `return()` is harmless on a
   * generator and undefined behaviour on a hand-written iterator.
   */
  released?: boolean;
}

/** Closes a directory cursor, at most once. */
async function releaseFrame(frame: WalkFrame): Promise<void> {
  if (frame.released === true) return;
  frame.released = true;
  await frame.iterator?.return?.();
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

  /**
   * The walk, as a {@link WalkResult}.
   *
   * **Synchronous on purpose.** Resolving the root directory handle needs an
   * `await`, but it happens *inside* the generator, on the first `next()` — so
   * calling `walk()` touches no filesystem at all and a caller that decides not
   * to iterate costs nothing. An `async` return type would have made every
   * consumer `await` a value that is already available.
   */
  const walk = (directory = ".", walkOptions: WalkOptions = {}): WalkResult => {
    const result: WalkResult = {
      entries: { async *[Symbol.asyncIterator]() {} },
      truncated: false,
      visited: 0,
    };

    result.entries = {
      async *[Symbol.asyncIterator]() {
        const maxEntries = walkOptions.maxEntries ?? DEFAULT_MAX_ENTRIES;
        const start = resolveWorkspacePath(".", directory);

        const stack: WalkFrame[] = [];

        /**
         * Resolving the root can *fail* (a missing directory, a `TypeMismatch`
         * from the platform). Resolving it here rather than in `walk()` keeps
         * that a rejection of the iteration, which is what it was before —
         * and it still has to release anything opened on the way out, so the
         * `finally` covers the whole body including this.
         */
        try {
          const startHandle = await resolveDirectory(root, start);
          stack.push({ handle: startHandle, prefix: isWorkspaceRoot(start) ? "" : `${start}/` });

          while (stack.length > 0) {
            if (walkOptions.signal?.aborted) return;

            const frame = stack[stack.length - 1];
            if (frame === undefined) return;
            frame.iterator ??= frame.handle.values();

            const next = await frame.iterator.next();
            if (next.done === true) {
              // Close the exhausted cursor too, not only the abandoned ones:
              // `values()` hands out a real iterator whose `return()` is the
              // documented way to release the directory, and a cursor that
              // merely ran to its end still has to be released by whoever
              // opened it.
              const finished = stack.pop();
              if (finished !== undefined) await releaseFrame(finished);
              continue;
            }

            const handle = next.value;
            const path = `${frame.prefix}${handle.name}`;
            const entry = toDirEntry(handle, path);

            // Documented contract of `WalkOptions.filter`: `false` on a directory
            // skips its whole subtree. (Ignore-filtering lives in the search
            // tools — they pass the filter in, we only honour it.)
            if (walkOptions.filter !== undefined && !walkOptions.filter(entry)) continue;

            // Checked before the yield, so `truncated` means "there was another
            // entry and we did not take it" — a fact about the tree, not about a
            // counter that happened to land on the limit. Exactly the rule the
            // memory walk applies, which is what keeps the two interchangeable.
            if (result.visited >= maxEntries) {
              result.truncated = true;
              return;
            }
            result.visited += 1;
            yield entry;

            if (isDirectoryHandle(handle)) stack.push({ handle, prefix: `${path}/` });
          }
        } finally {
          // Release the cursors of every directory we descended into. This runs
          // on the normal end, on `maxEntries`, on an abort, on a throw — and,
          // because the `for await … of` protocol calls `return()` on the
          // iterator when the *consumer* breaks out early, on that too: the
          // generator is suspended at `yield`, the protocol resumes it with a
          // return completion, and this block is what runs.
          while (stack.length > 0) {
            const frame = stack.pop();
            if (frame !== undefined) await releaseFrame(frame);
          }
        }
      },
    };

    return result;
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
