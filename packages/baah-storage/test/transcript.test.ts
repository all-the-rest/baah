/**
 * `TranscriptReader`: reading a session's log back, measured on both backends.
 *
 * ## What this file is
 *
 * `Plan.md` §6.1 and `AGENTS.md` §3.1 require the partial text to survive a
 * reload. Before the read port the transcript was *in* the database and nothing
 * in the seam could read it: `TurnStore` has no `listParts`/`getMessages`/
 * `listMessages`, and `recoverStaleTurns` returns anchors (`turnId`,
 * `heartbeatAt`, `startedAt`) and no text. A reloaded tab could be told *that* a
 * turn died and not what it said.
 *
 * So this file measures the four properties the port is actually for, and each
 * one is stated as a behaviour rather than as a field:
 *
 * 1. **A session read returns the log, oldest first, with the parts attached to
 *    their own message** — including the text of a turn that died mid-sentence.
 * 2. **A turn read returns that turn and nothing else.** The `limit + 1` window,
 *    the truncation flag and the parts join are shared, and this is where a
 *    dropped predicate would show up as "everything".
 * 3. **A live turn's current answer is in the read.** A part that is still
 *    `streaming` comes back *with* its text, at the latest flush — and the
 *    measurement that the delta log is not a holding pen is made here rather than
 *    argued in a comment.
 * 4. **A read that cannot be an answer rejects.** A closed database, a session
 *    that does not exist, a turn that is not in that session. An empty
 *    transcript in any of those cases is a lie the UI cannot detect.
 *
 * ## Why it is a parity test
 *
 * `Plan.md` §6.2: the two backends are interchangeable. The SQLite side is
 * **real** — the `exports.node` build of `@sqlite.org/sqlite-wasm` behind the
 * worker's own dispatch table (`test/harness/sqlite.ts`, the one documented
 * exception in `AGENTS.md` §2). So `ORDER BY seq DESC`, `IN (SELECT … LIMIT ?)`,
 * the foreign keys and the CHECK constraints are SQLite's, not a model of them.
 *
 * Every body runs against the in-memory maps **and** real SQLite, and the
 * assertions come after both — a `for` loop with `expect` inside would stop at
 * the first failure and leave the other backend unmeasured.
 *
 * ## What cannot be measured here, and is not claimed
 *
 * `createMemoryDatabase().close()` is a no-op — the memory backend has no
 * connection to close, and `memory.test.ts` asserts exactly that. So the
 * closed-database case is measured on the **loopback client** only, and there is
 * no claim that the memory backend behaves the same way. The port's own layer
 * (that it adds no `catch`) is measured on both, separately, with a database that
 * rejects.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { StorageError } from "../src/errors.ts";
import { createMemoryDatabase, type MemoryDatabase } from "../src/factory.ts";
import { MAX_TRANSCRIPT_MESSAGES, clampTranscriptLimit } from "../src/operations.ts";
import { createTranscriptReader, type TranscriptReader } from "../src/transcript.ts";
import type { StorageDatabase, TranscriptRows } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback } from "./harness/transport.ts";

const T0 = "2026-09-29T10:00:00.000Z";
const T1 = "2026-09-29T10:00:01.000Z";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/* ------------------------------------------------------------------ */
/* Backends                                                             */
/* ------------------------------------------------------------------ */

interface MemoryBackend {
  readonly name: "memory";
  /** The maps backend, which also exposes the delta log without SQL. */
  readonly db: MemoryDatabase;
  /** The statements the in-memory engine ran, single-spaced. */
  statements(): readonly string[];
}

interface SqlBackend {
  readonly name: "sql";
  readonly db: StorageDatabase;
  /**
   * Every statement the SQLite connection ran, in order — including the worker's
   * own `BEGIN IMMEDIATE` / `COMMIT`, so "one read is three statements" is
   * measured rather than inferred.
   */
  statements(): readonly string[];
}

type Backend = MemoryBackend | SqlBackend;

function memoryBackend(): MemoryBackend {
  const db = createMemoryDatabase();
  return { name: "memory", db, statements: () => db.statements() };
}

async function sqlBackend(): Promise<SqlBackend> {
  const { pool, install } = installInMemoryPool(sqlite3);
  const loopback = createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: install,
  });
  await loopback.client.open({ filename: "/baah.sqlite3" });
  return { name: "sql", db: loopback.client, statements: () => pool.opened[0]?.executed ?? [] };
}

