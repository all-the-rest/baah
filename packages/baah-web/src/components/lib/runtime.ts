/**
 * The app's composition: the one place that turns the injected ports into a
 * running runtime.
 *
 * ## Why this file exists and is not in `runtime/`
 *
 * `runtime/index.ts` is the composition root and takes **every** dependency as a
 * parameter — that is what makes it testable in vitest with no DOM
 * (`AGENTS.md` §6). What it deliberately does not know is *which* concrete
 * implementations the app uses: which database, which tools, which workspace.
 * That is a product decision, and it lives here.
 *
 * So the direction is the one `AGENTS.md` §4 sanctions —
 * `baah-web → baah-tools/* + baah-storage → baah-core` — and nothing in this file
 * reaches back. Every workspace package the app uses is now a **declared
 * dependency** in `package.json`; nothing here is reached through a relative path
 * into a sibling package's `src/`, so a `pnpm install` that pruned or relinked the
 * graph could not silently change what this file compiles against.
 *
 * ## The database: real SQLite in OPFS, in a worker that actually runs
 *
 * `Plan.md` §6 fixes SQLite-in-a-Worker with the `opfs-sahpool` VFS, and
 * `openDatabase()` is the entry point. It is used here.
 *
 * Getting there needed one thing the previous build did not have, and the reason is
 * worth writing down because it is a **bundler** fact, not an API one:
 *
 * - `openDatabase()` builds its worker from `new URL("./worker.ts", import.meta.url)`.
 *   Vite only rewrites that into a *bundled worker* when the two calls are
 *   syntactically nested (`vite:worker-import-meta-url`'s pattern is
 *   `new Worker(new URL(…, import.meta.url), …)`). In `baah-storage`'s
 *   `client.ts` the URL is assigned to a variable first and handed to `new Worker`
 *   afterwards, so the pattern does not match, the generic
 *   `vite:asset-import-meta-url` plugin takes over, and the build **copies the
 *   TypeScript source verbatim** into `dist/assets/worker-<hash>.ts`. Measured:
 *   556 lines / 20 738 bytes, byte-identical to `baah-storage/src/worker.ts`, with
 *   type annotations intact. Chromium cannot execute that, so `new Worker` fails at
 *   parse time and the database was unusable — which is why the previous build fell
 *   back to `createMemoryDatabase()` and shipped a banner saying the transcript
 *   would not survive a reload.
 * - The fix belongs **here**, not in `baah-storage`: Vite's other documented form,
 *   the `?worker` query, turns any module into a compiled worker entry, and
 *   `openDatabase()` already accepts a `workerUrl`. `baah-storage` exports
 *   `"./worker"` for exactly this. No `vite.config.ts` change is needed, and
 *   `optimizeDeps.exclude: ["@sqlite.org/sqlite-wasm"]` (which the package's own
 *   README requires, because Vite's dependency pre-bundling rewrites the URL the
 *   `.wasm` is fetched from) was already there.
 *
 * What a user gets now: sessions, messages, parts and tool cards in SQLite under
 * OPFS, in the tab's worker, **surviving a reload**. `opfs-sahpool` permits exactly
 * one connection per origin (`Plan.md` §14.2), so a second tab is refused with a
 * typed `database_owned_by_another_context` rather than corrupting the file — and
 * since that refusal reaches `App.tsx`'s boot-failure screen, it is stated rather
 * than swallowed.
 *
 * ## Why the storage module is still a *dynamic* import
 *
 * Not a code-splitting nicety: `baah-storage` statically imports
 * `@sqlite.org/sqlite-wasm`, and a static import would put the WASM glue into the
 * initial chunk. The worker is loaded on demand instead, so a user who never sends
 * a message never fetches it.
 */
import {
  createMemoryWorkspace,
  type AnyToolDefinition,
  type ProviderRegistry,
  type Workspace,
} from "@all-the.rest/baah-core";
import type { StorageDatabase } from "@all-the.rest/baah-storage";

import {
  newId,
  PROJECT_SESSIONS_KEY,
  resolveProjectSession,
  SANDBOX_PROJECT_ID,
  SESSION_ID_KEY,
  type ProjectSessionStores,
} from "../../lib/ids.ts";
import {
  createProjectFolderController,
  createIndexedDbHandleStore,
  type ProjectFolderController,
  type ProjectFolderHandleStore,
  type ProjectIdentity,
} from "../../lib/project-folder.ts";
import type { ResolveProjectIdOptions } from "@all-the.rest/baah-core/workspace/file-system-access";
import { createSettingsStore, type SettingsStore } from "../../lib/settings-store.ts";
import { createWebStorageBackend, type KeyValueBackend } from "../../lib/storage.ts";
import {
  createSwappableWorkspace,
  workspaceModeOf,
  type SwappableWorkspace,
  type WorkspaceMode,
} from "../../lib/swappable-workspace.ts";
import { createDefaultProviderRegistry } from "../../providers/factories.ts";
import { createRuntime, type BaahRuntime } from "../../runtime/index.ts";
import { createQuestionChannelState, toolChannelFor, withQuestionFraming, type QuestionChannelState } from "./question.ts";
import { createTodoState, type TodoState } from "./todo-state.ts";
import { withTranscriptRows } from "./turn-store.ts";

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

