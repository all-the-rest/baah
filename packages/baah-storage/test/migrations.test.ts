/**
 * Migrations: ordering, idempotency and rollback.
 *
 * Runs against a recording {@link MigrationHost} rather than a real SQLite
 * engine — the WASM build is browser/worker-only (`AGENTS.md` §2), and the
 * point here is the *ordering and bookkeeping logic*, which is engine
 * independent by design.
 */

import { describe, expect, it } from "vitest";

import {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
  type MigrationHost,
} from "../src/migrations.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "../src/schema.ts";
import type { SqlValue } from "../src/types.ts";

/**
 * A `MigrationHost` that records everything it is told and models just enough
 * of `schema_migrations` to answer "which versions are applied?".
 */
function createRecordingHost(options: { failOn?: string } = {}) {
  const executed: string[] = [];
  const applied: number[] = [];
  let bootstrapped = false;
  let transactionDepth = 0;
  let inTransaction = false;
  const recorded: { version: number; name: string; appliedAt: string }[] = [];

  const host: MigrationHost & {
    executed: string[];
    recorded: typeof recorded;
    appliedVersions(): number[];
    wasInTransaction(): boolean;
    bootstrapped(): boolean;
  } = {
    executed,
    recorded,

    appliedVersions: () => [...applied],
    wasInTransaction: () => inTransaction,
    bootstrapped: () => bootstrapped,

    exec(sql) {
      executed.push(sql);
      if (options.failOn !== undefined && sql.includes(options.failOn)) {
        throw new Error(`deliberate failure on: ${sql.slice(0, 40)}`);
      }
      if (sql === SCHEMA_MIGRATIONS_TABLE) {
        bootstrapped = true;
        return;
      }
      if (sql.startsWith("BEGIN")) {
        if (inTransaction) throw new Error("nested BEGIN");
        inTransaction = true;
        transactionDepth += 1;
        return;
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        if (!inTransaction) throw new Error(`${sql} without BEGIN`);
        inTransaction = false;
        transactionDepth -= 1;
        return;
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        const version = Number(/VALUES \((\d+),/.exec(sql)?.[1]);
        if (applied.includes(version)) {
          throw new Error(`duplicate row for version ${version}`);
        }
        const name = /VALUES \(\d+, '([^']*)'/.exec(sql)?.[1] ?? "";
        const appliedAt = /'([^']*)'\);$/.exec(sql)?.[1] ?? "";
        applied.push(version);
        recorded.push({ version, name, appliedAt });
      }
    },

    selectObjects(): Record<string, SqlValue>[] {
      return applied.map((version) => ({ version }));
    },
  };

  return host;
}

const fixedNow = (): string => "2026-09-29T12:00:00.000Z";

describe("the migration list", () => {
  it("is ordered by version with no gaps and no duplicates", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([1, 2, 3, 4]);
    expect(LATEST_SCHEMA_VERSION).toBe(Math.max(...versions));
  });

  it("gives every migration a name and at least one statement", () => {
    for (const migration of MIGRATIONS) {
      expect(migration.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(migration.statements.length).toBeGreaterThan(0);
    }
  });

  it("makes every statement of every *creating* step idempotent", () => {
    // Steps 1-3 only create things, so `IF NOT EXISTS` on each statement means a
    // replay cannot fail. Step 4 is a rebuild and cannot be — see the next test.
    for (const migration of MIGRATIONS.filter((entry) => entry.version < 4)) {
      for (const statement of migration.statements) {
        expect(statement, `${migration.name}: ${statement.slice(0, 60)}`).toMatch(/IF NOT EXISTS/i);
      }
    }
  });

  it("protects the rebuild step by its transaction, and says so", () => {
    // Step 4 replaces a table: `DROP TABLE`, an `ALTER … RENAME` and a copy.
    // None of those can carry `IF NOT EXISTS`, and pretending otherwise would
    // be a false promise. What protects it is that every statement of a
    // migration runs inside one `BEGIN IMMEDIATE` … `COMMIT`, so a failure
    // anywhere — including a replay that would duplicate a copied row — rolls
    // the whole rebuild back and the version is never recorded. The two tests
    // in `describe("idempotency")` measure that, and
    // `tool-call-identity.test.ts` measures it against a real SQLite.
    const rebuild = MIGRATIONS.find((migration) => migration.version === 4);
    expect(rebuild?.name).toBe("tool_call_identity");
    expect(rebuild?.statements.some((statement) => /DROP TABLE/i.test(statement))).toBe(true);
    expect(rebuild?.statements.some((statement) => /ALTER TABLE/i.test(statement))).toBe(true);
    expect(rebuild?.statements.some((statement) => /INSERT OR IGNORE/i.test(statement))).toBe(true);
  });
});