/**
 * A conversation: one session, two turns, and messages that belong to different
 * turns — so a read that ignored the turn predicate could not pass by accident.
 */
async function conversation(db: StorageDatabase): Promise<void> {
  await db.createSession({ id: "s1", title: "First" });
  await db.createSession({ id: "s2", title: "Other" });
  await db.appendTurn({ id: "t1", sessionId: "s1", startedAt: T0, status: "succeeded" });
  await db.appendTurn({ id: "t2", sessionId: "s1", startedAt: T1, status: "interrupted" });
  // A turn of the *other* session: the cross-session read has to be impossible.
  await db.appendTurn({ id: "t-other", sessionId: "s2", startedAt: T0, status: "succeeded" });

  // seq 0: the user prompt, which belongs to no turn.
  await db.appendMessage({ id: "m0", sessionId: "s1", role: "user", createdAt: T0, updatedAt: T0 });
  await db.appendPart({ id: "p0", messageId: "m0", sessionId: "s1", type: "text", contentText: "hi", updatedAt: T0 });

  // seq 1: the first turn's answer, finished.
  await db.appendMessage({
    id: "m1",
    sessionId: "s1",
    turnId: "t1",
    role: "assistant",
    createdAt: T1,
    updatedAt: T1,
  });
  await db.appendPart({
    id: "p1",
    messageId: "m1",
    sessionId: "s1",
    type: "text",
    contentText: "the first answer",
    status: "completed",
    updatedAt: T1,
  });

  // seq 2: the second turn's answer, still streaming — the reload case.
  await db.appendMessage({
    id: "m2",
    sessionId: "s1",
    turnId: "t2",
    role: "assistant",
    createdAt: T1,
    updatedAt: T1,
  });
  await db.appendPart({
    id: "p2",
    messageId: "m2",
    sessionId: "s1",
    type: "reasoning",
    contentText: "half a sen",
    status: "streaming",
    updatedAt: T1,
  });

  // A message of the OTHER session, with a part: it must never appear in s1.
  await db.appendMessage({
    id: "m-other",
    sessionId: "s2",
    turnId: "t-other",
    role: "assistant",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.appendPart({
    id: "p-other",
    messageId: "m-other",
    sessionId: "s2",
    type: "text",
    contentText: "somebody else's conversation",
    updatedAt: T0,
  });
}

/** Both backends, each seeded with the same conversation. */
async function bothSeeded(): Promise<[Backend, Backend]> {
  const backends: [Backend, Backend] = [memoryBackend(), await sqlBackend()];
  for (const backend of backends) await conversation(backend.db);
  return backends;
}

/**
 * Run on both backends and return both results.
 *
 * The body must not assert, and the reason is measured rather than stylistic: an
 * `expect` thrown inside here rejects the promise `onBoth` is building, and
 * vitest reports that as an **unhandled rejection** with the *test itself
 * reported as passing*. Two of this file's tests were written the other way and
 * the suite said 431/431 green while two assertions were failing in the margins.
 * Return the facts; assert them here, where a failure is a failure of the test.
 */
async function onBoth<R>(body: (backend: Backend) => Promise<R>): Promise<[R, R]> {
  const [memory, sql] = await bothSeeded();
  return [await body(memory), await body(sql)];
}

/** {@link onBoth} for a result that must be identical on both backends. */
async function same<R>(expected: R, body: (backend: Backend) => Promise<R>): Promise<[R, R]> {
  const [memory, sql] = await onBoth(body);
  expect(memory, "memory").toEqual(expected);
  expect(sql, "sql").toEqual(expected);
  return [memory, sql];
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("The call resolved, but a rejection was expected.");
}

function reader(backend: Backend): TranscriptReader {
  return createTranscriptReader(backend.db);
}

/**
 * The newest `part_deltas` entry for one part, read per backend.
 *
 * The memory backend has no `query` — that is what `MemoryDatabase.counts()` and
 * `deltas()` are for — so the two are read through their own doors. The
 * comparison this feeds is only meaningful because the SQL side is the *real*
 * engine's `part_deltas` table.
 */
async function newestDeltaFor(backend: Backend, partId: string): Promise<string | undefined> {
  if (backend.name === "memory") {
    const rows = backend.db.deltas().filter((delta) => delta.partId === partId);
    return rows.at(-1)?.contentText;
  }
  const result = await backend.db.query(
    "SELECT content_text AS contentText FROM part_deltas WHERE part_id = ? ORDER BY seq DESC LIMIT 1",
    [partId],
  );
  const row = result.rows[0] as { contentText?: string } | undefined;
  return row?.contentText;
}

/* ================================================================== */
/* 1 — a session read                                                   */
/* ================================================================== */

describe("a session transcript", () => {
  it("is the log, oldest first, with each message's own parts", async () =>
    same(
      {
        ids: ["m0", "m1", "m2"],
        texts: ["hi", "the first answer", "half a sen"],
        kinds: ["text", "text", "reasoning"],
        statuses: [null, "completed", "streaming"],
      },
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1" });
        return {
          ids: transcript.messages.map((message) => message.id),
          texts: transcript.messages.flatMap((message) =>
            message.parts.map((part) => part.contentText),
          ),
          // `reasoning` stays `reasoning`: a read that flattened the kinds would
          // render the model's thinking as something it said (§6.1).
          kinds: transcript.messages.flatMap((message) => message.parts.map((part) => part.type)),
          statuses: transcript.messages.flatMap((message) =>
            message.parts.map((part) => part.status),
          ),
        };
      },
    ));

  it("never carries another session's message or part", async () =>
    // The cross-session guard, measured. `parts.session_id` is not in the parts
    // statement's guard, so this is the test that holds the message subquery's
    // `session_id` honest.
    same(
      { ids: ["m0", "m1", "m2"], leak: false },
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1" });
        const parts = transcript.messages.flatMap((message) => message.parts);
        return {
          ids: transcript.messages.map((message) => message.id),
          leak: parts.some((part) => part.contentText === "somebody else's conversation"),
        };
      },
    ));

  it("reports the turn of every message, and the outcome where one is", async () =>
    same(
      [
        { id: "m0", turnId: null, outcome: null },
        { id: "m1", turnId: "t1", outcome: null },
        { id: "m2", turnId: "t2", outcome: null },
      ],
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1" });
        return transcript.messages.map((message) => ({
          id: message.id,
          turnId: message.turnId,
          outcome: message.outcome,
        }));
      },
    ));

  it("an upsert does NOT re-kind a part — the two backends agreed only after a fix", async () =>
    // The mutation work found this, and it is kept as a test because the fix is
    // one line that a later edit could "clean up" back into a divergence.
    //
    // `UPSERT_PART`'s `ON CONFLICT (id) DO UPDATE SET` names `content_text`,
    // `data`, `status` and `updated_at` — not `type` — so SQLite keeps the
    // original kind. The in-memory mirror wrote the caller's `type` on every
    // upsert, so a part seeded `reasoning` and re-flushed as `text` read back
    // `text` on one backend and `reasoning` on the other. Same query, two answers,
    // which is the exact failure `Plan.md` §6.2 forbids.
    //
    // The conservative direction is SQLite's: a part's kind cannot change under a
    // reader that has already seen it. And nothing writes a kind twice for one id,
    // because an explicit `INSERT` of a taken id is refused — asserted below.
    same(
      // The *text* is updated — that is the half that must work — and the kind is
      // not. Returned as a pair so a "fix" that froze the whole row would be caught
      // here rather than looking like agreement about the kind.
      { type: "reasoning", contentText: "thinking, re-flushed" },
      async (backend) => {
        // A `reasoning` part of its own, so the fixture's `text`/`reasoning` mix is
        // not doing the work of distinguishing the two cases.
        await backend.db.appendPart({
          id: "p-reason",
          messageId: "m1",
          sessionId: "s1",
          type: "reasoning",
          contentText: "thinking",
          status: "completed",
          updatedAt: T1,
        });
        await backend.db.upsertPart({
          id: "p-reason",
          messageId: "m1",
          sessionId: "s1",
          type: "text",
          contentText: "thinking, re-flushed",
          status: "streaming",
          updatedAt: T1,
        });
        const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t1" });
        const part = transcript.messages[0]?.parts.find((candidate) => candidate.id === "p-reason");
        return { type: part?.type ?? "missing", contentText: part?.contentText ?? "" };
      },
    ));

  it("so a re-flushed part cannot be re-inserted with a different kind either", async () =>
    same("sql_error", async (backend) =>
      failure(
        backend.db.appendPart({
          id: "p1",
          messageId: "m1",
          sessionId: "s1",
          type: "reasoning",
          contentText: "x",
          updatedAt: T1,
        }),
      ).then((result) => result.code),
    ));

  it("carries each part's `data`, so a tool part's file diff survives the round trip", async () =>
    // `Plan.md` §6.1: a file diff is not its own part type — it is
    // `data.metadata.files` of a `tool` part. A read that dropped the column would
    // hand the UI a tool card with nothing to render, and it would look exactly
    // like "this tool changed no files".
    //
    // Returned, not asserted inside the body: an `expect` in there throws inside
    // a promise {@link onBoth} never awaits into the test, and the failure arrives
    // as an unhandled rejection with the test itself reported green. That is
    // measured, not assumed — the harness's contract at {@link same} is that the
    // body does not assert.
    same(
      { type: "tool", files: ["src/app.ts"], raw: true },
      async (backend) => {
        await backend.db.appendPart({
          id: "p-tool",
          messageId: "m1",
          sessionId: "s1",
          type: "tool",
          contentText: "edited src/app.ts",
          data: JSON.stringify({
            type: "tool",
            metadata: { files: [{ file: "src/app.ts", patch: "+1", additions: 1, deletions: 0 }] },
          }),
          status: "completed",
          updatedAt: T1,
        });
        const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t1" });
        const tool = transcript.messages[0]?.parts.find((part) => part.id === "p-tool");
        return {
          type: tool?.type ?? "missing",
          // Raw text, not a parsed object: only the layer that knows the payload's
          // shape may parse it, and a port that handed an object out would be
          // asserting a schema it does not own. A `null` here would mean "this tool
          // changed nothing", which is a different claim from "the diff is gone".
          files: tool?.data === null || tool?.data === undefined
            ? []
            : (JSON.parse(tool.data) as { metadata: { files: { file: string }[] } }).metadata.files.map(
                (file) => file.file,
              ),
          raw: typeof tool?.data === "string",
        };
      },
    ));

  it("carries the `idle` outcome message, so a recovered turn can be named", async () =>
    // `Plan.md` §6.2: the turn outcome IS an `idle` message. A UI that had to
    // filter `role === "idle"` itself would be re-deriving the engine's
    // definition in a second place, and the second place is what drifts.
    same(
      [{ turnId: "t2", outcome: "interrupted" }],
      async (backend) => {
        await backend.db.finishTurn({
          turnId: "t2",
          sessionId: "s1",
          outcome: "interrupted",
          error: "interrupted: no heartbeat for 120s",
          finishedAt: T1,
        });
        const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t2" });
        return transcript.messages
          .filter((message) => message.outcome !== null)
          .map((message) => ({ turnId: message.turnId, outcome: message.outcome }));
      },
    ));

  it("is one bounded window, not a scan of the whole log", async () =>
    // The bound is the statement's own (`ORDER BY seq DESC LIMIT ?`), which is
    // why a caller cannot lose it by forgetting something on its side. Five
    // messages, `limit: 2` — and the parts statement gets the same window, so the
    // parts of a dropped message cannot leak in.
    same(
      { ids: ["m1", "m2"], texts: ["the first answer", "half a sen"], truncated: true, limit: 2 },
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1", limit: 2 });
        return {
          ids: transcript.messages.map((message) => message.id),
          texts: transcript.messages.flatMap((message) =>
            message.parts.map((part) => part.contentText),
          ),
          truncated: transcript.truncated,
          limit: transcript.limit,
        };
      },
    ));

  it("says `truncated: false` when the window holds the whole session", async () =>
    same(
      { truncated: false, ids: ["m0", "m1", "m2"] },
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1" });
        return {
          truncated: transcript.truncated,
          ids: transcript.messages.map((message) => message.id),
        };
      },
    ));

  it("a bound of 0 is a request for nothing, not for everything", async () =>
    same(
      { ids: [], truncated: true, limit: 0 },
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1", limit: 0 });
        return {
          ids: transcript.messages.map((message) => message.id),
          truncated: transcript.truncated,
          limit: transcript.limit,
        };
      },
    ));

  it("clamps a caller asking for more than the ceiling, in the shared layer", async () => {
    // Clamped by `clampTranscriptLimit` *before* the statement, so both backends
    // see the same number — the same reason `clampSearchLimit` exists. Asserted
    // on the value the port echoes, because that is the number the store was
    // actually asked for.
    const [, sql] = await onBoth(async (backend) =>
      (await reader(backend).read({ sessionId: "s1", limit: 10_000 })).limit,
    );
    expect(sql).toBe(MAX_TRANSCRIPT_MESSAGES);
    expect(clampTranscriptLimit(10_000)).toBe(MAX_TRANSCRIPT_MESSAGES);
    expect(clampTranscriptLimit(undefined)).toBe(50);
    expect(clampTranscriptLimit(Number.NaN)).toBe(0);
    expect(clampTranscriptLimit(-5)).toBe(0);
  });

  it("reads three statements, four when a turn is named — and never the whole log", async () =>
    // The count is the property: a session read is `SELECT_SESSION` + the window
    // + the parts join, and a turn read adds the existence check. It is *not* a
    // scan (`SELECT_MESSAGES` with no `LIMIT`) plus a `listParts` per message.
    same(
      { session: 3, turn: 4 },
      async (backend) => {
        const before = backend.statements().length;
        await reader(backend).read({ sessionId: "s1" });
        const session = backend.statements().length - before;
        await reader(backend).read({ sessionId: "s1", turnId: "t1" });
        return { session, turn: backend.statements().length - before - session };
      },
    ));
});

