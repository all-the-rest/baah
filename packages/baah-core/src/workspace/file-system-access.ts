/**
 * The File System Access workspace: the user's *real* project folder, in place.
 *
 * Chromium-only (Chrome/Edge 86+ desktop, Chrome Android 132+ — Plan.md
 * §5.3/§14.1). The handle comes from `showDirectoryPicker()`, which can only be
 * called from the **main thread**, and it survives a reload only as a
 * structured-cloneable handle in IndexedDB — not as bytes, not as JSON, and
 * never with its permission.
 *
 * ## `requestPermission()` and user activation
 *
 * `queryPermission()` is free and may be called anywhere. `requestPermission()`
 * is **not**: the spec requires *transient user activation*, and calling it
 * from a Web Worker throws `SecurityError` ("Permission request is only allowed
 * in user activation"). A Worker can therefore *use* a granted handle but can
 * never obtain one.
 *
 * Consequence for the app (already planned in Plan.md §5.3): after every cold
 * start the UI shows a "Projekt wieder öffnen" button whose click handler
 * calls {@link FileSystemAccessWorkspace.ensurePermission}. Until that ran,
 * {@link FileSystemAccessWorkspace.describe} reports `writable: false` so the
 * UI cannot pretend it can save.
 *
 * Import path: `@all-the.rest/baah-core/workspace/file-system-access.ts`
 */

import { z } from "zod";

import {
  createDirectoryWorkspace,
  type DirectoryWorkspace,
  type WorkspaceDescription,
  type WorkspaceKind,
} from "./directory-workspace.ts";
import { isDirectoryHandle } from "./paths.ts";

/**
 * The DOMException-free permission surface. TypeScript's DOM lib does not ship
 * `FileSystemHandle.queryPermission` yet, so we declare the narrow shape we
 * rely on instead of casting to `any` (AGENTS.md §5).
 */
export type HandlePermissionState = "granted" | "denied" | "prompt" | "unsupported";

export interface PermissionRequest {
  readonly mode: "read" | "readwrite";
}

interface PermissionCapableHandle {
  queryPermission?(descriptor?: PermissionRequest): Promise<HandlePermissionState>;
  requestPermission?(descriptor?: PermissionRequest): Promise<HandlePermissionState>;
}

export interface PermissionResult {
  readonly state: HandlePermissionState;
  /** A sentence the UI can show. Present when `state !== "granted"`. */
  readonly reason?: string;
}

export interface FileSystemAccessWorkspaceDescription extends WorkspaceDescription {
  readonly kind: "local-directory";
  /** The last known permission state; see `refreshPermission()`. */
  readonly permission: HandlePermissionState;
}

/**
 * Shown in the approval / reconnect UI. Kept as a constant because the
 * workaround is a UX decision, not something a component should re-invent.
 */
export const PERMISSION_REQUIRES_USER_GESTURE =
  "requestPermission() needs a user gesture on the main thread. Call it from a " +
  "click handler in the page — a Web Worker cannot ask for access.";

const PERMISSION_DENIED =
  "The user did not grant access to this folder (or the browser blocked it). " +
  "Reading is still possible if read access was granted earlier.";

/**
 * `true` for a directory handle we can actually work with.
 *
 * The handle crosses a trust boundary here: it comes out of IndexedDB (a
 * structured clone) or out of the picker, so it is validated structurally
 * instead of being cast (AGENTS.md §5, "Grenzen validieren"). The function
 * checks what we *call*, not that the object has the right prototype —
 * instances from another realm would fail a prototype check.
 */
export function isDirectoryHandleLike(value: unknown): value is FileSystemDirectoryHandle {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FileSystemDirectoryHandle>;
  return (
    candidate.kind === "directory" &&
    typeof candidate.name === "string" &&
    typeof candidate.getDirectoryHandle === "function" &&
    typeof candidate.getFileHandle === "function" &&
    typeof candidate.removeEntry === "function"
  );
}

const directoryHandleSchema = z.custom<FileSystemDirectoryHandle>(isDirectoryHandleLike, {
  message:
    "Expected a FileSystemDirectoryHandle from showDirectoryPicker() " +
    "(or from IndexedDB). A file handle or a plain object is not enough.",
});

/** The permission API is optional: OPFS handles never have it. */
function permissionApi(
  handle: FileSystemDirectoryHandle,
): PermissionCapableHandle | undefined {
  const candidate = handle as unknown as Partial<PermissionCapableHandle>;
  if (
    typeof candidate.queryPermission !== "function" &&
    typeof candidate.requestPermission !== "function"
  ) {
    return undefined;
  }
  return candidate as PermissionCapableHandle;
}

