/**
 * The project-folder wiring, and the one property that is easy to break silently.
 *
 * ## What is under test
 *
 * {@link createProjectFolderController} is the piece `AGENTS.md` §2a says was
 * missing: the picker, the place the handle is kept, and the rule about *when*
 * asking for permission is allowed. `createFileSystemAccessWorkspace` itself was
 * already written and unit-tested in `baah-core`; nothing here re-tests it.
 *
 * ## The load-bearing test is the negative one
 *
 * `restore()` — the cold-start path — must **never** call `requestPermission`.
 * A grant does not survive a cold start (Chrome: "until all tabs for its origin
 * are closed. Once a tab is closed, the site loses all access"), so every load
 * finds `queryPermission` answering `"prompt"`. The tempting line is to make the
 * app "just work" by asking anyway, and it fails in the worst possible way: the
 * browser rejects a `requestPermission` without transient user activation
 * (`SecurityError`), or — where it does prompt — the user is shown a permission
 * dialog they did not ask for and dismisses it. The folder then looks like it was
 * never connected, and the honest sentence ("press the button again") is gone.
 *
 * So the fake handle below **counts** its `requestPermission` calls, and the test
 * asserts the count is zero. A fake that merely returns a value cannot fail this
 * way, which is the whole reason it counts.
 */
import { describe, expect, it } from "vitest";

import {
  createProjectFolderController,
  isDirectoryPickerAvailable,
  type ProjectFolderHandleStore,
  type ProjectFolderState,
} from "./project-folder.ts";

/* ------------------------------------------------------------------ */
/* The planted material                                                */
/* ------------------------------------------------------------------ */

interface CallLog {
  query: number;
  request: number;
}

/**
 * A `FileSystemDirectoryHandle` that is structurally real and behaviourally a
 * spy.
 *
 * It satisfies `isDirectoryHandleLike` (the four members core checks) and counts
 * every permission call, so the assertion is on **what was called**, not on what
 * the code returned. The permission state is a parameter, because the two paths
 * must be checked against the two answers a browser actually gives.
 */