describe("applyMigrations", () => {
  it("applies everything pending, in order, in one transaction each", () => {
    const host = createRecordingHost();
    const result = applyMigrations(host, fixedNow);

    expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
    expect(result.applied.map((entry) => entry.name)).toEqual([
      "core_schema",
      "full_text_index",
      "query_indexes",
      "tool_call_identity",
    ]);
    expect(result.applied.every((entry) => entry.appliedAt === fixedNow())).toBe(true);

    // One BEGIN and one COMMIT per migration, and no rollback.
    expect(host.executed.filter((sql) => sql.startsWith("BEGIN"))).toHaveLength(4);
    expect(host.executed.filter((sql) => sql === "COMMIT")).toHaveLength(4);
    expect(host.executed.filter((sql) => sql === "ROLLBACK")).toHaveLength(0);
    expect(host.wasInTransaction()).toBe(false);
  });

  it("bootstraps schema_migrations before the first transaction", () => {
    const host = createRecordingHost();
    applyMigrations(host, fixedNow);

    const bootstrap = host.executed.indexOf(SCHEMA_MIGRATIONS_TABLE);
    const firstBegin = host.executed.findIndex((sql) => sql.startsWith("BEGIN"));
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeLessThan(firstBegin);
    expect(host.bootstrapped()).toBe(true);
  });

  it("keeps the user_version anchor in step with schema_migrations", () => {
    const host = createRecordingHost();
    applyMigrations(host, fixedNow);

    const userVersions = host.executed.filter((sql) => sql.startsWith("PRAGMA user_version"));
    expect(userVersions).toEqual([
      "PRAGMA user_version=1;",
      "PRAGMA user_version=2;",
      "PRAGMA user_version=3;",
      "PRAGMA user_version=4;",
    ]);
  });

  it("records every applied version exactly once", () => {
    const host = createRecordingHost();
    applyMigrations(host, fixedNow);

    expect(host.appliedVersions()).toEqual([1, 2, 3, 4]);
    expect(host.recorded).toEqual([
      { version: 1, name: "core_schema", appliedAt: fixedNow() },
      { version: 2, name: "full_text_index", appliedAt: fixedNow() },
      { version: 3, name: "query_indexes", appliedAt: fixedNow() },
      { version: 4, name: "tool_call_identity", appliedAt: fixedNow() },
    ]);
  });

  it("runs the schema statements of the matching migration", () => {
    const host = createRecordingHost();
    applyMigrations(host, fixedNow);

    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        expect(host.executed, `${migration.name} must run its statement`).toContain(statement);
      }
    }
  });
});