function failureState(error: unknown): HandlePermissionState {
  // `SecurityError`: no transient user activation (worker, or a non-click call).
  // `NotAllowedError`: the user dismissed the prompt, or the handle is read-only.
  if (error instanceof Error && error.name === "NotAllowedError") return "denied";
  return "unsupported";
}

export interface FileSystemAccessWorkspaceOptions {
  /** Label shown in the UI. Defaults to the picked folder name. */
  readonly label?: string;
  /** Stable id. Defaults to `local:<folder name>`. */
  readonly id?: string;
  /** See `DirectoryWorkspaceOptions.maxOpenFileHandles`. */
  readonly maxOpenFileHandles?: number;
}

export interface FileSystemAccessWorkspace extends DirectoryWorkspace {
  describe(): FileSystemAccessWorkspaceDescription;

  /**
   * Read the current permission **without** prompting. Call it on startup to
   * decide whether the "Projekt wieder öffnen" button is needed.
   */
  refreshPermission(write: boolean): Promise<PermissionResult>;

  /**
   * Make sure the handle may be used, asking the user if necessary.
   *
   * MUST be called from a user-gesture handler on the **main thread** when
   * prompting is required. In a Worker the second step throws `SecurityError`
   * and this resolves to `{ state: "unsupported", reason:
   * PERMISSION_REQUIRES_USER_GESTURE }` instead of hanging or throwing.
   */
  ensurePermission(write: boolean): Promise<PermissionResult>;
}

export function createFileSystemAccessWorkspace(
  handle: FileSystemDirectoryHandle,
  options: FileSystemAccessWorkspaceOptions = {},
): FileSystemAccessWorkspace {
  const parsed = directoryHandleSchema.parse(handle);
  if (!isDirectoryHandle(parsed)) {
    // Unreachable: `isDirectoryHandleLike` already pins `kind === "directory"`.
    throw new Error("Expected a directory handle.");
  }

  const label = options.label ?? parsed.name;
  const id = options.id ?? `local:${parsed.name}`;
  const kind: WorkspaceKind = "local-directory";
  const api = permissionApi(parsed);
  let last: HandlePermissionState = "prompt";

  const base = createDirectoryWorkspace(parsed, {
    id,
    label,
    kind,
    ...(options.maxOpenFileHandles === undefined
      ? {}
      : { maxOpenFileHandles: options.maxOpenFileHandles }),
  });

  const query = async (mode: "read" | "readwrite"): Promise<PermissionResult> => {
    if (api?.queryPermission === undefined) {
      return { state: "unsupported", reason: PERMISSION_REQUIRES_USER_GESTURE };
    }
    try {
      const state = await api.queryPermission({ mode });
      if (state !== "granted") {
        return { state, reason: "The folder needs to be reopened to grant access." };
      }
      return { state };
    } catch (error) {
      return { state: failureState(error), reason: PERMISSION_DENIED };
    }
  };

  const ensure = async (write: boolean): Promise<PermissionResult> => {
    const mode: "read" | "readwrite" = write ? "readwrite" : "read";
    const current = await query(mode);
    if (current.state === "granted") {
      last = "granted";
      return { state: "granted" };
    }
    if (api?.requestPermission === undefined) {
      last = "unsupported";
      return { state: "unsupported", reason: PERMISSION_REQUIRES_USER_GESTURE };
    }

    try {
      const state = await api.requestPermission({ mode });
      last = state;
      if (state === "granted") return { state };
      return {
        state,
        reason:
          state === "denied"
            ? PERMISSION_DENIED
            : PERMISSION_REQUIRES_USER_GESTURE,
      };
    } catch (error) {
      const state = failureState(error);
      last = state;
      return {
        state,
        reason: state === "denied" ? PERMISSION_DENIED : PERMISSION_REQUIRES_USER_GESTURE,
      };
    }
  };

  const refreshPermission = async (write: boolean): Promise<PermissionResult> => {
    const result = await query(write ? "readwrite" : "read");
    last = result.state;
    return result;
  };

  return {
    ...base,
    id: base.id,
    label: base.label,
    root: base.root,
    refreshPermission,
    ensurePermission: ensure,

    describe: (): FileSystemAccessWorkspaceDescription => ({
      label,
      kind,
      writable: last === "granted",
      permission: last,
    }),
  };
}
