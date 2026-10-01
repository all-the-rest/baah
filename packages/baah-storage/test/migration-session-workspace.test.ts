/**
 * Migration 5 (`session_workspace`), measured on a real SQLite.
 *
 * ## Why it needs an engine
 *
 * Step 5 is an `ALTER TABLE … ADD COLUMN` with a `REFERENCES` clause plus one
 * index. Every claim that matters about it is a claim about SQLite, not about a
 * string: is the column nullable, does the foreign key resolve, does `ON DELETE
 * SET NULL` fire, does a bad value refuse, does a second run refuse, and — the
 * one that decides whether this is shippable at all — **does a database written by
 * the old schema survive the migration with its rows intact**. None of those can
 * be checked against a string, so this file runs the `exports.node` build of
 * `@sqlite.org/sqlite-wasm` (the one documented exception in `AGENTS.md` §2, same
 * harness as `migration-tool-call-identity.test.ts`).
 *
 * ## The interesting case is an *old* database
 *
 * A fresh one has no sessions to preserve, so it would pass a migration that
 * dropped the table. `legacyDatabase()` stops at version 4 — running the first four
 * migrations for real — and then writes a session with messages, parts and a turn,
 * in the old vocabulary.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { applyMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS, readSchemaVersion, type MigrationHost } from "../src/migrations.ts";
import { SCHEMA_MIGRATIONS_TABLE, STEP_SESSION_WORKSPACE } from "../src/schema.ts";
import type { SqlValue } from "../src/types.ts";
import { loadSqlite3 } from "./harness/sqlite.ts";

const T0 = "2026-09-29T10:00:00.000Z";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/** A real `oo1.DB` behind the narrow `MigrationHost` the migrations ask for. */
function hostFor(): MigrationHost & { raw: InstanceType<Sqlite3Static["oo1"]["DB"]> } {
  const raw = new sqlite3.oo1.DB(":memory:", "c");
  return {
    raw,
    exec: (sql) => {
      raw.exec(sql);
    },
    selectObjects: (sql) => raw.selectObjects(sql),
  };
}

interface Row {
  [column: string]: SqlValue;
}

function rowsOf(host: ReturnType<typeof hostFor>, sql: string): Row[] {
  return host.selectObjects(sql) as Row[];
}

function columnsOf(host: ReturnType<typeof hostFor>, table: string): string[] {
  return rowsOf(host, `PRAGMA table_info(${table})`).map((row) => String(row["name"]));
}

/**
 * A database that stopped at version 4 — the shape a real upgrade arrives in.
 *
 * Built by running the first four migrations for real, so it carries exactly the
 * old schema, and then inserting a project, a session and a full turn's worth of
 * rows. Without those rows the "no data loss" claim would be untested.
 */
function legacyDatabase(): ReturnType<typeof hostFor> {
  const host = hostFor();
  host.exec("PRAGMA foreign_keys=ON");
  // `applyMigrations()` creates the bookkeeping table before anything else, so
  // a hand-built legacy database needs the same bootstrap.
  host.exec(SCHEMA_MIGRATIONS_TABLE);
  for (const migration of MIGRATIONS.filter((entry) => entry.version < 5)) {
    for (const statement of migration.statements) host.exec(statement);
    host.exec(
      `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name}', '${T0}');`,
    );
  }

  host.exec(
    `INSERT INTO workspaces (id, name, kind, root_handle_id, created_at) VALUES ('w1', 'projekt', 'directory', 'h1', '${T0}');`,
  );
  host.exec(
    `INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES ('s1', 'Frühere Sitzung', 'active', '${T0}', '${T0}');`,
  );
  host.exec(
    `INSERT INTO turns (id, session_id, seq, status, started_at) VALUES ('t1', 's1', 0, 'succeeded', '${T0}');`,
  );
  host.exec(
    `INSERT INTO messages (id, session_id, turn_id, seq, role, status, created_at, updated_at)
     VALUES ('m1', 's1', 't1', 0, 'user', 'completed', '${T0}', '${T0}');`,
  );
  host.exec(
    `INSERT INTO parts (id, message_id, session_id, seq, type, content_text, status, created_at, updated_at)
     VALUES ('p1', 'm1', 's1', 0, 'text', 'Frage', 'completed', '${T0}', '${T0}');`,
  );
  return host;
}

