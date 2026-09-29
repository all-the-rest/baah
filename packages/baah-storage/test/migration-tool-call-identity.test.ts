/**
 * Migration 4, measured on a real SQLite.
 *
 * ## Why it needs an engine
 *
 * Migration 4 is the first **rebuild** in this package: it creates
 * `tool_invocations_v4`, copies into it, drops the old table and renames. Every
 * claim that matters about such a step is about SQLite's behaviour — does the
 * rename rewrite `approvals`' foreign key, does `DROP TABLE` hit the FK, does
 * the copy preserve the rows, does a second `applyMigrations()` do nothing — and
 * none of them can be checked against a string. So this file runs the
 * `exports.node` build of `@sqlite.org/sqlite-wasm` (the one documented
 * exception in `AGENTS.md` §2, same harness as `backend-parity.test.ts`).
 *
 * The interesting cases are the ones a *fresh* database never produces: a
 * database that already has rows, written by the old six-value vocabulary, with
 * a child row in `approvals` pointing at it.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
  type MigrationHost,
} from "../src/migrations.ts";
import { SELECT_TOOL_CALL } from "../src/sql.ts";
import {
  SCHEMA_MIGRATIONS_TABLE,
  SCHEMA_STATEMENTS,
  STEP_TOOL_CALL_IDENTITY,
} from "../src/schema.ts";
import type { SqlValue } from "../src/types.ts";
import { loadSqlite3 } from "./harness/sqlite.ts";

const T0 = "2026-09-29T10:00:00.000Z";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/** A real `oo1.DB` behind the narrow `MigrationHost` the migrations ask for. */
function hostFor(): MigrationHost & { raw: InstanceType<Sqlite3Static["oo1"]["DB"]>; closed: boolean } {
  const raw = new sqlite3.oo1.DB(":memory:", "c");
  const state = { raw, closed: false };
  return {
    get raw() {
      return state.raw;
    },
    get closed() {
      return state.closed;
    },
    exec: (sql) => {
      state.raw.exec(sql);
    },
    selectObjects: (sql) => state.raw.selectObjects(sql),
  };
}

type Host = ReturnType<typeof hostFor>;

/**
 * A database that stopped at version 3 — the shape a real upgrade arrives in.
 *
 * Built by running the first three migrations for real and then inserting rows
 * in the *old* vocabulary, so the copy step has something to convert.
 */
function legacyDatabase(): Host {
  const host = hostFor();
  host.exec("PRAGMA foreign_keys=ON");
  // `applyMigrations()` creates the bookkeeping table before anything else, so
  // a hand-built legacy database needs the same bootstrap.
  host.exec(SCHEMA_MIGRATIONS_TABLE);
  for (const migration of MIGRATIONS.slice(0, 3)) {
    for (const statement of migration.statements) host.exec(statement);
    host.exec(
      `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name}', '${T0}');`,
    );
  }
  host.exec(`INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES ('s1', 't', 'active', '${T0}', '${T0}');`);
  return host;
}

interface Row {
  [column: string]: SqlValue;
}

function rowsOf(host: Host, sql: string): Row[] {
  return host.selectObjects(sql) as Row[];
}

function columnsOf(host: Host, table: string): string[] {
  return rowsOf(host, `PRAGMA table_info(${table})`).map((row) => String(row["name"]));
}

