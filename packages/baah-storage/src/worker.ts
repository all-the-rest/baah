/**
 * The single SQLite worker.
 *
 * Owns the `opfs-sahpool` VFS and the one connection it allows. Nothing else
 * in the app may open this database: a second tab or worker that tries will be
 * turned away with a typed `database_owned_by_another_context` error instead of
 * crashing on a raw `DOMException`.
 *
 * Two rules the whole file lives by:
 * 1. Never throw across `postMessage`. Every failure is a correlated
 *    `{ ok: false, error }` response.
 * 2. Never hold a SQLite transaction open across an `await`. `tx` and
 *    `flushDelta` are built from a pre-resolved parameter list and run
 *    synchronously between `BEGIN IMMEDIATE` and `COMMIT`.
 *
 * The logic is a factory, `createStorageWorker()`, with the SQLite module, the
 * VFS installer and the message scope injected. The module-level instance at
 * the bottom is what a bundler loads as the worker entry point; the factory is
 * what lets a test drive the same dispatch table without a browser. The
 * guards that matter most here — the ownership classification, the zod check on
 * incoming messages, the nested-transaction refusal — are only meaningful if
 * they can be run, and they could not be run at all while the state lived in
 * module-level `let`s.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { StorageError, isOwnershipFailure, ownershipError, toStorageError } from "./errors.ts";
import { applyMigrations } from "./migrations.ts";
import {
  createStorageOperations,
  toPartInput,
  type StorageEngine,
  type StatementOutcome,
} from "./operations.ts";
import { PRAGMAS } from "./schema.ts";
import { rpcRequestSchema, type RpcRequest, type RpcResponse } from "./protocol.ts";
import type { SqlMethod, SqlParam, SqlValue } from "./types.ts";

/**
 * The narrow slice of the worker global this file uses. Declared locally
 * because the tsconfig `lib` has no `WebWorker` and the package must not
 * depend on `@types/webworker`.
 */
