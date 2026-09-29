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
  FlushDeltaInput,
  FlushDeltaResult,
  Message,
  MessageInput,
  OpenResult,
  Part,
  PartInput,
  QueryResult,
  RunResult,
  SearchHit,
  SearchInput,
  Session,
  SessionInput,
  SqlMethod,
  SqlParam,
  SqlStatement,
  StorageDatabase,
  TxResult,
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
  /** Overrides the worker URL — for tests and non-Vite bundlers. */
  workerUrl?: string | URL;
  /**
   * Overrides how the worker is constructed — the seam the tests use to inject
   * an in-process fake instead of a real `Worker`.
   */
  workerFactory?: (url: string | URL) => WorkerLike;
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

  listSessions(): Promise<Session[]> {
    return this.#operations.listSessions();
  }

  deleteSession(id: string): Promise<void> {
    return this.#operations.deleteSession(id);
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
 * UNVERIFIED: the default worker URL uses the Vite-documented
 * `new URL("./worker.ts", import.meta.url)` form. That it resolves to a real
 * worker in the `baah-web` build is only provable in a browser.
 */
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
  const workerUrl = options.workerUrl ?? new URL("./worker.ts", import.meta.url);
  const worker = options.workerFactory
    ? options.workerFactory(workerUrl)
    : new Worker(workerUrl, { type: "module", name: "baah-storage" });
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

  return database;
}

/** Close the tab's database. Safe to call when nothing is open. */
export async function closeDatabase(): Promise<void> {
  const database = active;
  if (database === null) return;
  active = null;
  await database.close();
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
