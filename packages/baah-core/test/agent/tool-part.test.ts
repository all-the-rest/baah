/**
 * The tool part the engine persists: `toolPartContent`, and the four call sites
 * that feed it.
 *
 * ## Why this file is the one that matters for a reloaded card
 *
 * A tool card is written **once per event** and read back **forever**. That
 * asymmetry is the whole risk: a state that is wrong while the turn is live
 * corrects itself when the next event arrives, and a state that is wrong in the
 * database does not. So every assertion below is made on the value
 * `toolPartContent` produces — the thing that is serialised into the row — and
 * not on a `RenderPart` derived from it, which is a read of a row that would
 * pass with the derivation deleted from either side.
 *
 * ## The two facts the rule is built on
 *
 * 1. **Every throw becomes a result.** `createSdkTool` catches everything
 *    `definition.execute` throws and returns `toToolErrorResult`'s
 *    `{ ok: false, error }` as an ordinary *result* (`src/tool.ts:118`). So the
 *    SDK reports `output-available` for a tool that failed, and the `tool-error`
 *    part — the only thing that would say otherwise — is effectively unreachable
 *    (`src/agent/loop.ts`, the `tool-error` case). **The value decides, not the
 *    envelope.**
 * 2. **One `ok: false` envelope is not a failure.** `tool-outcome-unknown`
 *    (`src/agent/tools.ts`) returns `{ ok: false, outcome: "unknown", … }` with an
 *    `error` string. It says the call began and never reported, so its effect is
 *    unknowable — and `Plan.md` §5.1 gives it its own node for that reason.
 *    Filing it as a failure paints "Fehlgeschlagen" onto the one card whose state
 *    is a warning, so it is excluded by its own discriminator, first.
 *
 * ## What is deliberately NOT here
 *
 * No rendering, no store, no SQL. This is the engine's half; the row is measured
 * in `packages/baah-storage/test/turn-store.test.ts`, and the app's copy of the
 * rule is what this file exists to let be deleted.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMemoryWorkspace } from "../../src/workspace.ts";
import { defineTool, ToolError, type ToolContext } from "../../src/tool.ts";
import { buildApprovalTargets, createApprovalResolver, type ApprovalResolver, type PermissionEngine } from "../../src/agent/approval.ts";
import {
  AgentTurn,
  toolPartContent,
  toolPartIdOf,
  toolResultFailure,
  toolStateForResult,
  type AgentEvent,
  type ToolCardState,
  type ToolPartContent,
  type ToolPartEvent,
  type TurnStore,
  type UnfinishedTurn,
} from "../../src/agent/loop.ts";
import { createMockModel, finish, text, toolCall } from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The value `createSdkTool` hands back for a tool that threw. */
const FAILURE = { ok: false, error: "ENOENT: no such file or directory" };

/**
 * The `tool-outcome-unknown` envelope, **verbatim in shape**.
 *
 * Copied from `src/agent/tools.ts` rather than invented here, and that is the
 * point of the test: the exclusion in `toolResultFailure` is only meaningful
 * against the real envelope. A fixture that dropped `outcome: "unknown"` would
 * pass with the exclusion deleted.
 */
const UNKNOWN = {
  ok: false,
  outcome: "unknown",
  toolCallId: "c1",
  toolName: "write",
  error:
    "This call to write began but never reported a result — the previous session ended " +
    "in the middle of it, so its effect may or may not have happened.",
  guidance: "Do not repeat it blindly. Check the current state first.",
};

const call = (input: unknown = { path: "a.ts" }): ToolPartEvent => ({
  type: "tool-call",
  toolCallId: "c1",
  toolName: "read",
  input,
});
const result = (output: unknown): ToolPartEvent => ({
  type: "tool-result",
  toolCallId: "c1",
  toolName: "read",
  output,
});
const errored = (message = "the SDK caught a rejection"): ToolPartEvent => ({
  type: "tool-error",
  toolCallId: "c1",
  toolName: "read",
  error: message,
});
const denied = (): ToolPartEvent => ({
  type: "tool-output-denied",
  toolCallId: "c1",
  toolName: "write",
  reason: undefined,
});

/** The state and the `errorText` of a written part, and nothing else. */
function written(event: ToolPartEvent): { state: ToolCardState; errorText: string | undefined } {
  const { data } = toolPartContent(event);
  return { state: data.state, errorText: data.errorText };
}