type StorageModule = typeof import("@all-the.rest/baah-storage");

/**
 * `@all-the.rest/baah-storage`, lazily.
 *
 * Dynamic so the SQLite-WASM glue and its worker stay out of the initial chunk; see
 * the module header. The specifier is the workspace package, so this is an ordinary
 * dependency resolution — `AGENTS.md` §4's "dependencies point one way" is now
 * enforced by the graph instead of by a comment.
 */
async function loadStorage(): Promise<StorageModule> {
  return import("@all-the.rest/baah-storage");
}

/**
 * The tool packages, as one module per tool.
 *
 * `Plan.md` §10 puts the search engines in Phase 2 and `Plan.md` §14.5 measures a
 * full `grep` over ~300 MB as **seconds, not milliseconds** — so the two search
 * tools are separate dynamic imports and are not in the initial bundle for a user
 * who never searches. The four cheap tools are imported together for the same
 * reason the search ones are not: they are the ones every turn uses.
 */
async function loadFileTools(): Promise<readonly AnyToolDefinition[]> {
  const [read, write, edit, list] = await Promise.all([
    import("@all-the.rest/baah-tool-read"),
    import("@all-the.rest/baah-tool-write"),
    import("@all-the.rest/baah-tool-edit"),
    import("@all-the.rest/baah-tool-list"),
  ]);
  return [read.readTool, write.writeTool, edit.editTool, list.listTool].filter(isTool);
}

async function loadSearchTools(): Promise<readonly AnyToolDefinition[]> {
  const [glob, grep] = await Promise.all([
    import("@all-the.rest/baah-tool-glob"),
    import("@all-the.rest/baah-tool-grep"),
  ]);
  return [glob.globTool, grep.grepTool].filter(isTool);
}

function isTool(value: unknown): value is AnyToolDefinition {
  return typeof value === "object" && value !== null && "id" in value && "execute" in value;
}

/* ------------------------------------------------------------------ */
/* The runtime                                                         */
/* ------------------------------------------------------------------ */

export interface AppRuntimeOptions {
  readonly sessionId?: string;
  readonly workspace?: Workspace;
  /** Injected by a test; otherwise the app's own set is loaded. */
  readonly tools?: readonly AnyToolDefinition[];
  /**
   * Injected by a test; otherwise `createDefaultProviderRegistry()`.
   *
   * The same reason as {@link AppRuntimeOptions.tools}: a test that wants a real
   * turn — a real `AgentTurn`, a real store write, a real message row — needs a
   * model it scripts, and a provider registry is how one is handed in. The app
   * never passes it.
   */
  readonly registry?: ProviderRegistry | undefined;
  /** Injected by a test; otherwise `loadStorage()` runs. */
  readonly storage?: StorageModule;
  /**
   * Injected by a test; otherwise the real SQLite database in a worker.
   *
   * The only reason this exists is that the in-memory variant is the one thing
   * vitest can run without a browser: `createMemoryDatabase()` answers the whole
   * `StorageDatabase` contract from `Map`s, so a unit test can exercise the tool
   * part writer and the transcript reader end to end. The app never passes it.
   */
  readonly openDatabase?: ((storage: StorageModule) => Promise<StorageDatabase>) | undefined;
  /**
   * Where the session id is remembered, so nothing here needs a global and the
   * "storage refused" branch is reachable from a test.
   */
  readonly sessionStorage?: KeyValueBackend | undefined;
  /**
   * Where the settings live. Injected for the same reason as
   * {@link AppRuntimeOptions.sessionStorage}: `createWebStorageBackend` throws in a
   * browser with no `localStorage`, and vitest is one.
   */
  readonly settingsBackend?: KeyValueBackend | undefined;
  /**
   * Where the picked folder's handle is kept between loads.
   *
   * Injected for the same reason as the two backends above, and for one more:
   * `createAppRuntime` now **touches IndexedDB at boot** to see whether a folder
   * is still attached, and vitest has no IndexedDB. Without this seam every unit
   * test that builds an app runtime would need a browser.
   *
   * Omit it and the app passes {@link createIndexedDbHandleStore}.
   */
  readonly folderStore?: ProjectFolderHandleStore | undefined;
  /**
   * Do not look for a stored folder at all.
   *
   * Set by the E2E build, and by any caller that injected a `workspace`. The
   * reason is not convenience: a stored handle from a previous test run would
   * silently replace the sandbox the suite asserts against, and the 44 scenarios
   * would depend on the order they ran in. **A test that says nothing about the
   * folder gets the sandbox, always.**
   */
  readonly restoreFolder?: boolean | undefined;
  /**
   * Where the project→session pointers live, and where the pre-project single
   * pointer still is.
   *
   * Injected for the same reason as {@link AppRuntimeOptions.sessionStorage} — a test
   * needs a `KeyValueBackend` it can inspect, and the interesting property here is
   * **two projects keeping two pointers**, which is unobservable without one.
   */
  readonly projectSessions?: ProjectSessionStores | undefined;
  /** How `.baah/project.json` is read and written. See `lib/project-folder.ts`. */
  readonly projectId?: ResolveProjectIdOptions | undefined;
  /** The title a fresh conversation gets. Defaults to the constant `"Sitzung"`. */
  readonly sessionTitle?: string | undefined;
  /**
   * Which project this is — **asserted by the caller, not detected**.
   *
   * Exists for {@link AppRuntime.switchProject}, which knows the project and must not
   * re-derive it: the folder controller it would have to ask belongs to the *old* app,
   * and asking it would race the click that caused the switch. Naming the project is
   * also what makes the whole thing testable — a browser-free test can say "this is
   * project X" without a `FileSystemDirectoryHandle` anywhere.
   *
   * Omit it and the project is detected: the stored folder's identity, or the sandbox.
   */
  readonly project?: ProjectClaim | undefined;
}

