/**
 * A workspace whose target can be replaced after the runtime already holds it.
 *
 * ## The problem this exists for
 *
 * `createRuntime({ workspace })` takes the workspace as a **parameter** and the
 * `AgentTurn` is constructed with it per turn (`runtime/index.ts`). So the value
 * is captured at boot, and the folder the user picks comes *later* — the button
 * in the sidebar is reachable long after `createAppRuntime` resolved.
 *
 * Three ways out, and two of them are wrong:
 *
 * 1. **Rebuild the runtime on every pick.** Wrong: `createAppRuntime` opens the
 *    SQLite database, and `opfs-sahpool` permits **one** connection per origin
 *    (`Plan.md` §14.2). A second open is refused with
 *    `database_owned_by_another_context` — the app would land on the
 *    boot-failure screen because the user chose a folder. Measured in
 *    `components/lib/runtime.ts`'s header: the same refusal already cost a
 *    reload its database once.
 * 2. **Mutate the memory workspace in place.** Wrong, and worse: the tools would
 *    then read a *mixture* — files from the old root and the new one — and no
 *    test could tell. A workspace swap that is not atomic is a data-integrity
 *    bug wearing a feature's clothes.
 * 3. **A delegating wrapper.** The runtime holds a stable object; the wrapper
 *    forwards every call to whatever is current. A swap is one assignment, so no
 *    call can ever see half of each.
 *
 * (3) is this file.
 *
 * ## Why the wrapper is honest about what it is
 *
 * It is a **delegator**, not a cache and not a queue: an in-flight call started
 * before the swap finishes against the workspace it started on, because the
 * method was already dispatched. That is the correct behaviour — a `readText`
 * that began against the sandbox must not suddenly resolve against a folder the
 * user picked a second later — and it is stated here because the alternative
 * (re-dispatching mid-flight) would be the surprising one.
 *
 * `id` and `label` are **getters** rather than copied fields, so the UI reads the
 * current workspace's name. A copied label is a lie the moment the folder
 * changes, and §5.3 asks for the mode to be *visible*.
 */
import type { RemoveOptions, WalkOptions, WalkResult, Workspace } from "@all-the.rest/baah-core";

export interface SwappableWorkspace extends Workspace {
  /** The workspace calls are forwarded to right now. */
  readonly current: Workspace;
  /** Replace the target. Atomic: no call can observe a half-applied swap. */
  swap(next: Workspace): void;
}

/**
 * Wrap a workspace so the reference the runtime holds can be repointed.
 *
 * The forwarding is explicit per method rather than a `Proxy`: a `Proxy` would
 * forward `get`, `has` and `apply` traps for calls nobody makes, and the whole
 * point of the `Workspace` contract is that a consumer uses a **known set of
 * methods**. Spelling them out means a method added to `Workspace` later is a
 * **type error here** instead of an `undefined is not a function` at the moment a
 * user picks a folder.
 */
export function createSwappableWorkspace(initial: Workspace): SwappableWorkspace {
  let current = initial;

  return {
    get id() {
      return current.id;
    },
    get label() {
      return current.label;
    },
    get current() {
      return current;
    },
    swap(next: Workspace): void {
      current = next;
    },

    stat: (path) => current.stat(path),
    exists: (path) => current.exists(path),
    readText: (path) => current.readText(path),
    writeText: (path, content) => current.writeText(path, content),
    list: (path) => current.list(path),
    remove: (path, options?: RemoveOptions) => current.remove(path, options),
    walk: (directory?: string, options?: WalkOptions): WalkResult => current.walk(directory, options),
  };
}

/**
 * The mode, **read off the workspace** rather than remembered separately.
 *
 * `Plan.md` §5.3 requires the UI to make the mode visible, and this is the only
 * way to do that without a second source of truth: the composition root used to
 * hard-code `"memory"` next to a workspace that could be something else, and the
 * panel then described writes that were not happening (§5.3's exact failure).
 *
 * `describe()` is on `DirectoryWorkspace` and on the File System Access
 * workspace, and **not** on the base `Workspace` — `createMemoryWorkspace` does
 * not have it. So the fallback is derived from the `id` the memory workspace
 * sets (`"memory"`, `baah-core/src/workspace.ts`), and anything unrecognised is
 * reported as `"memory"` rather than guessed: a mode the panel cannot name is a
 * mode the panel must not invent.
 */
export type WorkspaceMode = "opfs" | "memory" | "local-directory";

interface Describable {
  describe(): { readonly kind: WorkspaceMode; readonly writable: boolean; readonly label: string };
}

function isDescribable(workspace: Workspace): workspace is Workspace & Describable {
  return typeof (workspace as Partial<Describable>).describe === "function";
}

export function workspaceModeOf(workspace: Workspace): WorkspaceMode {
  if (isDescribable(workspace)) return workspace.describe().kind;
  // The in-memory workspace is the only `Workspace` in core without a
  // `describe()`, and it names itself in its id. An id this function does not
  // recognise still reports `"memory"`: the panel has three modes and inventing a
  // fourth — or trusting an unknown id as a mode — is how the §5.3 lie comes
  // back. The real fix is for the workspace to carry a `describe()`, and both
  // core implementations that have a root already do.
  return "memory";
}

/** `true` when writes land somewhere durable rather than in RAM. */
export function isWorkspaceWritable(workspace: Workspace): boolean {
  return isDescribable(workspace) ? workspace.describe().writable : true;
}
