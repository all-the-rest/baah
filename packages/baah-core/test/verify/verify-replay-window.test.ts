/**
 * C4 / C5 — the replay window, the parse order, and the seams around them.
 *
 * ## C4 in one sentence
 *
 * `beginToolCall` persists "may have run" and `recordToolCall` persists "did
 * run". A crash in between leaves a begun call with no outcome, and this file
 * establishes which way the code resolves that — and what it costs.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, type ToolContext } from "../../src/tool.ts";
import { createMemoryWorkspace } from "../../src/workspace.ts";
import { buildApprovalTargets, createApprovalResolver } from "../../src/agent/approval.ts";
import {
  AgentTurn,
  heartbeatAgeMs,
  isTurnStale,
  recoverStaleTurns,
  STALE_HEARTBEAT_MS,
  type AgentEvent,
  type TurnStore,
} from "../../src/agent/loop.ts";
import {
  createToolSet,
  renderToolOutput,
  truncateToolOutput,
  DEFAULT_TOOL_OUTPUT_LIMITS,
  TRUNCATION_MARKER,
  type ToolCallKey,
} from "../../src/agent/tools.ts";
import { finish, text, toolCall, type MockStreamPart } from "../agent/mock-model.ts";
import { createMockModel } from "../agent/mock-model.ts";
import loopSource from "../../src/agent/loop.ts?raw";
import toolsSource from "../../src/agent/tools.ts?raw";
import toolDefinitionSource from "../../src/tool.ts?raw";

const schema = z.object({ value: z.string() });

/** The two methods of an SDK tool entry these tests drive directly. */
interface SdkEntry {
  execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>;
  toModelOutput: (args: { toolCallId: string; input: unknown; output: unknown }) => { type: string; value: string };
}

function echoTool(onExecute?: (context: ToolContext) => void) {
  return defineTool<{ value: string }, { ok: boolean; seen: string }>({
    id: "echo",
    description: "echo",
    access: "read",
    inputSchema: schema,
    execute: async (_c, input) => {
      onExecute?.(await Promise.resolve({} as ToolContext));
      return { ok: true, seen: input.value };
    },
  });
}

/**
 * A store that survives a crash.
 *
 * The distinction that matters: `begun` and `done` are **separate records**,
 * exactly as `TurnStore` declares them — `beginToolCall` and `recordToolCall`
 * are two methods, and `getToolCall` returns whichever one exists, tagged with a
 * `status`. That `status` is the whole answer to C4, and the interface is the
 * evidence: without it, "began without outcome" is unrepresentable.
 */
interface CrashableStore extends TurnStore {
  began: string[];
  recorded: Map<string, unknown>;
  /** Simulates the tab dying the moment the call is marked as begun. */
  crasher: ((id: string) => void) | undefined;
}

function crashableStore(): CrashableStore {
  const began: string[] = [];
  const recorded = new Map<string, unknown>();
  const idOf = (key: ToolCallKey): string =>
    `${key.sessionId}#${key.attempt}#${key.toolCallId}#${key.occurrence}`;
  const store: CrashableStore = {
    began,
    recorded,
    crasher: undefined,
    async flushDelta() {},
    async closePart() {},
    async closeTurnParts() {},
    async finishTurn() {},
    async heartbeat() {},
    async listUnfinishedTurns() {
      return [];
    },
    async listTurnOutcomes() {
      return [];
    },
    async recordToolCall(input: { key: ToolCallKey; output: unknown }) {
      recorded.set(idOf(input.key), input.output);
    },
    async getToolCall(key: ToolCallKey) {
      // Keyed on the whole key: a store that keyed on the id alone could not
      // tell a replay from a provider reusing one.
      const id = idOf(key);
      if (recorded.has(id)) return { status: "done", output: recorded.get(id) };
      return began.includes(id) ? { status: "begun" } : undefined;
    },
    async beginToolCall(input: { key: ToolCallKey }) {
      began.push(idOf(input.key));
      store.crasher?.(input.key.toolCallId);
    },
  };
  return store;
}