/* ================================================================== */
/* 2 — a turn read                                                      */
/* ================================================================== */

describe("a turn transcript", () => {
  it("returns that turn and nothing else", async () =>
    // The mutant this pins: a read that took the session and forgot the turn
    // would answer a question about a turn with the whole conversation. `m0`
    // (no turn) and `m1` (another turn) are both in the session, so the two
    // cannot be confused for each other.
    same(
      { ids: ["m2"], texts: ["half a sen"] },
      async (backend) => {
        const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t2" });
        return {
          ids: transcript.messages.map((message) => message.id),
          texts: transcript.messages.flatMap((message) =>
            message.parts.map((part) => part.contentText),
          ),
        };
      },
    ));

  it("echoes the turn it was narrowed to, so the caller can check its own key", async () =>
    same("t1", async (backend) => (await reader(backend).read({ sessionId: "s1", turnId: "t1" })).turnId));

  it("is empty for a turn that exists and has said nothing — a fact, not a refusal", async () =>
    // The other side of the boundary, so the existence check cannot be satisfied
    // by refusing everything. This is the case the UI is entitled to render as
    // "nothing here".
    same(
      { ids: [], turnId: "t-empty" },
      async (backend) => {
        await backend.db.appendTurn({ id: "t-empty", sessionId: "s1", startedAt: T1 });
        const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t-empty" });
        return { ids: transcript.messages.map((message) => message.id), turnId: transcript.turnId };
      },
    ));

  it("a turn of ANOTHER session is not readable, and is not an empty transcript", async () => {
    const [memory, sql] = await onBoth((backend) =>
      failure(reader(backend).read({ sessionId: "s1", turnId: "t-other" })),
    );
    expect(memory.code).toBe("sql_error");
    expect(memory.message).toMatch(/there is no turn t-other in session s1/);
    expect(sql).toEqual(memory);
  });
});

