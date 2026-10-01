/**
 * The project folder: picking it, keeping it, and being honest about the
 * permission that does not survive a cold start.
 *
 * `AGENTS.md` §2a names the target: the folder the user picks is the truth
 * source. This module is the part that was missing — not the workspace
 * implementation (that is `createFileSystemAccessWorkspace` in `baah-core`,
 * written and unit-tested) but the **wiring**: the picker, the place the handle
 * is kept, and the rule about when asking is allowed.
 *
 * ## Where the handle lives, and why not somewhere cleverer
 *
 * **IndexedDB**, in its own tiny database, and nowhere else. Three candidates
 * were weighed:
 *
 * | candidate | verdict |
 * |---|---|
 * | the project folder itself | **circular** — the job is "find the folder", so the folder cannot be what holds the pointer to the folder |
 * | the SQLite session database | a second path to the database, which `Plan.md` §16.1 refused for `TurnStore`; and `baah-storage` is not this file's to write |
 * | `localStorage` / settings JSON | a handle is not JSON. `JSON.stringify` of a `FileSystemDirectoryHandle` is `{}` |
 *
 * IndexedDB is what `Plan.md` §14.1 point 2 already prescribes ("Handles in
 * IndexedDB (structured clone), nie in JSON; sie referenzieren den Eintrag, nicht
 * die Bytes"), and it is browser storage, so `AGENTS.md` §2a rule 2 holds. It is
 * a **separate** database from the OPFS SQLite file on purpose: clearing the
 * session database must not silently unhook the user's folder, and vice versa.
 *
 * ## The rule this module exists to enforce
 *
 * A grant **does not survive a cold start**. Chrome: the web app can continue to
 * save changes without prompting *until all tabs for its origin are closed; once
 * a tab is closed, the site loses all access* (`Plan.md` §1129–1131, the
 * belegte Fassung — `Plan.md` §822 says the opposite, in a context about an
 * installed PWA, and the two are reconciled in the module header of
 * `baah-core/src/workspace/file-system-access.ts`).
 *
 * So the two paths are strictly separated, and the separation is the whole point:
 *
 * | path | may call `requestPermission`? | why |
 * |---|---|---|
 * | {@link ProjectFolderController.pick} | **yes** | it runs inside the click handler that opened the picker — transient user activation exists |
 * | {@link ProjectFolderController.restore} | **never** | it runs at boot with no gesture; `requestPermission` there throws `SecurityError`, and a user who is shown a permission prompt they did not ask for clicks "no" |
 *
 * `restore` asks `queryPermission` and accepts only `"granted"`. Anything else is
 * reported as {@link ProjectFolderState} `needs-gesture` / `denied` /
 * `unsupported` so the UI can say the truth — that the button has to be pressed
 * again — instead of claiming a handle is still attached when it is not.
 *
 * ## Why the seams are injected
 *
 * `showDirectoryPicker` cannot be called from a worker, from vitest, or without a
 * user gesture, and IndexedDB is unavailable in a unit test. Both are therefore
 * parameters (`ProjectFolderPorts`), never module-level lookups. That is what
 * makes the load-bearing property testable at all: `project-folder.test.ts`
 * plants a handle whose `requestPermission` counts its calls and proves the cold
 * start never makes one.
 */
import {
  createFileSystemAccessWorkspace,
  isDirectoryHandleLike,
  PERMISSION_REQUIRES_USER_GESTURE,
  resolveProjectId,
  type FileSystemAccessWorkspace,
  type HandlePermissionState,
  type ProjectIdResolution,
  type ResolveProjectIdOptions,
} from "@all-the.rest/baah-core/workspace/file-system-access";
import type { Workspace } from "@all-the.rest/baah-core";

import { createObservable, type Observable } from "./observable.ts";

/* ------------------------------------------------------------------ */
/* The state                                                           */
/* ------------------------------------------------------------------ */

/**
 * What is known about the folder, right now.
 *
 * The union exists so the UI cannot say "connected" when nothing is connected.
 * `needs-gesture` is the state `Plan.md` §14.1 point 1 asks for — "Nach jedem
 * Kaltstart ein 'Projekt wieder öffnen'-Button" — and it is a **different value**
 * from `no-handle`, because in one case the folder is known and only the
 * permission lapsed, and in the other the app has never seen it. A user who is
 * told "no folder" when the truth is "your folder is still selected, press the
 * button" will pick a second folder and lose the first one's context.
 */