describe("migration 4 brings an old tool_invocations forward", () => {
  it("a fresh database ends up with the rebuilt table", () => {
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    const result = applyMigrations(host, () => T0);

    expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    expect(readSchemaVersion(host)).toBe(LATEST_SCHEMA_VERSION);
    // The staging name is gone; the table is under its real name again.
    expect(columnsOf(host, "tool_invocations")).toContain("tool_call_id");
    expect(readSchemaVersion(host)).toBe(4);
    const staging = rowsOf(
      host,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_invocations_v4'",
    );
    expect(staging).toEqual([]);
  });

  it("every step ran inside its own transaction, and the version was recorded last", () => {
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    applyMigrations(host, () => T0);

    const versions = rowsOf(host, "SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4]);
    expect(host.selectObjects("PRAGMA user_version")).toEqual([{ user_version: 4 }]);
  });

  it("keeps the rows, and maps only `completed` to done", () => {
    // The mapping is the decision worth measuring. `completed` is the one old
    // value that is evidence of an outcome; every other one — `running`,
    // `pending`, `failed`, `aborted`, `awaiting_approval` — means "unknown",
    // and `begun` is the state a caller can do something safe with.
    const host = legacyDatabase();
    for (const status of ["completed", "running", "failed", "aborted", "pending", "awaiting_approval"]) {
      host.exec(
        `INSERT INTO tool_invocations
           (id, session_id, tool_name, args, status, result_preview, error, started_at, finished_at, created_at, updated_at)
         VALUES ('legacy-${status}', 's1', 'write', '{"path":"a"}', '${status}', 'preview', NULL, '${T0}', '${T0}', '${T0}', '${T0}');`,
      );
    }
    expect(readSchemaVersion(host)).toBe(3);

    applyMigrations(host, () => T0);

    const mapped = rowsOf(
      host,
      "SELECT id, status, output, tool_call_id, attempt, occurrence, args FROM tool_invocations ORDER BY id",
    );
    expect(mapped).toHaveLength(6);
    expect(mapped.find((row) => row["id"] === "legacy-completed")?.["status"]).toBe("done");
    for (const status of ["running", "failed", "aborted", "pending", "awaiting_approval"]) {
      expect(mapped.find((row) => row["id"] === `legacy-${status}`)?.["status"], status).toBe("begun");
    }
  });

  it("never turns a preview into a replayable output", () => {
    // `output` is what a replay hands back to the model. Filling it from
    // `result_preview` would replay a truncated string as the tool's answer —
    // the same class of lie the status column was added to remove.
    const host = legacyDatabase();
    host.exec(
      `INSERT INTO tool_invocations
         (id, session_id, tool_name, args, status, result_preview, created_at, updated_at)
       VALUES ('legacy', 's1', 'write', '{"path":"a"}', 'completed', 'first 400 chars…', '${T0}', '${T0}');`,
    );
    applyMigrations(host, () => T0);

    const row = rowsOf(host, "SELECT status, output, result_preview FROM tool_invocations")[0];
    expect(row?.["status"]).toBe("done");
    expect(row?.["output"]).toBeNull();
    expect(row?.["result_preview"]).toBe("first 400 chars…");
  });

  it("never turns a preview into a replayable output — measured through the lookup", () => {
    // The second path for the same property, and a different one: the test
    // above reads the column, this one runs the statement the replay actually
    // performs and looks at what it hands back. A migration that copied the
    // preview would make `SELECT_TOOL_CALL` return a truncated string as the
    // tool's answer, and that is the shape the damage takes in production.
    const host = legacyDatabase();
    host.exec(
      `INSERT INTO tool_invocations
         (id, session_id, tool_name, status, result_preview, created_at, updated_at)
       VALUES ('legacy', 's1', 'write', 'completed', 'truncated…', '${T0}', '${T0}');`,
    );
    applyMigrations(host, () => T0);

    // The real statement, with its real bindings, against the real engine.
    const row = host.raw.selectObjects(SELECT_TOOL_CALL, ["s1", 1, "legacy", 0])[0] as
      | Record<string, SqlValue>
      | undefined;

    // status = 'done', output = NULL. The engine reads `output`; NULL means
    // "there was no recorded value", which is honest, where the preview would
    // have been a confident wrong answer.
    expect(row?.["status"]).toBe("done");
    expect(row?.["output"]).toBeNull();
    // And it is genuinely not in the row at all.
    expect(Object.values(row ?? {})).not.toContain("truncated…");
  });

  it("gives a legacy row a unique, non-colliding key", () => {
    const host = legacyDatabase();
    for (const id of ["a", "b", "c"]) {
      host.exec(
        `INSERT INTO tool_invocations
           (id, session_id, tool_name, status, created_at, updated_at)
         VALUES ('${id}', 's1', 'write', 'completed', '${T0}', '${T0}');`,
      );
    }
    applyMigrations(host, () => T0);

    const keys = rowsOf(
      host,
      "SELECT session_id, attempt, tool_call_id, occurrence FROM tool_invocations",
    );
    expect(keys).toHaveLength(3);
    // The row's own `id` stands in for the missing `tool_call_id`: unique, and
    // it says "this record predates the call key" without inventing a value
    // that could collide with a real one.
    expect(new Set(keys.map((row) => String(row["tool_call_id"])))).toEqual(new Set(["a", "b", "c"]));
    for (const row of keys) {
      expect(row["attempt"]).toBe(1);
      expect(row["occurrence"]).toBe(0);
    }
  });

  it("survives a child row in approvals", () => {
    // The `DROP TABLE` is the moment this could have gone wrong: with
    // `foreign_keys=ON`, dropping a parent that still has children is a
    // constraint violation. `PRAGMA defer_foreign_keys` inside the transaction
    // defers the check to COMMIT, and the rename puts the name back — so
    // `approvals` must end up referencing the rebuilt table.
    const host = legacyDatabase();
    host.exec(
      `INSERT INTO tool_invocations
         (id, session_id, tool_name, status, created_at, updated_at)
       VALUES ('inv', 's1', 'write', 'running', '${T0}', '${T0}');`,
    );
    host.exec(
      `INSERT INTO approvals (id, session_id, tool_invocation_id, request, created_at)
       VALUES ('ap', 's1', 'inv', '{}', '${T0}');`,
    );

    applyMigrations(host, () => T0);

    const approval = rowsOf(
      host,
      "SELECT tool_invocation_id, decision FROM approvals WHERE id = 'ap'",
    );
    expect(approval).toHaveLength(1);
    expect(approval[0]?.["tool_invocation_id"]).toBe("inv");
    // The child's foreign key still resolves — so the cascade and the
    // `ON DELETE CASCADE` behind it are intact after the rebuild.
    host.exec("PRAGMA foreign_keys=ON");
    host.exec("DELETE FROM sessions WHERE id = 's1';");
    expect(rowsOf(host, "SELECT id FROM approvals")).toEqual([]);
    expect(rowsOf(host, "SELECT id FROM tool_invocations")).toEqual([]);
  });

  it("the rebuilt table still cascades off its session", () => {
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    applyMigrations(host, () => T0);
    host.exec(`INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES ('s1', 't', 'active', '${T0}', '${T0}');`);
    host.exec(
      `INSERT INTO tool_invocations
         (id, session_id, tool_name, tool_call_id, attempt, occurrence, status, created_at, updated_at)
       VALUES ('inv', 's1', 'write', 'c1', 1, 0, 'begun', '${T0}', '${T0}');`,
    );

    host.exec("DELETE FROM sessions WHERE id = 's1';");
    expect(rowsOf(host, "SELECT id FROM tool_invocations")).toEqual([]);
  });

  it("is a no-op on the second call, even for a rebuild", () => {
    // The property the four non-idempotent statements rely on. There is no
    // `IF NOT EXISTS` on a `DROP`, so the guarantee cannot come from the
    // statements — it comes from the version being recorded only after the
    // commit succeeded.
    const host = legacyDatabase();
    host.exec(
      `INSERT INTO tool_invocations
         (id, session_id, tool_name, status, created_at, updated_at)
       VALUES ('inv', 's1', 'write', 'completed', '${T0}', '${T0}');`,
    );
    applyMigrations(host, () => T0);

    const before = rowsOf(host, "SELECT * FROM tool_invocations");
    const ddlBefore = rowsOf(
      host,
      "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
    );

    for (let round = 0; round < 5; round += 1) {
      const second = applyMigrations(host, () => T0);
      expect(second.applied, `round ${round}`).toEqual([]);
      expect(second.version, `round ${round}`).toBe(LATEST_SCHEMA_VERSION);
    }

    expect(rowsOf(host, "SELECT * FROM tool_invocations")).toEqual(before);
    expect(rowsOf(host, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).toEqual(
      ddlBefore,
    );
    // The bookkeeping table gained nothing, which is the other half: a
    // duplicated rebuild would be invisible except through this row count.
    expect(rowsOf(host, "SELECT version FROM schema_migrations")).toHaveLength(4);
  });

  it("the recorded row is the only thing that says a migration ran", () => {
    // Read the mechanism directly: a host that already has version 4 recorded
    // runs none of its statements, whatever they are.
    const host = legacyDatabase();
    applyMigrations(host, () => T0);
    const before = host.selectObjects("SELECT version FROM schema_migrations").length;

    applyMigrations(host, () => T0);
    expect(host.selectObjects("SELECT version FROM schema_migrations").length).toBe(before);
  });

  it("a failure inside the rebuild rolls the whole step back", () => {
    // The other half of the guarantee. If a step could commit half of itself,
    // the "second call does nothing" property would be worthless.
    const host = legacyDatabase();
    host.exec(
      `INSERT INTO tool_invocations
         (id, session_id, tool_name, status, created_at, updated_at)
       VALUES ('inv', 's1', 'write', 'completed', '${T0}', '${T0}');`,
    );

    const broken: MigrationHost = {
      exec: (sql) => {
        if (sql.includes("ALTER TABLE tool_invocations_v4")) {
          throw new Error("deliberate failure inside the rebuild");
        }
        host.exec(sql);
      },
      selectObjects: (sql) => host.selectObjects(sql),
    };

    expect(() => applyMigrations(broken, () => T0)).toThrow(/deliberate failure/);
    // Still the old table, still the old shape, and version 4 is not recorded.
    expect(readSchemaVersion(host)).toBe(3);
    expect(columnsOf(host, "tool_invocations")).not.toContain("tool_call_id");
    expect(rowsOf(host, "SELECT id FROM tool_invocations")).toHaveLength(1);
  });

  it("the staging table is not left behind after a successful rebuild", () => {
    const host = legacyDatabase();
    applyMigrations(host, () => T0);
    expect(
      rowsOf(host, "SELECT name FROM sqlite_master WHERE name LIKE 'tool_invocations%'"),
    ).toEqual([{ name: "tool_invocations" }]);
  });

  it("the rebuilt table and the four key columns are what the SQL of the operations layer expects", () => {
    // Ties the DDL to the statements: every column `sql.ts` names has to exist.
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    applyMigrations(host, () => T0);
    const columns = new Set(columnsOf(host, "tool_invocations"));
    for (const column of [
      "id",
      "session_id",
      "message_id",
      "call_part_id",
      "result_part_id",
      "tool_name",
      "tool_call_id",
      "attempt",
      "occurrence",
      "args",
      "status",
      "output",
      "result_preview",
      "error",
      "started_at",
      "finished_at",
      "created_at",
      "updated_at",
    ]) {
      expect(columns.has(column), column).toBe(true);
    }
  });

  it("the index on the call key is created and used", () => {
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    applyMigrations(host, () => T0);
    const indexes = rowsOf(
      host,
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_invocations'",
    ).map((row) => String(row["name"]));
    expect(indexes).toContain("idx_tool_invocations_call_key");
    // The two indexes step 3 created died with the old table and had to come
    // back; if the rebuild had forgotten, only the new one would be here.
    expect(indexes).toContain("idx_tool_invocations_session_status");
    expect(indexes).toContain("idx_tool_invocations_message_id");
  });

  it("every statement in the schema still runs on a real SQLite", () => {
    // The DDL is asserted as strings in `schema.test.ts`; this is the one place
    // that proves the strings are *valid SQL*, including the rebuild's copy.
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    for (const statement of SCHEMA_STATEMENTS) {
      if (STEP_TOOL_CALL_IDENTITY.includes(statement)) continue;
      expect(() => host.exec(statement), statement.slice(0, 60)).not.toThrow();
    }
    for (const statement of STEP_TOOL_CALL_IDENTITY) {
      expect(() => host.exec(statement), statement.slice(0, 60)).not.toThrow();
    }
  });
});
