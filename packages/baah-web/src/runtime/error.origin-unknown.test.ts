/**
 * `src/runtime/index.ts` claimed a test file pinned both halves of
 * `toRuntimeError`. No file matching `*origin*` was in the repo. This is it, and it
 * exists because **both** halves survived 128/128 without it:
 *
 * | mutation                                                | before this file |
 * | ------------------------------------------------------- | ---------------- |
 * | forward `error.message` in the redaction branch (M13)     | 128/128 green    |
 * | classify the origin from the message text (M12)           | 128/128 green    |
 * | drop the `origin` argument from `fail()` (the shipped bug) | **it compiled** — `FALLBACK_CODE[undefined]` is `undefined`, so a database failure reached the user as `code: undefined` and the literal text `"Error: undefined"` |
 *
 * ## The two halves, and why they are tested together
 *
 * They are two halves of one function, and either alone is a bug:
 *
 * 1. **Redaction.** A bare `Error` reaching the fallback branch contributes only
 *    its class name. The reason is measured, not theoretical: Google's 401 quotes
 *    the key back verbatim, and a `RuntimeError` is rendered on screen *and*
 *    logged. So the message must not carry the key — nor may any other value the
 *    runtime hands out, because `state.lastError` and the `runtime-error` event
 *    carry the same string to a second and a third consumer.
 * 2. **Classification.** The `code` comes from the origin the **call site** passed,
 *    not from the message. A storage failure during a checkpoint is `turn-failed`;
 *    reporting it as `settings-write-failed` sends the user to a settings screen
 *    where nothing is wrong, while the actual fault — a full disk, a closed
 *    database — is never looked at.
 *
 * Testing them apart is what let both be removed. The redaction assertions do not
 * check which `code` came out, and the classification assertions would happily pass
 * on a code while the message quoted the key.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createMemoryWorkspace,
  defineTool,
  ProviderRegistry,
  type TurnStore,
} from "@all-the.rest/baah-core";
import type { LanguageModel } from "ai";

import { createSettingsStore } from "../lib/settings-store.ts";
import { createMemoryBackend, type KeyValueBackend } from "../lib/storage.ts";
import type { SettingsSnapshot } from "../lib/settings.ts";

import { createRuntime, RuntimeError } from "./index.ts";
import type { RuntimeEvent } from "./events.ts";
import * as guard from "./guard.ts";
import { RecordingTurnStore, fakeRegistry, finishPart, mockModel, textParts } from "./testing.ts";

const SESSION = "session-1";

/**
 * A key in the exact shape the real thing leaks in.
 *
 * `sk-live-…` belongs to nobody and is stored nowhere; it is here because the
 * assertion has to be about a *plausible* string. A test using `"SECRET"` would
 * also pass against a runtime that redacts only uppercase tokens.
 */
const KEY = "sk-live-4f9a1c2b7e8d";

/**
 * Google's 401 shape: it quotes the key back verbatim. See `providers/probe.ts`.
 *
 * A `TypeError`, which is what a browser's CORS-blocked `fetch` produces — so this
 * is the *likely* class, and it is the one the app most needs to redact.
 */
function keyBearingError(): TypeError {
  return new TypeError(`401 from Google: key ${KEY} is invalid`);
}

/**
 * The same leak from a plain `Error`.
 *
 * Separate from the `TypeError` above on purpose, and the reason is a mutation that
 * survived: narrowing the redaction to `if (error instanceof TypeError)` and letting
 * every other `Error` forward its message left all 157 tests green. The class is an
 * implementation detail of *which* leak happened to be modelled first — a
 * `DOMException` from a full disk, a plain `Error` from a Worker, a `RangeError` from
 * a bad parse can all carry provider text. The rule is "never", and "never" has to
 * be tested on a class the code does not single out.
 */
function keyBearingPlainError(): Error {
  return new Error(`sqlite: the request with key ${KEY} was rejected`);
}

const noopTool = defineTool<{ value: string }, string>({
  id: "noop",
  description: "echoes its input",
  access: "read",
  inputSchema: z.object({ value: z.string() }),
  execute: async (_context, input) => input.value,
});

/** A settings snapshot for `vendor`, with a key stored under its slot. */
function settingsWith(vendor = "openai", model = "gpt-4o-mini"): SettingsSnapshot {
  const store = createSettingsStore({ backend: createMemoryBackend() });
  store.update({ provider: { vendor, model } });
  store.setApiKey(vendor, "sk-test-not-a-real-key");
  return store.get();
}

