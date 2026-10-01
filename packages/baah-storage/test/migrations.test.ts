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
    expect(versions).toEqual([1, 2, 3, 4, 5]);
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
    // replay cannot fail. Steps 4 and 5 cannot be — see the two tests below, which
    // say *what* protects each of them instead.
    //
    // **Step 5's index does carry `IF NOT EXISTS`** and is not the problem; the
    // `ADD COLUMN` in the same step is, and SQLite has no spelling for it (a
    // second one is refused with `duplicate column name`, measured). So the filter
    // is `< 4` rather than "everything but the rebuilds" — it names the steps that
    // are covered by statements alone, which is what this test claims.
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

  it("protects step 5 by its transaction too, and drops no table", () => {
    /**
     * The other non-idempotent step, and the one whose reason is **different** —
     * which is why it is a separate test and not a second case in the one above.
     *
     * Step 5 adds a column and an index. It drops nothing, so the park-table
     * machinery that step 4 needs is not merely unnecessary here, it would be
     * harmful: parking the seven tables that reference `sessions` in order to add
     * one nullable column is a large amount of machinery guarding nothing. And it
     * cannot carry `IF NOT EXISTS` on the `ADD COLUMN` — SQLite has no such
     * spelling, and measures that by refusing a second one.
     *
     * What protects it is the same thing that protects step 4: one
     * `BEGIN IMMEDIATE` … `COMMIT` per migration, with the version recorded after
     * the commit. So the properties asserted here are "no DROP", "no data to
     * copy", and "one version, recorded once" — the last of them measured in
     * `describe("idempotency")`.
     */
    const step = MIGRATIONS.find((migration) => migration.version === 5);
    expect(step?.name).toBe("session_workspace");
    expect(step?.statements.some((statement) => /DROP TABLE/i.test(statement))).toBe(false);
    // No copy step either: `ADD COLUMN` gives every existing row the column's
    // default, so there is nothing to carry over by hand.
    expect(step?.statements.some((statement) => /^INSERT/i.test(statement.trim()))).toBe(false);
    // …and it points at a table step 1 already created, so it needs nothing parked.
    expect(step?.statements.some((statement) => /ADD COLUMN/i.test(statement))).toBe(true);
    expect(step?.statements.some((statement) => /REFERENCES workspaces\(id\)/i.test(statement))).toBe(true);
  });

  it("adds the session's workspace column nullable, with no default", () => {
    /**
     * Two constraints SQLite enforces, and both are load-bearing rather than
     * incidental.
     *
     * 1. **`ADD COLUMN` with a `REFERENCES` clause is only legal when the column's
     *    default is NULL.** It cannot validate the rows that already exist against
     *    a constraint it did not check when they were written. A `NOT NULL` column,
     *    or one with a default, is refused outright.
     * 2. **NULL is the truthful value for every pre-existing session.** It means
     *    "this conversation does not belong to a project", which is what a session
     *    written before the project level existed actually is. A default would
     *    have invented a workspace row per historical session.
     *
     * Asserted as a string, so the property is visible without a database; the
     * behavioural half (an old database migrates, and the FK resolves) is measured
     * against a real SQLite in `migration-session-workspace.test.ts`.
     */
    const add = MIGRATIONS[4]?.statements.find((statement) => /ADD COLUMN/i.test(statement));
    expect(add).toBeDefined();
    expect(add).toMatch(/ADD COLUMN\s+workspace_id\s+TEXT/i);
    expect(add, "NOT NULL would be refused and would be a lie").not.toMatch(/NOT NULL/i);
    expect(add, "a DEFAULT would be refused and would invent a project").not.toMatch(/DEFAULT/i);
  });
});

describe("applyMigrations", () => {
  it("applies everything pending, in order, in one transaction each", () => {
    const host = createRecordingHost();
    const result = applyMigrations(host, fixedNow);

    expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied.map((entry) => entry.version)).toEqual([1, 2, 3, 4, 5]);
    expect(result.applied.map((entry) => entry.name)).toEqual([
      "core_schema",
      "full_text_index",
      "query_indexes",
      "tool_call_identity",
      "session_workspace",
    ]);
    expect(result.applied.every((entry) => entry.appliedAt === fixedNow())).toBe(true);

    // One BEGIN and one COMMIT per migration, and no rollback.
    expect(host.executed.filter((sql) => sql.startsWith("BEGIN"))).toHaveLength(MIGRATIONS.length);
    expect(host.executed.filter((sql) => sql === "COMMIT")).toHaveLength(MIGRATIONS.length);
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
      "PRAGMA user_version=5;",
    ]);
  });

  it("records every applied version exactly once", () => {
    const host = createRecordingHost();
    applyMigrations(host, fixedNow);

    expect(host.appliedVersions()).toEqual([1, 2, 3, 4, 5]);
    expect(host.recorded).toEqual([
      { version: 1, name: "core_schema", appliedAt: fixedNow() },
      { version: 2, name: "full_text_index", appliedAt: fixedNow() },
      { version: 3, name: "query_indexes", appliedAt: fixedNow() },
      { version: 4, name: "tool_call_identity", appliedAt: fixedNow() },
      { version: 5, name: "session_workspace", appliedAt: fixedNow() },
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
    expect(host.appliedVersions()).toEqual([1, 2, 3, 4, 5]);
  });

  it("survives being applied ten times without duplicate rows", () => {
    const host = createRecordingHost();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = applyMigrations(host, fixedNow);
      expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    }
    expect(host.appliedVersions()).toEqual([1, 2, 3, 4, 5]);
    expect(host.recorded).toHaveLength(MIGRATIONS.length);
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

    expect(result.applied.map((entry) => entry.version)).toEqual([3, 4, 5]);
    expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    // The bootstrap `IF NOT EXISTS` once, then per pending migration its own
    // statements plus exactly four frames of bookkeeping: BEGIN, the
    // `schema_migrations` INSERT, `PRAGMA user_version` and COMMIT.
    //
    // Written as a **sum over the pending migrations** rather than an arithmetic
    // expression on their count, because the arithmetic version has to be edited
    // with every new step and the edited form is the one that gets the count
    // wrong — this test caught exactly that when step 5 arrived.
    const BOOKKEEPING_PER_MIGRATION = 4;
    const pending = MIGRATIONS.slice(2);
    expect(host.executed.length - before).toBe(
      1 +
        BOOKKEEPING_PER_MIGRATION * pending.length +
        pending.reduce((total, migration) => total + migration.statements.length, 0),
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

    expect(result.applied.map((entry) => entry.version)).toEqual([2, 3, 4, 5]);
    expect(result.version).toBe(LATEST_SCHEMA_VERSION);
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
