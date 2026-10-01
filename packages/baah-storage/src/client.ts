/**
 * The main-thread face of the persistence layer.
 *
 * `openDatabase()` starts the one worker, asks it to install the VFS and open
 * the connection, and returns a typed client. Everything is a promise: the
 * worker's SQLite calls are synchronous, but the transport and the
 * `postMessage` hop are not, and pretending otherwise would leak the worker's
 * threading model into the UI.
 *
 * The typed helpers are not re-implemented here. They are the *same*
 * `createStorageOperations()` the in-memory factory uses, bound to an engine
 * that speaks RPC instead of SQLite — so `seq` allocation, upsert semantics and
 * the row shapes cannot drift between the two backends.
 */

import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";
import type { z } from "zod";

import { StorageError } from "./errors.ts";
import { createStorageOperations, type StorageEngine } from "./operations.ts";
import {
  closeResultSchema,
  flushDeltaResultSchema,
  openResultSchema,
  queryResultSchema,
  rpcResponseSchema,
  runResultSchema,
  searchResultSchema,
  storageErrorPayloadSchema,
  txResultSchema,
} from "./protocol.ts";
import type {
  BeginToolCallInput,
  ClosePartInput,
  CloseTurnPartsInput,
  FinishTurnInput,
  FlushDeltaInput,
  FlushDeltaResult,
  Message,
  MessageInput,
  OpenResult,
  Part,
  PartInput,
  QueryResult,
  RecordToolCallInput,
  RenewHeartbeatInput,
  RunResult,
  SearchHit,
  SearchInput,
  Session,
  SessionInput,
  SqlMethod,
  SqlParam,
  SqlStatement,
  StorageDatabase,
  ToolCallKey,
  ToolCallRecord,
  TranscriptQuery,
  TranscriptRows,
  Turn,
  TurnInput,
  TurnOutcomeEntry,
  UnfinishedTurn,
  TxResult,
  Workspace,
  WorkspaceInput,
} from "./types.ts";

const DEFAULT_FILENAME = "/baah.sqlite3";
const DEFAULT_VFS_NAME = "opfs-sahpool";

/** The slice of `Worker` the client uses. A fake satisfies it in a test. */
export interface WorkerLike {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message: string }) => void): void;
  addEventListener(type: "messageerror", listener: (event: unknown) => void): void;
  terminate(): void;
}

export interface OpenDatabaseOptions {
  /** Path inside the VFS. Leading slash, as SQLite expects. */
  filename?: string;
  /** `opfs-sahpool` is the only supported VFS (see `Plan.md` §14.2). */
  vfsName?: string;
  /** OPFS directory the VFS keeps its file pool in. */
  directory?: string;
  /** The compiled worker's URL. Required unless `workerFactory` is given. */
  workerUrl?: string | URL;
  /**
   * Overrides how the worker is constructed — the seam the tests use to inject
   * an in-process fake instead of a real `Worker`.
   *
   * `url` is `undefined` when no `workerUrl` was passed. A factory that is
   * genuinely building its own worker does not need it; one that forwards it
   * must check, because the alternative used to be a bundler copying
   * `./worker.ts` verbatim into `dist/`.
   */
  workerFactory?: (url: string | URL | undefined) => WorkerLike;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: StorageError) => void;
};

export class WorkerStorageDatabase implements StorageDatabase {
  readonly kind = "worker" as const;
  /** The path inside the VFS. Known from the options, before the worker answers. */
  readonly filename: string;

  readonly #worker: WorkerLike;
  readonly #pending = new Map<string, Pending>();
  readonly #operations: ReturnType<typeof createStorageOperations>;
  #closed = false;

