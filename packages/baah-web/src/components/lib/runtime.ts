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
 * reaches back.
 *
 * ## The dependencies that are **not** declared in `package.json`
 *
 * `@all-the.rest/baah-storage` and the eight `@all-the.rest/baah-tool-*` packages
 * are not dependencies of `@all-the.rest/baah-web`; that package links only
 * `baah-core`. Two paths existed:
 *
 * 1. Add the entries to `package.json` and re-link — the correct fix, and it needs
 *    `pnpm install`, which was explicitly out of scope for this block.
 * 2. Import the sources through a relative path.
 *
 * (2) is what this file does, and it is a workaround, not an equivalent: it
 * bypasses the workspace dependency, and a `pnpm install` that pruned the graph
 * would break the build in a way a typecheck does not predict. It is isolated in
 * the two loaders below, so the fix is two import statements and nothing else —
 * and so a reviewer sees it in one place instead of throughout the app.
 *
 * The bundler accepts it and the app builds, which is why the app is
 * demonstrable rather than theoretical. The correct resolution is still (1), and
 * the report says so.
 *
 * ## The database
 *
 * `Plan.md` §6 fixes SQLite-in-a-Worker with the `opfs-sahpool` VFS, and
 * `openDatabase()` is the entry point. It is **not** used here, and the reason is
 * measured rather than assumed: `openDatabase` builds its worker from
 * `new URL("./worker.ts", import.meta.url)`, and a `vite build` of this app emits
 * that file into `dist/assets/` as **untranspiled TypeScript** (verified:
 * `dist/assets/worker-*.ts`, ~20 kB, which Chromium cannot execute). The comment
 * above `openDatabase` in `client.ts` calls its worker URL UNVERIFIED; this is
 * the measurement.
 *
 * So the app uses `createMemoryDatabase()` — the same `StorageDatabase` contract,
 * the same `createStorageOperations`, the same `seq` allocation, no OPFS. The
 * consequence is stated in the UI rather than hidden: **the transcript does not
 * survive a reload** (`Plan.md` §1 DoD 4 is not met) and the shell says so in the
 * first screen a user sees. The settings *do* survive, because they live in
 * `localStorage` behind an injected backend (`lib/storage.ts` says why they are
 * not in SQLite).
 *
 * Switching to `openDatabase()` once the dependency exists is one function body.
 */
import { createMemoryWorkspace, type AnyToolDefinition, type Workspace } from "@all-the.rest/baah-core";

import { newId } from "../../lib/ids.ts";
import { createSettingsStore, type SettingsStore } from "../../lib/settings-store.ts";
import { createWebStorageBackend } from "../../lib/storage.ts";
import { createDefaultProviderRegistry } from "../../providers/factories.ts";
import { createRuntime, type BaahRuntime } from "../../runtime/index.ts";
import { createQuestionChannelState, toolChannelFor, withQuestionFraming, type QuestionChannelState } from "./question.ts";
import { toolResultFailure, toolStateForResult } from "./parts.ts";
import { createTodoState, type TodoState } from "./todo-state.ts";
import { withTranscriptRows } from "./turn-store.ts";

/* ------------------------------------------------------------------ */
/* Loaders — the two relative imports, and nothing else                */
/* ------------------------------------------------------------------ */

type StorageModule = typeof import("../../../../baah-storage/src/index.ts");

/**
 * `@all-the.rest/baah-storage`.
 *
 * Dynamic rather than static so the in-memory factory and the two adapters land
 * in one lazily-evaluated chunk, and so a bundler failure in a path the app does
 * not use cannot take the whole bundle down. See the module header.
 */
async function loadStorage(): Promise<StorageModule> {
  return import("../../../../baah-storage/src/index.ts");
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
    import("../../../../baah-tools/read/src/index.ts"),
    import("../../../../baah-tools/write/src/index.ts"),
    import("../../../../baah-tools/edit/src/index.ts"),
    import("../../../../baah-tools/list/src/index.ts"),
  ]);
  return [read.readTool, write.writeTool, edit.editTool, list.listTool].filter(isTool);
}

