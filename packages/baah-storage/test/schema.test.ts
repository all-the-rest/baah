/**
 * The DDL, asserted statically.
 *
 * No SQLite engine is available in Node for this package (the WASM build is
 * browser/worker-only and must not be loaded here — `AGENTS.md` §2), so these
 * checks are structural: they prove the shape of the schema, the pragmas and
 * the index set. That the SQL *parses* against a real SQLite is verified in a
 * browser, not here.
 */

import { describe, expect, it } from "vitest";

import {
  INDEX_NAMES,
  PRAGMAS,
  SCHEMA_MIGRATIONS_TABLE,
  SCHEMA_STATEMENTS,
  STEP_CORE_TABLES,
  STEP_FULL_TEXT_INDEX,
  STEP_INDEXES,
  STEP_TOOL_CALL_IDENTITY,
  TABLE_NAMES,
  TOOL_INVOCATIONS_TABLE,
} from "../src/schema.ts";

/** The `CREATE TABLE`/`CREATE VIRTUAL TABLE` name of a statement, if it is one. */
function createdTable(statement: string): string | null {
  const match = /^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement);
  return match?.[1] ?? null;
}

/**
 * `schema_migrations` lives outside `SCHEMA_STATEMENTS` because
 * `applyMigrations()` must create it *before* it can read it, but it is part of
 * the schema and is asserted like every other table.
 */
const allTableStatements = [SCHEMA_MIGRATIONS_TABLE, ...SCHEMA_STATEMENTS];

const tableStatements = allTableStatements.map((statement, index) => {
  // A statement may be preceded by a comment, so comments are stripped before
  // the keyword is matched.
  const stripped = statement.replaceAll(/--[^\n]*/g, " ").replaceAll(/\s+/g, " ").trim();
  return { index, statement, stripped, table: createdTable(stripped) };
}).filter(
  (entry): entry is { index: number; statement: string; stripped: string; table: string } =>
    entry.table !== null,
);

const tables = tableStatements.map((entry) => entry.table);

function tableDdl(name: string): string {
  const entry = tableStatements.find((candidate) => candidate.table === name);
  if (entry === undefined) throw new Error(`No CREATE TABLE for '${name}' in the schema.`);
  return entry.statement;
}

/** Table-level constraints, which are not columns. */
const TABLE_CONSTRAINTS = new Set([
  "UNIQUE",
  "CHECK",
  "PRIMARY",
  "FOREIGN",
  "CONSTRAINT",
]);

/**
 * The declared column names of a table: the top-level entries inside the outer
 * parens, minus the table constraints.
 *
 * Comments are stripped first — a `--` line inside the body would otherwise be
 * split on its commas and read as columns.
 */
function columnsOf(ddl: string): string[] {
  const body = ddl
    .replaceAll(/--[^\n]*/g, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ");
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  const inner = body.slice(open + 1, close);

  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of inner) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);

  return entries
    .map((entry) => entry.replaceAll(/\s+/g, " ").trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => /^(\w+)/.exec(entry)?.[1] ?? "")
    .filter((name) => name.length > 0 && !TABLE_CONSTRAINTS.has(name.toUpperCase()));
}

describe("connection pragmas", () => {
  it("are exactly the four from Plan.md §6.1, foreign keys first", () => {
    expect(PRAGMAS).toEqual([
      "PRAGMA foreign_keys=ON",
      "PRAGMA journal_mode=DELETE",
      "PRAGMA synchronous=NORMAL",
      "PRAGMA busy_timeout=5000",
    ]);
  });

  it("puts foreign_keys before anything that writes", () => {
    expect(PRAGMAS.indexOf("PRAGMA foreign_keys=ON")).toBe(0);
  });
});

