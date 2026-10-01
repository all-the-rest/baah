/**
 * `parts.session_id` is redundant, and nothing checks it — measured here rather
 * than asserted from reading.
 *
 * ## The question this file answers
 *
 * `Plan.md` §18.5 step 5 proposes **dropping** `parts.session_id`. Before that step
 * is taken, §18.5 asks the honest counter-question: *does the column limit a query
 * that today is merely slow?* An index on it would be a **planned** query, and then
 * the step is not a refactor but an index — a different decision entirely.
 *
 * The measurement, on both backends:
 *
 * 1. a part carrying a **foreign** `session_id` is written without complaint;
 * 2. `readTranscript` — which goes through `message_id` — does not notice;
 * 3. `search({ sessionId })` — which goes through `parts.session_id` — **does**
 *    disagree with it. That is the finding, and it is why step 5 is not a refactor.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { createMemoryDatabase } from "../src/factory.ts";
import type { StorageDatabase } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback } from "./harness/transport.ts";

type Backend = StorageDatabase;

const T0 = "2026-01-01T00:00:00.000Z";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/** The real engine, exactly as `transcript.test.ts` builds it. */
async function sqlBackend(): Promise<StorageDatabase> {
  const { install } = installInMemoryPool(sqlite3);
  const loopback = createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: install,
  });
  await loopback.client.open({ filename: "/baah.sqlite3" });
  return loopback.client;
}

async function bothBackends(): Promise<readonly Backend[]> {
  return [createMemoryDatabase(), await sqlBackend()];
}

/**
 * Two sessions, one message each, and a part on the first message that claims to
 * belong to the **second** session.
 *
 * Both claims are legal at the schema level and only one of them is true: the part
 * hangs off `m1`, which is in `s1`, so its real session is `s1`.
 */
async function plantForeignPart(db: StorageDatabase): Promise<void> {
  await db.createSession({ id: "s1", title: "First" });
  await db.createSession({ id: "s2", title: "Other" });
  await db.appendMessage({ id: "m1", sessionId: "s1", role: "assistant", createdAt: T0, updatedAt: T0 });
  await db.appendMessage({ id: "m2", sessionId: "s2", role: "assistant", createdAt: T0, updatedAt: T0 });
  await db.appendPart({
    id: "p1",
    messageId: "m1",
    sessionId: "s2",
    type: "text",
    contentText: "the shared word",
    updatedAt: T0,
  });
}

describe("parts.session_id — the column is unchecked (Plan.md §18.5 step 5)", () => {
  it("accepts a part whose session_id belongs to another session, and says nothing", async () => {
    for (const db of await bothBackends()) {
      await plantForeignPart(db);

      // **The write succeeded.** No `sql_error`, no constraint, no warning — the row
      // is there with two different sessions in play.
      const [part] = await db.listParts("m1");
      expect(part?.sessionId).toBe("s2");
      expect(part?.messageId).toBe("m1");

      // And the message it points at is in `s1`. Two sources for one fact, and they
      // disagree — which is the whole finding.
      const message = await db.getMessage("m1");
      expect(message?.sessionId).toBe("s1");
    }
  });

  it("the transcript read follows message_id, so the part appears in s1 and not in s2", async () => {
    for (const db of await bothBackends()) {
      await plantForeignPart(db);

      const inS1 = await db.readTranscript({ sessionId: "s1" });
      const inS2 = await db.readTranscript({ sessionId: "s2" });

      // `SELECT_TRANSCRIPT_PARTS` filters on `message_id IN (SELECT id FROM messages
      // WHERE session_id = ?)` — the part's own `session_id` is deliberately not in
      // the guard, so the **message's** session decides.
      expect(inS1.parts.map((part) => part.id)).toEqual(["p1"]);
      expect(inS2.parts.map((part) => part.id)).toEqual([]);
    }
  });

  it("the session-scoped SEARCH follows parts.session_id — and disagrees with the transcript", async () => {
    for (const db of await bothBackends()) {
      await plantForeignPart(db);

      // `SEARCH_SQL_BY_SESSION` filters `AND p.session_id = ?` on the **part's** own
      // column, with no join to `messages`. So the same part is found under `s2` …
      const foundInS2 = await db.search({ query: "shared", sessionId: "s2" });
      expect(foundInS2.map((hit) => hit.partId)).toEqual(["p1"]);

      // … and is missing under `s1`, even though the transcript for `s1` shows it.
      const foundInS1 = await db.search({ query: "shared", sessionId: "s1" });
      expect(foundInS1).toEqual([]);

      const transcriptS1 = await db.readTranscript({ sessionId: "s1" });
      expect(transcriptS1.parts.map((part) => part.id)).toEqual(["p1"]);
    }
  });

  it("names the two statements that disagree, and the index that serves one of them", async () => {
    // Not a query — a **declaration**, and the two halves of the finding side by side.
    // `search` filters on the part's own column (`p.session_id`, qualified, because
    // the statement joins `parts_fts`); the transcript read filters on the message's
    // and never mentions the part's. The naive form of this assertion — "the
    // transcript SQL does not contain `session_id = ?`" — is **false**, because the
    // subquery over `messages` contains exactly that. The qualified form is the one
    // that states the fact, and getting it wrong would have hidden the whole finding
    // behind a green test.
    const { INDEX_NAMES } = await import("../src/schema.ts");
    const { SELECT_TRANSCRIPT_PARTS, SEARCH_SQL_BY_SESSION } = await import("../src/sql.ts");

    expect(SELECT_TRANSCRIPT_PARTS).not.toContain("p.session_id");
    expect(SEARCH_SQL_BY_SESSION).toContain("AND p.session_id = ?");
    expect(INDEX_NAMES).toContain("idx_parts_session_seq");
  });
});
