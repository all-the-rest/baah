/**
 * `.baah/project.json`: the project's own identity, and the exact extent of what the
 * app is allowed to write into a user's folder.
 *
 * Tested against `createMemoryWorkspace()` — no browser, no `showDirectoryPicker`, no
 * permission dance, and no `AGENTS.md` §2 test-harness exception. `resolveProjectId`
 * takes a `Workspace` precisely so that this file can exist.
 */

import { describe, expect, it } from "vitest";

import {
  PROJECT_DIRECTORY,
  PROJECT_ID_FORMAT,
  PROJECT_ID_PATH,
  resolveProjectId,
} from "../../src/workspace/file-system-access.ts";
import { createMemoryWorkspace, type Workspace } from "../../src/workspace.ts";

const T0 = "2026-01-01T00:00:00.000Z";

/**
 * The three methods `resolveProjectId` uses, over a map the test owns.
 *
 * **Not** `createMemoryWorkspace` with a spy: that workspace copies its seed into
 * private storage, so a "what did you write" spy has to be a second source of truth
 * for the same files. Here the map *is* the filesystem, and a second run is seeded
 * from it by hand — which is exactly what a second run does.
 */
function disk(seed: Readonly<Record<string, string>> = {}): {
  readonly files: Map<string, string>;
  readonly workspace: Pick<Workspace, "exists" | "readText" | "writeText">;
  readonly snapshot: () => Readonly<Record<string, string>>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    workspace: {
      exists: (path) => Promise.resolve(files.has(path)),
      readText: (path) => {
        const content = files.get(path);
        if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
        return Promise.resolve(content);
      },
      writeText: (path, text) => {
        files.set(path, text);
        return Promise.resolve();
      },
    },
    snapshot: () => Object.fromEntries(files),
  };
}

/** An `Error` whose `name` is what the code reads; a DOMException stand-in. */
function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("the project's write footprint, in full", () => {
  it("writes exactly one file, at exactly one path, and nothing else", async () => {
    const d = disk();
    const result = await resolveProjectId(d.workspace, { mint: () => "p-1", now: () => T0 });

    expect(result).toEqual({ kind: "resolved", projectId: "p-1", created: true });
    expect(d.snapshot()).toEqual({
      [PROJECT_ID_PATH]: `${JSON.stringify(
        { format: PROJECT_ID_FORMAT, id: "p-1", createdAt: T0 },
        null,
        2,
      )}\n`,
    });
    // The directory and the path, asserted separately: they are the two things a reader
    // of `Plan.md` §18.7 will look for, and `PROJECT_ID_PATH` is derived from the
    // directory, so a change to one is a change to both.
    expect(PROJECT_DIRECTORY).toBe(".baah");
    expect(PROJECT_ID_PATH).toBe(".baah/project.json");
  });

  it("writes nothing at all when the file is already there", async () => {
    const existing = `${JSON.stringify({ format: PROJECT_ID_FORMAT, id: "already", createdAt: T0 })}\n`;
    const d = disk({ [PROJECT_ID_PATH]: existing });

    const result = await resolveProjectId(d.workspace, { mint: () => "would-be-new" });

    expect(result).toEqual({ kind: "resolved", projectId: "already", created: false });
    // **Byte-identical.** A second open must not rewrite the file: a `writeText` here
    // would touch the user's disk on every single boot for no reason, and on a
    // read-only mount it would turn a working project into a broken one.
    expect(d.snapshot()[PROJECT_ID_PATH]).toBe(existing);
  });
});

describe("two runs, the same folder, the same project", () => {
  it("a second run reads the id the first one wrote, and never mints", async () => {
    // The whole point, and the reason the id is a file and not a browser-held value: a
    // run that finds the bytes already there arrives at the same id without asking
    // anything for it.
    const first = disk();
    const created = await resolveProjectId(first.workspace, { mint: () => "stable-id", now: () => T0 });
    expect(created).toEqual({ kind: "resolved", projectId: "stable-id", created: true });

    // The next run, over the same bytes. The mint throws if it is reached at all.
    const second = disk(first.snapshot());
    const read = await resolveProjectId(second.workspace, {
      mint: () => {
        throw new Error("the mint must not be reached for an existing project");
      },
    });

    expect(read).toEqual({ kind: "resolved", projectId: "stable-id", created: false });
  });

  it("two folders with the same name are two projects, because the id is not the name", async () => {
    // The counter-example to `` `local:${name}` ``. Both folders are called `api`; both
    // mint their own id; neither ever learns the other's — and the name appears nowhere
    // in the file.
    const a = disk();
    const b = disk();
    await resolveProjectId(a.workspace, { mint: () => "id-a", now: () => T0 });
    await resolveProjectId(b.workspace, { mint: () => "id-b", now: () => T0 });

    expect((await resolveProjectId(disk(a.snapshot()).workspace, { mint: () => "unused" })).projectId).toBe(
      "id-a",
    );
    expect((await resolveProjectId(disk(b.snapshot()).workspace, { mint: () => "unused" })).projectId).toBe(
      "id-b",
    );
    // And the written file carries no folder name at all, so renaming the folder
    // cannot change the project.
    expect(a.snapshot()[PROJECT_ID_PATH]).not.toContain("api");
  });
});

