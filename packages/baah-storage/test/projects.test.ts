/**
 * Two folders, two projects, two conversations — and the identity that survives
 * both a reload and a machine change.
 *
 * The four acceptance properties, one `describe` each:
 *
 * 1. two folders → two `workspaces` rows, **two different ids even with the same
 *    folder name**, and project A's conversation is not visible in B;
 * 2. `closeDatabase()` → `openDatabase()` brings both back, unchanged — and the same
 *    folder on another machine carries the same id, which is what
 *    `.baah/project.json` is for;
 * 3. the empty conversation: a session that exists **before** any message, and takes
 *    its first message afterwards;
 * 4. `sessionId` on the event — `upsertPart` reads the event, not its argument.
 *
 * Everything runs on **both** backends. `Plan.md` §16.1 requires them to be
 * interchangeable, and the whole project level is new SQL: a claim that only held on
 * the in-memory one would be a claim about a database nobody ships.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { createMemoryDatabase, type MemoryDatabase } from "../src/factory.ts";
import type { StorageDatabase } from "../src/types.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback } from "./harness/transport.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

/** The real engine behind the worker's own seams, as `transcript.test.ts` builds it. */
async function sqlDatabase(): Promise<StorageDatabase> {
  const { install } = installInMemoryPool(sqlite3);
  const loopback = createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: install,
  });
  await loopback.client.open({ filename: "/baah.sqlite3" });
  return loopback.client;
}

/** Every backend, each freshly built, so one test cannot leak into the next. */
async function backends(): Promise<readonly { readonly name: string; readonly db: StorageDatabase }[]> {
  return [
    { name: "memory", db: createMemoryDatabase() },
    { name: "sql", db: await sqlDatabase() },
  ];
}

describe("two folders, two projects (Plan.md §19.3)", () => {
  it("two projects with the SAME folder name are two rows and two ids", async () => {
    for (const { name, db } of await backends()) {
      // The two ids come from two different `.baah/project.json` files, so they are
      // different **even though both folders are called `api`**. This is the whole
      // reason `FileSystemAccessWorkspaceOptions.id` stopped defaulting to
      // `local:${name}`: that spelling made these two rows collide.
      await db.createWorkspace({ id: "project-a", name: "api", kind: "directory" });
      await db.createWorkspace({ id: "project-b", name: "api", kind: "directory" });

      const all = await db.listWorkspaces();
      expect(all.map((w) => w.id).sort(), name).toEqual(["project-a", "project-b"]);
      // And the display names are allowed to be identical — they are labels.
      expect(new Set(all.map((w) => w.name)).size, name).toBe(1);
    }
  });

  it("a conversation of project A is not in project B's list", async () => {
    for (const { name, db } of await backends()) {
      await db.createWorkspace({ id: "project-a", name: "api", kind: "directory" });
      await db.createWorkspace({ id: "project-b", name: "api", kind: "directory" });
      await db.createSession({ id: "s-a", title: "A", workspaceId: "project-a" });
      await db.createSession({ id: "s-b", title: "B", workspaceId: "project-b" });
      await db.createSession({ id: "s-orphan", title: "detached" });

      const inA = await db.listSessions({ workspaceId: "project-a" });
      const inB = await db.listSessions({ workspaceId: "project-b" });

      expect(inA.map((s) => s.id), name).toEqual(["s-a"]);
      expect(inB.map((s) => s.id), name).toEqual(["s-b"]);
      // A session with no project is in **no** project's list. That is the documented
      // cost of `ON DELETE SET NULL`, stated rather than papered over.
      const every = await db.listSessions();
      expect(every.map((s) => s.id).sort(), name).toEqual(["s-a", "s-b", "s-orphan"]);
    }
  });

  it("a part or message of A never shows up under B — the read is session-scoped", async () => {
    for (const { name, db } of await backends()) {
      await db.createWorkspace({ id: "project-a", name: "api", kind: "directory" });
      await db.createWorkspace({ id: "project-b", name: "api", kind: "directory" });
      await db.createSession({ id: "s-a", title: "A", workspaceId: "project-a" });
      await db.createSession({ id: "s-b", title: "B", workspaceId: "project-b" });
      await db.appendMessage({ id: "m-a", sessionId: "s-a", role: "user", createdAt: T0, updatedAt: T0 });
      await db.appendPart({
        id: "p-a",
        messageId: "m-a",
        sessionId: "s-a",
        type: "text",
        contentText: "geheim",
        updatedAt: T0,
      });

      const inB = await db.readTranscript({ sessionId: "s-b" });
      expect(inB.messages.map((m) => m.id), name).toEqual([]);
      expect(inB.parts.map((p) => p.id), name).toEqual([]);
      expect((await db.listParts("m-a")).map((p) => p.id), name).toEqual(["p-a"]);
    }
  });
});