/* ================================================================== */
/* 3 — a read that cannot be an answer                                  */
/* ================================================================== */

describe("a read that cannot be an answer says so", () => {
  it("refuses a session that does not exist, rather than reporting an empty room", async () => {
    const [memory, sql] = await onBoth((backend) => failure(reader(backend).read({ sessionId: "s-nope" })));
    expect(memory.code).toBe("sql_error");
    expect(memory.message).toMatch(/there is no session s-nope/);
    expect(sql).toEqual(memory);
  });

  it("refuses a turn that does not exist, rather than reporting silence", async () => {
    const [memory, sql] = await onBoth((backend) =>
      failure(reader(backend).read({ sessionId: "s1", turnId: "t-nope" })),
    );
    expect(memory.code).toBe("sql_error");
    expect(memory.message).toMatch(/there is no turn t-nope in session s1/);
    expect(sql).toEqual(memory);
  });

  it("rejects with `database_closed` after the database is closed", async () => {
    // The one that cannot be measured on the memory backend: its `close()` is a
    // no-op (`memory.test.ts` asserts exactly that), so a claim about the two
    // backends agreeing here would be false. Measured on the loopback, whose
    // `close()` terminates the worker and refuses further calls.
    const loopback = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
    });
    await loopback.client.open({ filename: "/baah.sqlite3" });
    await conversation(loopback.client);
    const transcript = createTranscriptReader(loopback.client);

    // Before the close it works, so the refusal below is about the close and not
    // about a read that never had anything to return.
    expect((await transcript.read({ sessionId: "s1" })).messages).toHaveLength(3);

    await loopback.client.close();

    expect(await failure(transcript.read({ sessionId: "s1" }))).toMatchObject({
      code: "database_closed",
    });
    expect(await failure(transcript.read({ sessionId: "s1", turnId: "t2" }))).toMatchObject({
      code: "database_closed",
    });
  });

  it("adds no catch of its own — the port hands the database's own rejection through", async () => {
    // The second path to the same property, and it is the one a "helpful" wrapper
    // would break. If the port caught a failure and returned `{ messages: [] }`,
    // a caller could not tell a broken read from an empty conversation — which is
    // the whole reason the failure is not swallowed. Identity, not code: the port
    // must not even synthesise a different error.
    const db = createMemoryDatabase();
    await conversation(db);
    const boom = new StorageError("database_closed", "This database handle is already closed.");
    const failing = {
      ...db,
      readTranscript: (): Promise<TranscriptRows> => Promise.reject(boom),
    } as StorageDatabase;

    await expect(createTranscriptReader(failing).read({ sessionId: "s1" })).rejects.toBe(boom);
  });
});

