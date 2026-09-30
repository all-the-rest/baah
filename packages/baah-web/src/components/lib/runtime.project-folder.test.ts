/**
 * The composition root, and the three facts about it that are invisible in a
 * screenshot.
 *
 * ## What is under test
 *
 * `createAppRuntime` is where the project folder stops being a paragraph in a
 * docstring and becomes the thing the runtime reads and writes through. Nothing
 * here re-tests `createProjectFolderController` (its own file does that) or
 * `createFileSystemAccessWorkspace` (core does that). These are the wiring
 * claims, and each one has a failure that looks like nothing at all:
 *
 * 1. **The default is still the in-memory sandbox.** The 44 E2E scenarios run
 *    against it and there is no `showDirectoryPicker` in that environment; a
 *    folder as the default would make the whole suite unrunnable. If this ever
 *    flips, this test says so loudly.
 * 2. **`workspaceMode` is derived, not remembered.** It was the literal
 *    `"memory"` next to a workspace that could be something else, and the panel
 *    then described writes that were not happening — `Plan.md` §5.3's exact
 *    failure mode. A derived value cannot drift from the workspace.
 * 3. **A restore that fails does not stop the app.** `AGENTS.md` §5 forbids a
 *    silent `catch`, and the failure here is not cosmetic: an IndexedDB that
 *    refuses would otherwise reject out of `createAppRuntime` and land the user
 *    on the boot-failure screen, which says "the app could not start" when in
 *    fact everything works and only the folder is gone.
 */
import { describe, expect, it } from "vitest";

import { createMemoryWorkspace, type ProviderRegistry, type Workspace } from "@all-the.rest/baah-core";

import { createAppRuntime, type AppRuntimeOptions } from "./runtime.ts";
import { createEphemeralHandleStore, type ProjectFolderHandleStore } from "../../lib/project-folder.ts";
import type { KeyValueBackend } from "../../lib/storage.ts";

/**
 * A build of the app runtime with no browser anywhere in it.
 *
 * Everything the composition root touches outside pure code is injected —
 * `openDatabase` (the memory database answers the whole contract),
 * the two key/value backends, the tool set and the provider registry. The one
 * that was **missing** before this block is the folder store, and its absence is
 * what made `createAppRuntime` reach for IndexedDB in a context that has none.
 */
async function buildApp(overrides: Partial<AppRuntimeOptions> = {}) {
  const storage = await import("@all-the.rest/baah-storage");
  return createAppRuntime({
    storage,
    openDatabase: async (module) => module.createMemoryDatabase(),
    sessionId: "session-test",
    sessionStorage: memoryBackend(),
    settingsBackend: memoryBackend(),
    tools: [],
    // Never resolved: no test here sends a turn, and a provider is the one
    // dependency with no honest in-memory answer.
    registry: { resolve: async () => { throw new Error("not used"); } } as unknown as ProviderRegistry,
    folderStore: createEphemeralHandleStore("planted"),
    restoreFolder: false,
    ...overrides,
  });
}

function memoryBackend(): KeyValueBackend {
  const map = new Map<string, string>();
  return {
    read: () => map.get("k"),
    write: (raw) => {
      map.set("k", raw);
    },
    clear: () => {
      map.delete("k");
    },
    description: "planted",
  };
}

/** A store that fails every read, for the paths that must survive it. */
function hostileStore(): ProjectFolderHandleStore {
  return {
    read: async () => {
      throw new Error("IndexedDB refused");
    },
    write: async () => undefined,
    clear: async () => undefined,
    description: "hostile",
  };
}

/* ------------------------------------------------------------------ */

describe("the sandbox is still the default — this is the E2E suite's life", () => {
  it("builds an in-memory workspace and says so", async () => {
    const app = await buildApp();
    expect(app.workspaceMode).toBe("memory");
    expect(app.workspace.current.id).toBe("memory");
  });

  it("a test that injects a workspace gets that workspace, and no stored folder replaces it", async () => {
    // The condition is `options.workspace === undefined`, not just
    // `restoreFolder: false`. A test that handed in a workspace and still got a
    // leftover handle swapped in underneath it would be asserting against
    // something it never set up.
    const app = await buildApp({
      workspace: createMemoryWorkspace({ "a.txt": "hallo" }),
      folderStore: hostileStore(),
    });
    expect(app.workspace.current.id).toBe("memory");
    expect(await app.workspace.readText("a.txt")).toBe("hallo");
  });
});

/* ------------------------------------------------------------------ */

describe("workspaceMode is read off the workspace", () => {
  it("follows a swap instead of staying at the value it had at boot", async () => {
    const app = await buildApp();
    expect(app.workspaceMode).toBe("memory");

    // A stand-in for a picked folder: core's `describe()` is where the mode
    // comes from, so a workspace that reports `local-directory` must be shown as
    // such. The literal `"memory"` this replaced could not have done this.
    const folder = {
      ...createMemoryWorkspace(),
      id: "local:projekt",
      label: "projekt",
      describe: () => ({ kind: "local-directory", writable: true, label: "projekt" }),
    } as unknown as Workspace;
    app.workspace.swap(folder);

    expect(app.workspaceMode).toBe("local-directory");
  });
});

/* ------------------------------------------------------------------ */

describe("a folder that cannot be restored is said, not fatal", () => {
  it("a store that rejects produces a boot problem and leaves the sandbox in place", async () => {
    const app = await buildApp({ folderStore: hostileStore(), restoreFolder: true });

    // Not a rejection out of `createAppRuntime`: the app is fully usable, only
    // the folder is gone, and the message says exactly that.
    expect(app.workspaceMode).toBe("memory");
    expect(app.bootProblems.join(" ")).toContain(" Projektordner");
  });
});