/* ================================================================== */
/* The rule itself: a failed tool is stored as a failure             */
/* ================================================================== */

describe("a tool that failed is persisted as a failure", () => {
  it("a tool-result carrying the failure envelope is NOT stored as output-available", () => {
    /**
     * The mutation this whole file exists for. Delete
     * `toolStateForResult` from `toolPartContent` and this reads
     * `output-available` — correct while the turn is live, because the live card
     * derives the state itself, and **permanently wrong afterwards**, because the
     * stored row is what a reload renders.
     */
    expect(written(result(FAILURE))).toEqual({
      state: "output-error",
      errorText: FAILURE.error,
    });
  });

  it("the failure's message is stored, so a reloaded card can say why", () => {
    // A row claiming `output-error` with nothing in it renders an empty red card,
    // which tells the user less than no badge at all.
    const { data } = toolPartContent(result(FAILURE));
    expect(data.errorText).toBe(FAILURE.error);
    expect(data.output).toBeUndefined();
  });

  it("a successful result is stored as a success, with its output", () => {
    expect(written(result({ ok: true, lines: 3 }))).toEqual({
      state: "output-available",
      errorText: undefined,
    });
    // The value is the output — kept whole, since the transcript is the truth
    // (`AGENTS.md` §3.1) and only the copy handed to the *model* is capped.
    expect(toolPartContent(result({ ok: true, lines: 3 })).data.output).toEqual({ ok: true, lines: 3 });
  });

  it("a `tool-error` event is stored as a failure even though its value is a string", () => {
    // The other direction, and the one that catches a mapping that derives the
    // state from the **value** alone: `toolResultFailure` reads the object
    // envelope, and this event's payload is a plain string, so a
    // value-only derivation would store a rejection as a success. The event is a
    // fact the engine reported on purpose, so it is kept.
    expect(written(errored("boom"))).toEqual({ state: "output-error", errorText: "boom" });
  });

  it("a denial is not an error — §7.6's refusal keeps its own state", () => {
    // A denial has no output at all, so nothing can promote it, and the state
    // stays `output-denied`. A card wearing the failure state would tell the
    // user the tool broke when the model read a perfectly good refusal.
    expect(written(denied())).toEqual({ state: "output-denied", errorText: undefined });
  });

  it("a call is stored as `input-available`, and the input is its value", () => {
    const { data, contentText } = toolPartContent(call({ path: "src/app.ts" }));
    expect(data.state).toBe("input-available");
    expect(data.input).toEqual({ path: "src/app.ts" });
    // `content_text` is §6.1's searchable projection, and for a tool part it is
    // the rendered input: a search for the path finds the call that made it.
    expect(contentText).toBe('{"path":"src/app.ts"}');
  });
});

/* ================================================================== */
/* The one envelope that must not be claimed                          */
/* ================================================================== */

describe("the outcome-unknown envelope is not a failure", () => {
  it("is stored as a success, because it is not one", () => {
    /**
     * The envelope arrives as a `tool-result`'s **output** — `tools.ts` returns it
     * from `execute`, so the SDK reports a result. It carries `ok: false` and an
     * `error` string, so a check that reads only `ok` stores
     * `output-error` and paints "Fehlgeschlagen" onto a call whose effect is
     * genuinely unknown. `Plan.md` §5.1 gives that situation its own node for
     * exactly this reason.
     */
    expect(written(result(UNKNOWN))).toEqual({ state: "output-available", errorText: undefined });
  });

  it("the exclusion is on its own discriminator, checked before `ok`", () => {
    // Measured on the exported check, not only on the stored row, so the *order*
    // of the two guards is visible: a swap would still return `undefined` here,
    // but the row is what the app reads.
    expect(toolResultFailure(UNKNOWN)).toBeUndefined();
    // And a genuine failure next to it still reads as one — so the exclusion is
    // not "anything with an `outcome` is fine".
    expect(toolResultFailure({ ...UNKNOWN, outcome: "rejected" })).toBe(UNKNOWN.error);
  });

  it("a `tool-outcome-unknown` EVENT is not a `ToolPartEvent` at all", () => {
    // The other half, and it is a *type* fact rather than a runtime one: the
    // event has its own node in the transcript because a card claiming an outcome
    // is the lie §5.1 is written against. So there is no state to write, and
    // `Extract` makes "pass it to `upsertPart`" a compile error rather than a
    // runtime branch that nobody exercises.
    const event: AgentEvent = {
      type: "tool-outcome-unknown",
      toolCallId: "c1",
      toolName: "write",
      input: { path: "a.ts" },
    };
    // The check is the *assignment* below, and it is a compile error rather than
    // a runtime branch nobody exercises. A fifth `ToolPartEvent` member would
    // have to be written here deliberately.
    type Accepted = Extract<typeof event, ToolPartEvent>;
    const _rejected: Accepted extends never ? true : false = true;
    void _rejected;
    // …and the four that *are* accepted, so the `Extract` is not vacuously empty.
    const accepted: ToolPartEvent[] = [call(), result({ ok: true }), errored(), denied()];
    expect(accepted.map((event) => event.type)).toEqual([
      "tool-call",
      "tool-result",
      "tool-error",
      "tool-output-denied",
    ]);
  });
});