interface WorkerScope {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const DEFAULT_VFS_NAME = "opfs-sahpool";

/** `open` payload, after validation. */
interface OpenOptions {
  filename: string;
  vfsName: string;
  directory: string | null;
}

/**
 * The slice of the SQLite-WASM `Database` class this worker actually calls.
 *
 * Narrower than the published class on purpose: it names the surface the engine
 * depends on, and it lets a test drive this same code path with a real
 * in-memory SQLite without a cast. The real `Database` satisfies it
 * structurally, so nothing is lost.
 */
export interface WorkerDatabase {
  exec(sql: string): void;
  exec(options: { sql: string; bind: readonly SqlParam[] }): void;
  selectObjects(sql: string, bind?: readonly SqlParam[]): Record<string, SqlValue>[];
  selectArrays(sql: string, bind?: readonly SqlParam[]): SqlValue[][];
  changes(): number;
  isOpen(): boolean;
  close(): void;
}

/**
 * What `installOpfsSAHPoolVfs` yields, reduced to the one constructor used. The
 * full `SAHPoolUtil` also carries capacity management, which this worker
 * deliberately leaves alone (`Plan.md` §6).
 */
export interface WorkerSahPool {
  OpfsSAHPoolDb: new (filename: string) => WorkerDatabase;
}

interface OpenHandle {
  sqlite3: Sqlite3Static;
  pool: WorkerSahPool;
  db: WorkerDatabase;
  options: OpenOptions;
  schemaVersion: number;
}

/**
 * Everything a worker instance owns, in one object rather than in module-level
 * `let`s — so a test can build one, drive it, and throw it away.
 */
interface WorkerState {
  handle: OpenHandle | null;
  /** Non-null while an `open` is in flight; blocks a concurrent one. */
  opening: Promise<OpenHandle> | null;
  /** True while a `tx`/`flushDelta` batch holds the write lock. */
  inBatch: boolean;
}

/** The seams a test replaces. Every one of them defaults to the real thing. */
export interface StorageWorkerOptions {
  /** Defaults to `@sqlite.org/sqlite-wasm`'s `sqlite3InitModule`. */
  sqlite3InitModule?: () => Promise<Sqlite3Static>;
  /** Defaults to `sqlite3.installOpfsSAHPoolVfs`. */
  installOpfsSAHPoolVfs?: (options: { name: string; directory?: string }) => Promise<WorkerSahPool>;
  /** Defaults to the real worker global. */
  scope?: WorkerScope;
}

export interface StorageWorker {
  /** What a `message` listener calls. Answers exactly one correlated response. */
  handleMessage(data: unknown): Promise<void>;
  /** Releases the connection, as the `close` request does. */
  closeDatabase(): void;
  /**
   * Read-only view of the state the guards consult. Exposed so a test can
   * assert that `handle` is actually null after a `close`, instead of inferring
   * it from the next error message.
   */
  readonly state: Readonly<WorkerState>;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

/**
 * SQLite-WASM is loaded inside the worker. The `.wasm` is located by the
 * package's own default `locateFile` (`new URL("sqlite3.wasm", import.meta.url)`),
 * so the bundler resolves it — we never build a path by hand.
 *
 * UNVERIFIED: the package's type declaration intentionally omits the parameter
 * list of `sqlite3InitModule()`, so a `locateFile` override is not reachable
 * type-safely and is therefore not used. The package README also requires
 * `optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] }` in the app's Vite
 * config; that config belongs to `baah-web`, not to this package.
 */
async function defaultLoadSqlite(): Promise<Sqlite3Static> {
  try {
    return await sqlite3InitModule();
  } catch (error) {
    throw new StorageError(
      "internal",
      `SQLite-WASM failed to initialise: ${toStorageError(error).message}`,
    );
  }
}

/**
 * Build a worker instance.
 *
 * The returned `handleMessage` is the whole dispatch surface: it validates the
 * message, runs the request, and posts one correlated response. It never
 * throws and never rejects — that is the invariant the client relies on.
 */
export function createStorageWorker(options: StorageWorkerOptions = {}): StorageWorker {
  const scope: WorkerScope = options.scope ?? (globalThis as unknown as WorkerScope);
  const loadSqlite = options.sqlite3InitModule ?? defaultLoadSqlite;

  const state: WorkerState = { handle: null, opening: null, inBatch: false };

  /**
   * Install the VFS and open the connection.
   *
   * The order is fixed by `Plan.md` §6 / §14.2: install, open, pragmas,
   * migrate. Pragmas come after `open` because `foreign_keys` and
   * `busy_timeout` are per-connection; migrations come last so the first
   * writer sees a valid schema.
   */
  async function openDatabase(openOptions: OpenOptions): Promise<OpenHandle> {
    if (state.handle !== null) {
      throw new StorageError(
        "database_already_open",
        "This worker already owns an open database; opfs-sahpool allows exactly one connection.",
      );
    }
    if (state.opening !== null) {
      // A concurrent `open` is the same situation, not a different one.
      throw new StorageError("database_already_open", "The database is already being opened.");
    }

    const attempt = (async (): Promise<OpenHandle> => {
      const sqlite3 = await loadSqlite();

      const install = options.installOpfsSAHPoolVfs ?? sqlite3.installOpfsSAHPoolVfs.bind(sqlite3);

      let pool: WorkerSahPool;
      try {
        pool = await install({
          name: openOptions.vfsName,
          ...(openOptions.directory === null ? {} : { directory: openOptions.directory }),
        });
      } catch (error) {
        // The interesting case: a second tab already holds the sync access
        // handles. That is a typed, expected outcome — not a crash. This
        // classification is a spec requirement (§6, single writer) and is the
        // difference between a banner and a stack trace.
        if (isOwnershipFailure(error)) throw ownershipError(error);
        throw new StorageError(
          "internal",
          `Could not install the '${openOptions.vfsName}' VFS: ${toStorageError(error).message}`,
        );
      }

      let db: WorkerDatabase;
      try {
        // `OpfsSAHPoolDb` takes the filename only; the VFS is already bound to
        // the pool. The file is created if it does not exist.
        db = new pool.OpfsSAHPoolDb(openOptions.filename);
      } catch (error) {
        throw new StorageError(
          "internal",
          `Could not open '${openOptions.filename}': ${toStorageError(error).message}`,
        );
      }

      try {
        for (const pragma of PRAGMAS) db.exec(pragma);
      } catch (error) {
        db.close();
        throw new StorageError(
          "internal",
          `Could not apply the connection pragmas: ${toStorageError(error).message}`,
        );
      }

      let schemaVersion: number;
      try {
        schemaVersion = applyMigrations(db).version;
      } catch (error) {
        db.close();
        throw toStorageError(error, "sql_error");
      }

      return { sqlite3, pool, db, options: openOptions, schemaVersion };
    })();

    // Claimed before the first `await`, so a second `open` that arrives while
    // this one is in flight is refused instead of racing it into the VFS.
    state.opening = attempt;
    try {
      const opened = await attempt;
      state.handle = opened;
      return opened;
    } finally {
      state.opening = null;
    }
  }

  function closeDatabase(): void {
    const current = state.handle;
    state.handle = null;
    if (current === null) return;
    if (current.db.isOpen()) current.db.close();
    // `sqlite3` and `pool` are held for their VFS lifetime; dropping the handle
    // releases them and makes the VFS name available to the next install.
  }

  /* ---------------------------------------------------------------- */
  /* Engine                                                             */
  /* ---------------------------------------------------------------- */

  /** Boolean binds are not a SQLite storage class; `0`/`1` is. */
  function bindable(params: readonly SqlParam[]): (string | number | null | Uint8Array)[] {
    return params.map((param) => (typeof param === "boolean" ? (param ? 1 : 0) : param));
  }

  /**
   * Run one SQLite call and name its failures.
   *
   * Everything SQLite rejects — a CHECK violation, a missing table, bad syntax
   * — is a `sql_error`, never `internal`. `internal` means "our bug", and the
   * in-memory backend already answers `sql_error` for the same bad input, so
   * letting the raw exception escape would make the two backends disagree on a
   * published error code.
   */
  function sqlite<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw toStorageError(error, "sql_error");
    }
  }