export type ProjectFolderState =
  /** Nothing stored, or storage unavailable. The app is on its fallback. */
  | { readonly kind: "no-handle" }
  /**
   * A handle is stored **and** `queryPermission` said `"granted"` without any
   * prompt. The only state in which the folder is usable without a gesture.
   */
  | { readonly kind: "connected"; readonly label: string; readonly workspace: FileSystemAccessWorkspace }
  /**
   * The handle is stored but the grant lapsed (cold start). **Honest name for
   * the situation**: the folder is still selected, and the button has to be
   * pressed again. The UI must not claim access.
   */
  | { readonly kind: "needs-gesture"; readonly label: string }
  /** The browser refuses, and re-asking will not help. */
  | { readonly kind: "denied"; readonly label: string }
  /** No File System Access API, or no permission surface on the handle. */
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * The project's stable identity, as far as it could be established.
 *
 * **A separate fact from {@link ProjectFolderState}, and deliberately not a field on
 * it.** The two come apart in ways that matter:
 *
 * - the folder is **granted** but its id could not be written (read-only mount, a
 *   `.baah/project.json` that is not ours) — usable, but the conversation list will
 *   not survive the next run;
 * - the folder is **not granted**, so it cannot be read at all and no id is known
 *   even though the folder is still selected;
 * - the folder is connected and its id is stable — the ordinary case.
 *
 * Putting `projectId` on the state union would have made the second case carry an id
 * it does not have, and every caller would then re-derive the same distinction from a
 * state that cannot express it. It is an accessor on the controller instead:
 * {@link ProjectFolderController.project}.
 */
export interface ProjectIdentity {
  readonly projectId: string;
  /** The folder's own name. A **label**; never an identity. */
  readonly name: string;
  /**
   * The folder as a workspace, carrying the project id as its own `id`.
   *
   * On the identity rather than looked up again, because a second
   * `createFileSystemAccessWorkspace` for the same handle would be a second object
   * claiming the same id — and `switchProject` needs the workspace that belongs to
   * *this* id, not one rebuilt from the handle.
   *
   * Typed as the base {@link Workspace} and not as `FileSystemAccessWorkspace`: the
   * only thing a consumer does with it is hand it to `createAppRuntime({ workspace })`,
   * and the narrower type would make a caller that is not a browser — a test, or a
   * future non-FSAA project kind — cast its way past the very check this module exists
   * to provide. `workspace.id` is the project id either way, and that is the property
   * callers read.
   */
  readonly workspace: Workspace;
  /**
   * `false` when the id could not be read from or written to
   * `.baah/project.json`. Such an id holds **for this run** and will differ on the
   * next one, which is why a caller that persists anything keyed on it must not
   * pretend otherwise.
   */
  readonly stable: boolean;
  /** Present when `stable === false`: the sentence a user has to be told. */
  readonly problem: string | undefined;
}

/* ------------------------------------------------------------------ */
/* The ports                                                           */
/* ------------------------------------------------------------------ */

/**
 * The File System Access API's folder picker, declared on `Window`
 * (`Plan.md` §14.1).
 *
 * TypeScript's DOM lib does not ship it (measured: zero hits in `lib.dom.d.ts`
 * of `typescript@7.0.2`), and `AGENTS.md` §5 forbids `any` at a foreign
 * boundary, so the shape is declared rather than cast.
 *
 * **`Window`, not a local interface**, and that is not a style choice. Two
 * independent reasons, one of them a gate:
 *
 * - The API is specified as a member of `Window`. Calling it detached — which is
 *   what a local interface read produces — throws `Illegal invocation` in a real
 *   browser and works fine against a plain object in a test. The test would be
 *   green and the feature broken.
 * - `scripts/browser-only.ts`'s `project-folder` capability looks for a
 *   `showDirectoryPicker(` **call** in comment-stripped source. A member call
 *   satisfies it; `candidate.call(globalThis, …)` does not, and the gate would
 *   keep reporting the folder as unreachable while the panel offers the button.
 *
 * `mode: "readwrite"` is not what a bare call would default to, and it is the
 * whole point: a read-only grant leaves `describe().writable` false and every
 * write tool fails on a folder the user believes they can write to.
 */
