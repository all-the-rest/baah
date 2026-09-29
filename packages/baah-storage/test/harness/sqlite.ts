/**
 * A real SQLite behind the worker's seams.
 *
 * The `@sqlite.org/sqlite-wasm` package ships a Node build (`exports.node`), so
 * the worker's dispatch table, its VFS guard, its transaction batching and the
 * `sql.ts` statements can all be exercised against the *real engine* in vitest —
 * no browser, no OPFS, no stubbed SQL semantics. `Plan.md` §6.2 requires the two
 * backends to be interchangeable; only a real engine can prove that.
 *
 * The `opfs-sahpool` VFS is the one thing that cannot run here (it needs OPFS),
 * so it is replaced by a pool whose constructor hands out a `:memory:`
 * database. Everything above the connection — install, pragmas, migrate, bind,
 * `changes()`, rollback, FTS5, CHECK constraints — is the production path.
 *
 * This file imports the package's Node build. Nothing under `src/` does: the
 * shipped worker still resolves the browser build, and this import is confined
 * to the test tree.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import type { SqlParam, SqlValue } from "../../src/types.ts";
import type { WorkerDatabase, WorkerSahPool } from "../../src/worker.ts";

let cached: Promise<Sqlite3Static> | null = null;

/** The real WASM module, initialised once per test file. */
export function loadSqlite3(): Promise<Sqlite3Static> {
  cached ??= sqlite3InitModule();
  return cached;
}

/**
 * The `oo1.DB` instance type, derived from the package's own declarations so an
 * upstream change surfaces here as a type error instead of a cast.
 */
type RawDatabase = InstanceType<Sqlite3Static["oo1"]["DB"]>;

/**
 * The six operations {@link WorkerDatabase} names, over a real `:memory:`
 * database. Nothing is faked: the constraint checks, the FTS5 index, the
 * transaction semantics and the `changes()` accounting are SQLite's own.
 */
export class InMemoryDatabase implements WorkerDatabase {
  readonly #raw: RawDatabase;
  /** Statements this connection ran — lets a test assert what was *not* run. */
  readonly executed: string[] = [];

  constructor(sqlite3: Sqlite3Static) {
    // `:memory:` is the only filename a real SQLite accepts without a VFS. The
    // worker's own filename handling is asserted through the requests instead.
    this.#raw = new sqlite3.oo1.DB(":memory:", "c");
  }

  exec(sql: string): void;
  exec(options: { sql: string; bind: readonly SqlParam[] }): void;
  exec(sqlOrOptions: string | { sql: string; bind: readonly SqlParam[] }): void {
    if (typeof sqlOrOptions === "string") {
      this.executed.push(sqlOrOptions);
      this.#raw.exec(sqlOrOptions);
      return;
    }
    this.executed.push(sqlOrOptions.sql);
    this.#raw.exec({ sql: sqlOrOptions.sql, bind: sqlOrOptions.bind });
  }

  selectObjects(sql: string, bind?: readonly SqlParam[]): Record<string, SqlValue>[] {
    this.executed.push(sql);
    return bind === undefined ? this.#raw.selectObjects(sql) : this.#raw.selectObjects(sql, bind);
  }

  selectArrays(sql: string, bind?: readonly SqlParam[]): SqlValue[][] {
    this.executed.push(sql);
    return bind === undefined ? this.#raw.selectArrays(sql) : this.#raw.selectArrays(sql, bind);
  }

  changes(): number {
    return this.#raw.changes();
  }

  isOpen(): boolean {
    return this.#raw.isOpen();
  }

  close(): void {
    this.#raw.close();
  }
}

export interface InMemoryPool extends WorkerSahPool {
  /** Every database the pool handed out, in construction order. */
  readonly opened: InMemoryDatabase[];
}

/**
 * A stand-in for the `opfs-sahpool` pool: the same constructor shape the worker
 * uses, a real in-memory database inside.
 */
export function createInMemoryPool(sqlite3: Sqlite3Static): InMemoryPool {
  const opened: InMemoryDatabase[] = [];
  return {
    opened,
    OpfsSAHPoolDb: class {
      readonly inner = new InMemoryDatabase(sqlite3);
      constructor(_filename: string) {
        opened.push(this.inner);
      }
      exec(sql: string): void;
      exec(options: { sql: string; bind: readonly SqlParam[] }): void;
      exec(sqlOrOptions: string | { sql: string; bind: readonly SqlParam[] }): void {
        if (typeof sqlOrOptions === "string") this.inner.exec(sqlOrOptions);
        else this.inner.exec(sqlOrOptions);
      }
      selectObjects(sql: string, bind?: readonly SqlParam[]): Record<string, SqlValue>[] {
        return bind === undefined
          ? this.inner.selectObjects(sql)
          : this.inner.selectObjects(sql, bind);
      }
      selectArrays(sql: string, bind?: readonly SqlParam[]): SqlValue[][] {
        return bind === undefined ? this.inner.selectArrays(sql) : this.inner.selectArrays(sql, bind);
      }
      changes(): number {
        return this.inner.changes();
      }
      isOpen(): boolean {
        return this.inner.isOpen();
      }
      close(): void {
        this.inner.close();
      }
    },
  };
}

export interface InMemoryInstaller {
  install: (options: { name: string; directory?: string }) => Promise<InMemoryPool>;
  pool: InMemoryPool;
}

/** The `installOpfsSAHPoolVfs` seam bound to an in-memory pool. */
export function installInMemoryPool(sqlite3: Sqlite3Static): InMemoryInstaller {
  const pool = createInMemoryPool(sqlite3);
  return { pool, install: async () => pool };
}

/**
 * The exception a browser throws when a `FileSystemSyncAccessHandle` is already
 * held by another context — the shape `isOwnershipFailure()` looks for.
 */
export function ownershipException(message = "The file is already locked by another tab."): Error {
  const error = new Error(message);
  error.name = "NoModificationAllowedError";
  return error;
}