/**
 * "This is project X", with what is known about it.
 *
 * Deliberately **not** `ProjectIdentity`: that one carries a `workspace`, and a caller
 * asserting a project may be switching *to* it and has already passed the workspace
 * separately. Two types for one concept would be two things to keep in step.
 */
export interface ProjectClaim {
  readonly projectId: string;
  readonly name: string;
  readonly kind: "directory" | "opfs";
  /** Defaults to `true`. `false` means "not persisted; this will not be here tomorrow". */
  readonly stable?: boolean | undefined;
  readonly problem?: string | undefined;
}

export interface AppRuntime {
  readonly runtime: BaahRuntime;
  readonly settings: SettingsStore;
  readonly questions: QuestionChannelState;
  readonly todos: TodoState;
  /**
   * The store this runtime writes through.
   *
   * Exposed for one reason that survives measurement: a test has to be able to ask
   * **what is actually on disk**, not what reading a row back produces. That is the
   * only way to test a *writer's* state derivation without the reader's identical
   * one standing in for it — which is what `turn-writes.test.ts` does for the tool
   * part the engine now writes.
   *
   * It was briefly also used to close the database on `pagehide`, so the next
   * document could claim the single `opfs-sahpool` connection. **Measured to be the
   * opposite of helpful** — the departing document's worker still held the pool while
   * the arriving one tried to install it, and a reload came up on the boot-failure
   * screen with a `StorageError`. The close is gone; the field stays, because the
   * test reason is real.
   */
  readonly database: StorageDatabase;
  /**
   * Something the boot had to say out loud, and the shell renders it.
   *
   * Currently: the session id could not be stored, so the next reload will open a
   * **new** session and the rows of this one become unreachable. `AGENTS.md` §5
   * forbids swallowing it, and a user who finds out by reloading has lost the
   * conversation — which is exactly what the persistent database was for.
   */
  readonly bootProblems: readonly string[];
  /**
   * §5.3: the mode is visible, because the user must know where writes land.
   *
   * **Derived from the workspace**, via `workspaceModeOf` — not a literal. It was
   * `"memory"` next to a workspace that could be something else, and the panel
   * then described writes that were not happening, which is §5.3's exact failure
   * mode. `Plan.md` §5.3: the UI must make the mode visible, "sonst erwartet ein
   * Firefox-Nutzer Speicherungen auf der Platte, die nicht passieren".
   *
   * A getter rather than a value, because the workspace is swappable at runtime
   * and a snapshot would be stale the moment a folder is picked.
   */
  readonly workspaceMode: WorkspaceMode;
  /**
   * The workspace the runtime holds, and the one that can be repointed.
   *
   * A `SwappableWorkspace` rather than a `Workspace` because the runtime captured
   * it at construction and the folder is picked later; see that module's header
   * for why rebuilding the runtime was not an option (`opfs-sahpool` allows one
   * connection per origin).
   */
  readonly workspace: SwappableWorkspace;
  /**
   * The project folder's own state: picked, needing a gesture, denied, or absent.
   *
   * Separate from {@link AppRuntime.workspaceMode} on purpose. The mode answers
   * "where do writes land"; this answers "does the browser still let us touch the
   * folder you chose", and after a cold start the honest answer is "not until you
   * press the button again" while the mode is already `local-directory`. Merging
   * them would force one of those two facts to be a lie.
   */
  readonly projectFolder: ProjectFolderController;
  /** `false` when a tool package failed to load. Said, not swallowed. */
  readonly toolsComplete: boolean;
  readonly missingTools: readonly string[];
  /**
   * The project this runtime is currently bound to.
   *
   * A value, not a getter, and that is the difference this block exists to close:
   * before it, the folder could change while `sessionId` did not, so the app wrote
   * project B's conversation into project A's session. {@link AppRuntime.switchProject}
   * is the only thing that may change either, and it returns a **new** `AppRuntime`
   * rather than mutating this one.
   */
  readonly project: ProjectBinding;
  /**
   * Move to another project: a new conversation, and a runtime bound to it.
   *
   * ## Why it returns a new object instead of mutating
   *
   * `createRuntime` captures `sessionId` in its closure, and the seam objects built
   * for it — the tool set (`loadAppTools` binds the `todo` tool to a `sessionId`) and
   * the `withTranscriptRows` decorator — are session-scoped too. So switching projects
   * means rebuilding **those**, and rebuilding them in place would leave a React tree
   * subscribed to an object whose identity no longer matches its contents.
   *
   * The one thing that is **not** rebuilt is the database. `opfs-sahpool` allows
   * exactly one connection per origin (`client.ts`), and a second `openDatabase()`
   * would refuse with `database_owned_by_another_context` — so this reuses the open
   * handle rather than opening one. That is also why the previous design's
   * "rebuild the whole runtime on pick" alternative was not available
   * (`lib/swappable-workspace.ts`'s header).
   *
   * ## What it refuses
   *
   * A turn in flight. Abandoning one would leave `turns.status = 'streaming'` with a
   * heartbeat nobody renews, and the next boot of that project would report an
   * interrupted turn the user never interrupted. The refusal is returned, not thrown,
   * because the caller is a click handler that has to render it.
   */
  switchProject(next: ProjectTarget): Promise<ProjectSwitchResult>;
}

