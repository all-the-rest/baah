/**
 * The composition root, exercised end to end without a DOM.
 *
 * A mock `LanguageModel` streams real parts through the real `AgentTurn`, the real
 * `ProviderRegistry` and a real memory workspace. Only two things are fake: the
 * store (recording) and the provider (a mock). Everything this block is
 * responsible for — the awaited `resolve`, the step-boundary checkpoint, the boot
 * recovery, the settings exclusion — is therefore measured rather than asserted
 * about.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryWorkspace, defineTool } from "@all-the.rest/baah-core";

import { createSettingsStore } from "../lib/settings-store.ts";
import { createMemoryBackend } from "../lib/storage.ts";
import type { SettingsSnapshot } from "../lib/settings.ts";

import {
  assertResolvedLanguageModel,
  createRuntime,
  RuntimeError,
  type RuntimeDependencies,
} from "./index.ts";
import type { RuntimeEvent } from "./events.ts";
import { RecordingTurnStore, fakeRegistry, finishPart, gate, mockModel, textParts, toolCallParts } from "./testing.ts";

const SESSION = "session-1";

/**
 * A tool that runs when the model asks for it.
 *
 * Present because the checkpoint test needs a two-step turn, and a second step only
 * happens when the model requests a tool. `access: "read"` so the in-tool approval
 * seam is not on the path for this suite.
 */
const noopTool = defineTool<{ value: string }, string>({
  id: "noop",
  description: "echoes its input",
  access: "read",
  inputSchema: z.object({ value: z.string() }),
  execute: async (_context, input) => input.value,
});

/**
 * A `read`, with a `path` — the one tool §7.4's default policy asks about.
 *
 * Named `read` **on purpose**: `buildApprovalTargets` keys off the tool id, and
 * `DEFAULT_APPROVAL_TARGETS.read` is what turns `{ path: ".env" }` into the action
 * `read` and the resource `.env` (`packages/baah-core/src/agent/approval.ts:107`).
 * A differently named tool would fall through to the `access` fallback, match the
 * `{ action: "*", resource: "*" }` allow rule, and never pause — so the suite would
 * pass while exercising a path no real read takes.
 */
const readTool = defineTool<{ path: string }, string>({
  id: "read",
  description: "reads a file",
  access: "read",
  inputSchema: z.object({ path: z.string() }),
  execute: async (_context, input) => `contents of ${input.path}`,
});

function settingsWith(options: {
  readonly vendor?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}): SettingsSnapshot {
  const store = createSettingsStore({ backend: createMemoryBackend() });
  store.update({
    provider: {
      vendor: options.vendor ?? "openai",
      model: options.model ?? "gpt-4o-mini",
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    },
  });
  if (options.apiKey !== undefined) store.setApiKey("openai", options.apiKey);
  return store.get();
}

interface HarnessOptions {
  readonly store?: RecordingTurnStore;
  /** One entry per `doStream` call — one entry per step of the turn. */
  readonly steps?: readonly (readonly unknown[])[];
  readonly key?: string;
  readonly unfinished?: readonly { turnId: string; heartbeatAt: string; startedAt: string }[];
  readonly now?: () => number;
  readonly settings?: SettingsSnapshot;
  /**
   * A gate the turn waits on before the model answers anything.
   *
   * This is how a turn is kept in flight **without wall-clock time**. The obvious
   * alternative is `chunkDelayMs`, and it is wrong for a reason worth writing down:
   * it makes the test's outcome depend on the machine. If the turn finishes before
   * the second `send` is reached, the guard being tested is never exercised — the
   * second turn simply runs and nothing throws, so the test passes **having
   * asserted nothing**. A gate the test opens explicitly cannot lose that race,
   * and the in-flight state is a fact the test established rather than a delay it
   * hoped for.
   */
  readonly gate?: Promise<void>;
  /** Makes one specific `doStream` call throw. See `testing.ts`'s `failAt`. */
  readonly failAt?: { readonly call: number; readonly error: unknown };
  readonly stallTimeoutMs?: number;
  readonly setStallTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearStallTimer?: (handle: unknown) => void;
  readonly overrides?: Partial<RuntimeDependencies>;
}

function harness(options: HarnessOptions = {}): {
  runtime: ReturnType<typeof createRuntime>;
  store: RecordingTurnStore;
  events: RuntimeEvent[];
  registry: ReturnType<typeof fakeRegistry>["registry"];
  created: ReturnType<typeof fakeRegistry>["created"];
} {
  const store =
    options.store ??
    new RecordingTurnStore(
      options.unfinished === undefined ? {} : { unfinished: options.unfinished },
    );
  const settings = createSettingsStore({
    backend: createMemoryBackend(),
    initial: options.settings ?? settingsWith({ apiKey: options.key ?? "sk-test-not-a-real-key" }),
  });
  const { registry, created } = fakeRegistry({
    model: mockModel(options.steps ?? [[...textParts("t0", "hello"), finishPart()]], {
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      ...(options.failAt === undefined ? {} : { failAt: options.failAt }),
    }),
  });

  const runtime = createRuntime({
    store: store.store,
    workspace: createMemoryWorkspace(),
    settings,
    registry,
    tools: [noopTool],
    sessionId: SESSION,
    instructions: "be brief",
    now: options.now ?? Date.now,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    ...(options.setStallTimer === undefined ? {} : { setStallTimer: options.setStallTimer }),
    ...(options.clearStallTimer === undefined ? {} : { clearStallTimer: options.clearStallTimer }),
    ...options.overrides,
  });

  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  return { runtime, store, events, registry, created };
}

