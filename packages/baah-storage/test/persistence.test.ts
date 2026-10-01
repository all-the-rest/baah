/**
 * `storage.persist()` for the session database.
 *
 * ## What was missing
 *
 * `Plan.md` §1136 grounds the call in two real facts: Safari deletes script-created
 * data after seven days without interaction, and OPFS is best-effort by default.
 * The call existed in exactly one place — `baah-core/src/workspace/opfs.ts` — and
 * **that function is never called by the app**. So the protection guarded a path
 * nobody walked, and the thing it protects, the session database, asked for nothing.
 * Found by the independent PWA audit; every case below is a planted `StorageManager`,
 * never a real browser.
 *
 * ## Why the answer is a value and not an exception
 *
 * `denied` is the browser's answer, not a failure. A caller that treats it as an
 * exception either crashes a working app or wraps the ask in a `catch` and loses the
 * state — which is exactly how the protection went missing the first time. So the
 * tests pin the *value*, including for a rejecting `persist()`, and pin that
 * `openDatabase` still resolves.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import {
  closeDatabase,
  openDatabase,
  persistenceSettled,
  persistenceState,
} from "../src/client.ts";
import { installInMemoryPool, loadSqlite3 } from "./harness/sqlite.ts";
import { createLoopback, type Loopback } from "./harness/transport.ts";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

afterEach(async () => {
  // `active` is module state; a test that leaves a database open makes every later
  // one fail for the wrong reason. The stubbed `navigator` is per-test.
  await closeDatabase();
  vi.unstubAllGlobals();
});

function loopback(): Loopback {
  return createLoopback({
    sqlite3InitModule: async () => sqlite3,
    installOpfsSAHPoolVfs: installInMemoryPool(sqlite3).install,
  });
}

/**
 * A `StorageManager` with both calls counted, because *not* asking is as much a
 * behaviour as asking.
 */
function storageManager({ persisted, persist }: { persisted: boolean; persist: boolean | "throws" }) {
  const calls = { persisted: 0, persist: 0 };
  return {
    calls,
    manager: {
      persisted: async () => {
        calls.persisted += 1;
        return persisted;
      },
      persist: async () => {
        calls.persist += 1;
        if (persist === "throws") throw new DOMException("denied by policy", "NotAllowedError");
        return persist;
      },
    } satisfies Partial<StorageManager>,
  };
}

async function open(): Promise<void> {
  await openDatabase({ workerFactory: loopback().workerFactory, filename: "/persist.sqlite3" });
}

describe("storage persistence for the session database", () => {
  it("asks, and records granted", async () => {
    const { manager, calls } = storageManager({ persisted: false, persist: true });
    vi.stubGlobal("navigator", { storage: manager });

    await open();

    expect(calls.persisted).toBe(1);
    expect(calls.persist).toBe(1);
    expect(persistenceState()).toBe("granted");
  });

  it("does NOT re-ask when persistence is already granted - no needless prompt", async () => {
    // The whole reason `persisted()` exists. Calling `persist()` unconditionally
    // risks a permission dialog on every cold start, which is the single fastest way
    // to make a user deny permission forever - and the denial is sticky.
    const { manager, calls } = storageManager({ persisted: true, persist: true });
    vi.stubGlobal("navigator", { storage: manager });

    await open();

    expect(calls.persisted).toBe(1);
    expect(calls.persist).toBe(0);
    expect(persistenceState()).toBe("granted");
  });

  it("records denied when the browser says no", async () => {
    const { manager } = storageManager({ persisted: false, persist: false });
    vi.stubGlobal("navigator", { storage: manager });

    await open();

    expect(persistenceState()).toBe("denied");
  });

  it("records denied when persist() REJECTS, and the database still opens", async () => {
    // The important one. A rejecting `persist()` is the browser declining. If that
    // propagated, a perfectly working app would fail to start over a storage
    // permission - and the historical shape of this bug is exactly that: the ask
    // lived somewhere nothing called, so the state was lost rather than shown.
    const { manager } = storageManager({ persisted: false, persist: "throws" });
    vi.stubGlobal("navigator", { storage: manager });

    await expect(open()).resolves.toBeUndefined();
    expect(persistenceState()).toBe("denied");
  });

  it("records unavailable without a StorageManager, and does not fail", async () => {
    // A test environment, or a browser without the Storage API. Not a failure: the
    // database works, it is simply not protected, and the UI can say so.
    vi.stubGlobal("navigator", {});
    await expect(open()).resolves.toBeUndefined();
    expect(persistenceState()).toBe("unavailable");
    // Closed between the two: `active` is module state, and a second `openDatabase()`
    // while it is set fails with `database_already_open`. The first version of this
    // test forgot, and the failure read as if the absence of a StorageManager broke
    // the database - which is the opposite of what it asserts.
    await closeDatabase();

    vi.stubGlobal("navigator", undefined);
    await expect(open()).resolves.toBeUndefined();
    expect(persistenceState()).toBe("unavailable");
  });

  it("survives a navigator that throws on property access — and records why", async () => {
    // Defensive, and cheap: a hostile or partial `navigator` must not take the
    // database down with it.
    //
    // **The second assertion is the load-bearing one, and it exists because a
    // mutation survived the first version of this test.** Moving the property access
    // OUTSIDE the `try` leaves `openDatabase()` resolving perfectly — because the
    // caller fires the ask with `void`, and a rejection nobody awaits is silent. The
    // only observable difference is the STATE, which stayed `unknown`.
    //
    // So "it did not crash" was the wrong assertion: a crash-free path that swallows
    // the reason is not a passing path, it is an unexplained one.
    vi.stubGlobal("navigator", {
      get storage(): never {
        throw new Error("no storage here");
      },
    });
    await expect(open()).resolves.toBeUndefined();
    // Containment happened, and it left a trace: `denied`, not `unknown`. `unknown`
    // would mean the ask never produced an answer at all.
    await expect(persistenceSettled()).resolves.toBe("denied");
    expect(persistenceState()).toBe("denied");
  });
});