function harness(
  options: {
    readonly store?: TurnStore;
    readonly settings?: ReturnType<typeof createSettingsStore>;
    readonly registry?: ProviderRegistry;
  } = {},
): { runtime: ReturnType<typeof createRuntime>; events: RuntimeEvent[] } {
  const { registry } = fakeRegistry({
    model: mockModel([[...textParts("t0", "hello"), finishPart()]]),
  });

  const runtime = createRuntime({
    store: options.store ?? new RecordingTurnStore().store,
    workspace: createMemoryWorkspace(),
    settings: options.settings ?? createSettingsStore({ backend: createMemoryBackend(), initial: settingsWith() }),
    registry: options.registry ?? registry,
    tools: [noopTool],
    sessionId: SESSION,
    now: () => 0,
  });

  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return { runtime, events };
}

/* ------------------------------------------------------------------ */
/* Injected failures                                                   */
/* ------------------------------------------------------------------ */

/** A store whose `listUnfinishedTurns` rejects — the `boot()` failure path. */
function storeFailingList(failure: () => unknown): TurnStore {
  const base = new RecordingTurnStore();
  return {
    ...base.store,
    listUnfinishedTurns: async () => {
      throw failure();
    },
  };
}

/**
 * A registry whose `resolve` rejects with an error of the test's choosing.
 *
 * Subclassed rather than faked as a literal object: `ProviderRegistry` is a class
 * with private state, and a cast would let a change to its internals pass here
 * while breaking the real caller. The override keeps the real `resolve` shape and
 * replaces only the one step, which is also what makes this a *provider* failure
 * rather than a settings one.
 */
class ThrowingRegistry extends ProviderRegistry {
  readonly failure: () => unknown;

  constructor(failure: () => unknown) {
    super([]);
    this.failure = failure;
  }

  override resolve(): Promise<LanguageModel> {
    return Promise.reject(this.failure());
  }
}

/** A settings backend that refuses every write. */
function refusingBackend(): KeyValueBackend {
  return {
    read: () => undefined,
    write: () => {
      throw new Error("the quota is full");
    },
    clear: () => undefined,
    description: "test backend",
  };
}

/* ------------------------------------------------------------------ */
/* Half one — redaction                                                */
/* ------------------------------------------------------------------ */

