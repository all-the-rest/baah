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

import { newId, resolveSessionId, SESSION_ID_KEY } from "../../lib/ids.ts";
import { createSettingsStore, type SettingsStore } from "../../lib/settings-store.ts";
import { createWebStorageBackend, type KeyValueBackend } from "../../lib/storage.ts";
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
}

export interface AppRuntime {
  readonly runtime: BaahRuntime;
  readonly settings: SettingsStore;
  readonly questions: QuestionChannelState;
  readonly todos: TodoState;
  readonly workspace: Workspace;
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
  /** §5.3: the mode is visible, because the user must know where writes land. */
  readonly workspaceMode: "opfs" | "memory";
  /** `false` when a tool package failed to load. Said, not swallowed. */
  readonly toolsComplete: boolean;
  readonly missingTools: readonly string[];
}

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
  const session =
    options.sessionId === undefined
      ? resolveSessionId(sessionStorage, { mint: () => newId("session") })
      : { sessionId: options.sessionId, restored: true, degraded: undefined };
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
   */
  if ((await database.getSession(sessionId)) === null) {
    await database.createSession({ id: sessionId, title: "Sitzung" });
  }

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
  const workspace = options.workspace ?? createMemoryWorkspace(defaultSandboxFiles());
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

  return {
    runtime,
    settings,
    questions,
    todos,
    workspace,
    database,
    bootProblems: session.degraded === undefined ? [] : [session.degraded],
    workspaceMode: "memory",
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
  };
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