  constructor(worker: WorkerLike, filename: string) {
    this.#worker = worker;
    this.filename = filename;
    this.#operations = createStorageOperations(this.#rpcEngine());

    worker.addEventListener("message", (event) => {
      // `MessageEvent.data` is `any` in the DOM lib. It is untrusted, so it is
      // narrowed to `unknown` here and parsed by zod in `#receive`.
      this.#receive(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.#failAll(new StorageError("internal", `The storage worker failed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
      this.#failAll(
        new StorageError("internal", "A storage worker message could not be deserialised."),
      );
    });
  }

  /** Installs the VFS and opens the connection inside the worker. */
  async open(options: OpenDatabaseOptions): Promise<OpenResult> {
    return this.#send(
      "open",
      {
        filename: options.filename ?? this.filename,
        vfsName: options.vfsName ?? DEFAULT_VFS_NAME,
        ...(options.directory === undefined ? {} : { directory: options.directory }),
      },
      openResultSchema,
    );
  }

  #receive(data: unknown): void {
    const parsed = rpcResponseSchema.safeParse(data);
    if (!parsed.success) {
      this.#failAll(
        new StorageError("internal", `Malformed worker response: ${parsed.error.message}`),
      );
      return;
    }
    const response = parsed.data;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);

    if (!response.ok) {
      const payload = response.error;
      pending.reject(
        payload === undefined
          ? new StorageError("internal", "The worker reported a failure without an error payload.")
          : StorageError.fromPayload(storageErrorPayloadSchema.parse(payload)),
      );
      return;
    }
    pending.resolve(response.result);
  }

  #failAll(error: StorageError): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  /**
   * One request/response round trip. Every response carries the request's
   * correlation id, so a late answer can never settle the wrong promise.
   */
  #send<S extends z.ZodType>(kind: string, payload: unknown, schema: S): Promise<z.output<S>> {
    if (this.#closed) {
      return Promise.reject(
        new StorageError("database_closed", "This database handle is already closed."),
      );
    }
    const id = crypto.randomUUID();
    return new Promise<z.output<S>>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => {
          const parsed = schema.safeParse(value);
          if (!parsed.success) {
            reject(
              new StorageError("internal", `Malformed '${kind}' result: ${parsed.error.message}`),
            );
            return;
          }
          resolve(parsed.data);
        },
        reject,
      });
      this.#worker.postMessage({ id, kind, payload });
    });
  }

  query(
    sql: string,
    params: readonly SqlParam[] = [],
    method: SqlMethod = "all",
  ): Promise<QueryResult> {
    return this.#send("query", { sql, params: [...params], method }, queryResultSchema);
  }

  run(sql: string, params: readonly SqlParam[] = []): Promise<RunResult> {
    return this.#send("run", { sql, params: [...params] }, runResultSchema);
  }

  transaction(statements: readonly SqlStatement[]): Promise<TxResult> {
    const payload = statements.map((statement) => ({
      sql: statement.sql,
      params: statement.params === undefined ? [] : [...statement.params],
    }));
    return this.#send("tx", { statements: payload }, txResultSchema);
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    const result = await this.#send(
      "search",
      {
        query: input.query,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      searchResultSchema,
    );
    return result.hits;
  }

  async flushDelta(input: FlushDeltaInput): Promise<FlushDeltaResult> {
    return this.#send("flushDelta", input, flushDeltaResultSchema);
  }

  createSession(input: SessionInput): Promise<Session> {
    return this.#operations.createSession(input);
  }

  getSession(id: string): Promise<Session | null> {
    return this.#operations.getSession(id);
  }

  listSessions(input?: { readonly workspaceId?: string | undefined }): Promise<Session[]> {
    return this.#operations.listSessions(input);
  }

  deleteSession(id: string): Promise<void> {
    return this.#operations.deleteSession(id);
  }

  attachSessionToWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
    return this.#operations.attachSessionToWorkspace(sessionId, workspaceId);
  }

  createWorkspace(input: WorkspaceInput): Promise<Workspace> {
    return this.#operations.createWorkspace(input);
  }

  getWorkspace(id: string): Promise<Workspace | null> {
    return this.#operations.getWorkspace(id);
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.#operations.listWorkspaces();
  }

  appendMessage(input: MessageInput): Promise<Message> {
    return this.#operations.appendMessage(input);
  }

  getMessage(id: string): Promise<Message | null> {
    return this.#operations.getMessage(id);
  }

  listMessages(sessionId: string): Promise<Message[]> {
    return this.#operations.listMessages(sessionId);
  }

  /**
   * A transcript window, over the shared operations module like every other read.
   *
   * That is what makes the closed-database case honest without a line of code
   * here: `engine.all` is `query`, `query` is `#send`, and `#send` refuses a
   * closed handle with `database_closed`. The read does not catch it, and the
   * read port does not catch it either — a refusal that became an empty array
   * would be a lie the UI could not detect.
   */
  readTranscript(input: TranscriptQuery): Promise<TranscriptRows> {
    return this.#operations.readTranscript(input);
  }

  appendPart(input: PartInput): Promise<Part> {
    return this.#operations.appendPart(input);
  }

  upsertPart(input: PartInput): Promise<Part> {
    return this.#operations.upsertPart(input);
  }

  listParts(messageId: string): Promise<Part[]> {
    return this.#operations.listParts(messageId);
  }

  /**
   * The three closing reads and writes go over the shared operations module, so
   * they are plain `run`/`all` RPCs rather than dedicated wire messages: a
   * close is one statement, and a wire message per statement is a second
   * dispatch table to keep in step with `sql.ts` for no gain.
   */
  closePart(input: ClosePartInput): Promise<void> {
    return this.#operations.closePart(input);
  }

  closeTurnParts(input: CloseTurnPartsInput): Promise<void> {
    return this.#operations.closeTurnParts(input);
  }

  appendTurn(input: TurnInput): Promise<Turn> {
    return this.#operations.appendTurn(input);
  }

  listUnfinishedTurns(input: { sessionId: string }): Promise<UnfinishedTurn[]> {
    return this.#operations.listUnfinishedTurns(input);
  }

  listTurnOutcomes(input: { sessionId: string }): Promise<TurnOutcomeEntry[]> {
    return this.#operations.listTurnOutcomes(input);
  }

  finishTurn(input: FinishTurnInput): Promise<void> {
    return this.#operations.finishTurn(input);
  }

  renewHeartbeat(input: RenewHeartbeatInput): Promise<void> {
    return this.#operations.renewHeartbeat(input);
  }

  beginToolCall(input: BeginToolCallInput): Promise<void> {
    return this.#operations.beginToolCall(input);
  }

  recordToolCall(input: RecordToolCallInput): Promise<void> {
    return this.#operations.recordToolCall(input);
  }

  getToolCall(key: ToolCallKey): Promise<ToolCallRecord | undefined> {
    return this.#operations.getToolCall(key);
  }

  /**
   * The engine the typed helpers run on: RPC instead of direct SQLite.
   *
   * Bound through arrow functions over the public methods, so the property
   * lookup resolves on `WorkerStorageDatabase` and not on the engine object —
   * otherwise `this.transaction` here would call the engine's own method.
   */
  #rpcEngine(): StorageEngine {
    const query = (sql: string, params: readonly SqlParam[]): Promise<QueryResult> =>
      this.query(sql, params, "all");
    const run = (sql: string, params: readonly SqlParam[]): Promise<RunResult> =>
      this.run(sql, params);
    const transaction = (statements: readonly SqlStatement[]): Promise<TxResult> =>
      this.transaction(statements);

    return {
      all: async (sql, params) => (await query(sql, params)).rows,
      run: async (sql, params) => (await run(sql, params)).changes,
      async transaction(statements) {
        const result = await transaction(statements);
        return statements.map((statement, index) => {
          const outcome: unknown = result.results[index];
          const changes =
            typeof outcome === "object" && outcome !== null
              ? (outcome as Record<string, unknown>)["changes"]
              : undefined;
          return {
            sql: statement.sql,
            changes: typeof changes === "number" ? changes : 0,
            rows: [],
          };
        });
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#send("close", {}, closeResultSchema);
    } catch {
      // Closing never throws: the worker is terminated either way, and a
      // half-closed handle would only make the caller noisier.
    } finally {
      this.#failAll(new StorageError("database_closed", "The database was closed."));
      this.#worker.terminate();
    }
  }
}

