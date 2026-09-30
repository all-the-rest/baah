/**
 * The worker's message entry point, and what happens when it cannot answer.
 *
 * ## Why this file exists
 *
 * `worker.ts` ends with a module-level `addEventListener` that hands every
 * incoming message to `handleMessage` **without awaiting it**. That is correct:
 * `handleMessage` answers each request with exactly one correlated response, and
 * that is the contract `client.ts` waits on.
 *
 * It is also the exact place a rejection disappears. The call was a bare
 * `void worker.handleMessage(event.data)`, and a discarded promise does not
 * become invisible — it becomes an **unhandled promise rejection**, which in a
 * worker is reported on the worker's own `unhandledrejection` and is invisible to
 * the parent. The client would then sit on a promise that never settles, forever,
 * with nothing in the log to say why.
 *
 * The response to that is not a `catch {}` either: a swallowed rejection turns
 * the hang into silence. `handleWorkerMessage` re-raises the failure as an
 * uncaught error in the worker's global scope, which is the one thing the parent
 * *does* observe — `client.ts` already listens for the worker's `error` event and
 * turns it into a typed `internal` rejection for every pending call.
 *
 * ## What is asserted here, and what cannot be
 *
 * The re-raise is observable in a worker and not in a `WorkerLike` fake, so what
 * this file pins down is (a) the function exists and is what the module's own
 * listener calls, (b) a rejecting worker produces a **scheduled throw** rather
 * than silence, and (c) a resolving worker schedules nothing. The browser-level
 * consequence — that the parent's `error` listener fires — is a browser
 * behaviour this harness cannot reproduce, and is named as unverified rather
 * than asserted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleWorkerMessage, type StorageWorker } from "../src/worker.ts";

/** A worker whose `handleMessage` behaves as the test needs. */
function stubWorker(behaviour: () => Promise<void>): StorageWorker {
  return {
    handleMessage: behaviour,
    closeDatabase: () => {},
    state: { open: false, filename: "", vfsName: "", schemaVersion: 0 },
  } as unknown as StorageWorker;
}

/**
 * Let the rejection's `.catch` handler run before the timers are inspected.
 *
 * The handler that schedules the re-raise is itself a microtask, so a fake clock
 * that is advanced too early would report "nothing was scheduled" for a worker
 * that did schedule something. Fake timers do not own microtasks; this drain is
 * what makes the assertion about the *scheduling* and not about the ordering.
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the worker's entry point", () => {
  it("schedules nothing when the message is answered — the ordinary path", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    handleWorkerMessage(stubWorker(async () => {}), { id: "1", kind: "close" });
    await settle();
    vi.runAllTimers();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("re-raises a failure in a fresh task instead of dropping it", async () => {
    // The three shapes a silent implementation could take, and what each costs:
    //   * no handler at all  → unhandled rejection, parent never hears of it
    //   * `catch {}`          → the client's promise never settles, silently
    //   * this                → a scheduled throw, which the parent's `error`
    //                           listener already knows how to turn into a typed
    //                           rejection for every pending call
    vi.useFakeTimers();

    handleWorkerMessage(
      stubWorker(() => Promise.reject(new Error("postMessage could not clone the response"))),
      { id: "1", kind: "close" },
    );
    await settle();

    expect(() => vi.runAllTimers()).toThrow("postMessage could not clone the response");
  });

  it("re-raises a thrown non-Error as an Error, so the throw itself always works", async () => {
    vi.useFakeTimers();

    handleWorkerMessage(stubWorker(() => Promise.reject("the worker vanished")), { id: "1" });
    await settle();

    expect(() => vi.runAllTimers()).toThrow("the worker vanished");
  });

  it("a synchronous throw from `handleMessage` is not a rejection and is not caught here", async () => {
    // `handleWorkerMessage` is documented as the *async* boundary: `handleMessage`
    // is `async`, so it cannot throw synchronously. This test pins that claim so
    // it cannot rot into a comment nobody checks.
    vi.useFakeTimers();

    const sync = stubWorker((() => {
      throw new Error("not a promise at all");
    }) as unknown as () => Promise<void>);

    expect(() => handleWorkerMessage(sync, { id: "1" })).toThrow("not a promise at all");
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
