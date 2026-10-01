/**
 * The visible defect, and the identity that fixes it.
 *
 * `AppShell.tsx` used to call `app.workspace.swap(...)` and stop. The files changed and
 * the conversation did not, so **opening project B showed project A's history**. This
 * file measures the fix at the seam below the component, because the component is where
 * the bug was *seen* and the seam is where it was *caused*.
 *
 * What is asserted, and what is deliberately not:
 *
 * - two projects ⇒ two `workspaces` rows, two session ids, and A's messages absent from
 *   B's transcript (criterion 1 and 3, at the read port);
 * - a project id read from `.baah/project.json` is what keys the conversation, so two
 *   folders with the same **name** are two conversations (criterion 1);
 * - a switch during a turn is **refused**, because abandoning one leaves a
 *   `streaming` turn with nobody renewing its heartbeat.
 */

import { describe, expect, it } from "vitest";

import { createMemoryDatabase, type StorageDatabase } from "@all-the.rest/baah-storage";
import { createMemoryWorkspace } from "@all-the.rest/baah-core";

import { createMemoryBackend } from "../../lib/storage.ts";
import { SANDBOX_PROJECT_ID, type ProjectSessionStores } from "../../lib/ids.ts";
import type { ProjectIdentity } from "../../lib/project-folder.ts";
import { fakeRegistry, gate, mockModel } from "../../runtime/testing.ts";
import { createAppRuntime, type AppRuntime } from "./runtime.ts";

/** A `ProjectIdentity` for a folder, without a browser anywhere near it. */
function projectOf(projectId: string, name: string): ProjectIdentity {
  // `id` is the project id, which is the property every consumer reads — a real
  // `FileSystemAccessWorkspace` sets it from `.baah/project.json`, and here it is
  // stated directly. `ProjectIdentity.workspace` is typed as the base `Workspace` so
  // that this is a construction and not a cast.
  const workspace = createMemoryWorkspace({ "readme.md": `# ${name}` });
  return {
    projectId,
    name,
    stable: true,
    problem: undefined,
    workspace: { ...workspace, id: projectId, label: name },
  };
}

/** Two stores the test keeps, so a "reload" is a real second read. */
function stores(): ProjectSessionStores {
  return { projects: createMemoryBackend(), legacy: createMemoryBackend() };
}

/**
 * Poll until `ready`, with a bound.
 *
 * **A bound, not a hang.** A `while (!ready) await tick()` would turn a broken build
 * into a test run that never finishes, and the AGENTS.md rule about a hung CI is worth
 * more here than the convenience of not counting.
 */
async function waitUntil(ready: () => boolean, ticks = 200): Promise<boolean> {
  for (let attempt = 0; attempt < ticks; attempt += 1) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return ready();
}

async function appOver(
  database: StorageDatabase,
  projectSessions: ProjectSessionStores,
  projectId: string,
): Promise<AppRuntime> {
  return createAppRuntime({
    openDatabase: async () => database,
    projectSessions,
    // The sandbox's own workspace is injected, so the boot path does not look for a
    // folder in IndexedDB; `sessionProjectId` is what says which project this is.
    workspace: createMemoryWorkspace(),
    restoreFolder: false,
    project: { projectId, name: projectId, kind: "directory" },
    settingsBackend: createMemoryBackend(),
  });
}