describe("idempotency", () => {
  it("does nothing at all on the second call", () => {
    const host = createRecordingHost();
    applyMigrations(host, fixedNow);
    const afterFirst = host.executed.length;

    const second = applyMigrations(host, fixedNow);

    expect(second.applied).toEqual([]);
    expect(second.version).toBe(LATEST_SCHEMA_VERSION);
    // The only statement a no-op call runs is the `IF NOT EXISTS` bootstrap —
    // not even a BEGIN, so it never takes the write lock. This is the guarantee
    // the rebuild step leans on: a second open cannot re-run `DROP TABLE`.
    const added = host.executed.slice(afterFirst);
    expect(added).toEqual([SCHEMA_MIGRATIONS_TABLE]);
    expect(host.appliedVersions()).toEqual([1, 2, 3, 4]);
  });

  it("survives being applied ten times without duplicate rows", () => {
    const host = createRecordingHost();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = applyMigrations(host, fixedNow);
      expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    }
    expect(host.appliedVersions()).toEqual([1, 2, 3, 4]);
    expect(host.recorded).toHaveLength(4);
  });

  it("applies only the versions a previous install did not record", () => {
    // A database written by an older build: versions 1 and 2 are already there.
    const host = createRecordingHost();
    for (const migration of MIGRATIONS.slice(0, 2)) {
      for (const statement of migration.statements) host.exec(statement);
      host.exec(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name}', '${fixedNow()}');`,
      );
    }
    const before = host.executed.length;

    const result = applyMigrations(host, fixedNow);

    expect(result.applied.map((entry) => entry.version)).toEqual([3, 4]);
    expect(result.version).toBe(4);
    // The bootstrap `IF NOT EXISTS` once, then per pending migration its own
    // statements plus exactly four frames of bookkeeping: BEGIN, the
    // `schema_migrations` INSERT, `PRAGMA user_version` and COMMIT.
    const BOOKKEEPING_PER_MIGRATION = 4;
    expect(host.executed.length - before).toBe(
      1 +
        BOOKKEEPING_PER_MIGRATION * 2 +
        MIGRATIONS[2]!.statements.length +
        MIGRATIONS[3]!.statements.length,
    );
  });

  it("re-runs a full install on a database with no recorded versions", () => {
    const host = createRecordingHost();
    const result = applyMigrations(host, fixedNow);
    expect(result.applied).toHaveLength(MIGRATIONS.length);
  });
});

describe("failure handling", () => {
  it("rolls back and records nothing when a statement fails", () => {
    const host = createRecordingHost({ failOn: "CREATE VIRTUAL TABLE" });
    expect(() => applyMigrations(host, fixedNow)).toThrow(/deliberate failure/);

    expect(host.executed.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(host.wasInTransaction()).toBe(false);
    // The first migration committed, the second rolled back, the third never ran.
    expect(host.appliedVersions()).toEqual([1]);
  });

  it("leaves the connection outside a transaction after a rollback", () => {
    const host = createRecordingHost({ failOn: "CREATE TABLE IF NOT EXISTS sessions" });
    expect(() => applyMigrations(host, fixedNow)).toThrow();
    expect(host.wasInTransaction()).toBe(false);
    expect(host.appliedVersions()).toEqual([]);
  });

  it("can retry after a failure and then succeeds", () => {
    const failing = createRecordingHost({ failOn: "CREATE VIRTUAL TABLE" });
    expect(() => applyMigrations(failing, fixedNow)).toThrow();
    expect(failing.appliedVersions()).toEqual([1]);

    // The next open sees version 1 already applied and finishes the rest.
    const retry = createRecordingHost();
    for (const statement of MIGRATIONS[0]?.statements ?? []) retry.exec(statement);
    retry.exec(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'core_schema', '2026-09-29T12:00:00.000Z');",
    );
    const result = applyMigrations(retry, fixedNow);

    expect(result.applied.map((entry) => entry.version)).toEqual([2, 3, 4]);
    expect(result.version).toBe(4);
  });
});

describe("readSchemaVersion", () => {
  it("reports the highest recorded version", () => {
    const host = createRecordingHost();
    expect(readSchemaVersion(host)).toBe(0);
    applyMigrations(host, fixedNow);
    expect(readSchemaVersion(host)).toBe(LATEST_SCHEMA_VERSION);
  });
});