async function loadSearchTools(): Promise<readonly AnyToolDefinition[]> {
  const [glob, grep] = await Promise.all([
    import("../../../../baah-tools/glob/src/index.ts"),
    import("../../../../baah-tools/grep/src/index.ts"),
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
  /** Injected by a test; otherwise `loadStorage()` runs. */
  readonly storage?: StorageModule;
}

export interface AppRuntime {
  readonly runtime: BaahRuntime;
  readonly settings: SettingsStore;
  readonly questions: QuestionChannelState;
  readonly todos: TodoState;
  readonly workspace: Workspace;
  /** §5.3: the mode is visible, because the user must know where writes land. */
  readonly workspaceMode: "opfs" | "memory";
  /**
   * `true` when the transcript is in memory only.
   *
   * The shell renders this as a banner rather than hiding it: `Plan.md` §1's DoD
   * says the transcript must survive a reload, and a build that cannot must say so
   * in the first screen instead of losing the user's work silently on a refresh.
   */
  readonly ephemeralTranscript: boolean;
  /** `false` when a tool package failed to load. Said, not swallowed. */
  readonly toolsComplete: boolean;
  readonly missingTools: readonly string[];
  /**
   * The id of the assistant message the engine is currently writing into.
   *
   * `undefined` until the engine has produced a part. The app needs it because the
   * engine persists **no** tool parts (see {@link AppRuntime.recordToolInvocation}) and
   * reports no message id on any event — so this is the only place that can come
   * from.
   */
  readonly assistantMessageId: string | undefined;
  /**
   * Write the user's own message into the log, before the turn runs.
   *
   * ## Why the app does this and not the engine
   *
   * The engine builds the prompt as an in-memory `UIMessage`
   * (`agent/loop.ts`: `{ id: newMessageId(), role: "user", parts: [{ type: "text",
   * text: prompt }] }`) and hands it to `convertToModelMessages` — it never writes
   * it. So after a reload the transcript showed the assistant's answers with the
   * questions that produced them **missing**, which is a conversation nobody can
   * follow and `Plan.md` §6.1's `messages` table exists to prevent.
   *
   * The app is the right party: it composes the prompt, it knows when the user sent
   * it, and it is already the layer that owns the transcript view. Writing it before
   * `send` also gets the `seq` ordering right — `appendMessage` allocates
   * `MAX(seq) + 1` per session, so the question gets the lower number and reads
   * before its answer.
   *
   * Best-effort on purpose: a failure here is reported and the turn still runs,
   * because refusing to send a message because the transcript could not be written
   * would leave the user with no way to do anything at all.
   */
  recordUserMessage(text: string): Promise<void>;
  /**
   * Write or update the tool part for one call.
   *
   * ## The same gap, one level over
   *
   * `TurnStore` persists **text and reasoning deltas only** — `PartKind` is
   * `"text" | "reasoning"` and the file says why: "a tool part is written whole (input
   * at `tool-call`, output at `tool-result`) and has no mid-stream text, so there is
   * nothing to flush". But there is no `TurnStore` method for "written whole" either,
   * so the tool part is written **nowhere**: it exists in the `UIMessage[]` the loop
   * assembles, and the transcript had no card at all after a reload.
   *
   * `Plan.md` §6.1 puts the tool's payload in `parts.data` and §14.3 puts file diffs in
   * `metadata.files` on that same part, so the row is where the plan wants it. The app
   * writes it from the engine's own events, which carry everything a tool part needs
   * (`toolCallId`, `toolName`, `input`, then `output` / `error`).
   *
   * **An upsert, not an append** — the same `toolCallId` arrives three times (call,
   * result, and again on a retry's replay) and `parts` is keyed by id, so a second
   * `appendPart` would be a `UNIQUE` violation rather than an update. `upsertPart`
   * keeps `seq` and `created_at` (`Plan.md` §16.1), which is what makes a card update
   * in place instead of jumping down the transcript.
   */
  recordToolInvocation(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly state: "input-available" | "output-available" | "output-error" | "output-denied";
    readonly value?: unknown;
  }): Promise<void>;
}

/**
 * Build the app's runtime.
 *
 * `sessionId` is minted per tab and **not** persisted. The store is in-memory, so
 * a persisted id would name a session whose rows went away with the previous tab,
 * and `readTranscript` would report "no such session" — honest, and a poor first
 * impression for a fresh install. Once the store is SQLite, a persisted id is
 * correct and this line is the only thing that changes.
 */
export async function createAppRuntime(options: AppRuntimeOptions = {}): Promise<AppRuntime> {
  const storage = options.storage ?? (await loadStorage());
  const database = storage.createMemoryDatabase();
  const sessionId = options.sessionId ?? newId("session");

  // A session must exist before anything is written to it: `flushDelta` and
  // `finishTurn` both enforce the foreign key, and a store with no row for this id
  // refuses the first delta with a `sql_error` that reads like a broken database
  // rather than a missing one-liner.
  await database.createSession({ id: sessionId, title: "Sitzung" });

  // The decorator, and why it is needed at all: `TurnStore` has no method that
  // appends a turn or a message row, so the engine's parts attach to rows nobody
  // created. Measured — a plain turn refuses with
  // `FOREIGN KEY constraint failed: messages.id = …`. See `lib/turn-store.ts` for
  // the whole argument and for the finding it is a stand-in for.
  //
  // `onMessageCreated` is how the app learns the engine's message id, which it needs
  // to attach the tool parts the engine does not persist. A closure, not state: it is
  // written from a store callback and read from an event callback, and nothing
  // renders it.
  //
  // The **buffer** is the other half. A tool call arrives *before* the engine has
  // flushed a single delta of that attempt — step 1 is the tool call, step 2 is the
  // text — and the message row does not exist until that first flush. So a tool part
  // written on arrival would have nowhere to go, and writing it to a *newly minted*
  // row would split the assistant's turn in two: the text in one bubble, the card in
  // another, in the wrong order. Buffering until the real id arrives puts the card
  // where the model actually said it, and `upsertPart` then keeps it in place as the
  // card's state changes.
  let assistantMessageId: string | undefined;
  let pending: Parameters<AppRuntime["recordToolInvocation"]>[0][] = [];

  const store = withTranscriptRows(storage.createTurnStore(database), {
    writer: database,
    sessionId,
    onMessageCreated: (messageId) => {
      assistantMessageId = messageId;
      const queued = pending;
      pending = [];
      // Fire-and-report, and the order is kept: a card whose result arrived before
      // its call would render as a result with no input.
      for (const entry of queued) {
        void writeToolPart(entry, messageId).catch(() => undefined);
      }
    },
  });
  const reader = storage.createTranscriptReader(database);
  const settings = createSettingsStore({ backend: createWebStorageBackend() });
  const workspace = options.workspace ?? createMemoryWorkspace(defaultSandboxFiles());
  const questions = createQuestionChannelState();
  const todos = createTodoState();
  const loaded = options.tools ?? (await loadAppTools({ questions, todos, sessionId }));

  const runtime = createRuntime({
    store,
    transcript: reader,
    workspace,
    settings,
    registry: createDefaultProviderRegistry(),
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
    workspaceMode: "memory",
    ephemeralTranscript: true,
    toolsComplete: loaded.length >= 8,
    missingTools: loaded.length >= 8 ? [] : ["ein oder mehrere Werkzeuge"],
    get assistantMessageId() {
      return assistantMessageId;
    },
    /**
     * The id is minted **here** and used for both writes, rather than written and
     * then read back. The read-back version would be a race: a second prompt
     * arriving between the append and the read would find *that* message and hang
     * its part off it, and the first prompt's bubble would come out empty. Two
     * writes sharing one id cannot get that wrong.
     */
    async recordUserMessage(text: string): Promise<void> {
      const at = new Date().toISOString();
      const messageId = newId("msg");
      await database.appendMessage({
        id: messageId,
        sessionId,
        role: "user",
        createdAt: at,
        updatedAt: at,
      });
      // The text lives in a **part**, not in `messages` — §6.1's `parts` table, and
      // the read port renders parts, so a message with no part would render as an
      // empty bubble. `status: "completed"` because the user is done typing; a
      // `streaming` user message would be marked in flight forever.
      await database.appendPart({
        id: newId("part"),
        sessionId,
        messageId,
        type: "text",
        contentText: text,
        status: "completed",
        createdAt: at,
        updatedAt: at,
      });
    },
    async recordToolInvocation(input): Promise<void> {
      const messageId = assistantMessageId;
      if (messageId === undefined) {
        // Queued, not dropped — see the buffer's note above. A tool-only turn never
        // gets a message row from the engine, and the live fold shows the card until
        // then; losing it would leave a reload with no record of what the agent did.
        pending.push(input);
        return;
      }
      await writeToolPart(input, messageId);
    },
  };

  /**
   * Write one tool part, or fold it into the row that is already there.
   *
   * An **upsert**, keyed on a part id derived from the `toolCallId` — see
   * {@link AppRuntime.recordToolInvocation} for why the engine persists no tool parts
   * and why the id is derived rather than minted.
   */
  async function writeToolPart(
    input: Parameters<AppRuntime["recordToolInvocation"]>[0],
    messageId: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    const partId = partIdOf(input.toolCallId);
    // The same value-based derivation the live and stored cards use
    // (`lib/parts.ts`). A row written here is the row a **reload** renders, so
    // persisting the SDK's `output-available` for a tool that actually failed would
    // bake the wrong state into the transcript for good: the live card would be
    // right until the reload, and then wrong. The engine persists no tool parts of
    // its own, so this write is the only place the stored state exists.
    const state = toolStateForResult(input.state, input.value);
    // The two ways a failure reaches this function, and they carry different values:
    // the `tool-error` event carries the message **as a string**, while a
    // `tool-result` carrying `toToolErrorResult`'s envelope carries an object. So
    // the envelope is read first and the string is the fallback — neither path may
    // end up storing a state with no `errorText` to render, which is how a row ends
    // up claiming `output-error` and saying nothing about why.
    const failure = toolResultFailure(input.value) ?? (state === "output-error" ? asText(input.value) : undefined);
    const data = JSON.stringify({
      // The discriminator carries the name, exactly as the engine's own
      // `toolCallPart` does — `packages/baah-core/src/agent/loop.ts` has no
      // `toolName` field, and a reader looking for one finds nothing.
      type: `tool-${input.toolName}`,
      toolCallId: input.toolCallId,
      state,
      input: input.value,
      ...(failure === undefined ? {} : { errorText: failure }),
      ...(state === "output-available" ? { output: input.value } : {}),
    });
    await database.upsertPart({
      id: partId,
      sessionId,
      messageId,
      type: "tool",
      // The searchable projection (`Plan.md` §6.1's `content_text`). For a tool part
      // it is the rendered input, so a search for a path finds the call that made it.
      // `upsertPart` keeps `seq` and `created_at` (`Plan.md` §16.1), which is what makes
      // a card update in place instead of jumping down the transcript.
      contentText: asText(input.value),
      data,
      status: "completed",
      createdAt: at,
      updatedAt: at,
    });
  }
}

/**
 * The part id for a tool call.
 *
 * Derived from the `toolCallId` rather than minted, because the app sees the same
 * `toolCallId` three times — call, result, and again on a replay — and three minted
 * ids would be three rows for one call. The prefix keeps it recognisable in a row
 * dump (`lib/ids.ts` says the prefix is how a reader tells a part id from a turn id).
 */
function partIdOf(toolCallId: string): string {
  return `part-${toolCallId}`;
}

function asText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
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
  const questionModule = await import("../../../../baah-tools/question/src/index.ts");
  const todoModule = await import("../../../../baah-tools/todo/src/index.ts");

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