describe("tables", () => {
  it("creates every table of Plan.md §6.1 plus the delta log and the FTS index", () => {
    // The FTS5 virtual table is a table as far as `sqlite_master` is concerned,
    // so it belongs in the expected set. `tool_invocations_v4` is the rebuild's
    // staging name: it exists only between the `CREATE` and the `RENAME`, and
    // by the end of the step the database holds `tool_invocations` again.
    expect(new Set(tables)).toEqual(
      new Set([
        ...TABLE_NAMES,
        "parts_fts",
        // The rebuild's two staging tables. Both are dropped again inside the
        // same transaction; they exist only between a `CREATE` and the
        // statement that removes them.
        "tool_invocations_v4",
        "approvals_tool_invocation_v3",
      ]),
    );
  });

  it("creates each table exactly once", () => {
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("makes every plain table STRICT", () => {
    for (const entry of tableStatements) {
      if (entry.table === "parts_fts") continue; // FTS5 has its own typing
      expect(entry.statement.trimEnd(), `${entry.table} must be STRICT`).toMatch(/\)\s*STRICT;\s*$/i);
    }
  });

  it("is idempotent — every creating statement is IF NOT EXISTS", () => {
    // Everything except the four statements of the rebuild step, which cannot
    // carry it: a `DROP TABLE`, an `ALTER … RENAME` and the two that surround
    // the copy. They are protected by the transaction `applyMigrations()` runs
    // each step in, which `migrations.test.ts` and the real-SQLite parity test
    // both measure. Claiming idempotency that does not exist would be worse
    // than naming the exception.
    const REBUILD_STATEMENTS = STEP_TOOL_CALL_IDENTITY;
    for (const statement of SCHEMA_STATEMENTS) {
      if (REBUILD_STATEMENTS.includes(statement)) continue;
      expect(statement).toMatch(/IF NOT EXISTS/i);
    }
    // The exception is exactly the rebuild. Five of its thirteen statements
    // create or drop something named (`CREATE TABLE` ×2, `DROP … IF EXISTS`
    // ×2, the three re-created/new indexes) and carry `IF NOT EXISTS`; the
    // other eight are the `PRAGMA`, the three `UPDATE`s, the two copies and
    // the `RENAME`, none of which can.
    const creating = REBUILD_STATEMENTS.filter((statement) => /IF NOT EXISTS/i.test(statement));
    expect(creating).toHaveLength(5);
    expect(REBUILD_STATEMENTS.filter((statement) => !/IF NOT EXISTS/i.test(statement)))
      .toHaveLength(8);
  });

  it("declares the live tool_invocations shape in the rebuild step", () => {
    // `STEP_CORE_TABLES` is a *released* migration and may not be edited, so it
    // still describes `tool_invocations` as it was before the call key. The
    // live shape is the rebuild, exported on its own so the two cannot drift.
    const live = TOOL_INVOCATIONS_TABLE.replace("tool_invocations_v4", "tool_invocations");
    expect(STEP_TOOL_CALL_IDENTITY).toContain(TOOL_INVOCATIONS_TABLE);

    const columns = columnsOf(live);
    // The four-part call key has to be *columns*, not just key computation:
    // `Plan.md` §6.1 allows the latter, but a key the database cannot enforce
    // is a key the in-memory backend and SQLite would disagree about.
    for (const column of ["tool_call_id", "attempt", "occurrence", "output"]) {
      expect(columns, column).toContain(column);
    }
    // And the status is `begun | done` — the crash window, made representable.
    expect(live).toMatch(/status\s+TEXT\s+NOT NULL CHECK \(status IN \('begun', 'done'\)\)/);
    expect(live).toMatch(
      /UNIQUE \(session_id, attempt, tool_call_id, occurrence\)/,
    );
  });

  it("declares the columns the typed helpers read", () => {
    expect(columnsOf(tableDdl("sessions"))).toEqual([
      "id",
      "title",
      "status",
      "model",
      "system_prompt",
      "metadata",
      "created_at",
      "updated_at",
      "archived_at",
    ]);
    expect(columnsOf(tableDdl("messages"))).toEqual([
      "id",
      "session_id",
      "turn_id",
      "parent_id",
      "seq",
      "role",
      "status",
      "model",
      "outcome",
      "error",
      "usage",
      "created_at",
      "updated_at",
    ]);
    expect(columnsOf(tableDdl("parts"))).toEqual([
      "id",
      "message_id",
      "session_id",
      "seq",
      "type",
      "data",
      "content_text",
      "status",
      "created_at",
      "updated_at",
    ]);
    expect(columnsOf(tableDdl("part_deltas"))).toEqual([
      "id",
      "part_id",
      "session_id",
      "seq",
      "content_text",
      "created_at",
    ]);
  });

  it("keeps the rest of §6.1 intact", () => {
    expect(columnsOf(tableDdl("turns"))).toContain("heartbeat_at");
    expect(columnsOf(tableDdl("turns"))).toContain("lease_owner");
    // The *live* `tool_invocations`, which is the rebuild, not the frozen step.
    expect(columnsOf(TOOL_INVOCATIONS_TABLE)).toContain("call_part_id");
    expect(columnsOf(tableDdl("approvals"))).toContain("decision");
    expect(columnsOf(tableDdl("todos"))).toContain("priority");
    expect(columnsOf(tableDdl("workspaces"))).toContain("root_handle_id");
    expect(columnsOf(tableDdl("file_handles"))).toContain("relative_path");
    expect(columnsOf(tableDdl("settings"))).toEqual(["key", "value", "updated_at"]);
  });
});

describe("constraints", () => {
  it("allows only the three part types of §14.3", () => {
    const parts = tableDdl("parts");
    const check = /type\s+TEXT\s+NOT NULL\s+CHECK\s*\(type IN \(([^)]*)\)\)/.exec(parts);
    expect(check?.[1]).toBeDefined();
    const values = (check?.[1] ?? "").match(/'([^']+)'/g) ?? [];
    expect(values.map((value) => value.replaceAll("'", ""))).toEqual([
      "text",
      "reasoning",
      "tool",
    ]);
  });

  it("never allows a fourth part type", () => {
    // The CHECK is the boundary; a `file` or `patch` part must not be storable.
    const parts = tableDdl("parts");
    expect(parts).not.toMatch(/'(file|patch|snapshot)'/);
  });

  it("orders messages and parts by seq, not by created_at", () => {
    for (const name of ["messages", "parts", "turns", "todos"]) {
      expect(tableDdl(name), `${name} must be unique per parent seq`).toMatch(
        /UNIQUE \(\s*\w+,\s*seq\s*\)/,
      );
    }
  });

  it("keeps a turn outcome on the message, per §6.2", () => {
    expect(tableDdl("messages")).toMatch(
      /outcome\s+TEXT\s+CHECK \(outcome IS NULL OR outcome IN \('succeeded', 'failed', 'interrupted'\)\)/,
    );
  });

  it("cascades every child table off its parent", () => {
    const cascades: Record<string, string> = {
      turns: "sessions",
      messages: "sessions",
      parts: "messages",
      part_deltas: "parts",
      tool_invocations: "sessions",
      approvals: "sessions",
      todos: "sessions",
      file_handles: "workspaces",
    };
    for (const [child, parent] of Object.entries(cascades)) {
      const ddl = child === "tool_invocations" ? TOOL_INVOCATIONS_TABLE : tableDdl(child);
      expect(ddl, `${child} must cascade from ${parent}`).toContain(
        `REFERENCES ${parent}(id) ON DELETE CASCADE`,
      );
    }
  });

  it("requires an archived session to carry archived_at", () => {
    expect(tableDdl("sessions")).toMatch(
      /CHECK \(status <> 'archived' OR archived_at IS NOT NULL\)/,
    );
  });

  it("rejects a null part type and a null session id", () => {
    expect(tableDdl("parts")).toMatch(/type\s+TEXT\s+NOT NULL CHECK/);
    expect(tableDdl("messages")).toMatch(/session_id\s+TEXT\s+NOT NULL/);
  });
});