/** The database this tab owns, if any. */
let active: WorkerStorageDatabase | null = null;

/**
 * Open the one database this page owns.
 *
 * `opfs-sahpool` permits exactly one connection per origin and directory
 * (`Plan.md` §14.2), so a second call while one is open is rejected here
 * instead of failing deeper down with a raw DOM exception.
 *
 * Rejects with `database_owned_by_another_context` when another tab or worker
 * already owns the VFS — that error is a typed, expected outcome, not a crash.
 *
 * **There is no default worker URL**, and that is a decision rather than a gap:
 * see the construction site below. `UNVERIFIED` used to stand here, describing a
 * fallback that nothing took and no browser could have run.
 */
/**
 * Whether the browser has agreed to keep this origin's storage.
 *
 * - `unknown`   nothing asked yet (or the ask is still in flight)
 * - `granted`   `navigator.storage.persisted()` or `.persist()` says yes: the browser
 *               will not clear OPFS or Local Storage under storage pressure
 * - `denied`    asked and refused. **Not an error** — it is the browser's answer, and
 *               it means best-effort storage, so the app has to behave as if a reload
 *               can lose data.
 * - `unavailable`  no StorageManager at all: a test environment, or a browser without
 *               the Storage API. Not a failure either.
 */
export type PersistenceState = "unknown" | "granted" | "denied" | "unavailable";