/** Which project a runtime is bound to, and how sure we are about it. */
export interface ProjectBinding {
  /** The stable project id — a `.baah/project.json` id, or {@link SANDBOX_PROJECT_ID}. */
  readonly projectId: string;
  /** Display name. The folder's own name, or the sandbox. */
  readonly name: string;
  readonly kind: "directory" | "opfs";
  /** `false` when the id is not persisted and will differ on the next run. */
  readonly stable: boolean;
  /**
   * Why the id is not stable, when it is not — and `undefined` when it is.
   *
   * Carried on the binding rather than only in `bootProblems`, because a UI that
   * renders the current project has to be able to say "this one will not be here
   * tomorrow" **at the project**, not only once in a boot banner the user has
   * already scrolled past.
   */
  readonly problem: string | undefined;
  /** The conversation this runtime writes into. */
  readonly sessionId: string;
}

/** What {@link AppRuntime.switchProject} was asked to move to. */
export interface ProjectTarget {
  /** `undefined` means the browser's own sandbox — the fallback workspace. */
  readonly identity?: ProjectIdentity | undefined;
}

/** Why a {@link AppRuntime.switchProject} did or did not happen. */
export type ProjectSwitchResult =
  | { readonly kind: "switched"; readonly app: AppRuntime }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * The real database: SQLite-WASM in a worker, `opfs-sahpool` VFS, OPFS file.
 *
 * ## The `?worker&url` import is the whole trick
 *
 * `baah-storage` exports `"./worker"`, and Vite's `?worker` suffix compiles any
 * module into its own bundle. `?worker&url` rather than bare `?worker`, because the
 * two return different things in Vite 8 (verified in `vite/client.d.ts`): `?worker`
 * gives a **Worker subclass**, while `?worker&url` gives the **URL string**. The
 * string is what `openDatabase({ workerUrl })` wants, and handing it a constructor
 * where a `string | URL` belongs is a type error rather than a silent surprise.
 *
 * So `openDatabase` still builds the worker itself with
 * `new Worker(workerUrl, { type: "module" })` — the production path it was written
 * for, unchanged. `baah-storage` is not modified and `vite.config.ts` is not
 * modified: the two files the orchestrator reserved.
 *
 * The alternative — the `new Worker(new URL("./worker.ts", import.meta.url), …)` form
 * Vite documents — cannot be used from here at all, because the call site is inside
 * `baah-storage` and Vite's pattern requires the two calls to be syntactically
 * nested. The module header says what that produced, byte for byte.
 *
 * `new URL(…, import.meta.url)` turns Vite's root-relative output path into an
 * absolute one, which matters because `openDatabase` passes the value straight to
 * `new Worker` and a root-relative path would resolve against the worker's own URL
 * base rather than the document's.
 */
async function openRealDatabase(storage: StorageModule): Promise<StorageDatabase> {
  const { default: workerUrl } = await import("@all-the.rest/baah-storage/worker?worker&url");
  return storage.openDatabase({ workerUrl: new URL(workerUrl, import.meta.url) });
}

/**
 * The project a boot ended up in, before a conversation is chosen.
 *
 * A separate type from {@link ProjectBinding} because that one carries the
 * `sessionId`, which does not exist yet at this point in the function. Merging them
 * would mean a `ProjectBinding` with an empty `sessionId` floating around, and an
 * empty string is a value that later reads as a real one.
 */
type ResolvedProject = Omit<ProjectBinding, "sessionId">;

/** The browser's own sandbox, as a project. There is exactly one per origin. */
function sandboxIdentity(): ResolvedProject {
  return {
    projectId: SANDBOX_PROJECT_ID,
    name: "Sandbox",
    kind: "opfs",
    stable: true,
    problem: undefined,
  };
}

