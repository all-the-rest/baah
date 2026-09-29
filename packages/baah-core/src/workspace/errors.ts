/**
 * Translation between the platform's `DOMException`s and `WorkspaceError`.
 *
 * Both browser filesystem APIs (File System Access API and OPFS) report every
 * failure as a `DOMException` whose *name* carries the meaning. The model on
 * the other side of a tool call never sees that name, so every handle call in
 * `workspace/` goes through {@link guardHandle} — a message like
 * `Directory not found: src/lib` is something a model can act on, a raw
 * `NotFoundError: Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle'` is not.
 *
 * Unknown error names are **rethrown**, not wrapped: a `TypeError` from our own
 * code is a bug and must not be laundered into a plausible-looking
 * "file system" error (AGENTS.md §5, no silent catch blocks).
 */

import { WorkspaceError, type EntryKind } from "../workspace.ts";

/** Extracts the `name` of a DOMException without relying on `instanceof`. */
function domExceptionName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name: unknown = (error as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** Capitalize an entry kind for the start of a sentence. */
function subject(kind: EntryKind): string {
  return kind === "directory" ? "Directory" : "File";
}

const HINT_PERMISSION =
  " The workspace handle is read-only or its permission was not granted; " +
  "request it with requestPermission() from a user gesture on the main thread.";
const HINT_SECURITY =
  " The browser refused the operation: it needs a user gesture on the main thread, " +
  "or the page is not in a secure context.";
const HINT_QUOTA =
  " The browser refused the write because the storage quota is exhausted; " +
  "free space or export the workspace.";
const HINT_IMMUTABLE =
  " A non-empty directory can only be removed with { recursive: true }.";
const HINT_ABORT = " The operation was aborted before it finished.";

/**
 * Turn a platform error into a `WorkspaceError` a model can act on.
 *
 * `expected` is what the caller was trying to reach; it decides both the
 * message (`Directory not found: x` vs. `File not found: x`) and the code a
 * `TypeMismatchError` maps to — asking a file for a directory and vice versa
 * are different mistakes.
 *
 * @throws the original error when it is not a known `DOMException` name, or
 *         when it already is a `WorkspaceError` (idempotent).
 */
export function translateHandleError(
  error: unknown,
  path: string,
  expected: EntryKind = "file",
): WorkspaceError {
  if (error instanceof WorkspaceError) throw error;

  switch (domExceptionName(error)) {
    case "NotFoundError":
      return new WorkspaceError(`${subject(expected)} not found: ${path}`, "not_found");

    case "TypeMismatchError":
      return expected === "directory"
        ? new WorkspaceError(`Not a directory: ${path}`, "not_a_directory")
        : new WorkspaceError(`Not a file: ${path}`, "not_a_file");

    case "NotAllowedError":
      return new WorkspaceError(`Permission denied: ${path}.${HINT_PERMISSION}`, "unsupported");

    case "SecurityError":
      return new WorkspaceError(`Permission denied: ${path}.${HINT_SECURITY}`, "unsupported");

    case "QuotaExceededError":
      return new WorkspaceError(`Storage quota exceeded: ${path}.${HINT_QUOTA}`, "unsupported");

    case "InvalidModificationError":
      return new WorkspaceError(
        expected === "directory"
          ? `Directory not empty: ${path}.${HINT_IMMUTABLE}`
          : `Cannot modify ${path}: the entry is immutable.`,
        "exists",
      );

    case "AbortError":
      return new WorkspaceError(`Operation aborted: ${path}.${HINT_ABORT}`, "unsupported");

    default:
      // Not a platform error we know: let it surface unchanged.
      throw error;
  }
}

/**
 * Run one handle operation and translate its failure.
 *
 * `path` is the *root-relative* path of the entry the operation is about, so
 * the resulting message points at something the model can name.
 */
export async function guardHandle<T>(
  path: string,
  expected: EntryKind,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateHandleError(error, path, expected);
  }
}

/** `true` for the codes that mean "there is no such entry of that kind". */
export function isMissingError(error: unknown): boolean {
  if (!(error instanceof WorkspaceError)) return false;
  return (
    error.code === "not_found" || error.code === "not_a_file" || error.code === "not_a_directory"
  );
}