let persistence: PersistenceState = "unknown";

/** The current answer, for the UI to show. Never throws, never blocks. */
export function persistenceState(): PersistenceState {
  return persistence;
}

/**
 * Ask the browser to make this origin's storage **persistent**.
 *
 * ## Why this is here and why it was missing
 *
 * `Plan.md` §1136 grounds `storage.persist()` in two real facts: Safari deletes
 * script-created data after seven days without interaction, and OPFS is
 * best-effort by default. Until now that call existed in exactly one place —
 * `baah-core/src/workspace/opfs.ts` — and **that function is never called by the
 * app**. So the protection sat on a path nobody walked while the thing it protects,
 * the session database, asked for nothing.
 *
 * ## Why it is not the critical path
 *
 * It is asked **after** `database.open()` resolved, so a slow or prompting
 * `persist()` cannot delay a usable database. A prompt during app start would be
 * the wrong moment to show one; this way the app is already running when it appears.
 *
 * ## Why the answer is recorded rather than thrown
 *
 * `denied` is a legitimate answer, not a failure. A caller that treats it as an
 * exception will either crash a perfectly working app or, worse, wrap the ask in a
 * `catch` and lose the state — which is precisely how the protection went missing
 * in the first place. `AGENTS.md` §5 wants errors the user must see turned into
 * typed events; this is a **fact about the environment**, surfaced as a value.
 */
let persistenceRequest: Promise<PersistenceState> | undefined;

function askForPersistence(): Promise<PersistenceState> {
  if (persistenceRequest !== undefined) return persistenceRequest;

  persistenceRequest = (async () => {
    // The property access is INSIDE the try. It was outside in the first version,
    // and a `navigator` whose `storage` getter throws then took the whole open down
    // with it - a hostile or partial global should not be able to do that, and the
    // test that pins it is `survives a navigator that throws on property access`.
    try {
      const manager = (globalThis.navigator as Navigator | undefined)?.storage;
      if (manager === undefined || typeof manager.persisted !== "function") {
        persistence = "unavailable";
        return persistence;
      }
      if (await manager.persisted()) {
        persistence = "granted";
        return persistence;
      }
      persistence = (await manager.persist()) ? "granted" : "denied";
    } catch {
      // A rejected `persist()` is the browser declining, not a bug in here. Recorded
      // as `denied` so the UI can tell the user their history is best-effort.
      persistence = "denied";
    }
    return persistence;
  })();

  return persistenceRequest;
}

/**
 * Resolves once the answer is in. **Not** awaited by `openDatabase()` - see the note
 * there - so this is how a caller waits for the state without having made the state a
 * precondition for opening the database.
 */
export function persistenceSettled(): Promise<PersistenceState> {
  return persistenceRequest ?? Promise.resolve(persistence);
}