/**
 * Which project a boot is in, in one place and with one precedence.
 *
 * `options.project` wins, because a caller that states the project is stating a fact it
 * already has — and re-deriving it would mean asking a folder controller that belongs
 * to a *previous* runtime. Otherwise the detected folder, otherwise the sandbox.
 *
 * Written as a chain rather than three `if`s so that "the sandbox" is the **default**
 * and not a branch somebody can forget: a project the app cannot name is the sandbox,
 * and the sandbox is a real project with a real `workspaces` row, not a special case
 * that has to be handled everywhere else.
 */
function resolveProject(
  options: AppRuntimeOptions,
  detected: ProjectIdentity | undefined,
): ResolvedProject {
  const claimed = options.project;
  if (claimed !== undefined) {
    return {
      projectId: claimed.projectId,
      name: claimed.name,
      kind: claimed.kind,
      stable: claimed.stable ?? true,
      problem: claimed.problem,
    };
  }
  if (detected !== undefined) {
    return {
      projectId: detected.projectId,
      name: detected.name,
      // A detected identity always came from a `FileSystemDirectoryHandle`.
      kind: "directory",
      stable: detected.stable,
      problem: detected.problem,
    };
  }
  return sandboxIdentity();
}

/**
 * Re-attach a stored folder and report which project we ended up in.
 *
 * **`queryPermission` only, no picker, no `requestPermission`** — see
 * `lib/project-folder.ts` for why that distinction is the whole feature.
 *
 * Every failure is caught and turned into a problem line. `AGENTS.md` §5: no silent
 * catch — and here it is not tidiness. An IndexedDB that refuses (a private window, a
 * blocked context, a browser that dropped the entry) would otherwise reject out of
 * `createAppRuntime` and land the user on the boot-failure screen, which says "the app
 * could not start" when in fact everything works and only the folder is gone.
 */
async function readBootFolder(
  projectFolder: ProjectFolderController,
  options: AppRuntimeOptions,
  workspace: SwappableWorkspace,
): Promise<{ readonly identity: ProjectIdentity | undefined; readonly problems: readonly string[] }> {
  if (options.restoreFolder === false || options.workspace !== undefined) {
    return { identity: undefined, problems: [] };
  }
  const problems: string[] = [];
  try {
    const restored = await projectFolder.restore();
    if (restored.kind === "connected") {
      workspace.swap(restored.workspace);
    } else if (restored.kind === "needs-gesture") {
      // **No project identity here, and that is the honest answer.** The folder is
      // selected but not readable, so `.baah/project.json` cannot be read and the app
      // must not invent an id — a guessed one would create a *second* project the next
      // time the grant comes back, and the user's conversation would be split in two.
      problems.push(
        `Der Ordner „${restored.label}" ist ausgewählt, aber der Browser hat die Freigabe nach dem ` +
          "Neuladen zurückgesetzt. Drücke „Ordner verbinden“, um sie erneut zu erteilen — bis dahin " +
          "läuft die App in der Sandbox.",
      );
    }
    // `denied` and `unsupported` produce no problem line on purpose: the panel already
    // has a state to render for each, and a second copy of the same sentence in two
    // places is one more thing to keep in step.
  } catch (cause) {
    problems.push(
      "Der gespeicherte Projektordner konnte nicht wiederhergestellt werden " +
        `(${cause instanceof Error ? cause.name : "unbekannter Fehler"}). Die App läuft im Sandbox-Workspace.`,
    );
  }
  return { identity: projectFolder.project(), problems };
}

/**
 * Record the project, and make sure the conversation exists inside it.
 *
 * **Two writes, in this order, and the order is the argument.** The project row comes
 * first because `sessions.workspace_id` is a foreign key into it — a session naming a
 * project that is not there is refused by both backends. And `createWorkspace` is an
 * **upsert** (`INSERT_WORKSPACE`), so calling it on every open is the normal path, not
 * a mistake to be avoided by reading first.
 *
 * The session is created **with no message**, and that is the measurement that made
 * this a two-line function rather than a design question. `messages.session_id` is
 * `NOT NULL`, so a project with no conversation would have nowhere to put its first
 * message — but nothing about binding a message to a session needs machinery: every
 * write takes its `sessionId` from the engine's own option, never from the message.
 * Verified on both backends in `test/projects.test.ts`.
 */
async function ensureSessionForProject(
  database: StorageDatabase,
  input: {
    readonly sessionId: string;
    readonly title: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly projectKind: "directory" | "opfs";
  },
): Promise<void> {
  // The upsert, every time. `INSERT_WORKSPACE` carries `ON CONFLICT (id)`, so this
  // is the normal path for a second and every later open of a project — not a
  // mistake to be avoided by reading first, which is what `createSession` needs and
  // this does not.
  await database.createWorkspace({
    id: input.projectId,
    name: input.projectName,
    kind: input.projectKind,
  });
  const existing = await database.getSession(input.sessionId);
  if (existing !== null) {
    // The row is there and the pointer is right. Re-binding would touch nothing
    // useful, and a session attached to a *different* project is left alone: the
    // pointer map is the authority on which session a project uses, and second-
    // guessing it here would move a conversation between projects.
    return;
  }
  await database.createSession({
    id: input.sessionId,
    title: input.title,
    workspaceId: input.projectId,
  });
}