describe("two projects, two conversations", () => {
  it("the same folder name twice is two projects and two conversations", async () => {
    const database = createMemoryDatabase();
    const projectSessions = stores();

    const a = projectOf("uuid-from-project-a", "api");
    const b = projectOf("uuid-from-project-b", "api");
    // **Same display name, different ids** — the case `` `local:${name}` `` could not
    // express at all.
    expect(a.name).toBe(b.name);
    expect(a.projectId).not.toBe(b.projectId);

    const first = await appOver(database, projectSessions, a.projectId);
    const second = await appOver(database, projectSessions, b.projectId);

    expect(first.project.projectId).toBe("uuid-from-project-a");
    expect(second.project.projectId).toBe("uuid-from-project-b");
    expect(second.runtime.sessionId).not.toBe(first.runtime.sessionId);

    const projects = await database.listWorkspaces();
    expect(projects.map((p) => p.id).sort()).toEqual(["uuid-from-project-a", "uuid-from-project-b"]);

    // A's conversation is in A's list and not in B's. The criterion is about what a
    // user can *see*, and this is the query a project list will run.
    const inA = await database.listSessions({ workspaceId: a.projectId });
    const inB = await database.listSessions({ workspaceId: b.projectId });
    expect(inA.map((s) => s.id)).toEqual([first.runtime.sessionId]);
    expect(inB.map((s) => s.id)).toEqual([second.runtime.sessionId]);
  });

  it("a message written in A never appears in B's transcript", async () => {
    const database = createMemoryDatabase();
    const projectSessions = stores();
    const a = await appOver(database, projectSessions, "uuid-a");
    const b = await appOver(database, projectSessions, "uuid-b");

    await database.appendMessage({
      id: "m-in-a",
      sessionId: a.runtime.sessionId,
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const readA = await a.runtime.readTranscript();
    const readB = await b.runtime.readTranscript();
    expect(readA.kind === "ok" ? readA.transcript.messages.map((m) => m.id) : readA.kind).toEqual(["m-in-a"]);
    expect(readB.kind === "ok" ? readB.transcript.messages : readB.kind).toEqual([]);
  });

  it("the same project id twice is the same conversation, across a reload", async () => {
    const database = createMemoryDatabase();
    const projectSessions = stores();

    const first = await appOver(database, projectSessions, "uuid-stable");
    const second = await appOver(database, projectSessions, "uuid-stable");

    // **The reload claim, at the level a unit test can reach.** The same stores, the
    // same database, the same project id ⇒ the same session. The project id is what
    // makes it the same project, and it comes from the folder's own file — a value the
    // browser did not have to remember.
    expect(second.runtime.sessionId).toBe(first.runtime.sessionId);
    expect(second.project.projectId).toBe(first.project.projectId);
    // And the project row was written once, not twice: `createWorkspace` is an upsert.
    expect((await database.listWorkspaces()).map((p) => p.id)).toEqual(["uuid-stable"]);
  });
});

describe("the sandbox is a project too", () => {
  it("a boot with no folder gets the reserved sandbox project", async () => {
    const database = createMemoryDatabase();
    const app = await createAppRuntime({
      openDatabase: async () => database,
      projectSessions: stores(),
      workspace: createMemoryWorkspace(),
      restoreFolder: false,
      settingsBackend: createMemoryBackend(),
    });

    expect(app.project.projectId).toBe(SANDBOX_PROJECT_ID);
    expect(app.project.kind).toBe("opfs");
    // The row exists and says `opfs`, so a project list does not have to special-case
    // "the one without a folder".
    const [row] = await database.listWorkspaces();
    expect(row?.kind).toBe("opfs");
    expect(row?.id).toBe(SANDBOX_PROJECT_ID);
  });

  it("a legacy single-session pointer is adopted once, by the sandbox project", async () => {
    const database = createMemoryDatabase();
    const projectSessions = stores();
    // The pre-project world: one value under `baah.session.v1`.
    projectSessions.legacy.write(JSON.stringify({ sessionId: "session-legacy", at: "2026-01-01T00:00:00.000Z" }));

    const sandbox = await appOver(database, projectSessions, SANDBOX_PROJECT_ID);
    // Adopted, not replaced — otherwise every existing browser would open an empty
    // project and the old conversation would be unreachable.
    expect(sandbox.runtime.sessionId).toBe("session-legacy");

    // And a **folder** does not adopt it: a pre-project pointer cannot be attributed
    // to a folder, and guessing would move a conversation into an unrelated project.
    const folder = await appOver(database, projectSessions, "uuid-a-folder");
    expect(folder.runtime.sessionId).not.toBe("session-legacy");
  });
});

describe("switching while a turn is running is refused", () => {
  it("refuses, and says why, rather than abandoning a streaming turn", async () => {
    const database = createMemoryDatabase();
    // A model that waits on a gate the test never opens, so the turn is genuinely **in
    // flight** for the whole assertion. Without it `send()` would finish before the
    // switch was attempted, the status would be `idle`, and the guard would never be
    // exercised — the test would pass having proved nothing, which is the shape this
    // file exists to avoid. `gate()` is `testing.ts`'s own answer to exactly this.
    const held = gate();
    const { registry } = fakeRegistry({ model: mockModel([], { gate: held.promise }) });
    const app = await createAppRuntime({
      openDatabase: async () => database,
      projectSessions: stores(),
      workspace: createMemoryWorkspace(),
      restoreFolder: false,
      project: { projectId: "uuid-a", name: "a", kind: "directory" },
      settingsBackend: createMemoryBackend(),
      registry,
    });
    app.settings.update({ provider: { vendor: "openai", model: "mock" } });
    app.settings.setApiKey("openai", "sk-test-not-a-real-key");

    const turn = app.runtime.send({ prompt: "eine Frage" });
    // **Wait for the fact, do not hope for it.** `send` is async all the way down to
    // the provider — settings, provider resolution, the model call — so a single
    // `setTimeout(0)` reads `idle` often enough to make this test flaky (measured: 1 of
    // 4 runs). Polling for the state the test needs, with a bound, turns a race into a
    // precondition; the assertion after it is then about the guard and nothing else.
    const running = await waitUntil(() => app.runtime.getState().status !== "idle");
    expect(running, "the turn never left `idle`, so the guard was never reached").toBe(true);
    expect(app.runtime.getState().status).toBe("running");

    const result = await app.switchProject({ identity: projectOf("uuid-b", "web") });

    // **Strictly refused.** An `if (kind !== "switched")` here would have passed on a
    // switch, and the guard would be untested.
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toMatch(/Turn/);
    // The session did not change underneath the running turn — the failure the guard
    // exists to prevent, and the one that would leave a `streaming` turn whose heartbeat
    // nobody renews.
    expect(app.project.projectId).toBe("uuid-a");

    // Let the turn finish, or the test leaves a pending promise behind.
    held.open();
    await turn.catch(() => undefined);
  });

  it("switching to the project already open is a no-op that reports success", async () => {
    const database = createMemoryDatabase();
    const app = await appOver(database, stores(), "uuid-a");
    const identity = projectOf("uuid-a", "api");

    const result = await app.switchProject({ identity });

    // Not an error and not a rebuild: a second click on the same folder hands back the
    // app the caller already had, so React is not re-subscribed to a new object for
    // nothing.
    expect(result.kind).toBe("switched");
    if (result.kind === "switched") expect(result.app).toBe(app);
  });
});

describe("the switch keeps one database and two sessions", () => {
  it("the new app shares the database and the old rows are still there", async () => {
    const database = createMemoryDatabase();
    const app = await appOver(database, stores(), "uuid-a");
    await database.appendMessage({
      id: "m-a",
      sessionId: app.runtime.sessionId,
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await app.switchProject({ identity: projectOf("uuid-b", "web") });

    expect(result.kind).toBe("switched");
    if (result.kind !== "switched") return;
    // **One connection.** `opfs-sahpool` allows exactly one per origin, so the switch
    // hands the open handle to the new runtime instead of opening a second one; a
    // `StorageDatabase` identity is how that is observable from here.
    expect(result.app.database).toBe(database);
    expect(result.app.runtime.sessionId).not.toBe(app.runtime.sessionId);
    // The old conversation is untouched and still reachable by its own project.
    const old = await database.readTranscript({ sessionId: app.runtime.sessionId });
    expect(old.messages.map((m) => m.id)).toEqual(["m-a"]);
  });
});