describe("the ask is not on the path between open and caller", () => {
  it("open() resolves while persist() is still pending", async () => {
    // This test failed the first time, and it was right to. It asserted a property my
    // own code did not have: I had written in the docstring that the ask must not be
    // awaited, and then awaited it - so a prompting `persist()` sat between "the
    // database is open" and "the caller has the database", which is the worst possible
    // moment for a permission dialog.
    //
    // The docstring and the code disagreed, and the test was the only thing that
    // noticed. **A comment is not a specification**, whatever its length.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager } = storageManager({ persisted: false, persist: true });
    let started = false;
    vi.stubGlobal("navigator", {
      storage: {
        ...manager,
        persist: async () => {
          started = true;
          await gate;
          return true;
        },
      },
    });

    // Resolves without the gate ever being released: that IS the property.
    await expect(open()).resolves.toBeUndefined();
    expect(started).toBe(true);
    expect(persistenceState()).toBe("unknown");

    release();
    await expect(persistenceSettled()).resolves.toBe("granted");
    expect(persistenceState()).toBe("granted");
  });

  it("asks on each open sequence, and never prompts once granted", async () => {
    // The second version of this test. The first asserted `persist()` is called once
    // ever, which is what a module-level cache gives you - and a cache that never
    // forgets is how a user who later installs the PWA is told "denied" forever, by a
    // value nobody re-checked.
    //
    // What actually protects against prompt-spam is `persisted()`: it is called every
    // time and does not prompt, so `persist()` - the one that can - is only reached
    // while persistence is genuinely absent.
    const { manager, calls } = storageManager({ persisted: false, persist: true });
    vi.stubGlobal("navigator", { storage: manager });
    await open();
    await closeDatabase();
    await open();
    await closeDatabase();
    await open();

    // Re-asked, and the cheap question leads every time.
    expect(calls.persisted).toBe(3);
    expect(calls.persist).toBe(3);
    // Closed before the next block. `active` is module state and `openDatabase()`
    // refuses a second call while it is set, so an unclosed database here fails the
    // next `open()` with `database_already_open` - which reads as "persistence broke
    // the database", the exact opposite of what this file is about.
    await closeDatabase();

    const already: ReturnType<typeof storageManager> = storageManager({
      persisted: true,
      persist: true,
    });
    vi.stubGlobal("navigator", { storage: already.manager });
    await open();
    await closeDatabase();
    await open();

    expect(already.calls.persisted).toBe(2);
    expect(already.calls.persist).toBe(0);
  });
});