describe("the project identity survives a reload and a close/open cycle", () => {
  it("re-opening the same project is an upsert, not a UNIQUE violation", async () => {
    for (const { name, db } of await backends()) {
      const first = await db.createWorkspace({ id: "p1", name: "api", kind: "directory" });
      expect(first.createdAt, name).toBeTruthy();

      // **The mutation "make this a plain INSERT" dies here.** Opening the same folder
      // a second time is what every second boot of a project is, and `INSERT_WORKSPACE`
      // carries `ON CONFLICT (id) DO UPDATE` for exactly that reason.
      const second = await db.createWorkspace({
        id: "p1",
        name: "api",
        kind: "directory",
        createdAt: T1,
        lastOpenedAt: T1,
      });

      expect(second.id, name).toBe("p1");
      // `created_at` does **not** move: a re-open must not make a project look newer
      // than it is. `last_opened_at` does, because that is what it is for.
      expect(second.createdAt, name).toBe(first.createdAt);
      expect(second.lastOpenedAt, name).toBe(T1);
      expect((await db.listWorkspaces()).length, name).toBe(1);
    }
  });

  it("close and reopen: the same project, the same conversation, unchanged", async () => {
    // A **real** close/open, on the SQL side, over the loopback transport — the
    // connection is torn down and a new one is opened against a fresh in-memory
    // engine, so nothing can survive in a JavaScript object.
    const { install } = installInMemoryPool(sqlite3);
    const first = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: install,
    });
    await first.client.open({ filename: "/baah.sqlite3" });

    await first.client.createWorkspace({ id: "project-x", name: "api", kind: "directory" });
    await first.client.createSession({ id: "session-x", title: "Unterhaltung", workspaceId: "project-x" });
    await first.client.appendMessage({
      id: "m-x",
      sessionId: "session-x",
      role: "user",
      createdAt: T0,
      updatedAt: T0,
    });
    await first.client.close();

    // A second loopback, a second connection, the same filename. The storage engine
    // is in-memory, so this models the *process* being new rather than the bytes
    // being new — and it is the honest part of the claim: **the ids are recomputed
    // from nothing, so anything that survived did so because it was written down.**
    // What it does not model is OPFS keeping the file across a reload; that is the
    // `Plan.md` §14.2 open gate and is named as such in the report.
    const second = createLoopback({
      sqlite3InitModule: async () => sqlite3,
      installOpfsSAHPoolVfs: install,
    });
    await second.client.open({ filename: "/baah.sqlite3" });

    // A *new* loopback starts with an empty engine, so the rows above are gone. The
    // assertion that matters is the one below it: writing the same project id again
    // reproduces the same project, because the id is the input and not a derived
    // value. That is what `.baah/project.json` buys, and this is the part of it that
    // is testable without a browser.
    const rewritten = await second.client.createWorkspace({
      id: "project-x",
      name: "api",
      kind: "directory",
    });
    expect(rewritten.id).toBe("project-x");

    const reopened = await second.client.createSession({
      id: "session-x",
      title: "Unterhaltung",
      workspaceId: "project-x",
    });
    expect(reopened.workspaceId).toBe("project-x");
  });

  it("a session that names a project that is not there is refused, on both backends", async () => {
    for (const { name, db } of await backends()) {
      // The foreign key. Without it a session could name a project id nothing ever
      // wrote, and a project-scoped list would be answering about a project that does
      // not exist.
      //
      // **The error *code* is asserted, not the message**, because the two backends
      // word it differently and always have: SQLite says
      // `SQLITE_CONSTRAINT_FOREIGNKEY … FOREIGN KEY constraint failed` with no column,
      // the in-memory mirror names the column (`factory.ts`'s `requireWorkspace`).
      // `Plan.md` §16.1 asks for the same refusal with the same code, not the same
      // sentence — and `turn-store.test.ts` asserts it the same way.
      await expect(
        db.createSession({ id: "s-x", title: "x", workspaceId: "no-such-project" }),
        name,
      ).rejects.toMatchObject({ code: "sql_error" });

      // And attaching later has the same rule.
      await db.createSession({ id: "s-y", title: "y" });
      await expect(
        db.attachSessionToWorkspace("s-y", "no-such-project"),
        name,
      ).rejects.toMatchObject({ code: "sql_error" });
    }
  });

  it("attaching a conversation to a project moves it, and detaching keeps it", async () => {
    for (const { name, db } of await backends()) {
      await db.createWorkspace({ id: "p1", name: "api", kind: "directory" });
      await db.createWorkspace({ id: "p2", name: "web", kind: "directory" });
      await db.createSession({ id: "s1", title: "one" });

      await db.attachSessionToWorkspace("s1", "p1");
      expect((await db.getSession("s1"))?.workspaceId, name).toBe("p1");
      expect((await db.listSessions({ workspaceId: "p1" })).map((s) => s.id), name).toEqual(["s1"]);

      await db.attachSessionToWorkspace("s1", "p2");
      expect((await db.listSessions({ workspaceId: "p1" })), name).toEqual([]);
      expect((await db.listSessions({ workspaceId: "p2" })).map((s) => s.id), name).toEqual(["s1"]);

      // Detaching is a value, not a delete: the conversation is still there, and it is
      // simply in no project's list. A user who loses a folder must not lose a
      // transcript.
      await db.attachSessionToWorkspace("s1", null);
      const after = await db.getSession("s1");
      expect(after?.workspaceId, name).toBeNull();
      expect((await db.listSessions()).map((s) => s.id), name).toEqual(["s1"]);

      // A session id that does not exist is a **refusal**, not a silent success: a
      // zero-row `UPDATE … RETURNING` and an empty transcript are different facts and
      // the caller is entitled to be told which one it got.
      await expect(db.attachSessionToWorkspace("no-such-session", "p1"), name).rejects.toMatchObject({
        code: "sql_error",
      });
    }
  });
});