export async function openDatabase(
  options: OpenDatabaseOptions = {},
): Promise<WorkerStorageDatabase> {
  if (active !== null) {
    throw new StorageError(
      "database_already_open",
      "A database is already open in this tab; opfs-sahpool allows a single connection.",
    );
  }

  const filename = options.filename ?? DEFAULT_FILENAME;
  // **No `new URL("./worker.ts", import.meta.url)` fallback, deliberately.**
  //
  // That line was here, marked `UNVERIFIED` by the code itself, and it cost
  // 20 738 bytes: a bundler resolves `new URL(<literal>, import.meta.url)`
  // statically and copies the target into `dist/` **verbatim**, so the shipped
  // artefact carried untranspiled TypeScript — which a static host then serves
  // as `video/mp2t`. Nothing ever ran it: every test passes a `workerFactory`,
  // and the app passes the URL from a `?worker&url` import.
  //
  // A path that is never taken and cannot work is not a fallback, it is a way to
  // ship a file by accident. The error below names the import that works.
  if (options.workerUrl === undefined && options.workerFactory === undefined) {
    throw new StorageError(
      "unsupported",
      "openDatabase() needs a worker URL or a factory. In a Vite build: " +
        "const { default: url } = await import('@all-the.rest/baah-storage/worker?worker&url'); " +
        "then pass `workerUrl: url`. (`?worker&url`, not bare `?worker` - they differ in Vite 8.)",
    );
  }
  const workerUrl = options.workerUrl;
  const worker = options.workerFactory
    ? options.workerFactory(workerUrl)
    : new Worker(workerUrl as string | URL, { type: "module", name: "baah-storage" });
  const database = new WorkerStorageDatabase(worker, filename);

  // Claim the slot *synchronously*, before the first `await`. Assigning it
  // after `database.open()` resolved left a window in which a second
  // `openDatabase()` call saw `active === null`, spawned a second worker, and
  // raced this one into `installOpfsSAHPoolVfs` — where the loser fails with
  // an ownership error instead of the typed "already open" one, and the
  // winner's handle can be clobbered by the loser's assignment.
  active = database;

  try {
    await database.open({ ...options, filename });
  } catch (error) {
    // The typed error from the worker (ownership, VFS, migration) is the
    // answer; the worker itself is dead either way. The claim has to be
    // released, or a failed open would block every later one.
    active = null;
    worker.terminate();
    throw error;
  }

  // Started after the open and deliberately NOT awaited. The first version awaited it,
  // and that contradicted its own stated reason: a `persist()` that prompts would then
  // sit on the path between "database is open" and "caller has the database", which is
  // the worst moment for a permission dialog. A caller that needs the answer awaits
  // `persistenceSettled()`.
  // The handler is not decoration. Every path inside `askForPersistence` is inside a
  // `try`, so it cannot reject — and that is exactly why `void promise` is the wrong
  // spelling: a reader cannot see the internal `try` from the call site, and if a
  // future refactor moved a line out of it, the rejection would be **unhandled and
  // silent**. The repo's own `no-bare-void` gate caught exactly this, and it was
  // right: a discarded promise with no handler is an unhandled rejection, not a
  // no-op.
  //
  // The handler records rather than swallows. If the ask ever fails for a reason the
  // inner `try` does not cover, the honest answer for the UI is that protection is NOT
  // in place — not `unknown`, which reads as "no answer yet" and would leave a user
  // being told nothing at all.
  void askForPersistence().catch(() => {
    persistence = "denied";
  });

  return database;
}