describe("full-text index", () => {
  it("is an external-content FTS5 table over parts", () => {
    const fts = STEP_FULL_TEXT_INDEX[0] ?? "";
    expect(fts).toMatch(/CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5/);
    expect(fts).toContain("content = 'parts'");
    expect(fts).toContain("content_rowid = 'rowid'");
  });

  it("keeps the index in sync with inserts, updates and deletes", () => {
    const triggers = STEP_FULL_TEXT_INDEX.slice(1).join("\n");
    for (const event of ["AFTER INSERT", "AFTER UPDATE", "AFTER DELETE"]) {
      expect(triggers).toContain(event);
    }
    // An update must delete the old row and insert the new one in one trigger.
    const update = STEP_FULL_TEXT_INDEX.find((statement) => statement.includes("AFTER UPDATE")) ?? "";
    expect(update).toContain("'delete'");
  });
});

describe("indexes", () => {
  it("creates exactly the declared index set", () => {
    // Step 3 creates the eleven, and the rebuild step re-creates the two that
    // died with the old table plus one for the new key. `INDEX_NAMES` lists
    // all thirteen, and no statement is allowed to create a name that is not
    // on that list.
    const created = [...STEP_INDEXES, ...STEP_TOOL_CALL_IDENTITY]
      .filter((statement) => /CREATE\s+INDEX/i.test(statement))
      .map((statement) => {
        const match = /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(statement);
        if (match?.[1] === undefined) throw new Error(`Index name not found in: ${statement}`);
        return match[1];
      });
    // A rebuild re-creates two of them on purpose; the *final* set is what the
    // database ends up with.
    expect(new Set(created)).toEqual(new Set(INDEX_NAMES));
    expect(new Set(STEP_INDEXES.map((s) => /EXISTS\s+(\w+)/i.exec(s)?.[1] ?? "")))
      .toEqual(new Set(INDEX_NAMES.filter((name) => name !== "idx_tool_invocations_call_key")));
  });

  it("indexes the replay lookup in the order the key is written", () => {
    const statement = STEP_TOOL_CALL_IDENTITY.find((entry) =>
      entry.includes("idx_tool_invocations_call_key"),
    );
    expect(statement).toContain("(session_id, attempt, tool_call_id, occurrence)");
  });

  it("indexes the reload check: streaming turns by heartbeat", () => {
    const statement = STEP_INDEXES.find((entry) => entry.includes("idx_turns_status_heartbeat"));
    expect(statement).toBeDefined();
    expect(statement).toContain("(status, heartbeat_at)");
  });

  it("uses a partial index for the open approvals", () => {
    const statement = STEP_INDEXES.find((entry) => entry.includes("idx_approvals_pending"));
    expect(statement).toContain("WHERE decision IS NULL");
  });

  it("does not re-index a column pair a UNIQUE constraint already indexes", () => {
    // (session_id, seq) and (message_id, seq) are covered by UNIQUE on
    // messages, turns, todos and parts. A second index on the same pair would
    // only cost write throughput. The one exception is documented below.
    const uniquePairs = new Set<string>();
    for (const name of ["messages", "turns", "todos", "parts"]) {
      uniquePairs.add(`${name}:session_id,seq`);
      uniquePairs.add(`${name}:message_id,seq`);
    }
    for (const statement of STEP_INDEXES) {
      const name = /ON\s+(\w+)\s*\(([^)]*)\)/.exec(statement);
      if (name?.[1] === undefined || name[2] === undefined) {
        throw new Error(`Index target not parsed from: ${statement}`);
      }
      const key = `${name[1]}:${name[2].replaceAll(/\s+/g, "")}`;
      if (key === "parts:session_id,seq") continue; // see below
      expect(uniquePairs.has(key), `${key} duplicates a UNIQUE index`).toBe(false);
    }
  });

  it("keeps the deliberate exception: parts are read session-wide", () => {
    // `idx_parts_session_seq` is (session_id, seq) and duplicates nothing in
    // the schema — parts carry session_id for exactly this access pattern
    // (search results, session export), not only message_id.
    const statement = STEP_INDEXES.find((entry) => entry.includes("idx_parts_session_seq"));
    expect(statement).toContain("ON parts (session_id, seq)");
  });
});