  function requireOpen(): OpenHandle {
    if (state.handle === null) {
      throw new StorageError(
        "database_not_open",
        "No database is open in this worker; send an 'open' request first.",
      );
    }
    return state.handle;
  }

  /**
   * One `BEGIN IMMEDIATE … COMMIT` batch.
   *
   * Between the two there is **no `await`**: every statement is executed
   * synchronously, so the write lock is never held across the worker boundary
   * and no other call can interleave. A nested batch is rejected rather than
   * silently opening a second transaction on the same connection.
   */
  function runBatch(
    statements: readonly { sql: string; params: readonly SqlParam[] }[],
  ): StatementOutcome[] {
    const { db } = requireOpen();
    if (state.inBatch) {
      // A second BEGIN on the same connection would fail with a bare SQLite
      // error ("cannot start a transaction within a transaction"); naming the
      // cause is worth the two lines, because a caller can act on this code
      // and not on `sql_error`.
      throw new StorageError(
        "nested_transaction",
        "A transaction is already running on this connection; batches cannot overlap.",
      );
    }

    const outcomes: StatementOutcome[] = [];
    state.inBatch = true;
    sqlite(() => db.exec("BEGIN IMMEDIATE"));
    try {
      for (const statement of statements) {
        const rows = sqlite(() => db.selectObjects(statement.sql, bindable(statement.params)));
        const changes = sqlite(() => db.changes());
        outcomes.push({ sql: statement.sql, changes, rows });
      }
      sqlite(() => db.exec("COMMIT"));
    } catch (error) {
      try {
        sqlite(() => db.exec("ROLLBACK"));
      } catch (rollbackError) {
        // Nothing useful is left to do: the transaction is in an unknown state.
        throw new AggregateError(
          [error, rollbackError],
          "The transaction failed and could not be rolled back.",
        );
      }
      throw toStorageError(error, "sql_error");
    } finally {
      state.inBatch = false;
    }
    return outcomes;
  }

  /**
   * One engine, one operations object: `tx` and `flushDelta` must not disagree
   * about how a transaction behaves.
   */
  const engine: StorageEngine = {
    async all(sql, params) {
      const { db } = requireOpen();
      // `rowMode: 'object'` gives the camelCase aliases from `sql.ts` back.
      return sqlite(() => db.selectObjects(sql, bindable(params)));
    },
    async run(sql, params) {
      const { db } = requireOpen();
      sqlite(() => db.exec({ sql, bind: bindable(params) }));
      return sqlite(() => db.changes());
    },
    async transaction(statements) {
      return runBatch(statements);
    },
  };
  const operations = createStorageOperations(engine);

  /* ---------------------------------------------------------------- */
  /* Dispatch                                                           */
  /* ---------------------------------------------------------------- */