function plantedHandle(log: CallLog, permission: "granted" | "prompt" | "denied"): FileSystemDirectoryHandle {
  // The full `FileSystemDirectoryHandle` surface, because `tsc` checks the
  // fixture too: a fake with only the four members core inspects would be a
  // compile error, and a fake that *did* compile while being structurally wrong
  // is exactly what would make every assertion above pass for the wrong reason.
  const handle = {
    kind: "directory" as const,
    name: "projekt",
    async queryPermission() {
      log.query += 1;
      return permission;
    },
    async requestPermission() {
      log.request += 1;
      return "granted" as const;
    },
    async getDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
      return handle;
    },
    async getFileHandle(): Promise<FileSystemFileHandle> {
      throw new Error("not used by this test");
    },
    async removeEntry(): Promise<void> {
      throw new Error("not used by this test");
    },
    // Present for the type, never called: `isDirectoryHandleLike` checks four
    // members, and the walker in `baah-core` is not exercised here. The iterator
    // members yield `[name, handle]` pairs in the DOM lib and nothing calls
    // them, so they are declared through the same cast as the rest rather than
    // spelled out — a fake that satisfies `tsc` but not the runtime is still a
    // fake, and the assertions below are on the four members core really reads.
    isSameEntry: async (other: FileSystemHandle) => other === handle,
    async *entries(): AsyncIterableIterator<never> {
      return;
    },
    async *keys(): AsyncIterableIterator<string> {
      return;
    },
    async *values(): AsyncIterableIterator<never> {
      return;
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<never> {
      return handle.entries();
    },
    async resolve(): Promise<string[] | null> {
      return null;
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

/**
 * Install a `showDirectoryPicker` on `globalThis` for the duration of `body`.
 *
 * `exactOptionalPropertyTypes` means the property has to be assigned as
 * `undefined` rather than deleted, and the restore has to be in a `finally` —
 * a leaked stub would make every later test in this file pass against a fake.
 */
async function withPicker<T>(picker: typeof globalThis.showDirectoryPicker, body: () => Promise<T>): Promise<T> {
  // `before` is typed as a function but is `undefined` in vitest, which has no
  // File System Access API. The restore therefore has to write back the value as
  // it was, including the absent case — assigning a captured `undefined` is what
  // keeps this helper from leaving a stub behind for a later test.
  const before = globalThis.showDirectoryPicker;
  globalThis.showDirectoryPicker = picker;
  try {
    return await body();
  } finally {
    if (before === undefined) delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    else globalThis.showDirectoryPicker = before;
  }
}

/** A store backed by a variable, so a test can assert what was written. */
function plantedStore(initial?: FileSystemDirectoryHandle): ProjectFolderHandleStore & {
  readonly written: () => readonly FileSystemDirectoryHandle[];
  readonly cleared: () => number;
} {
  let held = initial;
  const written: FileSystemDirectoryHandle[] = [];
  let cleared = 0;
  return {
    read: async () => held,
    write: async (handle) => {
      held = handle;
      written.push(handle);
    },
    clear: async () => {
      held = undefined;
      cleared += 1;
    },
    description: "planted",
    written: () => written,
    cleared: () => cleared,
  };
}

/* ------------------------------------------------------------------ */
/* The cold start                                                      */
/* ------------------------------------------------------------------ */

describe("the cold start reuses a grant and never asks for one", () => {
  it("does NOT call requestPermission, and says the button has to be pressed again", async () => {
    // Planted material: a stored handle whose grant has lapsed, which is the
    // state of every real cold start.
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "prompt");
    const store = plantedStore(handle);
    const controller = createProjectFolderController({ store });

    const state = await controller.restore();

    // The assertion the whole module exists for.
    expect(log.request, "restore() must never call requestPermission").toBe(0);
    expect(log.query, "restore() asks with queryPermission, which is free").toBeGreaterThan(0);

    // …and the honest outcome, not a claim of access.
    expect(state.kind).toBe("needs-gesture");
    expect(controller.current().kind).toBe("needs-gesture");
  });

  it("reuses a surviving grant without a picker and without a prompt", async () => {
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "granted");
    let pickerOpened = 0;
    const controller = createProjectFolderController({
      store: plantedStore(handle),
      pick: async () => {
        pickerOpened += 1;
        return handle;
      },
    });

    const state = await controller.restore();

    expect(state.kind).toBe("connected");
    expect(pickerOpened, "a surviving grant is reused, not re-picked").toBe(0);
    expect(log.request).toBe(0);
  });

  it("no stored handle is `no-handle`, which the UI must not call `needs-gesture`", async () => {
    const controller = createProjectFolderController({ store: plantedStore() });
    expect((await controller.restore()).kind).toBe("no-handle");
  });
});

/* ------------------------------------------------------------------ */
/* The gesture                                                         */
/* ------------------------------------------------------------------ */

describe("picking is the only path that may ask", () => {
  it("opens the picker, asks, and persists the handle", async () => {
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "prompt");
    const store = plantedStore();
    let pickerOpened = 0;
    const controller = createProjectFolderController({
      store,
      pick: async () => {
        pickerOpened += 1;
        return handle;
      },
    });

    const state = await controller.pick();

    expect(pickerOpened).toBe(1);
    // `pick` runs inside the click handler, so asking is legal — and the fake
    // grants it, which is what a real gesture produces.
    expect(state.kind).toBe("connected");
    expect(log.request, "the gesture path is where requestPermission belongs").toBeGreaterThan(0);
    expect(store.written()).toEqual([handle]);
  });

  it("a dismissed picker throws a typed error and stores nothing", async () => {
    const store = plantedStore();
    const controller = createProjectFolderController({
      store,
      pick: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });

    await expect(controller.pick()).rejects.toThrow();
    expect(store.written(), "a refused pick must not leave a handle behind").toEqual([]);
  });

  it("refuses to build a workspace from something that is not a handle", async () => {
    // The structured clone that did not survive. Handing this to core would be a
    // `zod` throw with no German sentence attached.
    const store = plantedStore();
    const controller = createProjectFolderController({
      store,
      pick: async () => ({ kind: "directory" }) as unknown as FileSystemDirectoryHandle,
    });

    const state = await controller.pick();
    expect(state.kind).toBe("unsupported");
    // …and the dead entry is dropped, or the button could never fix it.
    expect(store.cleared()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The state vocabulary                                                */
/* ------------------------------------------------------------------ */

describe("the state union cannot say 'connected' when nothing is connected", () => {
  it("carries the workspace only in the one state that is usable", async () => {
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "denied");
    const controller = createProjectFolderController({ store: plantedStore(handle) });

    const state = await controller.restore();
    expect(state.kind).toBe("denied");
    // The compile-time half is the `switch` below; the runtime half is that a
    // `denied` state has no `workspace` key at all.
    expect(Object.hasOwn(state, "workspace")).toBe(false);
  });

  it("release() forgets the folder and returns to the fallback", async () => {
    const log: CallLog = { query: 0, request: 0 };
    const store = plantedStore(plantedHandle(log, "granted"));
    const controller = createProjectFolderController({ store });

    expect((await controller.release()).kind).toBe("no-handle");
    expect(store.cleared()).toBe(1);
  });

  it("release() on an already-empty controller notifies nobody", async () => {
    // **Measured defect this test exists for.** `release()` used to call
    // `state.set({ kind: "no-handle" })` unconditionally. `createObservable.set`
    // is a no-op only on `Object.is` equality, and a fresh object literal is
    // never equal — so every `release()` notified a `useSyncExternalStore`
    // subscriber that nothing had changed, the shell re-rendered, and
    // `isConfigured` re-evaluated. The observable effect was that choosing a
    // workspace in the wizard made the wizard **replace itself with the
    // workbench**, before its own last step rendered: 20 of the 44 E2E
    // scenarios died on a `baah-wizard-finish` locator that no longer existed.
    //
    // A subscriber count is the only thing that can see this — the returned state
    // is `"no-handle"` either way, so asserting on the value passes in both
    // worlds.
    const controller = createProjectFolderController({ store: plantedStore() });
    let notified = 0;
    const unsubscribe = controller.state.subscribe(() => {
      notified += 1;
    });

    await controller.release();

    expect(notified, "a release that changes nothing must not notify").toBe(0);
    unsubscribe();

    // …and a release that *does* change something still notifies, so the fix is
    // not "stop notifying".
    const log: CallLog = { query: 0, request: 0 };
    const attached = createProjectFolderController({ store: plantedStore(plantedHandle(log, "granted")) });
    await attached.restore();
    let changed = 0;
    attached.state.subscribe(() => {
      changed += 1;
    });
    await attached.release();
    expect(changed).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The self-check: does the reader see what it is meant to catch?       */
/* ------------------------------------------------------------------ */

describe("the spy is a spy — without this the tests above could pass vacuously", () => {
  it("the planted handle really satisfies core's structural check", async () => {
    // If `isDirectoryHandleLike` rejected the fake, every "connected" assertion
    // above would be passing for the wrong reason (everything would be
    // `unsupported`) and the suite would still be green.
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "granted");
    const { isDirectoryHandleLike } = await import("@all-the.rest/baah-core/workspace/file-system-access");
    expect(isDirectoryHandleLike(handle)).toBe(true);

    const controller = createProjectFolderController({ store: plantedStore(handle) });
    expect((await controller.restore()).kind).toBe("connected");
  });

  it("a handle whose permission API is absent is `unsupported`, not a crash", async () => {
    // OPFS handles have no `queryPermission`. Reaching that branch is what stops
    // a `restore()` from throwing inside the boot path.
    const bare = {
      kind: "directory" as const,
      name: "opfs-root",
      async getDirectoryHandle() {
        return bare;
      },
      async getFileHandle(): Promise<FileSystemFileHandle> {
        throw new Error("unused");
      },
      async removeEntry(): Promise<void> {
        throw new Error("unused");
      },
    } as unknown as FileSystemDirectoryHandle;

    const controller = createProjectFolderController({ store: plantedStore(bare) });
    const state = await controller.restore();
    expect(state.kind).toBe("unsupported");
  });

  it("the default picker reads `globalThis` per call, not at import", async () => {
    // A module-level capture would make this test fail and, worse, would make
    // the picker impossible to stub in the app's own tests. Same rule as
    // `lib/storage.ts` and `localStorage`.
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "granted");
    await withPicker(
      async () => handle,
      async () => {
        const controller = createProjectFolderController({ store: plantedStore() });
        expect((await controller.pick()).kind).toBe("connected");
      },
    );
  });

  it("the availability check is honest when the API is absent", async () => {
    // Firefox and Safari have no `showDirectoryPicker` (`Plan.md` §14.1's table),
    // and the panel disables the button on the strength of this one function. The
    // global is declared non-optional — the compiler cannot narrow a global across
    // statements — so a truthiness test here would report a capability that does
    // not exist, and the button would be offered to a browser that cannot honour
    // it. That is §5.3's exact failure in reverse: a claim the app cannot back.
    expect(isDirectoryPickerAvailable()).toBe(false);
    await withPicker(
      async () => plantedHandle({ query: 0, request: 0 }, "granted"),
      async () => {
        expect(isDirectoryPickerAvailable()).toBe(true);
      },
    );
    expect(isDirectoryPickerAvailable(), "the stub must not leak past the helper").toBe(false);
  });

  it("`showDirectoryPicker` is asked for readwrite, because a read grant cannot save", async () => {
    // A regression guard on the one option that is easy to drop: with the
    // default (`read`), the folder attaches and every write tool then fails on a
    // folder the panel says writes to the disk. Core's `describe().writable` is
    // derived from the last permission answer, so a read grant would even make
    // the panel *claim* it.
    const log: CallLog = { query: 0, request: 0 };
    const handle = plantedHandle(log, "granted");
    let seen: { readonly mode?: "read" | "readwrite" } | undefined;
    await withPicker(
      async (options) => {
        seen = options;
        return handle;
      },
      async () => {
        const controller = createProjectFolderController({ store: plantedStore() });
        await controller.pick();
      },
    );
    expect(seen?.mode).toBe("readwrite");
  });
});

/* ------------------------------------------------------------------ */
/* The states the UI has to be able to say out loud                    */
/* ------------------------------------------------------------------ */

describe("every state renders without a claim it cannot back", () => {
  it("`needs-gesture` is distinct from `no-handle`", () => {
    // The two are different facts and the UI says different things: one is "your
    // folder is still selected, press the button", the other is "pick a folder".
    const states: ProjectFolderState[] = [
      { kind: "no-handle" },
      { kind: "needs-gesture", label: "projekt" },
      { kind: "denied", label: "projekt" },
      { kind: "unsupported", reason: "x" },
    ];
    expect(states.map((s) => s.kind)).toEqual(["no-handle", "needs-gesture", "denied", "unsupported"]);
  });
});