declare global {
  // Declared on `globalThis` and **not** on `Window`: the call sites use
  // `globalThis.showDirectoryPicker(…)`, and augmenting `Window` does not reach
  // `globalThis` under this tsconfig (`"lib": ["ES2023", "DOM", "DOM.Iterable"]`
  // with `"types": []`) — measured, five `TS7017`s. It is the same object in a
  // browser, and `globalThis` is what the module already reads for `indexedDB`.
  //
  // The `var` form is required: an `interface` cannot be a property of
  // `globalThis`, and a bare `const` would be a module-local binding rather than
  // a global augmentation.
  //
  // Declared **non-optional**: the API is absent in Firefox and Safari
  // (`Plan.md` §14.1's table), and a non-optional type would have the compiler
  // trusting every call site. The absence is a *runtime* fact, so it is checked at
  // runtime by {@link isDirectoryPickerAvailable} — and the type says what the
  // capability looks like when it exists. Every call site is behind that check.
  var showDirectoryPicker: (options?: {
    readonly mode?: "read" | "readwrite";
    readonly id?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

/** Where a handle is kept between loads. Injected; the app passes IndexedDB. */
export interface ProjectFolderHandleStore {
  /** The stored handle, or `undefined`. Never throws for "nothing stored". */
  read(): Promise<FileSystemDirectoryHandle | undefined>;
  write(handle: FileSystemDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
  /** Shown in a settings row, so a user can see where the pointer lives. */
  readonly description: string;
}

/**
 * The id the **throwaway** workspace is built with, inside `attach`, before the
 * folder's own `.baah/project.json` has been read.
 *
 * It is a constant and not a name-derived string on purpose. The probe never leaves
 * `attach` — the workspace handed to the UI and to the runtime is built a few lines
 * later with the real id — so this value has no meaning outside those lines. Naming
 * it makes that visible: a reader who finds it in a debugger is looking at the probe,
 * not at the project's identity.
 */
const PROJECT_ID_PROBE = "probe:not-yet-resolved";

export interface ProjectFolderPorts {
  readonly store: ProjectFolderHandleStore;
  /**
   * Opens the picker, replacing the `globalThis` call. Injected so a test can
   * plant a handle; the app never passes it.
   */
  readonly pick?: (() => Promise<FileSystemDirectoryHandle>) | undefined;
  /**
   * How `.baah/project.json` is read and written — the id mint and the clock.
   *
   * Injected for the reason every other seam here is: `crypto.randomUUID` and the
   * wall clock are the two things a test must not depend on, and `resolveProjectId`
   * writes a **file into a user's folder** on first open. A test that cannot fix the
   * id cannot assert "the same folder yields the same project twice", which is the
   * property the whole feature rests on.
   */
  readonly projectId?: ResolveProjectIdOptions | undefined;
}

export interface ProjectFolderController {
  readonly state: Observable<ProjectFolderState>;
  /** The current value, for callers outside a subscription. */
  readonly current: () => ProjectFolderState;
  /**
   * The attached folder's stable id, or `undefined` when there is no readable
   * folder.
   *
   * Read through a getter rather than off {@link ProjectFolderState}, for the reason
   * at {@link ProjectIdentity}: a `needs-gesture` folder is selected and has **no**
   * readable id, and a `connected` folder can have an id that is not stable. Both are
   * states the union cannot carry, so both live here.
   */
  readonly project: () => ProjectIdentity | undefined;
  /**
   * Open the picker and attach the folder.
   *
   * **Must be called from a user-gesture handler on the main thread.** This is
   * the only path that may call `requestPermission`, and it is the only one that
   * may call `showDirectoryPicker`.
   */
  pick(): Promise<ProjectFolderState>;
  /**
   * Re-attach a stored handle after a load. **Never prompts.**
   *
   * Runs `queryPermission` only. Returns `connected` when the grant survived,
   * and `needs-gesture` when it did not — which on Chrome is every cold start.
   */
  restore(): Promise<ProjectFolderState>;
  /** Forget the folder and fall back. Used when the user asks for the sandbox. */
  release(): Promise<ProjectFolderState>;
}

/* ------------------------------------------------------------------ */
/* The controller                                                      */
/* ------------------------------------------------------------------ */

/**
 * `true` when this browser has the picker at all. §14.1's Chromium-only row.
 *
 * A **runtime** check, and it has to be: the declaration above is non-optional
 * because the compiler cannot narrow a global across statements, but the API is
 * genuinely absent in Firefox and Safari. `typeof` is the only honest test — the
 * global is not there at all, so reading it is not an error and a truthiness test
 * would be a claim about a value that does not exist.
 */
export function isDirectoryPickerAvailable(): boolean {
  return typeof globalThis.showDirectoryPicker === "function";
}

/**
 * `true` when this context can keep a handle between loads.
 *
 * Separate from {@link isDirectoryPickerAvailable} on purpose: they are different
 * capabilities, and conflating them is how a boot path ends up trying to open a
 * database that does not exist.
 *
 * **Measured, not assumed:** with only the picker checked, `createAppRuntime`
 * built an IndexedDB store in vitest — which has no `indexedDB` global — and every
 * unit test that builds an app runtime failed with a `ReferenceError` surfacing
 * as a boot problem. `typeof indexedDB === "undefined"` is the check that says
 * "this context cannot keep anything", and it is a fact about the environment
 * rather than an exception to be caught and explained to the user.
 */
export function isHandleStoreAvailable(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

export function createProjectFolderController(ports: ProjectFolderPorts): ProjectFolderController {
  const state = createObservable<ProjectFolderState>({ kind: "no-handle" });
  /**
   * The attached folder's identity, kept beside the state rather than inside it.
   *
   * A plain `let`, not an observable: the value only ever changes together with
   * `state.set(...)`, and every reader of it (`project()`) is reached from the same
   * call. A second observable would be a second thing that can notify without the
   * first, which is the "two sources for one fact" shape this whole block exists to
   * remove.
   */
  let identity: ProjectIdentity | undefined;

  const openPicker = async (): Promise<FileSystemDirectoryHandle> => {
    if (ports.pick !== undefined) return ports.pick();
    // Read **per call**, never captured at module load — the same rule
    // `lib/storage.ts` follows for `localStorage`, so a test that installs a stub
    // after import still hits the stub.
    //
    // The availability check and the call are separated, because a guard on
    // `globalThis.showDirectoryPicker` does not narrow the property for the *next*
    // expression (measured: `TS2722`) — a global could be reassigned between the
    // two statements. The check is the honest one; the call is a real **member
    // call** on `globalThis`, because the API is specified on `Window` and a
    // detached call throws `Illegal invocation` in a real browser while working
    // fine against a plain object in a test. The two lines are deliberately not
    // the same expression.
    if (!isDirectoryPickerAvailable()) {
      throw new ProjectFolderError("unsupported", "no-picker");
    }
    // `mode: "readwrite"` deliberately. A read-only handle would make every write
    // fail on a folder the user believes they can write to, and core derives
    // `describe().writable` from the last permission answer — so the panel would
    // claim the folder is writable rather than merely failing.
    return globalThis.showDirectoryPicker({ mode: "readwrite" });
  };

  /**
   * The one place a handle becomes a workspace, and the one place a grant is
   * read. Two rules live here rather than at the call sites:
   *
   * 1. `isDirectoryHandleLike` runs **before** `createFileSystemAccessWorkspace`,
   *    so a structured clone that did not survive (a private window, a browser
   *    that dropped the entry) produces a typed state instead of a `zod` throw
   *    escaping into a click handler.
   * 2. `requestPermission` is reachable **only** through `ensurePermission`,
   *    which only {@link pick} calls. `restore` calls `refreshPermission`, and
   *    that one is `queryPermission` by construction
   *    (`baah-core/.../file-system-access.ts`, `refreshPermission` → `query`).
   *
   * ## Why both paths ask for `readwrite`, not `read`
   *
   * Because the folder is the **truth source** (`AGENTS.md` §2a), and a
   * read-only grant would be a folder the agent can read and not write. The
   * subtle half is that core derives writability from the *last* permission
   * answer: `describe().writable` is `last === "granted"`. So a `restore()` that
   * asked for `read` and got `granted` would hand back a workspace whose
   * `describe()` claims `writable: true` — the panel would promise writes that
   * then fail on the first `writeText`. `queryPermission` is free and never
   * prompts, so asking for the stricter mode at restore costs nothing and makes
   * the answer honest.
   *
   * ## And the third thing `attach` decides: the project's identity
   *
   * Once the grant is in, `attach` reads — and on first open creates —
   * `<folder>/.baah/project.json`, and the workspace the UI and the runtime receive
   * is built **with that id**. That is why `FileSystemAccessWorkspaceOptions.id` is
   * required: the old `` `local:${name}` `` made two folders called `api` the same
   * project, and nothing on disk remembered either of them.
   */
  const attach = async (
    handle: FileSystemDirectoryHandle,
    ask: "query" | "request",
  ): Promise<ProjectFolderState> => {
    if (!isDirectoryHandleLike(handle)) {
      // The stored entry did not survive. Drop it, or it fails the same way on
      // every future load and the button can never fix it.
      await forget(ports.store, handle);
      identity = undefined;
      return { kind: "unsupported", reason: "Der gespeicherte Ordner-Zugriff ist nicht mehr gültig." };
    }

    // **The order is forced, and it is the whole point of this change.**
    //
    // The permission is asked on a throwaway workspace, because reading
    // `.baah/project.json` needs a folder the app may actually touch — and the
    // second workspace is built *with the id that file carried*. The old code built
    // one workspace and gave it `` `local:${name}` ``; the name is not an identity,
    // two folders called `api` collided, and nothing on disk remembered either of
    // them.
    //
    // The probe's id is a constant placeholder, not a fallback: it never leaves this
    // function, and `FileSystemAccessWorkspaceOptions.id` is required precisely so
    // that no caller can end up shipping one.
    const probe = createFileSystemAccessWorkspace(handle, { id: PROJECT_ID_PROBE });
    const permission =
      ask === "request" ? await probe.ensurePermission(true) : await probe.refreshPermission(true);
    if (permission.state !== "granted") {
      // Not readable ⇒ no id. A `needs-gesture` folder is still *selected*, which is
      // why the state says so and the identity says nothing: they are two facts.
      identity = undefined;
      return fromPermission(probe.label, permission.state, permission.reason, probe);
    }

    const resolution: ProjectIdResolution = await resolveProjectId(probe, ports.projectId);
    const label = probe.label;
    const workspace = createFileSystemAccessWorkspace(handle, { id: resolution.projectId, label });
    identity = {
      projectId: resolution.projectId,
      name: label,
      stable: resolution.kind === "resolved",
      problem: resolution.kind === "resolved" ? undefined : resolution.reason,
      workspace,
    };
    return fromPermission(label, permission.state, permission.reason, workspace);
  };

  const restore = async (): Promise<ProjectFolderState> => {
    const handle = await ports.store.read();
    if (handle === undefined) {
      const next: ProjectFolderState = { kind: "no-handle" };
      identity = undefined;
      state.set(next);
      return next;
    }
    // `refreshPermission`, never `ensurePermission`. This one line is the whole
    // difference between "the folder survives a reload" and "the user is asked
    // again every reload, and clicks no". Pinned by
    // `project-folder.test.ts` → "the cold start never calls requestPermission".
    const next = await attach(handle, "query");
    state.set(next);
    return next;
  };

  const pick = async (): Promise<ProjectFolderState> => {
    const handle = await openPicker();
    // In a gesture, so asking is legal. Persisted **after** the grant: storing a
    // handle the user then refused would make the next cold start claim a folder
    // that was never attached.
    const next = await attach(handle, "request");
    if (next.kind === "connected") await ports.store.write(handle);
    state.set(next);
    return next;
  };

  const release = async (): Promise<ProjectFolderState> => {
    const handle = await ports.store.read();
    if (handle !== undefined) await forget(ports.store, handle);
    // The identity goes with the folder. Leaving it behind would be the exact bug
    // this block exists to kill in the other direction: a released folder's id still
    // naming a project, so the conversation list would show a project the user just
    // detached.
    identity = undefined;
    // **Only notify when the state actually changed.** `createObservable.set` is
    // a no-op on `Object.is` equality, and `{ kind: "no-handle" }` is a fresh
    // object literal every call — so an unconditional `set` notifies a
    // `useSyncExternalStore` subscriber that nothing happened, the shell
    // re-renders, and `isConfigured` re-evaluates. Measured: that re-render is
    // what made the wizard replace itself with the workbench the moment a
    // workspace step was chosen.
    if (state.get().kind !== "no-handle") state.set({ kind: "no-handle" });
    return state.get();
  };

  return { state, current: state.get, project: () => identity, pick, restore, release };
}

/**
 * Turn a permission result into a state, keeping the workspace **only** when it
 * is genuinely usable.
 */
function fromPermission(
  label: string,
  permission: HandlePermissionState,
  reason: string | undefined,
  workspace: FileSystemAccessWorkspace,
): ProjectFolderState {
  if (permission === "granted") return { kind: "connected", label, workspace };
  if (permission === "prompt") return { kind: "needs-gesture", label };
  if (permission === "denied") return { kind: "denied", label };
  return { kind: "unsupported", reason: reason ?? PERMISSION_REQUIRES_USER_GESTURE };
}

/**
 * Drop a handle that cannot be used any more.
 *
 * A clear that itself fails is **not** swallowed into a silent success: the
 * caller is about to report "unsupported", and the reason the entry is still
 * there has to stay visible in the error the click handler reports. `AGENTS.md`
 * §5 forbids a bare `catch`; here the failure would otherwise be a *permanent*
 * one, repeated on every load.
 */
async function forget(store: ProjectFolderHandleStore, handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await store.clear();
  } catch (cause) {
    throw new ProjectFolderError("unwritable", cause instanceof Error ? cause.name : "unknown", handle);
  }
}

export type ProjectFolderErrorCode = "unsupported" | "unwritable" | "picker-dismissed";

export class ProjectFolderError extends Error {
  constructor(
    readonly code: ProjectFolderErrorCode,
    detail: string,
    /** The handle involved, when there is one. Never a byte of content. */
    readonly handle?: FileSystemDirectoryHandle,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ProjectFolderError";
  }
}

/* ------------------------------------------------------------------ */
/* The IndexedDB store                                                 */
/* ------------------------------------------------------------------ */

const DB_NAME = "baah-project-folder.v1";
const STORE_NAME = "handles";
const RECORD_KEY = "selected";

/**
 * The handle store, in its own IndexedDB database.
 *
 * A **structured clone**, so the value stored is a reference to the entry, not
 * the bytes of the folder — the file says so too, and it is why this is safe to
 * restore without the user's disk being touched.
 *
 * The database is separate from the OPFS SQLite file on purpose. One holds the
 * user's work, the other holds a pointer to where their work is; "Daten löschen"
 * is a user action about the first and must not be a silent second action about
 * the second, and neither should be able to corrupt the other.
 */
/**
 * The handle store, in its own IndexedDB database — **or a store that keeps
 * nothing**, where IndexedDB does not exist.
 *
 * That fallback is not a convenience for tests. `createAppRuntime` is called at
 * boot by `App.tsx`, and a context without IndexedDB (vitest, a hardened private
 * window, a browser with site data blocked) would otherwise get an object whose
 * every method throws a `ReferenceError` on first use. Returning a store that
 * honestly reports "nothing stored" keeps the boot path a no-op in exactly those
 * contexts, and keeps the **app** in the sandbox rather than on a failure screen.
 *
 * It is a real store with a real `description`, so a settings row can tell the
 * user where the pointer would live rather than showing an empty string.
 */
export function createIndexedDbHandleStore(): ProjectFolderHandleStore {
  if (!isHandleStoreAvailable()) return createEphemeralHandleStore("not available in this context");
  return createRealIndexedDbHandleStore();
}

/** A store that stores nothing, and says so. */
export function createEphemeralHandleStore(description = "not persisted"): ProjectFolderHandleStore {
  return {
    read: async () => undefined,
    write: async () => undefined,
    clear: async () => undefined,
    description,
  };
}

function createRealIndexedDbHandleStore(): ProjectFolderHandleStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
      // A second tab upgrading the schema must not hang this one. Without this
      // the promise never settles and `restore` never returns, so the app sits
      // on the fallback forever with no explanation.
      request.onblocked = () => reject(new Error("indexedDB.open blocked"));
    });

  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = body(tx.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      });
    } finally {
      // The connection is per-operation. Held open it would block a future
      // `deleteDatabase` and, more visibly, keep a `versionchange` pending.
      db.close();
    }
  };

  return {
    async read() {
      const value = await run<unknown>("readonly", (store) => store.get(RECORD_KEY) as IDBRequest<unknown>);
      // Re-validated on the way out, not on the way in. The value crossed a
      // storage boundary, and `AGENTS.md` §5 says what comes from outside is
      // validated — a handle that lost its methods returns `{}` here, and
      // handing that to the workspace constructor would throw a `zod` error with
      // no German sentence attached.
      return isDirectoryHandleLike(value) ? value : undefined;
    },
    write: (handle) => run("readwrite", (store) => store.put(handle, RECORD_KEY)).then(() => undefined),
    clear: () => run("readwrite", (store) => store.delete(RECORD_KEY)).then(() => undefined),
    description: "IndexedDB",
  };
}