describe("an unknown error never carries its own text into the runtime", () => {
  it("drops a key-bearing message from a turn failure, on every surface", async () => {
    // The store rejects with the exact error a provider's 401 would produce once
    // the SDK has wrapped it. The rejected value, the state snapshot and the event
    // payload are all checked: they are three consumers, and a leak into any one
    // of them is a leak.
    const store = new RecordingTurnStore({ failFlush: true, failFlushWith: keyBearingError() });
    const { runtime, events } = harness({ store: store.store });

    const thrown = await runtime.send({ prompt: "hi" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(RuntimeError);
    for (const surface of errorSurfaces(thrown, runtime.getState(), events)) {
      expect(surface).not.toContain(KEY);
    }
    // The class name is the only part carried over: the message says *what kind* of
    // thing broke without saying what it said. Exactly — so a change that appends
    // anything is caught here and not only by the `not.toContain` above.
    expect((thrown as RuntimeError).message).toBe("TypeError: the turn could not be completed");
  });

  it("drops it from a boot failure too, not only from a turn", async () => {
    // A different call site, a different origin, the same rule. A boot failure is
    // exactly the one a user pastes into an issue.
    const { runtime, events } = harness({ store: storeFailingList(keyBearingError) });

    const thrown = await runtime.boot().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(RuntimeError);
    for (const surface of errorSurfaces(thrown, runtime.getState(), events)) {
      expect(surface).not.toContain(KEY);
    }
  });

  it("drops a plain `Error`'s text too, not only a `TypeError`'s", async () => {
    // A real surviving mutation: narrowing the redaction branch to
    // `if (error instanceof TypeError)` — on the theory that only a CORS-blocked
    // `fetch` can carry a key — and forwarding the message for every other `Error`
    // left the whole suite green. Which class leaks is not knowable at the call site
    // (a `DOMException` for a full disk, an `Error` from a Worker, a `RangeError`
    // from a bad parse all quote whatever they were given), so "never" is the rule
    // and "never" is tested on a class the code does not single out.
    const { runtime, events } = harness({ store: storeFailingList(keyBearingPlainError) });

    const thrown = await runtime.boot().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(RuntimeError);
    expect((thrown as RuntimeError).message).toBe("Error: the interrupted turns could not be closed");
    for (const surface of errorSurfaces(thrown, runtime.getState(), events)) {
      expect(surface).not.toContain(KEY);
    }
  });

  it("drops a non-Error throwable's own text as well", async () => {
    // A rejected string is a real shape: a `Worker` message handler, a
    // `postMessage` payload. A redaction that only handled `Error` would let this
    // one straight into a rendered message, and it is the *only* throwable this
    // layer cannot even name a class for — so the branch for it is the one with no
    // room for the text, and that is worth pinning.
    const { runtime } = harness({ store: storeFailingList(() => `sqlite: cannot open ${KEY}`) });

    const thrown = await runtime.boot().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(RuntimeError);
    expect((thrown as RuntimeError).message).toBe("the interrupted turns could not be closed");
    expect((thrown as RuntimeError).message).not.toContain(KEY);
  });

  it("keeps the key out of the whole state snapshot, not just `lastError`", async () => {
    // The snapshot is what a screenshot shows and what a support bundle is built
    // from, so it is the widest surface this layer owns. `lastError` is the part the
    // runtime *composes*; the rest (`text`, `messages`) is forwarded from the engine,
    // and a turn that fails leaves the model's own words in there. What is asserted
    // is the property this layer can actually guarantee: the key it was given in the
    // failing error is nowhere in the object it hands to a renderer.
    const store = new RecordingTurnStore({ failFlush: true, failFlushWith: keyBearingError() });
    const { runtime } = harness({ store: store.store });

    await expect(runtime.send({ prompt: `my key is ${KEY}` })).rejects.toBeInstanceOf(RuntimeError);

    // `lastError` is asserted on its own above, on the rejection value and on the
    // bus event. This one is the whole object, because the snapshot is what a
    // screenshot contains. The model still answered, so `text` is the model's — the
    // assertion is that the *error's* key did not get there, not that the snapshot
    // is empty.
    expect(runtime.getState().text).toBe("hello");
    expect(JSON.stringify(runtime.getState().lastError)).not.toContain(KEY);
    expect(JSON.stringify(runtime.getState())).not.toContain(KEY);
  });
});

/* ------------------------------------------------------------------ */
/* Half two — classification, one origin at a time                     */
/* ------------------------------------------------------------------ */

describe("each origin reports its own code", () => {
  it("names a turn failure `turn-failed`, not a settings failure", async () => {
    // The bug this file exists for. The write that failed is the engine's, inside
    // the turn. `settings-write-failed` would send the user to a screen where
    // nothing is wrong, and the real fault — a full disk, a closed database —
    // would never be looked at.
    const store = new RecordingTurnStore({ failFlush: true });
    const { runtime } = harness({ store: store.store });

    await expect(runtime.send({ prompt: "hi" })).rejects.toMatchObject({ code: "turn-failed" });
    expect(runtime.getState().lastError).toMatchObject({ code: "turn-failed" });
  });

  it("names a boot failure `recovery-failed`", async () => {
    const { runtime } = harness({ store: storeFailingList(() => new Error("the database is closed")) });

    await expect(runtime.boot()).rejects.toMatchObject({ code: "recovery-failed" });
    expect(runtime.getState().lastError).toMatchObject({ code: "recovery-failed" });
  });

  it("names a provider-resolution failure `provider-unresolved`", async () => {
    // The registry fails with an *untyped* error on purpose. A `ProviderError`
    // would be mapped to `provider-unresolved` by its own branch whatever the
    // origin said, which would make this a test of the exception ladder instead of
    // of the origin.
    const { runtime } = harness({
      registry: new ThrowingRegistry(() => new Error("crypto.subtle is unavailable in this context")),
    });

    await expect(runtime.send({ prompt: "hi" })).rejects.toMatchObject({ code: "provider-unresolved" });
  });

  it("names a settings write `settings-write-failed`", async () => {
    // The opposite mislabel is the bug here: a turn that cannot save its deltas is
    // not a settings failure, and a settings write that failed is not a turn
    // failure. The backend is what makes the *write* fail, so only the origin can
    // produce this code.
    const { runtime } = harness({ settings: createSettingsStore({ backend: refusingBackend() }) });

    expect(() => runtime.applySettings(settingsWith())).toThrow(RuntimeError);
    expect(runtime.getState().lastError).toMatchObject({ code: "settings-write-failed" });
  });

  it("names a settings export `settings-write-failed` too", async () => {
    // `export` cannot fail from storage — it only reads the in-memory snapshot — so
    // the only way to reach this call site with an unknown error is an exporter that
    // throws one. The origin still has to be stated, and it has to be the settings
    // one: a wizard that cannot write the file is not a turn and not a provider.
    const base = createSettingsStore({ backend: createMemoryBackend() });
    const { runtime } = harness({
      settings: {
        ...base,
        export: () => {
          throw new Error("the exporter is not initialised");
        },
      },
    });

    expect(() => runtime.exportSettings()).toThrow(RuntimeError);
    expect(runtime.getState().lastError).toMatchObject({ code: "settings-write-failed" });
  });

  it("names a settings import `settings-import-rejected`", async () => {
    // §8.2's file boundary. A malformed import is neither a storage failure nor a
    // turn, and "the settings could not be saved" is the one answer that is not
    // actionable: nothing was saved because nothing was read.
    const { runtime } = harness();

    expect(() => runtime.prepareSettingsImport("this is not json")).toThrow(RuntimeError);
    expect(runtime.getState().lastError).toMatchObject({ code: "settings-import-rejected" });
  });

  it("gives all five origins five different codes", async () => {
    // The structural version of the same property. A sixth origin added later with a
    // copy-pasted code would collapse two subsystems into one label, and none of the
    // behavioural tests above would notice — each pins one origin on its own.
    const codes = await Promise.all([
      codeOf(() => harness({ store: new RecordingTurnStore({ failFlush: true }).store }).runtime.send({ prompt: "hi" })),
      codeOf(() => harness({ registry: new ThrowingRegistry(() => new Error("x")) }).runtime.send({ prompt: "hi" })),
      codeOf(() => harness({ store: storeFailingList(() => new Error("x")) }).runtime.boot()),
      codeOf(() =>
        harness({ settings: createSettingsStore({ backend: refusingBackend() }) }).runtime.applySettings(
          settingsWith(),
        ),
      ),
      codeOf(() => harness().runtime.prepareSettingsImport("not json")),
    ]);

    expect(new Set(codes).size).toBe(5);
    expect(codes.every((code) => code !== undefined)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The guard, at the call site                                         */
/* ------------------------------------------------------------------ */

describe("the guard is wired into the resolve, not merely exported", () => {
  it("is called by `resolveModel`, with the vendor it resolved for", async () => {
    // M2. `runtime.test.ts` unit-tests `assertResolvedLanguageModel` in isolation;
    // nothing proved `resolveModel` *calls* it. Dropping the await still failed 11
    // tests, which is exactly why the missing call was survivable — the guard is
    // the thing that turns a forgotten `await` into a clear error here instead of a
    // provider failure three layers down, so the call itself is the property.
    //
    // It can only be pinned by interception: `await` flattens thenables, so while
    // the await is present the guard can never *fire*, and a test that waited for
    // the error would pass for the wrong reason. `guard.ts` is a separate module
    // precisely so this spy has something to attach to.
    const spy = vi.spyOn(guard, "assertResolvedLanguageModel");
    try {
      const { runtime } = harness();

      await runtime.resolveModel();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe("openai");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a value that is still a promise, naming the call site", () => {
    // The error the guard exists to produce, asserted by value. A model carrying a
    // `then` is exactly the shape a forgotten `await` hands the loop.
    const thenable = Object.assign(mockModel([[finishPart()]]), {
      then: (resolve: (value: unknown) => void): void => resolve("resolved"),
    });

    expect(() => guard.assertResolvedLanguageModel(thenable, "openai")).toThrow(RuntimeError);
    expect(() => guard.assertResolvedLanguageModel(thenable, "openai")).toThrow(
      /ProviderRegistry\.resolve\("openai"\) was not awaited/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every string the runtime hands out after a failure.
 *
 * Three consumers, one source string: the rejected value (what a caller's `catch`
 * sees), the state snapshot (what a settings screen renders long afterwards), and
 * the bus event (what an error boundary logs). A leak into any one of them is a
 * leak, so all three are asserted rather than the first.
 */
function errorSurfaces(
  thrown: unknown,
  state: { readonly lastError: { readonly message: string } | undefined },
  events: readonly RuntimeEvent[],
): readonly string[] {
  return [
    thrown instanceof Error ? thrown.message : "",
    thrown instanceof Error ? thrown.name : "",
    state.lastError?.message ?? "",
    ...events.flatMap((event) =>
      event.kind === "runtime-error" ? [event.error.message, event.error.code] : [],
    ),
  ];
}

/** The `code` a call rejected with, or `undefined` if it did not reject. */
async function codeOf(run: () => unknown): Promise<string | undefined> {
  const thrown = await Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  return thrown instanceof RuntimeError ? thrown.code : undefined;
}