const allowAll = { evaluate: () => ({ effect: "allow" as const }), recordAlways: async () => {} };

function makeTurn(model: ReturnType<typeof createMockModel>, store: TurnStore, tools: ReturnType<typeof createToolSet> extends never ? never : Parameters<typeof buildApprovalTargets>[0]["tools"]) {
  const events: AgentEvent[] = [];
  const t = new AgentTurn({
    model,
    instructions: "test",
    tools,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store,
    approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
    onEvent: (e) => events.push(e),
    approve: async () => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
  });
  return { turn: t, events };
}

const oneToolStep = (id: string) => ({
  parts: [toolCall({ toolCallId: id, toolName: "echo", input: { value: "x" } }), finish("tool-calls")] as MockStreamPart[],
});
const doneStep = { parts: [...text("t1", "ok"), finish("stop")] as MockStreamPart[] };

/* ================================================================== */
/* C4 — the crash window                                               */
/* ================================================================== */

describe("C4 · a crash between beginToolCall and recordToolCall", () => {
  it("the store interface CAN express 'began without an outcome'", () => {
    // The structural fact, inverted: `getToolCall` is fed by *both* writers and
    // tags which one it saw. `status: "begun"` is a representable state, so the
    // engine can answer "this may have run" instead of having to guess from an
    // absence.
    const sink = crashableStore();
    expect(typeof sink.getToolCall).toBe("function");
    expect(typeof sink.beginToolCall).toBe("function");
    expect(typeof sink.recordToolCall).toBe("function");
    expect(sink.began).toEqual([]);
    expect([...sink.recorded.keys()]).toEqual([]);
  });

  it("a begun record reads back as `begun`, and a recorded one as `done`", async () => {
    const store = crashableStore();
    const tools = [echoTool()];

    const first = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await first.turn.run("go");

    // The `tool-result` part arrived, so this one is finished.
    expect(await store.getToolCall({ sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 })).toEqual({
      status: "done",
      output: { ok: true, seen: "x" },
    });

    // Now the crash window: the begin survives, the outcome does not.
    store.recorded.clear();
    expect(await store.getToolCall({ sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 })).toEqual({
      status: "begun",
    });
  });

  it("FIXED: a begun-without-outcome call is NOT re-run on the next turn", async () => {
    // What used to happen: the short-circuit did not fire, the tool ran a
    // second time, and the turn still reported `succeeded`.
    const store = crashableStore();
    const tool = echoTool();
    const tools = [tool];

    const first = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await first.turn.run("go");
    store.recorded.clear(); // ← the crash window: began survives, outcome does not

    let executions = 0;
    const counting = echoTool(() => {
      executions += 1;
    });
    const second = makeTurn(
      createMockModel({ steps: [oneToolStep("c1"), doneStep] }),
      store,
      [counting as ReturnType<typeof echoTool>],
    );
    const result = await second.turn.run("go again");

    expect(executions).toBe(0);
    expect(result.outcome).toBe("succeeded");
    // …and it is not silently skipped either: the turn says the outcome is
    // unknown, so neither the model nor the user is left with a false premise.
    expect(result.unknownOutcomes).toEqual([{ toolCallId: "c1", toolName: "echo", input: { value: "x" } }]);
  });

  it("the residual risk, restated: a WRITE tool is NOT applied twice", async () => {
    // This was the residual risk: the tool below appends, and the engine's old
    // choice — re-run — produced `log === ["x","x"]` while the transcript showed
    // one write. Silent corruption of the user's files, unrecoverable by the
    // model. The trade now taken is the other one, and it is visible.
    const log: string[] = [];
    const append = defineTool<{ value: string }, { written: string[] }>({
      id: "echo",
      description: "append",
      access: "write",
      inputSchema: schema,
      execute: async (_c, input) => {
        log.push(input.value);
        return { written: [...log] };
      },
    });
    const store = crashableStore();
    const tools = [append];

    const first = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await first.turn.run("go");
    expect(log).toEqual(["x"]);

    store.recorded.clear(); // crash: the outcome never reached the store

    const second = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    const result = await second.turn.run("go again");

    // No second append.
    expect(log).toEqual(["x"]);
    // And the model is told to verify rather than to repeat, which is the one
    // instruction that is correct whether or not the first append landed.
    const results = second.events.filter((e) => e.type === "tool-result");
    expect(JSON.stringify(results.at(-1)?.output)).toContain("Do not repeat it blindly");
    expect(result.unknownOutcomes).toHaveLength(1);
  });

  it("a call that DID record its outcome is not re-run — the short-circuit holds", async () => {
    // The control, so C4's fix is not mistaken for "replay is broken".
    const store = crashableStore();
    const executions: number[] = [];
    const tool = echoTool(() => executions.push(1));
    const tools = [tool];
    const first = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await first.turn.run("go");
    expect(
      await store.getToolCall({ sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 }),
    ).toMatchObject({ status: "done" });

    const second = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await second.turn.run("go again");
    expect(executions).toHaveLength(1);
  });

  it("the user sees it: a `tool-outcome-unknown` event, not silence", async () => {
    const store = crashableStore();
    const tools = [echoTool()];
    const first = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await first.turn.run("go");
    store.recorded.clear();

    const second = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await second.turn.run("go again");

    const events = second.events.filter((event) => event.type === "tool-outcome-unknown");
    expect(events).toEqual([{ type: "tool-outcome-unknown", toolCallId: "c1", toolName: "echo", input: { value: "x" } }]);
  });

  it("FIXED: `getToolCall` is scoped to a session, an attempt and an occurrence", async () => {
    // `tool_invocations` has a `session_id` column (Plan.md §6.1) and the store
    // has a `sessionId`, but `getToolCall(toolCallId)` took only the id. A store
    // written to that interface could only key on the id, so two sessions that
    // minted the same toolCallId shared one short-circuit record.
    const storeDeclaration = loopSource.slice(
      loopSource.indexOf("export interface TurnStore"),
      loopSource.indexOf("/** A turn that a reload may have left open"),
    );
    expect(storeDeclaration).toContain("getToolCall(key: ToolCallKey)");
    expect(storeDeclaration).not.toMatch(/getToolCall\(toolCallId: string\)/);

    // The key itself, and all three parts of it.
    const keyDeclaration = toolsSource.slice(
      toolsSource.indexOf("export interface ToolCallKey"),
      toolsSource.indexOf("export type ToolCallRecord"),
    );
    expect(keyDeclaration).toContain("sessionId: string");
    expect(keyDeclaration).toContain("attempt: number");
    expect(keyDeclaration).toContain("toolCallId: string");
    expect(keyDeclaration).toContain("occurrence: number");
  });

  it("and two sessions that mint the same id do not share a record", async () => {
    const store = crashableStore();
    const tools = [echoTool()];
    const first = makeTurn(createMockModel({ steps: [oneToolStep("c1"), doneStep] }), store, tools);
    await first.turn.run("go");
    expect(
      await store.getToolCall({ sessionId: "s1", attempt: 1, toolCallId: "c1", occurrence: 0 }),
    ).toMatchObject({ status: "done" });

    // The same id, a different session: a fresh call, not a replay — and not
    // the other session's answer handed to this session's model.
    const other = new AgentTurn({
      model: createMockModel({ steps: [oneToolStep("c1"), doneStep] }),
      instructions: "test",
      tools,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s2",
      turnId: "t2",
      store,
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools }) }),
      onEvent: () => {},
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
    });
    const result = await other.run("go");
    expect(result.unknownOutcomes).toEqual([]);
    expect(
      await store.getToolCall({ sessionId: "s2", attempt: 1, toolCallId: "c1", occurrence: 0 }),
    ).toMatchObject({ status: "done" });
  });
});