describe("step order", () => {
  it("creates tables before the triggers that reference them", () => {
    const lastTable = SCHEMA_STATEMENTS.findLastIndex(
      (statement) => createdTable(statement) === "parts",
    );
    const firstTrigger = SCHEMA_STATEMENTS.findIndex((statement) =>
      statement.includes("CREATE TRIGGER"),
    );
    expect(firstTrigger).toBeGreaterThan(lastTable);
  });

  it("creates the FTS table before its triggers", () => {
    const ftsIndex = SCHEMA_STATEMENTS.findIndex((statement) => statement.includes("parts_fts USING"));
    const firstTrigger = SCHEMA_STATEMENTS.findIndex((statement) =>
      statement.includes("CREATE TRIGGER"),
    );
    expect(ftsIndex).toBeGreaterThanOrEqual(0);
    expect(ftsIndex).toBeLessThan(firstTrigger);
  });

  it("keeps the three steps in dependency order", () => {
    expect(STEP_CORE_TABLES.length).toBeGreaterThan(0);
    expect(STEP_FULL_TEXT_INDEX.length).toBeGreaterThan(0);
    expect(STEP_INDEXES.length).toBeGreaterThan(0);
    const core = STEP_CORE_TABLES.map((statement) => createdTable(statement));
    expect(core).toContain("sessions");
    expect(core.indexOf("sessions")).toBeLessThan(core.indexOf("turns"));
    expect(core.indexOf("turns")).toBeLessThan(core.indexOf("messages"));
    expect(core.indexOf("messages")).toBeLessThan(core.indexOf("parts"));
  });
});