/**
 * Build the app's runtime.
 *
 * `sessionId` is **remembered, not minted per document**, and that is the difference
 * between a durable database and a durable database the user can see. The previous
 * build minted one on every load, so after a reload the app asked the read port
 * about a session that did not exist and rendered an empty transcript — which is
 * what the banner was really describing. `lib/ids.ts`'s `resolveSessionId` carries
 * the argument; a test that injects `sessionId` bypasses it, and the app does not.
 */
export async function createAppRuntime(options: AppRuntimeOptions = {}): Promise<AppRuntime> {
  const storage = options.storage ?? (await loadStorage());
  const database =
    options.openDatabase === undefined
      ? await openRealDatabase(storage)
      : await options.openDatabase(storage);
  const sessionStorage = options.sessionStorage ?? createWebStorageBackend({ key: SESSION_ID_KEY });
  const projectSessions =
    options.projectSessions ??
    ({
      projects: createWebStorageBackend({ key: PROJECT_SESSIONS_KEY }),
      legacy: sessionStorage,
    } satisfies ProjectSessionStores);

  /**
   * The workspace, and the folder controller that can replace it.
   *
   * ## Why the sandbox is still the default — deliberately, and it is the test's life
   *
   * `createMemoryWorkspace(defaultSandboxFiles())` stays the fallback and the
   * answer for every test. That is not caution, it is a hard constraint: the E2E
   * suite runs against the in-memory sandbox, there is no `showDirectoryPicker`
   * in that environment, and a dialog a test cannot answer is not a test. A
   * project folder as the *default* would make all 44 scenarios depend on a
   * picker, and the honest outcome would be a suite that cannot run at all.
   *
   * So: memory by default, folder on request. `AGENTS.md` §2a asks for the
   * folder to be the truth source, and it is — from the moment the user picks it,
   * over every subsequent turn, until they pick something else.
   *
   * ## Why restore is conditional on *two* things
   *
   * `options.restoreFolder === false` **or** an injected `workspace`. A test that
   * handed in a workspace and still got a stored folder swapped in underneath it
   * would be asserting against something it never set up — and the E2E build, a
   * real browser with a real IndexedDB, is exactly where a leftover handle from
   * an earlier run would appear.
   */
  const fallback = options.workspace ?? createMemoryWorkspace(defaultSandboxFiles());
  const workspace = createSwappableWorkspace(fallback);
  const projectFolder = createProjectFolderController({
    store: options.folderStore ?? createIndexedDbHandleStore(),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
  });

  /**
   * Which project are we in? **The folder first, the session second.**
   *
   * The order is the fix. `sessionId` used to be resolved at the very top of this
   * function, before the folder was even looked at, and then never revisited — so
   * every project on the machine shared one conversation, and picking a second folder
   * changed the files but not the history. Resolving the project first means the
   * session is a property of the project rather than of the browser.
   */
  const bootFolder = await readBootFolder(projectFolder, options, workspace);
  const project: ResolvedProject = resolveProject(options, bootFolder.identity);

  const session =
    options.sessionId === undefined
      ? resolveProjectSession(projectSessions, project.projectId, { mint: () => newId("session") })
      : { sessionId: options.sessionId, restored: true, adopted: false, degraded: undefined };
  const sessionId = session.sessionId;

  /**
   * A session must exist before anything is written to it: `flushDelta` and
   * `finishTurn` both enforce the foreign key, and a store with no row for this id
   * refuses the first delta with a `sql_error` that reads like a broken database
   * rather than a missing one-liner.
   *
   * **And it must not be created twice.** `createSession` is a plain
   * `INSERT … RETURNING` (`packages/baah-storage/src/sql.ts`, `INSERT_SESSION`) —
   * not an upsert — so a second call for the same id raises a `UNIQUE` violation.
   * The moment the session id is remembered across reloads, "create it" and "it is
   * already there" are the same situation on the second load, and an unconditional
   * create would turn every reload into a boot failure. Read first, write second.
   *
   * **It is created with no message, and that is not a placeholder.** A brand-new
   * project has no conversation yet, and `messages.session_id` is `NOT NULL` — so
   * there would be nowhere to write the first message if the session had to be born
   * from one. The binding to the first message needs no machinery at all: every write
   * takes its `sessionId` from the engine's own option, never from the message, so the
   * empty session simply receives it. Measured on both backends before this was
   * written; see `test/projects.test.ts` → "an empty conversation".
   */
  await ensureSessionForProject(database, {
    sessionId,
    title: options.sessionTitle ?? "Sitzung",
    projectId: project.projectId,
    projectName: project.name,
    projectKind: project.kind,
  });

  // The decorator, and what is left of it. The engine creates the **turn** row and
  // the **user's** message row itself (`AgentTurn.#persistPrompt`); nobody creates the
  // **assistant's**, and `parts.message_id → messages.id` is a real foreign key.
  // Measured — a plain turn refuses with `FOREIGN KEY constraint failed: messages.id
  // = …`. See `lib/turn-store.ts` for the whole argument, for what replaced the tool
  // part buffer that used to live here, and for the memo that keeps the user's row
  // from being manufactured a second time.
  const store = withTranscriptRows(storage.createTurnStore(database), {
    writer: database,
    sessionId,
  });
  const reader = storage.createTranscriptReader(database);
  const settings = createSettingsStore({
    backend: options.settingsBackend ?? createWebStorageBackend(),
  });

  const questions = createQuestionChannelState();
  const todos = createTodoState();
  const loaded = options.tools ?? (await loadAppTools({ questions, todos, sessionId }));

  const runtime = createRuntime({
    store,
    transcript: reader,
    workspace,
    settings,
    registry: options.registry ?? createDefaultProviderRegistry(),
    tools: loaded,
    sessionId,
    /**
     * The in-tool approval seam (`Plan.md` §4.2), for tools whose `access` is
     * not `read`.
     *
     * **No tool in the repo calls `ctx.approve` today** — the engine hands the
     * helper to the tool's `execute` and every tool ignores it, because §7.6
     * decides at `toolApproval` and the tool never needs a second gate. So this
     * callback is wired and correct, and nothing routes to it. The reachable
     * approval path is the SDK's rule-driven pause, and the card answers *that*
     * one; see `components/lib/approval.ts` for how the three answers map onto
     * both seams.
     *
     * It denies when no channel is wired, per `runtime/approval.ts`'s own rule:
     * a wiring mistake must not become an allow.
     */
    answer: () => Promise.resolve("deny"),
  });

  /**
   * Everything the user has to be told out loud, assembled **before** the folder
   * is looked at — because looking can produce one more.
   */
  const bootProblems: string[] = [];
  if (session.degraded !== undefined) bootProblems.push(session.degraded);
  bootProblems.push(...bootFolder.problems);
  if (project.problem !== undefined) bootProblems.push(project.problem);

  /**
   * The options a project switch carries over.
   *
   * **Only the ones that describe the *browser*, not the project.** The session,
   * the workspace, the tools and the folder store are all per-project or per-session
   * and are re-derived by the callee — carrying them would be carrying the bug.
   *
   * Conditional spreads rather than `x: options.x`, because
   * `exactOptionalPropertyTypes` makes an explicit `undefined` a different type from
   * an omitted key, and a spread of `{ tools: undefined }` is the former. The
   * alternative — dropping `exactOptionalPropertyTypes` for this file — would be a
   * much larger change than the three spreads it replaces.
   */
  const carriedOptions: AppRuntimeOptions = {
    storage,
    projectSessions,
    sessionStorage,
    ...(options.settingsBackend === undefined ? {} : { settingsBackend: options.settingsBackend }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.folderStore === undefined ? {} : { folderStore: options.folderStore }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.sessionTitle === undefined ? {} : { sessionTitle: options.sessionTitle }),
  };

  const app: AppRuntime = {
    runtime,
    settings,
    questions,
    todos,
    workspace,
    projectFolder,
    database,
    bootProblems,
    /**
     * **A getter, not a value.** The workspace is swappable — the folder is picked
     * after this object is built — so a snapshot taken here would report `"memory"`
     * forever, which is the exact lie this replaced. See the interface.
     */
    get workspaceMode(): WorkspaceMode {
      return workspaceModeOf(workspace.current);
    },
    toolsComplete: loaded.length >= 8,
    missingTools: loaded.length >= 8 ? [] : ["ein oder mehrere Werkzeuge"],
    // **`recordUserMessage` is gone, and the engine is why.**
    //
    // It used to be here: the app wrote the user's own prompt into `messages` and its
    // `parts` before calling `send`, because the engine built the prompt as an
    // in-memory `UIMessage` and never wrote it — so a reload showed answers with the
    // questions that produced them missing. `AgentTurn.#persistPrompt` now does it, on
    // the seam, before the first model call, naming the turn it belongs to.
    //
    // Two writers for one row is not a redundancy to keep but a defect to remove: the
    // ids differ, so the transcript would show the question **twice** — once from the
    // app's row and once from the engine's — and the two would carry different `seq`
    // numbers and different timestamps. This comment is the tombstone, because the
    // next reader will find `turn.ts` explaining why the app *had* to write it.
    //
    // **`recordToolInvocation` and `assistantMessageId` are gone for the same
    // reason, one block later.** The app subscribed to the event bus, mapped each
    // tool event to a write, buffered the write until it knew the assistant's message
    // id, and built the row itself. The engine now writes that row
    // (`TurnStore.upsertPart`, awaited, on the seam) and the write names the message
    // the part belongs to, so there is no buffer, no second copy of the row, and no
    // rule about `output-available` versus `output-error` in this package at all.
    project: { ...project, sessionId },

    /**
     * Move to another project. A **new** `AppRuntime`, sharing this one's database.
     *
     * ## Why the seam objects are rebuilt rather than repointed
     *
     * Three things in here are bound to a `sessionId` at construction: the engine
     * (`createRuntime` captured one in its closure), the `todo` tool
     * (`loadAppTools` passes it to `createTodoTool`), and the `withTranscriptRows`
     * decorator. Reusing any of them would keep writing into the **old**
     * conversation — which is precisely the bug being fixed, one layer down, and it
     * would look like a fix that did not work rather than like a broken seam.
     *
     * ## Why the database is *not* reopened
     *
     * `opfs-sahpool` allows exactly one connection per origin, so a second
     * `openDatabase()` throws `database_owned_by_another_context`
     * (`client.ts`). `createAppRuntime` is therefore re-entered with `openDatabase`
     * handing back the handle this app already has. That is the only way two projects
     * can share one database, and it is why "just swap the workspace" could never have
     * been enough: the workspace is not what carries the conversation.
     *
     * ## Why the folder controller is not carried over
     *
     * The new runtime gets `restoreFolder: false` and a **fresh** controller, and the
     * caller keeps the old one. Two controllers over one IndexedDB record would be
     * two sources for the same fact, and the new one would re-read the handle the
     * click that caused the switch has just replaced. The caller (`AppShell`) owns
     * the controller and is the one that knows what the user actually picked.
     */
    async switchProject(next: ProjectTarget): Promise<ProjectSwitchResult> {
      if (runtime.getState().status !== "idle") {
        return {
          kind: "refused",
          reason:
            "Während eines laufenden Turns kann nicht das Projekt gewechselt werden — der Turn würde " +
            "mitten im Schreiben abgerissen. Stoppe ihn zuerst.",
        };
      }
      const target = next.identity;
      if (target !== undefined && target.projectId === project.projectId) {
        // A repeated click on the same folder is not an error: the caller is handed
        // the app it already had, so nothing is rebuilt underneath React.
        return { kind: "switched", app };
      }
      try {
        const switched = await createAppRuntime({
          ...carriedOptions,
          openDatabase: () => Promise.resolve(database),
          workspace: target?.workspace ?? createMemoryWorkspace(defaultSandboxFiles()),
          restoreFolder: false,
          // The project is **named**, not re-detected: the controller that could detect
          // it belongs to the app being replaced, and asking it would race this very
          // click. `undefined` is the sandbox, which is a project with a real row.
          project:
            target === undefined
              ? { projectId: SANDBOX_PROJECT_ID, name: "Sandbox", kind: "opfs" }
              : {
                  projectId: target.projectId,
                  name: target.name,
                  kind: "directory",
                  stable: target.stable,
                  problem: target.problem,
                },
        });
        return { kind: "switched", app: switched };
      } catch (cause: unknown) {
        return {
          kind: "failed",
          reason:
            "Das Projekt konnte nicht gewechselt werden: " +
            `${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
        };
      }
    },
  };
  return app;
}

/**
 * The file tools, the search tools, and the two Tier-2 tools whose UI this block
 * owns.
 *
 * `question` and `todo` are created **per session** (`Plan.md` §16.2): the
 * question tool holds a pending promise, and the todo tool holds a `sessionId`
 * that the tool's own contract requires to be bound — a shared instance would make
 * two sessions share one list, which that contract forbids explicitly.
 */
async function loadAppTools(input: {
  readonly questions: QuestionChannelState;
  readonly todos: TodoState;
  readonly sessionId: string;
}): Promise<readonly AnyToolDefinition[]> {
  const fileTools = await loadFileTools();
  const searchTools = await loadSearchTools();
  const questionModule = await import("@all-the.rest/baah-tool-question");
  const todoModule = await import("@all-the.rest/baah-tool-todo");

  const question = questionModule.createQuestionTool({ channel: toolChannelFor(input.questions) });
  const todo = todoModule.createTodoTool({
    store: input.todos.toolStore(input.sessionId),
    sessionId: input.sessionId,
  });

  // The framing seam, applied by the app. See `components/lib/question.ts`:
  // `toModelOutput` is where `Plan.md` §16.2's untrusted-answer obligation is met,
  // and the tool package does not define one, so the app supplies it — and
  // `withQuestionFraming` delegates first, so a tool that grows its own is never
  // overridden.
  return [...fileTools, ...searchTools, withQuestionFraming(question), todo];
}

/**
 * The sandbox's initial contents.
 *
 * A fresh workspace with **one** file, and it says what it is. An empty workspace
 * makes the first `read` fail with "File not found", which a user reasonably
 * reads as a broken app rather than as an empty folder.
 */
function defaultSandboxFiles(): Record<string, string> {
  return {
    "HINWEIS.md": [
      "# Arbeitsbereich",
      "",
      "Dies ist ein Sandbox-Workspace im Browser. Er überlebt keinen Reload,",
      "solange die Datenbank im Arbeitsspeicher liegt (siehe Startseite).",
      "",
      "Schreib hier etwas hinein, oder frag den Agenten, was er findet.",
      "",
    ].join("\n"),
  };
}