/** Close the tab's database. Safe to call when nothing is open. */
export async function closeDatabase(): Promise<void> {
  const database = active;
  if (database === null) return;
  active = null;
  await database.close();
  // The persistence answer is forgotten with the database, and this is a semantic
  // decision, not a convenience. Cached for the lifetime of the tab, a `denied` from
  // one session is never re-asked in the next - and persistence is not the only thing
  // that changes: a user who later installs the PWA, or reaches Chrome's engagement
  // thresholds, would be told "denied" forever, by a value nobody re-checked.
  //
  // The cost is one `persisted()` call per open sequence, which does not prompt.
  // `persist()` - the call that can - is only reached when `persisted()` says false,
  // so the prompt-per-cold-start worry is handled at the right place rather than by
  // caching a value that goes stale. Whether repeated denials produce repeated prompts
  // is **not** measured here; AGENTS.md §2b says that is a manual gate, and guessing
  // it would be the same fault as the caching itself.
  persistenceRequest = undefined;
  // The **state** too, not just the promise. Resetting only the promise leaves the
  // previous answer visible - which is the more dangerous half: a caller reads
  // `denied` from a database that is not even the one that was denied, and the UI
  // tells a user their history is best-effort on the strength of a stale value.
  persistence = "unknown";
}

/**
 * A `drizzle-orm/sqlite-proxy` callback over this database.
 *
 * `sqlite-proxy` is not an HTTP driver — it is a generic async callback, which
 * is exactly the shape of a worker RPC (`Plan.md` §14.2). `values` asks for
 * positional rows, `all`/`get` want column-name keyed objects; the worker
 * returns the matching shape for each.
 */
/**
 * Convert one drizzle bind parameter into a value the worker accepts.
 *
 * `sqlite-proxy` types its `params` as `any[]`, but the worker's
 * `sqlParamsSchema` is a strict union of `string | number | boolean | null |
 * Uint8Array` (`protocol.ts`). Anything outside it — a `Date` column, a `bigint`
 * from a `mode: 'number'`-ish mapper, a plain object — is rejected at the
 * worker boundary as an `invalid_message`, long after the caller could do
 * anything about it. Normalising here turns those into SQLite values:
 *
 * - `Date` → ISO-8601 string. SQLite has no date storage class, and the schema
 *   stores every timestamp as ISO text (`AGENTS.md` §5), so this is exactly
 *   what a hand-written query would pass.
 * - `bigint` → decimal string. SQLite-WASM binds a `bigint` as a REAL or
 *   INTEGER depending on magnitude, and a 64-bit id that does not fit an
 *   INTEGER would silently lose precision; a string is lossless and compares
 *   correctly against TEXT ids (which is what the schema uses for every `id`).
 * - `boolean` → `0`/`1` is left to the worker's `bindable()`, which is the
 *   single place that rule is written.
 *
 * Anything else is refused by name, so the failure is at the call site with a
 * message that says which driver introduced it.
 */
export function normaliseDrizzleParam(value: unknown, index: number): SqlParam {
  // `index` is the 0-based array position; the message counts from 1, which is
  // how a caller reading SQL would name it.
  const position = index + 1;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new StorageError(
        "invalid_message",
        `drizzle passed the non-finite number ${String(value)} as parameter ${position}; ` +
          "SQLite cannot bind it.",
        { parameter: String(position) },
      );
    }
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new StorageError(
        "invalid_message",
        `drizzle passed an invalid Date as parameter ${position}; it cannot be bound.`,
        { parameter: String(position) },
      );
    }
    return value.toISOString();
  }
  if (typeof value === "bigint") return value.toString();

  throw new StorageError(
    "invalid_message",
    `drizzle passed a value of type ${describeValue(value)} as parameter ${position}, ` +
      "which the SQLite worker cannot bind. Supported: string, number, boolean, " +
      "bigint, Date, Uint8Array, null.",
    { parameter: String(position) },
  );
}

/**
 * A readable type name for an error message.
 *
 * The *value* is never included: a bind parameter can be a secret, and an
 * error message crosses the worker boundary and lands in a log.
 */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) {
    const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : "object";
  }
  return typeof value;
}

/** {@link normaliseDrizzleParam} over a whole parameter list. */
export function normaliseDrizzleParams(params: readonly unknown[]): SqlParam[] {
  return params.map((value, index) => normaliseDrizzleParam(value, index));
}

export function createDrizzleCallback(database: WorkerStorageDatabase): RemoteCallback {
  return async (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    const result = await database.query(sql, normaliseDrizzleParams(params), method);
    return { rows: result.rows };
  };
}