/* ================================================================== */
/* C5 — parse before the replay short-circuit                          */
/* ================================================================== */

describe("C5 · a replayed call with malformed input", () => {
  const setUp = (recorded: Record<string, unknown>, input: unknown) => {
    const executed: string[] = [];
    const tool = defineTool<{ value: string }, string>({
      id: "t",
      description: "t",
      access: "read",
      inputSchema: schema,
      execute: async () => {
        executed.push("ran");
        return "ran";
      },
    });
    const toolSet = createToolSet({
      tools: [tool] as never,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      lookupToolCall: async (id) => (id in recorded ? { status: "done", output: recorded[id] } : undefined),
    });
    const entry = (toolSet as Record<string, SdkEntry>).t;
    if (entry === undefined) throw new Error("tool set has no entry for t");
    return { entry, executed, input };
  };

  it("returns the RECORDED result when the replayed input is well-formed", async () => {
    const { entry } = setUp({ c1: "recorded answer" }, { value: "x" });
    await expect(entry.execute({ value: "x" }, { toolCallId: "c1" })).resolves.toBe("recorded answer");
  });

  it("FINDING: throws a validation error instead, when the replayed input is malformed", async () => {
    // The consequence C5 asks about. The model re-sends a call whose id is
    // already recorded, but with `value: 42`. The user gets a validation
    // error — the recorded answer is not returned, and the model is told the
    // call was invalid rather than that it already happened.
    const { entry, executed } = setUp({ c1: "recorded answer" }, { value: 42 });
    await expect(entry.execute({ value: 42 }, { toolCallId: "c1" })).rejects.toThrow(/Invalid input for tool t/);
    expect(executed).toEqual([]);
  });

  it("and the error text names the schema, not the replay", async () => {
    const { entry } = setUp({ c1: "recorded answer" }, { value: 42 });
    await expect(entry.execute({ value: 42 }, { toolCallId: "c1" })).rejects.toThrow(/value/);
  });

  it("the schema still bounds the argument on the FIRST run", async () => {
    // The reason the order is defensible: without parsing first, a persisted
    // id could be used to smuggle an unvalidated input past the schema. This
    // is the guarantee the order buys.
    const { entry, executed } = setUp({}, { value: 42 });
    await expect(entry.execute({ value: 42 }, { toolCallId: "fresh" })).rejects.toThrow(/Invalid input/);
    expect(executed).toEqual([]);
  });
});