describe("migration 5 adds sessions.workspace_id", () => {
  it("a fresh database gets the column and the index", () => {
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    const result = applyMigrations(host, () => T0);

    expect(result.version).toBe(LATEST_SCHEMA_VERSION);
    expect(columnsOf(host, "sessions")).toContain("workspace_id");
    const indexes = rowsOf(
      host,
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    ).map((row) => String(row["name"]));
    expect(indexes).toContain("idx_sessions_workspace_id");
  });

  it("brings an OLD database forward without losing a single row", () => {
    /**
     * The property that decides whether the step is shippable.
     *
     * `ALTER TABLE … ADD COLUMN` cannot lose rows — that is not in doubt — but it
     * *can* be wrapped in something that does (a rebuild, a `DROP` of a parent with
     * seven children, a `DELETE`), and step 4 in this very file does exactly that.
     * So the assertion is on the data, counted before and after, and not on the
     * schema version.
     */
    const host = legacyDatabase();
    const before = {
      sessions: rowsOf(host, "SELECT id FROM sessions").length,
      turns: rowsOf(host, "SELECT id FROM turns").length,
      messages: rowsOf(host, "SELECT id FROM messages").length,
      parts: rowsOf(host, "SELECT id FROM parts").length,
      workspaces: rowsOf(host, "SELECT id FROM workspaces").length,
    };
    expect(readSchemaVersion(host)).toBe(4);

    applyMigrations(host, () => T0);

    expect(readSchemaVersion(host)).toBe(LATEST_SCHEMA_VERSION);
    expect({
      sessions: rowsOf(host, "SELECT id FROM sessions").length,
      turns: rowsOf(host, "SELECT id FROM turns").length,
      messages: rowsOf(host, "SELECT id FROM messages").length,
      parts: rowsOf(host, "SELECT id FROM parts").length,
      workspaces: rowsOf(host, "SELECT id FROM workspaces").length,
    }).toEqual(before);
    // …and the *content* survived, not just the counts.
    expect(rowsOf(host, "SELECT title FROM sessions WHERE id = 's1'")).toEqual([
      { title: "Frühere Sitzung" },
    ]);
    expect(rowsOf(host, "SELECT content_text FROM parts WHERE id = 'p1'")).toEqual([
      { content_text: "Frage" },
    ]);
  });

  it("the existing session reads NULL — 'belongs to no project', not an invented one", () => {
    /**
     * The semantic half, and the reason the column is nullable with no default.
     *
     * A session written before this migration genuinely does not belong to a
     * project. `NULL` says that. A `DEFAULT` would have had to invent a
     * `workspaces` row per historical session — a project the user never opened,
     * which is a **false** claim in the one table whose entire job is to say which
     * folders exist. And `NOT NULL` is not merely undesirable: SQLite refuses
     * `ADD COLUMN … NOT NULL` without a default at all, so the choice is enforced
     * as well as correct.
     */
    const host = legacyDatabase();
    expect(
      columnsOf(host, "sessions"),
      "the old schema has no such column, which is the premise",
    ).not.toContain("workspace_id");

    applyMigrations(host, () => T0);

    expect(rowsOf(host, "SELECT id, workspace_id FROM sessions WHERE id = 's1'")).toEqual([
      { id: "s1", workspace_id: null },
    ]);
  });

  it("the reference resolves, and a session can be attached to a project", () => {
    const host = legacyDatabase();
    applyMigrations(host, () => T0);

    host.exec("UPDATE sessions SET workspace_id = 'w1' WHERE id = 's1'");
    expect(rowsOf(host, "SELECT workspace_id FROM sessions WHERE id = 's1'")).toEqual([
      { workspace_id: "w1" },
    ]);
  });

  it("a session naming a project that does not exist is refused", () => {
    /**
     * The column is a **real** foreign key, not a string in a column. This is the
     * whole reason for `REFERENCES workspaces(id)` rather than a bare `TEXT`: a
     * typo in a project id would otherwise create a session that belongs to
     * nothing, and a project-scoped read would silently skip it.
     */
    const host = legacyDatabase();
    applyMigrations(host, () => T0);

    expect(() => host.exec("UPDATE sessions SET workspace_id = 'nope' WHERE id = 's1'")).toThrow(
      /FOREIGN KEY/i,
    );
    // …and the refusal left the row as it was.
    expect(rowsOf(host, "SELECT workspace_id FROM sessions WHERE id = 's1'")).toEqual([
      { workspace_id: null },
    ]);
  });

  it("deleting a project detaches its sessions instead of deleting them", () => {
    /**
     * `ON DELETE SET NULL`, measured — and the reason it is not `CASCADE`.
     *
     * `CASCADE` would take the session with it, and with it `turns`, `messages`,
     * `parts`, `part_deltas`, `tool_invocations`, `approvals` and `todos` by their
     * own cascades. A user detaching a folder reference from the app would lose the
     * transcript of every conversation in it — irrecoverably, because there is no
     * server (§2).
     *
     * The cost, stated: a detached session is invisible to a project-scoped query.
     * That is correct — it has no project — and it is why deleting a `workspaces`
     * row must never be how the code means "this project has no conversations".
     */
    const host = legacyDatabase();
    applyMigrations(host, () => T0);
    host.exec("UPDATE sessions SET workspace_id = 'w1' WHERE id = 's1'");

    host.exec("DELETE FROM workspaces WHERE id = 'w1'");

    // The session is still there, with no project.
    expect(rowsOf(host, "SELECT id, workspace_id FROM sessions WHERE id = 's1'")).toEqual([
      { id: "s1", workspace_id: null },
    ]);
    // …and so is everything hanging off it. That is the half `CASCADE` would
    // have gotten wrong.
    expect(rowsOf(host, "SELECT id FROM turns")).toHaveLength(1);
    expect(rowsOf(host, "SELECT id FROM messages")).toHaveLength(1);
    expect(rowsOf(host, "SELECT id FROM parts")).toHaveLength(1);
  });

  it("a project-scoped read returns exactly that project's sessions", () => {
    /**
     * The read the column exists for, and the reason for the index: with two
     * projects, one query per project has to answer differently.
     *
     * This is the storage half of the requirement that a conversation from
     * project A is **not** visible in project B. The other half — that the app
     * asks with the right project id — does not exist yet, and this test does not
     * pretend it does: it asserts that the data can answer the question, which is
     * all a schema can be responsible for.
     */
    const host = legacyDatabase();
    applyMigrations(host, () => T0);
    host.exec(
      `INSERT INTO workspaces (id, name, kind, created_at) VALUES ('w2', 'anderes', 'directory', '${T0}');`,
    );
    host.exec(
      `INSERT INTO sessions (id, title, status, created_at, updated_at, workspace_id)
     VALUES ('s2', 'Zweite Sitzung', 'active', '${T0}', '${T0}', 'w2');`,
    );
    host.exec("UPDATE sessions SET workspace_id = 'w1' WHERE id = 's1'");

    const scoped = (workspaceId: string) =>
      rowsOf(host, `SELECT id FROM sessions WHERE workspace_id = '${workspaceId}' ORDER BY id`).map(
        (row) => row["id"],
      );

    expect(scoped("w1")).toEqual(["s1"]);
    expect(scoped("w2")).toEqual(["s2"]);
  });

  it("is a no-op on the second call — and a bare re-run of the step is refused", () => {
    /**
     * Two different guarantees, measured separately because only one of them is
     * the migration system's job.
     *
     * 1. `applyMigrations()` a second time does **nothing**: no statement, not
     *    even a `BEGIN`. That comes from `schema_migrations`, since `ADD COLUMN`
     *    has no `IF NOT EXISTS` spelling (SQLite refuses a second one — measured
     *    in the next test).
     * 2. Running the step's *statements* a second time **fails**. That is not a
     *    bug to be engineered away; it is the property that makes the version
     *    record load-bearing rather than decorative.
     */
    const host = legacyDatabase();
    applyMigrations(host, () => T0);

    const statementsBefore = rowsOf(host, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    for (let round = 0; round < 3; round += 1) {
      const second = applyMigrations(host, () => T0);
      expect(second.applied, `round ${round}`).toEqual([]);
      expect(second.version, `round ${round}`).toBe(LATEST_SCHEMA_VERSION);
    }

    expect(rowsOf(host, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).toEqual(
      statementsBefore,
    );
    expect(rowsOf(host, "SELECT version FROM schema_migrations")).toHaveLength(
      MIGRATIONS.length,
    );

    // …and the raw statement does refuse. This is why the guarantee cannot come
    // from the statements.
    expect(() => {
      for (const statement of STEP_SESSION_WORKSPACE) host.exec(statement);
    }).toThrow(/duplicate column name/i);
  });

  it("a failure inside the step rolls the whole step back", () => {
    // The other half of "the version is the authority". If step 5 could commit
    // half of itself — column added, index missing, version recorded — the next
    // `applyMigrations()` would skip it and the index would never appear.
    const host = legacyDatabase();
    const step = MIGRATIONS.find((entry) => entry.version === 5);
    expect(step).toBeDefined();

    // The index is the *second* statement, so the column exists by the time the
    // step is interrupted.
    const broken: MigrationHost = {
      exec: (sql) => {
        if (sql.includes("idx_sessions_workspace_id")) {
          throw new Error("deliberate failure inside step 5");
        }
        host.exec(sql);
      },
      selectObjects: (sql) => host.selectObjects(sql),
    };

    expect(() => applyMigrations(broken, () => T0)).toThrow(/deliberate failure/);
    expect(readSchemaVersion(host)).toBe(4);
    expect(columnsOf(host, "sessions")).not.toContain("workspace_id");
    expect(rowsOf(host, "SELECT id FROM sessions")).toHaveLength(1);
  });

  it("every statement in the schema is valid SQL on a real engine", () => {
    // The DDL is asserted as strings in `schema.test.ts`; this is the one place
    // that proves the strings are *valid*, including step 5's `ALTER`.
    const host = hostFor();
    host.exec("PRAGMA foreign_keys=ON");
    applyMigrations(host, () => T0);
    // Re-running every *creating* statement must stay valid — which is the check
    // `schema.test.ts` cannot make, because it compares strings.
    for (const statement of STEP_SESSION_WORKSPACE) {
      if (/ADD COLUMN/i.test(statement)) continue;
      expect(() => host.exec(statement), statement.slice(0, 60)).not.toThrow();
    }
  });
});