  async function dispatch(request: RpcRequest): Promise<unknown> {
    switch (request.kind) {
      case "open": {
        const openOptions: OpenOptions = {
          filename: request.payload.filename,
          vfsName: request.payload.vfsName ?? DEFAULT_VFS_NAME,
          directory: request.payload.directory ?? null,
        };
        const opened = await openDatabase(openOptions);
        return {
          filename: opened.options.filename,
          vfsName: opened.options.vfsName,
          sqliteVersion: opened.sqlite3.version.libVersion,
          schemaVersion: opened.schemaVersion,
        };
      }

      case "query": {
        const { db } = requireOpen();
        const params = bindable(request.payload.params);
        const method: SqlMethod = request.payload.method;
        // `values` is the array shape `drizzle-orm/sqlite-proxy` expects for
        // `method: 'values'`; everything else is column-name keyed.
        const rows = sqlite(() =>
          method === "values"
            ? db.selectArrays(request.payload.sql, params)
            : db.selectObjects(request.payload.sql, params),
        );
        return { rows, changes: sqlite(() => db.changes()) };
      }

      case "run": {
        const { db } = requireOpen();
        sqlite(() => db.exec({ sql: request.payload.sql, bind: bindable(request.payload.params) }));
        return { changes: sqlite(() => db.changes()) };
      }

      case "tx": {
        const outcomes = runBatch(request.payload.statements);
        return {
          changes: outcomes.reduce((total, outcome) => total + outcome.changes, 0),
          results: outcomes.map((outcome) => ({ changes: outcome.changes, rows: outcome.rows })),
        };
      }

      case "search": {
        requireOpen();
        const payload = request.payload;
        return {
          hits: await operations.search({
            query: payload.query,
            ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
            limit: payload.limit,
          }),
        };
      }

      case "flushDelta": {
        requireOpen();
        const payload = request.payload;
        return operations.flushDelta({
          deltaId: payload.deltaId,
          part: toPartInput(payload.part),
          flushedAt: payload.flushedAt,
        });
      }

      case "close": {
        closeDatabase();
        return { closed: true };
      }
    }
  }

  function post(response: RpcResponse): void {
    scope.postMessage(response);
  }

  /** Best-effort correlation id recovery for a message that failed validation. */
  function extractCorrelationId(data: unknown): string {
    if (typeof data !== "object" || data === null) return "";
    const raw = (data as Record<string, unknown>)["id"];
    return typeof raw === "string" ? raw : "";
  }

  async function handleMessage(data: unknown): Promise<void> {
    // `AGENTS.md` §5: everything crossing a boundary is parsed, never blind-cast.
    // A malformed message must not reach `dispatch` — an unvalidated `kind`
    // would run whatever it names.
    const parsed = rpcRequestSchema.safeParse(data);
    if (!parsed.success) {
      // We may not have a usable correlation id — the message was malformed.
      // Reply anyway with an empty id so the caller's pending map can drain.
      post({
        id: extractCorrelationId(data),
        kind: "invalid",
        ok: false,
        error: {
          code: "invalid_message",
          message: `Rejected worker message: ${parsed.error.message}`,
          details: { issues: parsed.error.issues.length.toString() },
        },
      });
      return;
    }

    const request = parsed.data;
    try {
      const result = await dispatch(request);
      post({ id: request.id, kind: request.kind, ok: true, result });
    } catch (error) {
      const failure = toStorageError(error);
      post({
        id: request.id,
        kind: request.kind,
        ok: false,
        error: failure.toPayload(),
      });
    }
  }

  return {
    handleMessage,
    closeDatabase,
    get state(): Readonly<WorkerState> {
      return state;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Hand one incoming message to the worker, without producing an unhandled
 * rejection and without swallowing a failure either.
 *
 * `handleMessage` answers **every** request with exactly one correlated
 * response — that is the contract `client.ts` waits on, and it is why this call
 * is fire-and-forget at the entry point rather than awaited. The only way it can
 * reject is a `postMessage` that itself failed, and then the client is sitting
 * on a promise that will never settle. A `catch {}` here would turn that hang
 * into silence; a bare `void` would turn it into an *unhandled promise
 * rejection*, which in a worker is reported on the worker's own
 * `unhandledrejection` and is invisible to the parent — the client keeps waiting
 * either way.
 *
 * The honest report is an uncaught error in the worker's global scope, because
 * that is the one thing the parent does observe: `client.ts` already listens for
 * the worker's `error` event and turns it into a typed `internal` rejection for
 * every pending call. So the failure is re-raised in a fresh task instead of
 * being dropped.
 *
 * Exported and named so the behaviour is reachable from a test — the module-level
 * `addEventListener` registration below is the only production caller, and a
 * branch nothing can reach is a branch nothing can check.
 */
export function handleWorkerMessage(worker: StorageWorker, data: unknown): void {
  void worker.handleMessage(data).catch((error: unknown) => {
    setTimeout(() => {
      throw error instanceof Error ? error : new Error(String(error));
    }, 0);
  });
}

const worker = createStorageWorker();

const workerGlobal = globalThis as unknown as Partial<WorkerScope>;
if (typeof workerGlobal.addEventListener === "function") {
  // Only inside a real worker. Node has no `addEventListener` on `globalThis`,
  // and the test suite imports this module to drive `createStorageWorker()`
  // directly — importing it must not require a browser.
  workerGlobal.addEventListener("message", (event) => {
    // Fire and forget: every path answers with a correlated response, and a
    // failure to answer is re-raised rather than dropped — see
    // {@link handleWorkerMessage}.
    handleWorkerMessage(worker, event.data);
  });
}