/* ================================================================== */
/* toModelOutput: the marker, the boundary, and what is persisted      */
/* ================================================================== */

describe("the model-facing output cap", () => {
  const { maxLines, maxBytes } = DEFAULT_TOOL_OUTPUT_LIMITS;

  it("leaves an output of EXACTLY the line limit alone", () => {
    const value = Array.from({ length: maxLines }, (_, i) => `line ${i}`).join("\n");
    const result = truncateToolOutput(value);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(value);
    expect(result.text).not.toContain(TRUNCATION_MARKER);
  });

  it("truncates one line over the limit, and says so", () => {
    const value = Array.from({ length: maxLines + 1 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateToolOutput(value);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(TRUNCATION_MARKER);
    expect(result.originalLines).toBe(maxLines + 1);
  });

  it("leaves an output of EXACTLY the byte limit alone", () => {
    const value = "a".repeat(maxBytes);
    expect(new TextEncoder().encode(value).length).toBe(maxBytes);
    const result = truncateToolOutput(value);
    expect(result.truncated).toBe(false);
  });

  it("truncates one byte over, and the result still respects the cap", () => {
    const result = truncateToolOutput("a".repeat(maxBytes + 1));
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(maxBytes);
  });

  it("the marker reports the ORIGINAL size, not the kept size", () => {
    const result = truncateToolOutput("a".repeat(maxBytes + 1));
    expect(result.text).toContain(`${maxBytes + 1} bytes shown in part`);
  });

  it("never truncates silently, at any boundary", () => {
    for (const n of [maxLines - 1, maxLines, maxLines + 1, maxBytes - 1, maxBytes, maxBytes + 1]) {
      const result = truncateToolOutput("a".repeat(n));
      expect(result.truncated).toBe(n > maxBytes);
      if (result.truncated) expect(result.text).toContain(TRUNCATION_MARKER);
    }
  });

  it("the transcript keeps the full value while the model sees the cap", async () => {
    // The claim under test: "transcript lossless, model capped".
    const full = "x".repeat(maxBytes + 5_000);
    const tool = defineTool<{ value: string }, string>({
      id: "t",
      description: "t",
      access: "read",
      inputSchema: schema,
      execute: async () => full,
    });
    const toolSet = createToolSet({
      tools: [tool] as never,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
    });
    const entry = (toolSet as Record<string, SdkEntry>).t;
    if (entry === undefined) throw new Error("tool set has no entry for t");

    // What the transcript records: the whole thing.
    const executed = await entry.execute({ value: "x" }, { toolCallId: "c1" });
    expect(executed).toBe(full);

    // What the model is shown: capped, with a marker.
    const shown = entry.toModelOutput({ toolCallId: "c1", input: { value: "x" }, output: executed });
    expect(shown.value.length).toBeLessThan(full.length);
    expect(shown.value).toContain(TRUNCATION_MARKER);
  });

  it("the DEFAULT rendering is what `question` used to get, and it does not frame", () => {
    // The question tool's own contract says framing is "Wave 2's job at the
    // toModelOutput seam". Core owned that seam and there was nothing to hook:
    // `ToolDefinition` had no `toModelOutput` field and `createSdkTool`
    // hard-coded one, so the answer reached the model as a bare JSON array of
    // labels with no indication of which question it answers.
    const output = { answers: [["SQLite WASM (Recommended)"]] };
    const rendered = renderToolOutput(output);
    expect(rendered).toBe('{"answers":[["SQLite WASM (Recommended)"]]}');
    expect(rendered).not.toContain("question");
    expect(rendered).not.toContain("user");
  });

  it("FIXED: the contract now has a per-tool seam, and the default is unchanged", () => {
    const interfaceBody = toolDefinitionSource.slice(
      toolDefinitionSource.indexOf("export interface ToolDefinition"),
      toolDefinitionSource.indexOf("/** Preserves the concrete input type"),
    );
    expect(interfaceBody).toContain("toModelOutput");
    // Optional, and returning `undefined` means "use the default" — so a tool
    // that does not care pays nothing.
    expect(interfaceBody).toMatch(/toModelOutput\?\(/);
  });
});

/* ================================================================== */
/* The heartbeat: the reload boundary, both sides                       */
/* ================================================================== */

describe("the heartbeat age threshold for `interrupted`", () => {
  it("FIXED: there is now a constant, a reader and age arithmetic", () => {
    // What was asked: which side of the boundary does `interrupted` fall on.
    // The answer used to be that no boundary existed — `heartbeat_at` was
    // written and never read, so a fresh turn was indistinguishable from a
    // stale one, and no `interrupted` in the loop was a reload recovery.
    expect(STALE_HEARTBEAT_MS).toBe(30_000);
    const code = loopSource.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).toMatch(/heartbeatAgeMs\(/);
    expect(code).toMatch(/isTurnStale\(/);
    // Written at the start of an attempt as well as per step, so a turn that
    // dies before its first `onStepEnd` still has an anchor.
    //
    // Whitespace-tolerant on purpose: the count is the property, not the line
    // breaking. An earlier version of this assertion was `/store\.heartbeat\(/`
    // and it silently stopped matching the moment the call was reformatted onto
    // two lines — a regex that measures formatting is a regex that reports
    // nothing.
    expect(code.match(/store\s*\.\s*heartbeat\s*\(/g) ?? []).toHaveLength(1);
    expect(code.match(/heartbeat\(\);/g) ?? []).toHaveLength(2);
    // And the discarded promise is not there any more: the failure of the one
    // write on this seam that is *not* awaited has to be reported, and a bare
    // `void` is the same silence as a `catch {}` with an extra step. Asserted on
    // the call site rather than on the word `void`, so the chained
    // `.catch(…)` right below it is exactly what keeps the assertion true.
    expect(code).not.toMatch(/store\s*\.\s*heartbeat\s*\([^)]*\)\s*;/);
  });

  it("a FRESH heartbeat is on the live side, both sides of the boundary", () => {
    const now = Date.parse("2026-09-29T12:00:30.000Z");
    expect(heartbeatAgeMs("2026-09-29T12:00:00.000Z", now)).toBe(30_000);
    // One millisecond below the boundary: still working.
    expect(isTurnStale("2026-09-29T12:00:00.001Z", now)).toBe(false);
    // Exactly on it: stale. The boundary is `>=`, documented on the constant.
    expect(isTurnStale("2026-09-29T12:00:00.000Z", now)).toBe(true);
    // Comfortably past it.
    expect(isTurnStale("2026-09-29T11:50:00.000Z", now)).toBe(true);
  });

  it("an unparsable heartbeat counts as stale, not as fresh", () => {
    // "I cannot tell how old this is" must resolve to the recoverable side.
    // Guessing 0 would keep a turn whose anchor is corrupt looking alive, which
    // is the silent direction.
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    expect(heartbeatAgeMs("not a date", now)).toBe(Number.POSITIVE_INFINITY);
    expect(isTurnStale("not a date", now)).toBe(true);
  });

  it("the recovery closes a STALE turn and leaves a LIVE one alone", async () => {
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    const closed: { turnId: string; error: string | undefined }[] = [];
    const store = {
      ...crashableStore(),
      async finishTurn(input: { turnId: string; outcome: string; error: string | undefined }) {
        closed.push({ turnId: input.turnId, error: input.error });
      },
      async listUnfinishedTurns() {
        return [
          { turnId: "dead", heartbeatAt: "2026-09-29T11:58:00.000Z", startedAt: "2026-09-29T11:57:00.000Z" },
          { turnId: "alive", heartbeatAt: "2026-09-29T11:59:59.000Z", startedAt: "2026-09-29T11:57:00.000Z" },
        ];
      },
    };

    const recovered = await recoverStaleTurns({ store, sessionId: "s1", nowMs: now });

    // Only the dead one. A fresh heartbeat means someone else is still working
    // on it, and closing that would kill a live turn in another tab.
    expect(recovered.map((turn) => turn.turnId)).toEqual(["dead"]);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.turnId).toBe("dead");
    // Said out loud: "interrupted" with no reason reads as a crash.
    expect(closed[0]?.error).toContain("no heartbeat for 120s");
  });

  it("a recovery with nothing to do writes nothing", async () => {
    let calls = 0;
    const store = {
      ...crashableStore(),
      async finishTurn() {
        calls += 1;
      },
      async listUnfinishedTurns() {
        return [{ turnId: "alive", heartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString() }];
      },
    };
    const recovered = await recoverStaleTurns({ store, sessionId: "s1" });
    expect(recovered).toEqual([]);
    expect(calls).toBe(0);
  });

  it("the attempt-scoped `interrupted` outcomes are still there, and are not the reload one", () => {
    expect(loopSource).toContain('"interrupted", "stopped"');
    expect(loopSource).toContain('"interrupted", "attempts exhausted"');
    expect(loopSource).toContain('"interrupted", "no response"');
  });
});