/* ================================================================== */
/* 4 — a live turn's current answer is in the read                      */
/* ================================================================== */

describe("a read sees a turn that is still being written", () => {
  /**
   * Flush one part twice with growing text and leave it open — the exact state a
   * tab is in 40 ms into an answer, and the state a reload has to read back.
   *
   * Flushes only: the corpus comes from {@link onBoth}'s seeding, so this must
   * not seed again.
   */
  async function streamingPart(backend: Backend): Promise<void> {
    for (const [deltaId, contentText] of [
      ["d1", "the opfs"],
      ["d2", "the opfs vfs needs no"],
      ["d3", "the opfs vfs needs no COOP header"],
    ] as const) {
      await backend.db.flushDelta({
        deltaId,
        part: {
          id: "p2",
          messageId: "m2",
          sessionId: "s1",
          type: "text",
          contentText,
          status: "streaming",
          updatedAt: T1,
        },
        flushedAt: T1,
      });
    }
  }

  it("returns the newest flushed text, not the first and not nothing", async () => {
    // The property. A read that ignored the in-flight part, or reported the text
    // of the *first* flush, would leave a reloaded tab showing a truncated
    // sentence with nothing to say it was truncated.
    const [memory, sql] = await onBoth(async (backend) => {
      await streamingPart(backend);
      const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t2" });
      return transcript.messages[0]?.parts[0]?.contentText;
    });
    expect(memory).toBe("the opfs vfs needs no COOP header");
    expect(sql).toBe("the opfs vfs needs no COOP header");
  });

  it("marks the part `streaming`, which is the half that says it will still grow", async () =>
    same("streaming", async (backend) => {
      await streamingPart(backend);
      const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t2" });
      return transcript.messages[0]?.parts[0]?.status;
    }));

  it("a `streaming` part is never dropped or de-typed as though it had no text", async () =>
    // Returned, not asserted inside the body — see the note on the `data` test
    // above. This is the property as a *set*, so a read that dropped the part and
    // a read that kept it with the wrong kind are two different failures rather
    // than one.
    same(
      // `reasoning`, and the reason is a schema property rather than an accident
      // of this test: the corpus seeds `p2` as `reasoning` and the three flushes
      // above write it as `text`, and `UPSERT_PART`'s `ON CONFLICT (id) DO UPDATE`
      // sets `content_text`, `data`, `status` and `updated_at` — **not** `type`.
      // So a re-flush cannot re-kind a part, which is the conservative direction
      // (a part's kind cannot change under a reader) and is measured here rather
      // than left to be discovered as a "why is this reasoning?" bug report.
      // `sql.ts` says the same about the upsert keeping the original `seq`.
      { types: ["reasoning"], statuses: ["streaming"], count: 1, allHaveText: true },
      async (backend) => {
        await streamingPart(backend);
        const parts = (await reader(backend).read({ sessionId: "s1", turnId: "t2" })).messages[0]
          ?.parts;
        const list = parts ?? [];
        return {
          types: list.map((part) => part.type),
          statuses: list.map((part) => part.status),
          count: list.length,
          allHaveText: list.every((part) => part.contentText.length > 0),
        };
      },
    ));

  it("after the part closes, the text is unchanged and the status is `aborted`", async () =>
    // The recovery's own write, read back. This is the whole `Plan.md` §6.1
    // promise in one assertion: the half-written sentence survives, and it is
    // marked as cut off rather than as finished.
    same(
      { contentText: "the opfs vfs needs no COOP header", status: "aborted" },
      async (backend) => {
        await streamingPart(backend);
        await backend.db.closeTurnParts({ sessionId: "s1", turnId: "t2", updatedAt: T1 });
        const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t2" });
        return {
          contentText: transcript.messages[0]?.parts[0]?.contentText,
          status: transcript.messages[0]?.parts[0]?.status,
        };
      },
    ));

  it("the delta log is NOT a holding pen — the projection carries the same text", async () => {
    // The premise this read is designed against, measured rather than assumed:
    // "a part's deltas live in the delta log until the part closes". They do not.
    // `flushDelta` writes the part's cumulative text in the *same transaction* as
    // the log append, so the newest delta and the part hold the same string — which
    // is why the read uses the projection: one statement cheaper, and the same
    // definition the transcript and the export already use.
    const [memory, sql] = await onBoth(async (backend) => {
      await streamingPart(backend);
      const transcript = await reader(backend).read({ sessionId: "s1", turnId: "t2" });
      return {
        newestDelta: await newestDeltaFor(backend, "p2"),
        projected: transcript.messages[0]?.parts[0]?.contentText,
      };
    });
    expect(memory).toEqual({
      newestDelta: "the opfs vfs needs no COOP header",
      projected: "the opfs vfs needs no COOP header",
    });
    expect(sql).toEqual(memory);
  });

  it("and the delta log is one statement the read never runs", async () => {
    // …and therefore not needed: the read touches `messages` and `parts` only.
    // Measured on the memory backend's statement log, where every statement it
    // ran is recorded.
    const backend = memoryBackend();
    await conversation(backend.db);
    await streamingPart(backend);
    const before = backend.statements().length;
    await reader(backend).read({ sessionId: "s1", turnId: "t2" });
    const ran = backend.statements().slice(before).join("\n");
    expect(ran).not.toContain("part_deltas");
    expect(ran).toContain("FROM messages");
    expect(ran).toContain("FROM parts");
  });
});

