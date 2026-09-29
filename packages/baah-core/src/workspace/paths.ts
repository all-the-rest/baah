/**
 * Resolving a root-relative path onto a `FileSystemDirectoryHandle`.
 *
 * Both browser filesystem APIs expose only a *one level at a time* API:
 * `getDirectoryHandle(name)` / `getFileHandle(name)`. There is no `open("/a/b/c")`.
 * This module is the single place that knows how to walk those segments, and
 * the only place that has to tell "does not exist" (`NotFoundError`) apart from
 * "exists, but is the other kind of thing" (`TypeMismatchError`).
 *
 * It is deliberately free of any assumption about *which* filesystem is behind
 * the root handle, so the OPFS workspace and the File System Access workspace
 * share it — and so it can be unit-tested in Node against a fake handle.
 */

import { assertInsideRoot } from "../path.ts";
import { WorkspaceError } from "../workspace.ts";
import { guardHandle } from "./errors.ts";

/** Split a normalized root-relative path into its handle-sized segments. */
function toSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Resolve a tool-supplied path against the session cwd and refuse to leave the
 * workspace root.
 *
 * `assertInsideRoot` throws a plain `Error`; here it becomes a `WorkspaceError`
 * so a path escape reads like every other workspace failure for the model.
 * `unsupported` is the closest code in the `WorkspaceError` union — a dedicated
 * `escapes_root` code would be better and needs a change to `workspace.ts`.
 */
export function resolveWorkspacePath(cwd: string, path: string): string {
  try {
    return assertInsideRoot(cwd, path);
  } catch {
    throw new WorkspaceError(`Path escapes the workspace root: ${path}`, "unsupported");
  }
}

/** A file handle together with the directory it lives in. */
export interface ResolvedFile {
  /** Normalized, root-relative path. */
  readonly path: string;
  /** Last path segment. */
  readonly name: string;
  /** The directory that contains the file — needed for `remove` and to find the file. */
  readonly parent: FileSystemDirectoryHandle;
  readonly handle: FileSystemFileHandle;
}

/**
 * `FileSystemHandle.kind` is a union-typed *property*, not a discriminated
 * union, so TypeScript cannot narrow `FileSystemHandle` to the file variant on
 * its own. These predicates give it the information the DOM lib is missing.
 */
export function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === "file";
}

export function isDirectoryHandle(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
  return handle.kind === "directory";
}

/**
 * Walk to a directory, optionally creating the missing segments.
 *
 * The path is normalised and checked against the root first, so `a/../b`
 * resolves to `b` and `..` is refused instead of being looked up as a literal
 * directory name.
 *
 * `"."` returns the root itself, untouched.
 */
export async function resolveDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
  options: { readonly create?: boolean } = {},
): Promise<FileSystemDirectoryHandle> {
  const segments = toSegments(resolveWorkspacePath(".", path));
  if (segments.length === 0) return root;

  let current = root;
  let walked = "";
  for (const segment of segments) {
    walked = walked === "" ? segment : `${walked}/${segment}`;
    const next = await guardHandle(walked, "directory", () =>
      current.getDirectoryHandle(segment, options.create ? { create: true } : undefined),
    );
    if (next.kind !== "directory") {
      // Only reachable with a non-conforming implementation; the API throws
      // `TypeMismatchError` instead. Fail with the same code we would have used.
      throw new WorkspaceError(`Not a directory: ${walked}`, "not_a_directory");
    }
    current = next;
  }
  return current;
}

/**
 * Walk to a file and return it together with its parent directory.
 *
 * `create` applies to the **file only**. Parent directories are never created
 * implicitly — OPFS does not do that either, and the `Workspace` contract
 * wants a missing parent reported as such (see {@link ensureDirectory} for
 * `mkdir -p`).
 */
export async function resolveFile(
  root: FileSystemDirectoryHandle,
  path: string,
  options: { readonly create?: boolean } = {},
): Promise<ResolvedFile> {
  const target = resolveWorkspacePath(".", path);
  const segments = toSegments(target);
  const name = segments.pop();
  if (name === undefined) {
    throw new WorkspaceError(`Cannot write to the workspace root: ${target}`, "unsupported");
  }

  const parent = await resolveDirectory(root, segments.join("/"));
  const handle = await guardHandle(target, "file", () =>
    parent.getFileHandle(name, options.create ? { create: true } : undefined),
  );
  if (handle.kind !== "file") {
    throw new WorkspaceError(`Not a file: ${target}`, "not_a_file");
  }

  return { path: target, name, parent, handle };
}

/** `mkdir -p` for handles: every missing segment becomes a directory. */
export async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  return resolveDirectory(root, path, { create: true });
}

/** Byte size of a file, without reading it. */
export async function fileSize(handle: FileSystemFileHandle, path: string): Promise<number> {
  return guardHandle(path, "file", async () => (await handle.getFile()).size);
}