/* ================================================================== */
/* Envelope vs. value — the two are distinguishable in both directions  */
/* ================================================================== */

describe("the state comes from the value, and the envelope cannot overrule it", () => {
  it("an `ok: false` with no message is not a failure — a tool may return that", () => {
    // A tool is free to return `{ ok: false }` as an ordinary value. A check that
    // only read the flag would store a failure with nothing to render, and
    // `errorText` has to be a **non-empty string** for a badge to be honest.
    expect(written(result({ ok: false }))).toEqual({
      state: "output-available",
      errorText: undefined,
    });
    expect(toolResultFailure({ ok: false })).toBeUndefined();
    expect(toolResultFailure({ ok: false, error: "" })).toBeUndefined();
  });

  it("only `output-available` is reconsidered — the other states are facts", () => {
    // `output-denied` is a refusal and `output-error` is an SDK-caught
    // rejection. Re-deciding either from a value would let a tool's own payload
    // overrule the engine, and the reverse case matters too: a *success* value
    // must not clear a state the engine set deliberately.
    const failure = toolStateForResult("output-available", FAILURE);
    const success = toolStateForResult("output-error", { ok: true });
    const refusal = toolStateForResult("output-denied", FAILURE);

    expect(failure).toBe("output-error");
    expect(success).toBe("output-error");
    expect(refusal).toBe("output-denied");
  });

  it("a non-object value is never a failure, whatever it is", () => {
    for (const value of [undefined, null, "ok", 42, true, [], [{ ok: false, error: "x" }]]) {
      expect(toolResultFailure(value), String(value)).toBeUndefined();
    }
  });
});

/* ================================================================== */
/* The row the engine asks for                                        */
/* ================================================================== */