/* ================================================================== */
/* 5 — the port is a port                                              */
/* ================================================================== */

describe("the read port", () => {
  it("is separate from the engine's write seam, and implements neither half of it", async () => {
    // `TurnStore` stays a write-only seam: the engine builds `UIMessage[]` as it
    // goes and never reads a transcript back, so a read there would be a method
    // no engine caller could call. Two ports, two injected dependencies, and the
    // composition root holds both rather than one object that is both.
    const db = createMemoryDatabase();
    const port = createTranscriptReader(db) as unknown as Record<string, unknown>;

    expect(typeof port.read).toBe("function");
    expect(Object.keys(port).sort()).toEqual(["read"]);
    // None of the engine's ten writes, so a caller cannot accidentally use the
    // read port as a `TurnStore`.
    for (const write of ["flushDelta", "closePart", "finishTurn", "heartbeat", "beginToolCall"]) {
      expect(port[write], write).toBeUndefined();
    }
  });

  it("is a factory, not a singleton: two readers over two databases stay apart", async () => {
    // A factory, for the same reason `createTurnStore` is one: a module-level
    // reader would make the second test's fixture depend on the first's. Neither
    // factory holds state — the database does.
    const first = memoryBackend();
    const second = memoryBackend();
    await conversation(first.db);
    await conversation(second.db);
    // …and they are genuinely independent, not one object behind two names.
    await first.db.createSession({ id: "s3", title: "Only in the first" });

    const readFirst = await createTranscriptReader(first.db).read({ sessionId: "s1" });
    const readSecond = await createTranscriptReader(second.db).read({ sessionId: "s1" });
    expect(readFirst.messages.map((message) => message.id)).toEqual(["m0", "m1", "m2"]);
    expect(readSecond.messages.map((message) => message.id)).toEqual(["m0", "m1", "m2"]);
    await expect(
      createTranscriptReader(second.db).read({ sessionId: "s3" }),
    ).rejects.toMatchObject({ code: "sql_error" });
  });
});