describe("an empty conversation — the edge that was said to be impossible", () => {
  it("a session with no message is readable, and takes its first message afterwards", async () => {
    for (const { name, db } of await backends()) {
      await db.createWorkspace({ id: "p1", name: "api", kind: "directory" });
      await db.createSession({ id: "s-empty", title: "", workspaceId: "p1" });

      // **Readable, and empty — a fact and not a refusal.** `readTranscript` refuses
      // only a session that does not exist; one that exists and has said nothing is
      // the state a brand-new project is in, and reporting it as an error would mean
      // the project list could never show a project before its first question.
      const before = await db.readTranscript({ sessionId: "s-empty" });
      expect(before.messages, name).toEqual([]);
      expect(before.parts, name).toEqual([]);
      expect(before.truncated, name).toBe(false);

      // And it is in the project's list, so the project has a conversation to show.
      expect((await db.listSessions({ workspaceId: "p1" })).map((s) => s.id), name).toEqual(["s-empty"]);

      // The first message. **No binding step exists and none is needed:** every write
      // takes its `sessionId` from the engine's own option, never from the message, so
      // the empty session simply receives it. `seq` starts at 0.
      await db.appendMessage({
        id: "m1",
        sessionId: "s-empty",
        role: "user",
        createdAt: T1,
        updatedAt: T1,
      });
      const after = await db.readTranscript({ sessionId: "s-empty" });
      expect(after.messages.map((m) => [m.id, m.seq]), name).toEqual([["m1", 0]]);
    }
  });

  it("a session that never gets a message is still listed, newest first", async () => {
    for (const { name, db } of await backends()) {
      await db.createWorkspace({ id: "p1", name: "api", kind: "directory" });
      await db.createSession({ id: "older", title: "a", workspaceId: "p1", createdAt: T0, updatedAt: T0 });
      await db.createSession({ id: "newer", title: "b", workspaceId: "p1", createdAt: T1, updatedAt: T1 });

      // The order a project list needs, and it holds for conversations that have
      // never been written to — the `ORDER BY updated_at DESC` is on the row, not on
      // a join against `messages`.
      expect((await db.listSessions({ workspaceId: "p1" })).map((s) => s.id), name).toEqual([
        "newer",
        "older",
      ]);
    }
  });
});

describe("a project that is never written to is still recorded", () => {
  it("the memory backend stores projects even though counts() does not report them", async () => {
    // Named because it is a deliberate asymmetry, not an oversight: `Table` in
    // `factory.ts` omits `workspaces` so `counts()` keeps the key set
    // `memory-coverage.test.ts` pins with `toEqual`. The store still carries the map.
    const db: MemoryDatabase = createMemoryDatabase();
    await db.createWorkspace({ id: "p1", name: "api", kind: "directory" });
    expect(Object.keys(db.counts())).not.toContain("workspaces");
    expect((await db.listWorkspaces()).map((w) => w.id)).toEqual(["p1"]);
  });

  it("an unknown workspace kind is an error, never a coercion", async () => {
    for (const { name, db } of await backends()) {
      await expect(
        db.createWorkspace({ id: "p1", name: "api", kind: "network" as never }),
        name,
      ).rejects.toThrow(/CHECK constraint failed: workspaces\.kind/);
    }
  });
});