describe("a file that is not ours is never overwritten", () => {
  it("invalid JSON is reported as unstable and left alone", async () => {
    const d = disk({ [PROJECT_ID_PATH]: "{ not json" });
    const result = await resolveProjectId(d.workspace, { mint: () => "fresh" });

    expect(result.kind).toBe("unstable");
    // **The file is untouched.** Overwriting something we do not understand is how a
    // future version of the app loses its data to an older one.
    expect(d.snapshot()[PROJECT_ID_PATH]).toBe("{ not json");
    if (result.kind === "unstable") expect(result.reason).toContain(PROJECT_ID_PATH);
  });

  it("our format with an extra key is refused, because it may be a newer file", async () => {
    const newer = JSON.stringify({
      format: PROJECT_ID_FORMAT,
      id: "from-the-future",
      createdAt: T0,
      somethingWeDoNotKnow: true,
    });
    const d = disk({ [PROJECT_ID_PATH]: newer });

    // `strictObject` on the schema is what makes this an error rather than a partial
    // accept: a field we cannot read is a file written by something we are not.
    expect((await resolveProjectId(d.workspace, { mint: () => "fresh" })).kind).toBe("unstable");
    expect(d.snapshot()[PROJECT_ID_PATH]).toBe(newer);
  });

  it("a wrong format marker is refused", async () => {
    const d = disk({
      [PROJECT_ID_PATH]: JSON.stringify({ format: "something-else", id: "x", createdAt: T0 }),
    });
    expect((await resolveProjectId(d.workspace, { mint: () => "fresh" })).kind).toBe("unstable");
  });

  it("an empty id is refused — a project with a blank identity is not a project", async () => {
    const d = disk({
      [PROJECT_ID_PATH]: JSON.stringify({ format: PROJECT_ID_FORMAT, id: "", createdAt: T0 }),
    });
    expect((await resolveProjectId(d.workspace, { mint: () => "fresh" })).kind).toBe("unstable");
  });
});

describe("when the id cannot be persisted, the app says so", () => {
  it("a failing write yields an unstable id and a reason", async () => {
    const d = disk();
    const result = await resolveProjectId(
      {
        ...d.workspace,
        writeText: () => Promise.reject(namedError("NotAllowedError")),
      },
      { mint: () => "ephemeral" },
    );

    // A **separate kind**, not a `resolved` with a caveat. A caller rendering a
    // project list has to be able to say "this project's conversations are not
    // reachable from the next run", and it cannot say that about a `resolved`.
    expect(result.kind).toBe("unstable");
    if (result.kind === "unstable") {
      expect(result.projectId).toBe("ephemeral");
      expect(result.reason).toContain("NotAllowedError");
    }
  });

  it("a folder that cannot be inspected is `unstable`, and is NOT written to", async () => {
    // The distinction that matters: "I could not look" is not "it is not there".
    // Treating it as absent would turn a read failure into a write failure, and the
    // user would see two problems instead of one.
    const d = disk();
    let writes = 0;
    const result = await resolveProjectId(
      {
        exists: () => Promise.reject(namedError("NotFoundError")),
        readText: d.workspace.readText,
        writeText: (path, text) => {
          writes += 1;
          return d.workspace.writeText(path, text);
        },
      },
      { mint: () => "ephemeral" },
    );

    expect(result.kind).toBe("unstable");
    expect(writes).toBe(0);
    if (result.kind === "unstable") expect(result.reason).toContain("NotFoundError");
  });

  it("an unreadable file is `unstable` and not a write attempt either", async () => {
    const d = disk({ [PROJECT_ID_PATH]: "irrelevant" });
    let writes = 0;
    const result = await resolveProjectId(
      {
        exists: () => Promise.resolve(true),
        readText: () => Promise.reject(namedError("SecurityError")),
        writeText: (path, text) => {
          writes += 1;
          return d.workspace.writeText(path, text);
        },
      },
      { mint: () => "ephemeral" },
    );

    expect(result.kind).toBe("unstable");
    expect(writes).toBe(0);
  });
});

describe("the real workspace, so the tests are not only against a double", () => {
  it("works through `createMemoryWorkspace`, including the nested directory", async () => {
    // The double above has no idea what a path is. This one does, and it is what proves
    // that `.baah/project.json` is a *nested* write — the directory has to be created,
    // which is a capability `FileSystemDirectoryHandle.createWritable()` has and a flat
    // map does not.
    const workspace = createMemoryWorkspace();
    const result = await resolveProjectId(workspace, { mint: () => "real-one", now: () => T0 });

    expect(result.kind).toBe("resolved");
    expect(await workspace.exists(PROJECT_ID_PATH)).toBe(true);
    const content: unknown = JSON.parse(await workspace.readText(PROJECT_ID_PATH));
    expect(content).toEqual({ format: PROJECT_ID_FORMAT, id: "real-one", createdAt: T0 });
  });
});
