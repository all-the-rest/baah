/**
 * Ordered, idempotent migrations.
 *
 * The version anchor is doubled up on purpose (`Plan.md` §6): `schema_migrations`
 * is the audit trail, `PRAGMA user_version` is what an outside tool reads. Both
 * are written inside the same transaction as the DDL, so a half-applied
 * migration is impossible.
 *
 * `applyMigrations()` takes a narrow {@link MigrationHost} rather than the
 * SQLite-WASM `Database` class. That is what makes the migration logic testable
 * in plain Node — no OPFS, no WASM — while the worker passes the real handle,
 * which satisfies the interface structurally.
 */

import {
  SCHEMA_MIGRATIONS_TABLE,
  STEP_CORE_TABLES,
  STEP_FULL_TEXT_INDEX,
  STEP_INDEXES,
  STEP_SESSION_WORKSPACE,
  STEP_TOOL_CALL_IDENTITY,
} from "./schema.ts";
import type { SqlValue } from "./types.ts";

/**
 * The only two operations migrations need.
 *
 * Intentionally parameter-free: `sqlite3` binds only to the first statement of
 * an `exec()` call, so a parameterised multi-statement migration would silently
 * bind the wrong thing. Migration SQL therefore inlines its literals.
 */
export interface MigrationHost {
  exec(sql: string): void;
  selectObjects(sql: string): Record<string, SqlValue>[];
}

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

export interface MigrationResult {
  /** The schema version after this call. */
  version: number;
  /** Only the migrations this call actually ran; empty on a no-op call. */
  applied: AppliedMigration[];
}

/**
 * The migration list. Append only — never edit a released step, add a new one.
 *
 * Step 3 is separated from step 1 so a database can be inspected (or repaired)
 * even if the FTS5 virtual table cannot be created.
 *
 * Step 5 is the first step whose statements are **neither** `IF NOT EXISTS` nor
 * a rebuild: a plain `ALTER TABLE … ADD COLUMN` plus one index. It is here as its
 * own version precisely because it is irreversible in the other direction — no
 * `IF NOT EXISTS` spelling exists for `ADD COLUMN` (a second one is refused with
 * `duplicate column name`, measured) — so its idempotency comes from
 * `schema_migrations` alone, exactly like step 4. The column is nullable with no
 * default, which is both what SQLite requires for a `REFERENCES` clause and the
 * truthful value for every session that predates the project level. The reasoning
 * is at `STEP_SESSION_WORKSPACE` in `schema.ts`, including why this step needs
 * **no** park table and step 4 does.
 *
 * Step 4 is the first **rebuild** rather than a plain `CREATE … IF NOT
 * EXISTS`: it replaces `tool_invocations` so that `status` can become
 * `begun | done` and so that the four-part call key can carry a real `UNIQUE`
 * constraint. `ALTER TABLE … ADD COLUMN` cannot add a table constraint in
 * SQLite, and it cannot change a `CHECK` at all.
 *
 * **Its idempotency comes from the transaction, not from its statements.**
 * Everything in a step runs inside one `BEGIN IMMEDIATE` … `COMMIT`, so a
 * failure anywhere — including a re-run that would duplicate a copied row —
 * rolls the whole rebuild back, and the version is recorded only after the
 * commit succeeded. `schema_migrations` is therefore the single authority on
 * "has this run", and a second `applyMigrations()` does no work at all. The
 * earlier steps still carry `IF NOT EXISTS` on every statement as a second
 * line of defence; this one cannot, and saying so is better than pretending.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "core_schema", statements: STEP_CORE_TABLES },
  { version: 2, name: "full_text_index", statements: STEP_FULL_TEXT_INDEX },
  { version: 3, name: "query_indexes", statements: STEP_INDEXES },
  { version: 4, name: "tool_call_identity", statements: STEP_TOOL_CALL_IDENTITY },
  { version: 5, name: "session_workspace", statements: STEP_SESSION_WORKSPACE },
];

/** Newest version the code knows about. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/** Single-quote escaping for the two literals a migration step interpolates. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readAppliedVersions(host: MigrationHost): Set<number> {
  const rows = host.selectObjects("SELECT version FROM schema_migrations");
  const versions = new Set<number>();
  for (const row of rows) {
    const version = row["version"];
    if (typeof version === "number") versions.add(version);
  }
  return versions;
}

/**
 * Run every migration that is not in `schema_migrations` yet, one transaction
 * per migration, and record it.
 *
 * Safe to call any number of times: a second call with an unchanged schema
 * does no work at all — not even a `BEGIN`.
 */
export function applyMigrations(
  host: MigrationHost,
  now: () => string = nowIso,
): MigrationResult {
  // Bootstrap. Runs outside a transaction because it has to exist before the
  // first one can be journaled.
  host.exec(SCHEMA_MIGRATIONS_TABLE);

  const appliedVersions = readAppliedVersions(host);
  const pending = MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version));
  const applied: AppliedMigration[] = [];

  for (const migration of pending) {
    const appliedAt = now();
    // BEGIN IMMEDIATE takes the write lock up front, so a concurrent writer
    // fails fast instead of half-way through the DDL.
    host.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) {
        host.exec(statement);
      }
      host.exec(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (` +
          `${migration.version}, ${quote(migration.name)}, ${quote(appliedAt)});`,
      );
      host.exec(`PRAGMA user_version=${migration.version};`);
      host.exec("COMMIT");
    } catch (error) {
      // Keep the rollback visible: a failed migration must not look like a
      // clean one. The original error is rethrown by the caller.
      try {
        host.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Migration ${migration.version} (${migration.name}) failed and could not be rolled back.`,
        );
      }
      throw error;
    }
    applied.push({ version: migration.version, name: migration.name, appliedAt });
  }

  return {
    version: Math.max(LATEST_SCHEMA_VERSION, ...applied.map((entry) => entry.version)),
    applied,
  };
}

/** Versions already recorded in the database. */
export function readSchemaVersion(host: MigrationHost): number {
  const versions = readAppliedVersions(host);
  let highest = 0;
  for (const version of versions) highest = Math.max(highest, version);
  return highest;
}
