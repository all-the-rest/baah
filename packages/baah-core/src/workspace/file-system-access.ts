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
 *
 * ## The project's identity is a file, not a name
 *
 * `FileSystemAccessWorkspaceOptions.id` is **required**, and it comes from
 * {@link resolveProjectId}, which reads — and on first open creates —
 * `<folder>/.baah/project.json`. The previous default, `` `local:${handle.name}` ``,
 * was removed rather than repaired: two folders named `api` were one string, and a
 * renamed folder was a different project. A browser-held id would not have been
 * enough either, because it does not follow the folder to another machine. See
 * {@link PROJECT_DIRECTORY} for the exact and complete write footprint.
 */

import { z } from "zod";

import {
  createDirectoryWorkspace,
  type DirectoryWorkspace,
  type WorkspaceDescription,
  type WorkspaceKind,
} from "./directory-workspace.ts";
import { isDirectoryHandle } from "./paths.ts";
import type { Workspace } from "../workspace.ts";

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
  /**
   * The project's stable id — **required**.
   *
   * It used to be optional and default to `` `local:${handle.name}` ``. That
   * default is gone, and deliberately: two folders named `api` produced the **same
   * string**, so the third project on a machine collided with the first, and a
   * renamed folder became a different project. A name is a display label, never an
   * identity.
   *
   * Making it required rather than merely discouraged is the point. An optional id
   * with a fallback is a fallback somebody eventually takes, and the resulting bug —
   * two projects sharing one id — is silent: both open, both list, and the
   * conversations of one appear under the other. `resolveProjectId` is how a caller
   * gets a correct value; see the module section on `.baah/project.json`.
   */
  readonly id: string;
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
  options: FileSystemAccessWorkspaceOptions,
): FileSystemAccessWorkspace {
  const parsed = directoryHandleSchema.parse(handle);
  if (!isDirectoryHandle(parsed)) {
    // Unreachable: `isDirectoryHandleLike` already pins `kind === "directory"`.
    throw new Error("Expected a directory handle.");
  }

  const label = options.label ?? parsed.name;
  const id = options.id;
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

/* ------------------------------------------------------------------ */
/* The project's own identity: `<folder>/.baah/project.json`          */
/* ------------------------------------------------------------------ */

/**
 * The one directory this app is allowed to create inside a user's folder.
 *
 * **The whole of the app's write footprint in a project folder, and the reason is
 * stated rather than implied.** `Plan.md` §18.7 records the decision: the user chose
 * "still anlegen, `.git` gleich" — create it silently, the way `.git` is created.
 * That is a licence for **one** directory and nothing else:
 *
 * - no `.gitignore` entry, and no attempt to be ignored,
 * - no cleanup, no pruning, no "temporary" file left behind,
 * - no write anywhere outside `.baah/`.
 *
 * A convention is a permission, not a blank cheque. The second bullet is the one
 * that is easy to drift into: a "helpful" cleanup would delete a file a user put
 * there, and the app cannot tell their file from its own.
 */
export const PROJECT_DIRECTORY = ".baah";

/** The file inside {@link PROJECT_DIRECTORY} that carries the project's stable id. */
export const PROJECT_ID_PATH = `${PROJECT_DIRECTORY}/project.json`;

/** The `format` marker, so a file from a future version is recognisable. */
export const PROJECT_ID_FORMAT = "baah-project";

/**
 * The file's shape, validated with `zod` like every other foreign boundary
 * (`AGENTS.md` §5). **Read from a file the user can edit**, which is the strongest
 * version of that rule in this codebase: this is not a message from a provider, it
 * is a file on the user's disk.
 */
const projectIdFileSchema = z.strictObject({
  format: z.literal(PROJECT_ID_FORMAT),
  id: z.string().min(1),
  createdAt: z.string().min(1),
});

/** What {@link resolveProjectId} found, and what it did about it. */
export type ProjectIdResolution =
  | {
      readonly kind: "resolved";
      readonly projectId: string;
      /** `true` when this call is the one that wrote the file. */
      readonly created: boolean;
    }
  | {
      /**
       * The folder is usable, but it has **no trustworthy project identity**.
       *
       * Reached when the file exists and is not our JSON, or when it is ours and the
       * write of a new one failed. `projectId` is then a fresh id that is **not**
       * persisted, so it will differ on the next run — which is exactly why this is
       * a separate kind instead of a `resolved` with a caveat: a caller that renders
       * a project list must be able to say "this project's conversations are not
       * reachable from the next run", and it cannot say that about a `resolved`.
       */
      readonly kind: "unstable";
      readonly projectId: string;
      readonly reason: string;
    };

export interface ResolveProjectIdOptions {
  /** Injected so a test gets a deterministic id. Defaults to `crypto.randomUUID()`. */
  readonly mint?: (() => string) | undefined;
  /** Injected clock, ISO-8601. Only used when the file is written. */
  readonly now?: (() => string) | undefined;
}

function mintProjectId(mint: (() => string) | undefined): string {
  if (mint !== undefined) return mint();
  const cryptoRef = globalThis.crypto;
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
  // The same degraded-browser fallback `newId` uses. A colliding project id merges
  // two projects' conversation lists, so it is worth the counter rather than a
  // timestamp that two calls in one millisecond would share.
  return `unstable-${Date.now().toString(36)}-${Math.trunc(performance.now()).toString(36)}`;
}

/**
 * Read the project's stable id out of the folder, creating it on first open.
 *
 * ## Why the identity lives in the folder and not in the browser
 *
 * A browser-stored id (IndexedDB, `localStorage`) is *this device's* id. It does not
 * survive copying the project to another machine, and it does not survive "clear
 * site data" — both of which the requirement "über mehrere Läufe eindeutig" is about.
 * A file inside the folder travels with the folder, so two machines that open the
 * same directory agree on the project without talking to each other. That is the
 * whole reason this function exists.
 *
 * ## What it writes, and what it never does
 *
 * Exactly one file, at exactly {@link PROJECT_ID_PATH}, and only when that file is
 * absent. It never rewrites a file that is already there, and — the important half —
 * it never **overwrites a file it does not understand**. A `.baah/project.json`
 * holding something else is reported as {@link ProjectIdResolution} `"unstable"`,
 * because silently replacing it would destroy whatever the user or a newer version
 * of the app put there, and an identity that changes when you re-open a project is
 * worse than one the app admits it cannot vouch for.
 *
 * ## Why the workspace, and not the handle
 *
 * The parameter is a {@link Workspace}, not a `FileSystemDirectoryHandle`, so this
 * is testable against `createMemoryWorkspace()` in plain Node — no browser, no
 * permission dance, no `AGENTS.md` §2 exception needed. The real caller passes the
 * folder's own workspace, which is the only thing that should be writing there.
 */
export async function resolveProjectId(
  workspace: Pick<Workspace, "exists" | "readText" | "writeText">,
  options: ResolveProjectIdOptions = {},
): Promise<ProjectIdResolution> {
  const mint = (): string => mintProjectId(options.mint);
  const existing = await readExistingProjectId(workspace);
  if (existing.kind === "resolved") return existing;
  if (existing.kind === "foreign") {
    return {
      kind: "unstable",
      projectId: mint(),
      reason:
        `${PROJECT_ID_PATH} exists but is not a ${PROJECT_ID_FORMAT} file, so its id cannot be ` +
        "trusted. It was left untouched.",
    };
  }
  if (existing.kind === "unreadable") {
    // **Not** "absent", and therefore not a write attempt: creating a file in a
    // folder the app could not even stat would turn a read failure into a write
    // failure, and the user would see two problems instead of one.
    return { kind: "unstable", projectId: mint(), reason: existing.reason };
  }

  const projectId = mint();
  const at = (options.now ?? ((): string => new Date().toISOString()))();
  const file = `${JSON.stringify({ format: PROJECT_ID_FORMAT, id: projectId, createdAt: at }, null, 2)}\n`;
  try {
    await workspace.writeText(PROJECT_ID_PATH, file);
  } catch (error: unknown) {
    // Reported, never swallowed (`AGENTS.md` §5) and never retried with a different
    // path. The id exists for this run and the user is told it will not survive it.
    return {
      kind: "unstable",
      projectId,
      reason:
        `${PROJECT_ID_PATH} could not be written (${
          error instanceof Error ? error.name : "unbekannter Fehler"
        }), so this project's identity is not stable across restarts.`,
    };
  }
  return { kind: "resolved", projectId, created: true };
}

type ExistingProjectId =
  | { readonly kind: "resolved"; readonly projectId: string; readonly created: boolean }
  /** The file is there and is not ours. Never overwritten. */
  | { readonly kind: "foreign" }
  /** The file is not there. */
  | { readonly kind: "absent" }
  /** The folder could not be inspected. A different fact, and never "absent". */
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * **Total on purpose** — every outcome is a value, none is a throw.
 *
 * The first version threw a `ProjectIdUnavailable` when `exists()` failed, and that
 * forced every caller to wrap a function whose whole job is to describe a folder's
 * identity in a `try`. A throw from here reaches a click handler
 * (`projectFolder.pick()`), where an escaping error is a rejected promise the UI has
 * to catch separately from the ordinary "not connected" answer. Reading a folder can
 * fail for reasons that are not bugs — a revoked grant, a folder removed from under
 * the handle — and those belong in the same union as everything else.
 */
async function readExistingProjectId(
  workspace: Pick<Workspace, "exists" | "readText">,
): Promise<ExistingProjectId> {
  let present: boolean;
  try {
    present = await workspace.exists(PROJECT_ID_PATH);
  } catch (error: unknown) {
    return {
      kind: "unreadable",
      reason:
        `${PROJECT_ID_PATH} could not be checked (${
          error instanceof Error ? error.name : "unbekannter Fehler"
        }).`,
    };
  }
  if (!present) return { kind: "absent" };

  let raw: string;
  try {
    raw = await workspace.readText(PROJECT_ID_PATH);
  } catch (error: unknown) {
    return {
      kind: "unreadable",
      reason:
        `${PROJECT_ID_PATH} could not be read (${
          error instanceof Error ? error.name : "unbekannter Fehler"
        }).`,
    };
  }
  const parsed = projectIdFileSchema.safeParse(safeJsonParse(raw));
  // `strictObject`: a file with an extra key is **not** silently accepted. It may be a
  // newer version's file, and treating it as ours would mean this build writes over
  // fields it does not understand.
  if (!parsed.success) return { kind: "foreign" };
  return { kind: "resolved", projectId: parsed.data.id, created: false };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