describe("the composition root", () => {
  it("runs a turn end to end and returns the text", async () => {
    const { runtime, store } = harness();

    const result = await runtime.send({ prompt: "hi" });

    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("hello");
    expect(store.heartbeats.length).toBeGreaterThan(0);
    expect(store.finishes.at(-1)).toMatchObject({ turnId: expect.any(String), outcome: "succeeded" });
  });

  it("forwards every engine event verbatim, tagged as `agent`", async () => {
    const { runtime, events } = harness();

    await runtime.send({ prompt: "hi" });

    const agentEvents = events.filter((event) => event.kind === "agent");
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(agentEvents.some((event) => event.kind === "agent" && event.event.type === "text-delta")).toBe(true);
    expect(agentEvents.some((event) => event.kind === "agent" && event.event.type === "turn-finished")).toBe(true);
    // The runtime's own vocabulary is disjoint from the engine's — a UI switches on
    // `kind`, never on a string that appears in both.
    expect(events.some((event) => event.kind === "turn-settled")).toBe(true);
  });

  it("refuses a second turn while one is in flight", async () => {
    // The gate, not a delay. With `chunkDelayMs` the turn could finish before the
    // second `send` is reached, the guard would never run, and the test would pass
    // having asserted nothing — green on a fast machine, red on a loaded one, and
    // neither outcome about the guard.
    const held = gate();
    const { runtime } = harness({ gate: held.promise });

    const first = runtime.send({ prompt: "one" });
    await expect(runtime.send({ prompt: "two" })).rejects.toMatchObject({ code: "turn-busy" });
    held.open();
    await expect(first).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("accepts a new turn once the previous one has settled", async () => {
    // The other side of the guard, and the one a stuck flag would break. A failed
    // turn and a successful one both have to release the flag — otherwise the session
    // is dead after a single failure, which is a worse bug than the one the flag
    // prevents.
    const { runtime } = harness();

    await runtime.send({ prompt: "one" });
    await expect(runtime.send({ prompt: "two" })).resolves.toMatchObject({ outcome: "succeeded" });

    // The failing half. It used to reject with a `RuntimeError`; `AgentTurn`'s
    // `#persistPrompt` now catches a failed write and **resolves** with a `failed`
    // `TurnResult`. The assertion is therefore on the flag, not on the shape of the
    // failure: a second send must be *accepted*, and a stuck `inFlight` would answer
    // `turn-busy` instead.
    const failing = harness({ store: new RecordingTurnStore({ failFlush: true }) });
    await expect(failing.runtime.send({ prompt: "three" })).resolves.toMatchObject({ outcome: "failed" });
    await expect(failing.runtime.send({ prompt: "four" })).resolves.toMatchObject({ outcome: "failed" });
  });
});

describe("the awaited resolve (AGENTS.md §2, Plan.md §9)", () => {
  /**
   * The mutation this suite exists for.
   *
   * `ProviderRegistry.resolve` is `async` because the memo key is a `crypto.subtle`
   * digest of the API key. Drop the `await` and you get a `Promise` wearing a
   * `LanguageModel` type: the turn runs, the SDK calls `doStream` on a promise,
   * everything throws deep inside the agent, and the error a user sees names the
   * provider — the one component that is innocent.
   *
   * So the assertion is on the **value**, not on the call having happened. The guard
   * `assertResolvedLanguageModel` exists for the same reason, and this test fails if
   * either the await or the guard goes.
   */
  it("hands the loop a real LanguageModel, not a Promise", async () => {
    const { runtime } = harness();

    const model = await runtime.resolveModel();

    // The failure this guards against is invisible until three layers down: a
    // promise wearing a `LanguageModel` type. So the assertion is about the value,
    // not about the call having happened.
    expect(model).not.toBeInstanceOf(Promise);
    expect(typeof (model as { doStream?: unknown }).doStream).toBe("function");
  });

  it("passes the configured key and model to the factory", async () => {
    const { runtime, created } = harness({ key: "sk-runtime-key" });

    await runtime.resolveModel();

    expect(created).toHaveLength(1);
    expect(created[0]?.apiKey).toBe("sk-runtime-key");
    expect(created[0]?.model).toBe("gpt-4o-mini");
  });

  it("fails loudly when no provider is configured", async () => {
    const { runtime } = harness({ settings: createSettingsStore({ backend: createMemoryBackend() }).get() });

    await expect(runtime.resolveModel()).rejects.toMatchObject({ code: "no-provider-configured" });
  });

  it("fails loudly when a key is configured for a different slot", async () => {
    // The registry would accept an empty key as missing too; what matters here is
    // that the runtime refuses rather than sending a request that cannot succeed.
    const settings = createSettingsStore({ backend: createMemoryBackend() });
    settings.setApiKey("anthropic", "sk-anthropic-only");

    const { runtime } = harness({ settings: settings.get() });

    await expect(runtime.resolveModel()).rejects.toMatchObject({ code: "no-provider-configured" });
  });

  it("rejects a thenable handed in place of a model", () => {
    // The guard, tested on its own: a value that *looks* resolved but is still a
    // promise has to be rejected at the call site, not three layers down.
    const promise = Promise.resolve({});

    expect(() => assertResolvedLanguageModel(promise as never, "openai")).toThrow(RuntimeError);
    expect(() => assertResolvedLanguageModel(promise as never, "openai")).toThrow(/was not awaited/);
  });

  it("accepts a resolved model unchanged", () => {
    const model = mockModel([[finishPart()]]);

    expect(assertResolvedLanguageModel(model, "openai")).toBe(model);
  });
});

describe("the stall report reaches the snapshot, not only the bus", () => {
  /**
   * M17, and the two halves of one publish.
   *
   * `publish({ stall: report })` was uncovered: deleting it left 128/128 green.
   * The reason is that `bus.emit({ kind: "stall", report })` sits on the very next
   * line, so a subscriber-driven test still sees the event and a test that only
   * counts events is satisfied. What is left unverified is the half a UI that
   * reads `getState()` on mount depends on — a stall that fired **before** the
   * component subscribed is in the snapshot and nowhere else. A late subscriber
   * would wait for a second report that never comes, because the watchdog latches.
   *
   * The timer is injected so the window is opened by the test, not by a sleep: a
   * wall-clock stall test passes on a fast machine and fails on a loaded one,
   * which is the same defect the `chunkDelayMs` in-flight test had.
   */
  it("puts the report into the state, so a UI that mounts late still sees it", async () => {
    // The turn waits on a gate the test never opens, so it is genuinely silent —
    // no sleep, and no dependence on how fast the machine runs the stream.
    const held = gate();
    const stall = fakeTimers();
    const { runtime, events } = harness({
      gate: held.promise,
      stallTimeoutMs: 20_000,
      setStallTimer: stall.setTimer,
      clearStallTimer: stall.clearTimer,
    });

    const running = runtime.send({ prompt: "hi" });
    await armed(stall);
    stall.fireAll();

    // Subscribe *after* the stall fired — the case the bus cannot serve, since the
    // watchdog latches and will not report a second time.
    expect(runtime.getState().stall).toMatchObject({
      sessionId: SESSION,
      timeoutMs: 20_000,
      phase: "awaiting-provider",
    });
    expect(events.some((event) => event.kind === "stall")).toBe(true);

    held.open();
    await running;
  });

  it("clears the stall when the next turn starts, so a stale one is not rendered", async () => {
    const held = gate();
    const stall = fakeTimers();
    const { runtime } = harness({
      gate: held.promise,
      stallTimeoutMs: 20_000,
      setStallTimer: stall.setTimer,
      clearStallTimer: stall.clearTimer,
    });

    const first = runtime.send({ prompt: "hi" });
    await armed(stall);
    stall.fireAll();
    expect(runtime.getState().stall).toBeDefined();
    held.open();
    await first;

    // Second turn, and this time the timers are left alone — so the only thing that
    // can set a stall is the turn that is running.
    const second = runtime.send({ prompt: "again" });
    await armed(stall);

    // `runTurn`'s `publish` lists `stall: undefined` in the same patch as `turnId`.
    // A UI rendering "stalled" from a previous turn's report is making a claim about
    // a turn that no longer exists, and a user who then waits 20 s for a second
    // report is waiting for one the latch will never produce.
    expect(runtime.getState().stall).toBeUndefined();
    held.open();
    await second;
  });
});

/**
 * A timer queue the test fires **on demand**.
 *
 * The stall window is the only thing in this layer that lives on a clock, and
 * sleeping out a 20 s window is not a test. Deliberately *not* a "fire everything on
 * the next microtask" fake: that would make every turn stall, including the second
 * one in a test about a stall being cleared, and the test would then be asserting
 * about its own fixture. Same shape as `watchdog.test.ts`'s `fakeClock`; duplicated
 * rather than shared because these are two test files and one exported helper is a
 * dependency neither of them needs.
 */
function fakeTimers(): {
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Fire every timer currently pending. */
  fireAll: () => void;
  /** How many are armed. 0 means the watchdog has not armed yet. */
  readonly pending: number;
} {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (callback) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    fireAll: () => {
      // A copy first: a fired callback re-arms, and re-arming into the map being
      // iterated would either skip or double-fire depending on the iteration order.
      for (const [id, callback] of [...timers]) {
        if (timers.delete(id)) callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

/**
 * Wait until the watchdog has armed a timer.
 *
 * The watchdog arms on the first engine event, and the turn has to reach that event
 * before it blocks on the gate. "How many microtask turns is that" is a question
 * about the engine's internals, so the test waits on the *observable* — a pending
 * timer — rather than on a number of ticks. The bound is a ceiling, not a delay: it
 * is the difference between "waited long enough" and "hung forever", and a run that
 * hits it fails on the assertion that follows.
 */
async function armed(stall: { readonly pending: number }): Promise<void> {
  for (let tick = 0; tick < 200 && stall.pending === 0; tick += 1) {
    // A macrotask yield, not a microtask: `resolveModel` awaits a `crypto.subtle`
    // digest, which does not complete on the microtask queue. Zero-delay — this is
    // draining the queue, not waiting for anything.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(stall.pending).toBeGreaterThan(0);
}

describe("the step boundary", () => {
  /**
   * Delta persistence is the engine's, not this layer's — and the premise moved
   * under this block while it was being written.
   *
   * **What changed.** An app-side `flushDelta` writer used to live here: a
   * `StepCheckpoint` that flushed the step's accumulated text on `step-end`. It was
   * removed on purpose, because `AgentTurn` grew its own per-part streaming writer
   * (`DELTA_FLUSH_INTERVAL_MS`, `closePart`, `closeTurnParts`). An app-side writer
   * alongside it is a **second path into the database** writing the same parts under
   * a different `deltaId` scheme — the duplication `Plan.md` §16.1 refused for the
   * `TurnStore` adapter, where two paths into one store are how the two classifiers
   * drifted apart. Two writers, one part, two `deltaId` schemes.
   *
   * **M3, and why restoring the flush is the wrong fix.** "Flush at attempt end
   * instead of at the part boundary" survived 128/128 — a surviving mutant, and the
   * temptation is to add a step-boundary flush back and let it catch it. That would
   * be fixing a test by re-introducing the bug the removal fixed. The invariant that
   * actually holds is the one below, and a second writer violates it in two
   * independent, observable ways:
   *
   * 1. it cannot mint a part id (`text:<messageId>` is a derived key space), and
   * 2. it would *double* the deltas for a part the engine already flushed.
   *
   * Both are asserted rather than "some deltas exist", and the count assertion is
   * the one that survives an equivalent mutation — a writer that reused the
   * engine's id scheme would still double the rows.
   */
  it("writes no deltas of its own — every part id is one the engine minted", async () => {
    const { runtime, store } = harness();

    await runtime.send({ prompt: "hi" });

    expect(store.deltas.length).toBeGreaterThan(0);
    for (const delta of store.deltas) {
      /**
       * The engine mints two part-id shapes and this layer used to derive a third.
       *
       * - `t0` — an assistant text part, from the stream loop.
       * - a `newMessageId()` — the **prompt** part, which `AgentTurn.#persistPrompt`
       *   writes before the first model call. That write arrived with core's
       *   `appendTurn` / `appendMessage`, and it is why this pattern is two
       *   alternatives rather than one.
       * - `text:<messageId>` — the derived key space this app used before the
       *   step-boundary writer was removed. A second writer invents exactly that, so
       *   it is asserted *absent* as well as "not one of the other two".
       */
      expect(delta.partId).toMatch(/^(t\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
      expect(delta.partId.startsWith("text:")).toBe(false);
      expect(delta.partType).toBe("text");
      expect(delta.sessionId).toBe(SESSION);
    }
  });

  it("gives every delta a distinct id, so a replay cannot double-apply", async () => {
    const { runtime, store } = harness();

    await runtime.send({ prompt: "hi" });

    const ids = store.deltas.map((delta) => delta.deltaId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes each part exactly once, so a second writer cannot hide behind the ids", async () => {
    // The engine flushes a part on its 100 ms interval and unconditionally when the
    // part ends. An app-side writer at the *step* boundary would fire in between and
    // produce a second delta for the same part, with a distinct `deltaId` — so the
    // uniqueness assertion above would not see it. This one does.
    const { runtime, store } = harness();

    await runtime.send({ prompt: "hi" });

    const perPart = new Map<string, number>();
    for (const delta of store.deltas) {
      perPart.set(delta.partId, (perPart.get(delta.partId) ?? 0) + 1);
    }
    expect(perPart.size).toBeGreaterThan(0);
    for (const [partId, count] of perPart) {
      // Asserted through a string so a failure names the part instead of printing
      // two parallel Maps and asking the reader to diff them.
      expect(`${partId} → ${String(count)}`).toBe(`${partId} → 1`);
    }
  });

  it("counts steps from the engine's `step-end`, so progress is a fact", async () => {
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    const step1 = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r1", modelId: "gpt-4o-mini", timestamp: new Date(0) },
      ...textParts("t0", "let me look"),
      { type: "tool-call", toolCallId: "c1", toolName: "noop", input: JSON.stringify({ value: "x" }) },
      { type: "tool-result", toolCallId: "c1", toolName: "noop", output: JSON.stringify({ type: "text", value: "x" }) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
    ];
    const step2 = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r2", modelId: "gpt-4o-mini", timestamp: new Date(1) },
      ...textParts("t1", "done"),
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];

    const { runtime, store } = harness({ steps: [step1, step2] });

    const result = await runtime.send({ prompt: "hi" });

    expect(result.outcome).toBe("succeeded");
    // Two steps, counted from the same event the engine checkpoints on — not guessed.
    expect(runtime.getState().step).toBe(2);
    // Both texts on disk, because the engine closed both parts rather than waiting
    // for the turn to end. A turn-end-only writer would have lost step 1.
    const persisted = store.deltas.map((delta) => delta.contentText).join(" ");
    expect(persisted).toContain("let me look");
    expect(persisted).toContain("done");
  });

  it("renews the session-scoped heartbeat at every step", async () => {
    const { runtime, store } = harness();

    await runtime.send({ prompt: "hi" });

    // The reload anchor. A turn that stops renewing it looks dead to the next boot.
    expect(store.heartbeats.length).toBeGreaterThanOrEqual(2);
    for (const heartbeat of store.heartbeats) {
      expect(heartbeat.sessionId).toBe(SESSION);
    }
  });

  it("surfaces a failed write rather than pretending the turn was clean", async () => {
    // The write failing is not the turn succeeding. `AgentTurn.#persistPrompt` awaits
    // the write before the first model call and, when it fails, ends the turn
    // `failed` with a `Classification` — which is the stronger contract of the two:
    // the turn never reaches the model at all, so there is nothing half-written to
    // describe, and the user is told the turn failed rather than being handed an
    // empty "success".
    //
    // It used to reject with a `RuntimeError`; the assertion that survives the shape
    // change is the one that matters — **not** `succeeded` — plus the fact that the
    // model was never called, which is what makes it a persistence failure rather
    // than a provider one.
    const store = new RecordingTurnStore({ failFlush: true });
    const { runtime } = harness({ store });

    const result = await runtime.send({ prompt: "hi" });

    expect(result.outcome).toBe("failed");
    // `attempts: 0` is the part that names it a *persistence* failure: the model was
    // never asked. A provider failure has attempts.
    expect(result.attempts).toBe(0);
    expect(result.classification).toBeDefined();
  });
});

describe("owned call site — reload recovery at boot", () => {
  const T0 = Date.parse("2026-09-29T12:00:00.000Z");

  function unfinishedAt(ageSeconds: number): { turnId: string; heartbeatAt: string; startedAt: string } {
    const heartbeatAt = new Date(T0 - ageSeconds * 1000).toISOString();
    return { turnId: `turn-${ageSeconds}`, heartbeatAt, startedAt: heartbeatAt };
  }

  it("closes a stale turn and keeps the reason", async () => {
    const { runtime, store } = harness({ unfinished: [unfinishedAt(120)], now: () => T0 });

    const report = await runtime.boot();

    expect(report.recovered).toHaveLength(1);
    expect(store.finishes).toHaveLength(1);
    expect(store.finishes[0]?.outcome).toBe("interrupted");
    // The reason is said out loud: "interrupted" with no explanation reads as a
    // crash, and the user has to be able to tell a reload from a provider failure.
    expect(store.finishes[0]?.error).toContain("no heartbeat");
  });

  it("leaves a fresh heartbeat alone — another tab is still working", async () => {
    // The other side of the boundary, and the dangerous one: closing this would kill
    // a live turn in a second tab.
    const { runtime, store } = harness({ unfinished: [unfinishedAt(5)], now: () => T0 });

    const report = await runtime.boot();

    expect(report.recovered).toHaveLength(0);
    expect(report.untouched).toHaveLength(1);
    expect(store.finishes).toHaveLength(0);
  });

  it("treats exactly 30 s as stale, not 29.999", async () => {
    const onTheBoundary = harness({ unfinished: [unfinishedAt(30)], now: () => T0 });
    await onTheBoundary.runtime.boot();
    expect(onTheBoundary.store.finishes).toHaveLength(1);

    const justUnder = harness({ unfinished: [unfinishedAt(29.999)], now: () => T0 });
    await justUnder.runtime.boot();
    expect(justUnder.store.finishes).toHaveLength(0);
  });

  it("issues exactly one finish per stale turn and nothing else", async () => {
    const store = new RecordingTurnStore({ unfinished: [unfinishedAt(60), unfinishedAt(120)] });
    const { runtime } = harness({ store, now: () => T0 });

    await runtime.boot();

    // One write per stale turn, and no other store call: recovery closes rows, it
    // does not touch the partial text (which is the whole of §6.1's "keep the
    // partial text" — the text survives because nothing deletes it).
    expect(store.finishes.map((finish) => finish.turnId).sort()).toEqual(["turn-120", "turn-60"]);
    expect(store.deltas).toHaveLength(0);
    expect(store.heartbeats).toHaveLength(0);
  });

  it("is idempotent: a second boot finds nothing unfinished", async () => {
    const { runtime, store } = harness({ unfinished: [unfinishedAt(120)], now: () => T0 });

    await runtime.boot();
    await runtime.boot();

    expect(store.finishes).toHaveLength(1);
  });

  it("publishes the report on the event stream", async () => {
    const { runtime, events } = harness({ unfinished: [unfinishedAt(90)], now: () => T0 });

    await runtime.boot();

    const boot = events.find((event) => event.kind === "boot");
    expect(boot).toBeDefined();
    expect(boot?.kind === "boot" && boot.report.recovered).toHaveLength(1);
  });
});

describe("the state snapshot", () => {
  it("ends with the turn's messages, outcome and text", async () => {
    const { runtime } = harness();

    await runtime.send({ prompt: "hi" });

    const state = runtime.getState();
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("succeeded");
    expect(state.text).toBe("hello");
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.sessionId).toBe(SESSION);
  });

  it("notifies state subscribers exactly once per change", async () => {
    const { runtime } = harness();
    let notifications = 0;
    const unsubscribe = runtime.subscribeState(() => {
      notifications += 1;
    });

    await runtime.send({ prompt: "hi" });
    unsubscribe();

    expect(notifications).toBeGreaterThan(0);
    const after = notifications;
    await runtime.send({ prompt: "again" });
    // Unsubscribed, so nothing new arrives. Without the copy-on-emit in the bus this
    // would be a leak rather than a test.
    expect(notifications).toBe(after);
  });

  it("exposes the provider catalog for the wizard", () => {
    const { runtime } = harness();
    expect(runtime.providers.map((entry) => entry.id)).toContain("openai");
    expect(runtime.providers.map((entry) => entry.id)).not.toContain("opencode-zen");
  });
});

describe("approval answering", () => {
  it("rejects when there is no paused turn", async () => {
    const { runtime } = harness();

    await expect(runtime.answerApproval({ approvalId: "a1", approved: true })).rejects.toBeInstanceOf(
      RuntimeError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* A parked turn is not a finished turn                                */
/* ------------------------------------------------------------------ */

/**
 * ## Why this block exists at all
 *
 * `runTurn`'s `finally` cleared `turn`, `watchdog` and `turnId` **unconditionally**,
 * including when the engine resolved with `outcome: "awaiting-approval"` — which it
 * does precisely so the turn can be continued. `answerApproval` opens with
 * `if (turn === undefined) throw new RuntimeError("turn-busy", …)`, so every answer
 * failed and the turn stood there forever. Two E2E scenarios were encoded as
 * `test.fail` against exactly this.
 *
 * The E2E suite proves the product. This block proves the **rule**, with no browser
 * and no DOM (`AGENTS.md` §6), and it is the place where the three things a parked
 * turn keeps — the `AgentTurn`, its `turnId`, its watchdog — are each pinned, because
 * the E2E cannot tell a missing watchdog from a disarmed one.
 *
 * ## Every assertion below has a second path, on purpose
 *
 * A test that only checks `answerApproval` resolves would pass against a mutant that
 * simply stopped clearing `turn` at all — which leaks the turn into the next one and
 * breaks something else entirely. So the state assertions (status, `inFlight`,
 * `turnId`) are not implied by the resolution ones: they are measured alongside.
 */
describe("a turn parked on an approval", () => {
  /**
   * One step that asks for `.env` — which §7.4's default policy judges `ask` — and
   * one step that answers. Two steps, because `#continue` re-sends the transcript
   * and the model has to be asked again; a single-step script would have the mock
   * replay the tool call and park forever.
   */
  function askEnvThenAnswer(text: string): (readonly unknown[])[] {
    return [
      [...toolCallParts({ toolCallId: "call_env", toolName: "read", input: { path: ".env" } }), finishPart("tool-calls")],
      [...textParts("t1", text), finishPart()],
    ];
  }

  function parkedHarness(answer: string) {
    return harness({ steps: askEnvThenAnswer(answer), overrides: { tools: [readTool] } });
  }

  async function park(runtime: ReturnType<typeof createRuntime>) {
    const result = await runtime.send({ prompt: "lies da eine .env?" });
    expect(result.outcome).toBe("awaiting-approval");
    return result.openApprovals[0]?.approvalId;
  }

  it("resolves `run()` with the open approval, so the turn is continuable", async () => {
    // The premise of the whole block, asserted rather than assumed: the engine parks
    // for exactly one approval, and it is a `read` of `.env` — the `ask` §7.4
    // produces with no rules configured at all.
    const { runtime } = parkedHarness("gelesen");
    const result = await runtime.send({ prompt: "lies da eine .env?" });

    expect(result.outcome).toBe("awaiting-approval");
    expect(result.openApprovals).toHaveLength(1);
    expect(result.openApprovals[0]?.toolName).toBe("read");
  });

  it("keeps the turn reachable: answering runs the tool and finishes the turn", async () => {
    // The mutation this kills: `turn = undefined` restored in the `finally`. Every
    // other assertion in this block still passes with that mutant in place — the
    // park is reported identically — so this is the one line that has to fail.
    const { runtime, store } = parkedHarness("gelesen");
    const approvalId = await park(runtime);

    const resumed = await runtime.answerApproval({ approvalId: approvalId ?? "", approved: true });

    expect(resumed?.outcome).toBe("succeeded");
    expect(resumed?.text).toBe("gelesen");
    // And the tool actually ran on the resumed turn — the difference between a
    // correct resume and the "re-send with an empty prompt" shortcut, which reaches
    // the model without ever executing the approved call.
    expect(store.beganToolCalls).toHaveLength(1);
    expect(store.recordedToolCalls).toHaveLength(1);
  });

  it("reads `idle` while parked — nothing is running, the card is what waits", async () => {
    // `turn-view.ts` turns `outcome: "awaiting-approval"` into "Wartet auf eine
    // Freigabe.", and that sentence is only reachable while `status` is not
    // `running`. A parked turn that still claimed `running` would say "Der Turn
    // läuft." over a card the user is supposed to answer.
    const { runtime } = parkedHarness("gelesen");
    await park(runtime);

    const state = runtime.getState();
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("awaiting-approval");
  });

  it("publishes `running` for the continuation, and `idle` once it is over", async () => {
    // The mutation this kills: `publish({ status: "idle" })` on the resume instead of
    // `running`. Asserted as a **sequence of snapshots**, not as the end state: the
    // end state is `idle` either way, so a test that only looked at the end would
    // pass against the mutant and prove nothing about the window in between.
    const { runtime } = parkedHarness("gelesen");
    const approvalId = await park(runtime);

    const seen: string[] = [];
    runtime.subscribeState(() => {
      seen.push(runtime.getState().status);
    });

    await runtime.answerApproval({ approvalId: approvalId ?? "", approved: true });

    expect(seen).toContain("running");
    expect(seen.at(-1)).toBe("idle");
  });

  it("blocks a second turn while parked — §15.5's card blocks further operation", async () => {
    // A second `send` would construct a **new** `AgentTurn` and overwrite the
    // reference, so the open card would point at a turn that no longer exists. This
    // is the same guard the in-flight case uses, held across the pause — and it is a
    // separate assertion from the resume one, because a mutant that clears `turn`
    // but forgets `inFlight` fails here and nowhere else.
    const { runtime } = parkedHarness("gelesen");
    await park(runtime);

    await expect(runtime.send({ prompt: "und jetzt?" })).rejects.toMatchObject({ code: "turn-busy" });
  });

  it("accepts a new turn again after the resume has finished", async () => {
    // The other direction of the same guard, and the one a "never clear it" mutant
    // dies on: holding `inFlight` across the resume too would leave the session
    // permanently unable to send anything.
    const { runtime } = parkedHarness("gelesen");
    const approvalId = await park(runtime);
    await runtime.answerApproval({ approvalId: approvalId ?? "", approved: true });

    const next = await runtime.send({ prompt: "weiter" });

    expect(next.outcome).toBe("succeeded");
  });

  it("keeps its turn id, so the resume settles under the turn it belongs to", async () => {
    // The `turnId` is read *before* the await in `answerApproval` and the settled
    // turn is published on the bus. A mutant that cleared `turnId` in the `finally`
    // would make the resume's `settle` skip silently — no error, no event, a UI that
    // never learns the continuation finished.
    const { runtime, events } = parkedHarness("gelesen");
    const parked = await runtime.send({ prompt: "lies da eine .env?" });
    const parkedTurnId = runtime.getState().turnId;
    expect(parkedTurnId).toBeDefined();

    const approvalId = parked.openApprovals[0]?.approvalId;
    await runtime.answerApproval({ approvalId: approvalId ?? "", approved: true });

    const settled = events.filter((event) => event.kind === "turn-settled");
    expect(settled).toHaveLength(2);
    // Same turn, both times: a resume is a continuation, not a new turn.
    expect(settled.map((event) => (event.kind === "turn-settled" ? event.turnId : ""))).toEqual([
      parkedTurnId,
      parkedTurnId,
    ]);
  });

  it("keeps the watchdog across the pause and re-arms it for the continuation", async () => {
    // The claim, and it is two claims with two different answers.
    //
    // While a human decides, **no window is open** — that is `watchdog.ts`'s own
    // design: `approval-requested` is in `DISARM` and moves the phase to
    // `awaiting-human`, because "a card is waiting for a person" is not a stall.
    // Asserted first, so a mutant that simply never opened a window passes it.
    //
    // The second claim is the load-bearing one: **the resume opened a new window.**
    // `approval-answered` is in `ARM`, and the only way it can be observed is if the
    // parked turn still held its `StallWatchdog` — `handleEvent` calls
    // `watchdog?.observe(event)`, and a `finally` that dropped the watchdog turns
    // that into a silent no-op. A continuation with no stall affordance is invisible
    // everywhere else, which is why it is measured through the injected timer rather
    // than through a sleep.
    const opened: number[] = [];
    const closed: unknown[] = [];
    const live = (): number => opened.length - closed.length;

    const { runtime } = harness({
      steps: askEnvThenAnswer("gelesen"),
      overrides: { tools: [readTool] },
      setStallTimer: (_callback, ms) => {
        opened.push(ms);
        return opened.length;
      },
      clearStallTimer: (handle) => {
        closed.push(handle);
      },
    });

    const approvalId = await park(runtime);
    expect(live(), "no stall window while a human decides").toBe(0);
    const openedWhileParked = opened.length;

    await runtime.answerApproval({ approvalId: approvalId ?? "", approved: true });

    // The resume armed it — more than once, because `approval-answered` and the
    // approved call's `tool-result` both open a window.
    expect(opened.length).toBeGreaterThan(openedWhileParked);
    // And the finished turn released it, so a released turn leaves no timer behind.
    expect(live(), "no stall window after the turn is over").toBe(0);
  });

  it("answers a refusal the same way, and the turn finishes", async () => {
    // `Plan.md` §7.6: a refusal is a readable answer, not a malfunction. The two
    // answers take the same code path in `AgentTurn`, so the runtime must treat them
    // the same way too — a runtime that only released the turn for `approved: true`
    // would park forever on a "nein".
    const { runtime, events } = parkedHarness("verstanden");
    const approvalId = await park(runtime);

    const resumed = await runtime.answerApproval({ approvalId: approvalId ?? "", approved: false });

    expect(resumed?.outcome).toBe("succeeded");
    // The tool did **not** run. A denial that still executed the call would be the
    // security bug §7.6 exists to prevent.
    expect(
      events.some((event) => event.kind === "agent" && event.event.type === "tool-output-denied"),
    ).toBe(true);
  });

  it("releases the turn when the answer matches no open approval", async () => {
    // A second click on a card that was already answered. `respondToApproval` answers
    // `undefined` — nothing ran — and holding the turn open would re-create the
    // dead end this path exists to end.
    const { runtime } = parkedHarness("gelesen");
    await park(runtime);

    const result = await runtime.answerApproval({ approvalId: "gibt-es-nicht", approved: true });

    expect(result).toBeUndefined();
    await expect(runtime.send({ prompt: "weiter" })).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("parks a second time when the continuation asks about another call", async () => {
    // `AgentTurn.#continue` runs the approved call and then hits a second one, so a
    // park is not a one-shot. A runtime that released the turn on the first result
    // would leave the *second* card unanswerable, and the failure would look exactly
    // like the bug this block fixed — one card further along.
    const { runtime } = harness({
      steps: [
        [...toolCallParts({ toolCallId: "call_1", toolName: "read", input: { path: ".env" } }), finishPart("tool-calls")],
        [...toolCallParts({ toolCallId: "call_2", toolName: "read", input: { path: ".env.local" } }), finishPart("tool-calls")],
        [...textParts("t1", "beides gelesen"), finishPart()],
      ],
      overrides: { tools: [readTool] },
    });

    const first = await park(runtime);
    const second = await runtime.answerApproval({ approvalId: first ?? "", approved: true });

    expect(second?.outcome).toBe("awaiting-approval");
    expect(second?.openApprovals).toHaveLength(1);
    // Still the same turn, still blocked, still answerable.
    expect(runtime.getState().status).toBe("idle");
    await expect(runtime.send({ prompt: "nein" })).rejects.toMatchObject({ code: "turn-busy" });

    const third = await runtime.answerApproval({ approvalId: second?.openApprovals[0]?.approvalId ?? "", approved: true });
    expect(third?.outcome).toBe("succeeded");
    expect(runtime.getState().status).toBe("idle");
  });

  it("releases the turn when the continuation fails, rather than holding it open", async () => {
    // A turn nobody can finish is the dead end this block exists to end, and a
    // continuation that throws is one. So a failed continuation is classified
    // **and** released — the opposite of the parked branch, and the one a
    // `releaseTurn()`-less mutation gets wrong in the direction of "looks fine,
    // never recovers".
    //
    // The failure is a **thrown** `doStream`, not a `finish` part carrying
    // `raw: "error"`: §5.4's terminal-event check is `rawFinishReason !== undefined`,
    // so a finish part with a reason is a *clean* finish and the turn would succeed.
    // `mockModel`'s `failAt` exists for exactly that distinction.
    const { runtime } = harness({
      steps: [
        [...toolCallParts({ toolCallId: "call_env", toolName: "read", input: { path: ".env" } }), finishPart("tool-calls")],
      ],
      overrides: { tools: [readTool] },
      // The second `doStream` — the continuation — throws.
      failAt: { call: 1, error: new TypeError("Verbindung weg") },
    });
    const approvalId = await park(runtime);

    const result = await runtime.answerApproval({ approvalId: approvalId ?? "", approved: true });

    expect(result?.outcome).toBe("failed");
    expect(runtime.getState().status).toBe("idle");
    // Released: a new turn is possible. A held turn would reject this with
    // `turn-busy` and the session would be stuck behind a card nobody can answer.
    await expect(runtime.send({ prompt: "neu" })).resolves.toMatchObject({ outcome: expect.any(String) });
  });
});