describe("the part id and the blob", () => {
  it("is derived from the toolCallId, so three events are one row", () => {
    // The same call is reported up to three times (call, result, and again on a
    // replay). Three minted ids would be three rows for one call, and the
    // transcript would show a card that never stops updating next to two that
    // froze.
    expect(toolPartIdOf("c1")).toBe("part-c1");
    const ids = [call(), result({ ok: true }), denied()].map((event) =>
      toolPartIdOf(event.toolCallId),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("carries the tool name in the discriminator, as §6.1's three types require", () => {
    // `ToolUIPart`'s `type` is `` `tool-${NAME}` `` and there is no `toolName`
    // field — so a reader looking for one finds nothing, which was a real
    // `undefined` here before the discriminator was filled.
    expect(toolPartContent(call()).data.type).toBe("tool-read");
    expect(toolPartContent(denied()).data.type).toBe("tool-write");
  });

  it("keeps the call's `toolCallId` in the blob, so a card can be matched to its call", () => {
    expect(toolPartContent(call()).data.toolCallId).toBe("c1");
  });

  it("survives a value that cannot be serialised, without losing the id", () => {
    // A cycle throws in `JSON.stringify` and a function returns `undefined`. The
    // engine's projection (`contentText`) handles both, and the adapter's
    // `serialiseData` falls back rather than dropping the card — measured in
    // `baah-storage`, because that is where the serialisation lives. What is
    // measurable here is that the *value* handed over is still a usable object.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    const content: ToolPartContent = toolPartContent(call(cyclic));
    expect(content.partId).toBe("part-c1");
    expect(content.data.state).toBe("input-available");
    expect(content.contentText).toBeTypeOf("string");
  });
});

/* ================================================================== */
/* The four call sites — the engine really does persist tool parts    */
/* ================================================================== */

const echoSchema = z.object({ value: z.string() });
const allowAll: PermissionEngine = { evaluate: () => ({ effect: "allow" }), recordAlways: async () => {} };

/** A tool that fails, so the SDK's *result* path carries the envelope. */
function failingTool(): ReturnType<typeof defineTool> {
  return defineTool<{ value: string }, unknown>({
    id: "flaky",
    description: "Always throws.",
    access: "read",
    inputSchema: echoSchema,
    execute: async (): Promise<unknown> => {
      throw new ToolError("the file vanished");
    },
  });
}

function okTool(): ReturnType<typeof defineTool> {
  return defineTool<{ value: string }, { ok: true; seen: string }>({
    id: "echo",
    description: "Echo a value back.",
    access: "read",
    inputSchema: echoSchema,
    execute: async (_context: ToolContext, input) => ({ ok: true, seen: input.value }),
  });
}

/** Every tool part the engine wrote, in order, with what it wrote. */
interface ToolPartLog {
  readonly writes: { partId: string; state: ToolCardState; errorText: string | undefined }[];
  /** The store's own call order, so "the call came before the result" is real. */
  readonly calls: string[];
  readonly events: AgentEvent[];
  /** A rejection the caller can install, to measure the warning path. */
  failNextWrite: unknown | undefined;
}

function recordingStore(log: ToolPartLog): TurnStore {
  return {
    async appendTurn() {},
    async appendMessage() {},
    async upsertPart(input) {
      const content = toolPartContent(input.event);
      log.calls.push(`upsertPart:${content.partId}:${content.data.state}`);
      log.writes.push({
        partId: content.partId,
        state: content.data.state,
        errorText: content.data.errorText,
      });
      if (log.failNextWrite !== undefined) {
        const error = log.failNextWrite;
        log.failNextWrite = undefined;
        throw error;
      }
    },
    async flushDelta() {},
    async closePart() {},
    async closeTurnParts() {},
    async finishTurn() {},
    async heartbeat() {},
    async listUnfinishedTurns(): Promise<readonly UnfinishedTurn[]> {
      return [];
    },
    async listTurnOutcomes() {
      return [];
    },
    async recordToolCall() {},
    async getToolCall() {
      return undefined;
    },
    async beginToolCall() {},
  };
}

async function runTurnWithTool(options: {
  steps: Parameters<typeof createMockModel>[0]["steps"];
  tool: ReturnType<typeof defineTool>;
  log: ToolPartLog;
}): Promise<void> {
  const tools = [options.tool];
  const approval: ApprovalResolver = createApprovalResolver({
    engine: allowAll,
    targets: buildApprovalTargets({ tools }),
  });
  const turn = new AgentTurn({
    model: createMockModel({ steps: options.steps }),
    instructions: "test",
    tools,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store: recordingStore(options.log),
    approval,
    onEvent: (event) => {
      options.log.events.push(event);
    },
    approve: async () => "allow-once",
    sleep: async () => undefined,
    random: () => 0.5,
  });
  await turn.run("go");
}

function freshLog(): ToolPartLog {
  return { writes: [], calls: [], events: [], failNextWrite: undefined };
}

/** One step that calls the tool, then one that finishes the turn. */
const callingSteps = (name: string) => [
  {
    parts: [
      { type: "tool-input-start" as const, id: "c1", toolName: name },
      toolCall({ toolCallId: "c1", toolName: name, input: { value: "x" } }),
      finish("tool-calls"),
    ],
  },
  { parts: [...text("t1", "done"), finish("stop")] },
];

describe("the engine persists tool parts, on every one of the four events", () => {
  it("a successful call is written twice: the call, then the result", async () => {
    const log = freshLog();
    await runTurnWithTool({ steps: callingSteps("echo"), tool: okTool(), log });

    expect(log.writes).toEqual([
      { partId: "part-c1", state: "input-available", errorText: undefined },
      { partId: "part-c1", state: "output-available", errorText: undefined },
    ]);
    // And the two land in that order, on the same row. This is the ordering the
    // `await` at the call site buys: fired rather than awaited, a result can be
    // overtaken by the call it follows and the row ends up back at
    // `input-available` — a card frozen mid-flight, persisted, surviving every
    // reload.
    expect(log.calls).toEqual([
      "upsertPart:part-c1:input-available",
      "upsertPart:part-c1:output-available",
    ]);
  });

  it("a tool that throws is stored as a failure, from a `tool-result`", async () => {
    /**
     * The end-to-end half of the rule, and the one a unit test on
     * `toolPartContent` cannot reach: it needs `createSdkTool` to actually
     * convert the throw into a result, which only happens inside a real turn.
     */
    const log = freshLog();
    await runTurnWithTool({ steps: callingSteps("flaky"), tool: failingTool(), log });

    expect(log.writes).toEqual([
      { partId: "part-c1", state: "input-available", errorText: undefined },
      { partId: "part-c1", state: "output-error", errorText: "the file vanished" },
    ]);
    // The `tool-error` event never fired — measured, not assumed. The engine's
    // own comment on that branch says so; this is the measurement, and it is why
    // the value rather than the envelope is what the state is derived from.
    expect(log.events.map((event) => event.type)).not.toContain("tool-error");
    expect(log.events.filter((event) => event.type === "tool-result")).toHaveLength(1);
  });

  it("the failure's text is the tool's, not a wrapper's — no stack trace is stored", () => {
    // `toToolErrorResult` returns the message; the persisted row is what a card
    // shows, and `AGENTS.md` §5 says what the user sees must not be a stack.
    expect(toolResultFailure(FAILURE)).toBe(FAILURE.error);
    expect(toolResultFailure(FAILURE)).not.toContain("at ");
  });

  it("a replayed call folds into the same row instead of adding one", async () => {
    // The upsert is keyed on the derived part id, so a second turn that replays
    // the same `toolCallId` writes over the row. A minted id would have produced
    // a second card for one call.
    const log = freshLog();
    await runTurnWithTool({ steps: callingSteps("echo"), tool: okTool(), log });
    await runTurnWithTool({ steps: callingSteps("echo"), tool: okTool(), log });

    expect(new Set(log.writes.map((write) => write.partId)).size).toBe(1);
    expect(log.writes).toHaveLength(4);
  });

  it("a store that cannot take the row is a `storage-warning`, and the turn still finishes", async () => {
    /**
     * The failure path, and the asymmetry with `flushDelta` stated here rather
     * than left to be inferred: a lost tool part costs a card **after a reload**,
     * while a lost delta costs a sentence. So the write is awaited (for the
     * ordering) and its rejection only warns — the model already holds the tool's
     * real output and the call really did happen.
     */
    const log = freshLog();
    // A `StorageError`-shaped rejection, and the `name` is what the event's
    // `message` carries. This assertion used to read `message: "database_closed"`,
    // i.e. it required the store's own text — one of the six assertions that
    // pinned the key leak in `describeStorageFailure`. A `toBe` on a class rather
    // than a `not.toContain` on a token, so a constant cannot pass it and the
    // useful half is pinned too.
    const failure = new Error("database_closed: the statement arrived after close()") as Error & {
      code: string;
    };
    failure.name = "StorageError";
    failure.code = "database_closed";
    log.failNextWrite = failure;
    await runTurnWithTool({ steps: callingSteps("echo"), tool: okTool(), log });

    const warnings = log.events.filter((event) => event.type === "storage-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      operation: "upsert-part",
      toolCallId: "c1",
      toolName: "echo",
      message: "StorageError",
    });
    // The turn carried on to its outcome — a bookkeeping write that made the
    // answer disappear would be the wrong trade.
    expect(log.events.filter((event) => event.type === "turn-finished")).toHaveLength(1);
    // Both writes were *attempted*: the first was rejected and the second — the
    // result, which is the one that matters — went through. That asymmetry is
    // the property: a rejected call write must not abort the result write, or
    // the card would be stuck in flight in the database rather than merely
    // wrong. `writes` records the attempt, so both are here.
    expect(log.writes).toEqual([
      { partId: "part-c1", state: "input-available", errorText: undefined },
      { partId: "part-c1", state: "output-available", errorText: undefined },
    ]);
  });
});
