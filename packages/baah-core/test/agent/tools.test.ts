/**
 * The `ToolDefinition` → AI SDK tool adapter.
 *
 * The properties under test are the ones whose failure is invisible: the schema
 * is passed through rather than re-derived, the abort signal reaches the tool,
 * and the model's copy of a large output is capped with a visible marker while
 * the transcript's copy is not.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineTool, type ToolContext, type ToolDefinition } from "../../src/tool.ts";
import { createMemoryWorkspace } from "../../src/workspace.ts";
import {
  createToolSet,
  DEFAULT_TOOL_OUTPUT_LIMITS,
  MissingToolCallIdError,
  renderToolOutput,
  truncateToolOutput,
  TRUNCATION_MARKER,
  type AiTool,
  type SdkCall,
} from "../../src/agent/tools.ts";

/** Recover the SDK's call options from the built tool, without an `any` escape. */
type ExecuteFn = (input: unknown, options: SdkCall) => Promise<unknown>;

function executeOf(tool: AiTool): ExecuteFn {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") throw new Error("tool has no execute");
  return execute as ExecuteFn;
}

function toModelOutputOf(tool: AiTool): (args: { toolCallId: string; input: unknown; output: unknown }) => { type: string; value: string } {
  const fn = (tool as { toModelOutput?: unknown }).toModelOutput;
  if (typeof fn !== "function") throw new Error("tool has no toModelOutput");
  return fn as (args: { toolCallId: string; input: unknown; output: unknown }) => { type: string; value: string };
}

const readSchema = z.object({ path: z.string(), limit: z.number().optional() });

/**
 * The erased input type.
 *
 * Declared with `limit?: number | undefined` rather than `limit?: number`
 * because `exactOptionalPropertyTypes` is on and zod's output carries an
 * explicit `undefined` for an absent optional key. This is the same friction the
 * adapter hits and is worth seeing in a test.
 */
type ReadInput = z.infer<typeof readSchema>;

function makeReadTool(overrides?: { run?: () => Promise<string> }): {
  tool: ToolDefinition<ReadInput, string>;
  seen: ToolContext[];
} {
  const seen: ToolContext[] = [];
  const tool = defineTool<ReadInput, string>({
    id: "read",
    description: "Read a file from the workspace.",
    access: "read",
    inputSchema: readSchema,
    async execute(context, input) {
      seen.push(context);
      return overrides?.run ? overrides.run() : `contents of ${input.path}`;
    },
  });
  return { tool, seen };
}

describe("the tool set", () => {
  it("is keyed by the tool id", () => {
    const { tool } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    expect(Object.keys(set)).toEqual(["read"]);
  });

  it("carries the id as the SDK tool name and the description verbatim", () => {
    const { tool } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    expect(set["read"]?.description).toBe("Read a file from the workspace.");
  });

  it("passes the zod schema through as the same object, not a copy", () => {
    // Plan.md §4.2: `inputSchema` is the ONE source of parameter truth. A
    // re-derived JSON Schema would be a second truth, and the untested one.
    const { tool } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    expect(set["read"]?.inputSchema).toBe(readSchema);
    expect(set["read"]?.inputSchema).toBe(tool.inputSchema);
  });

  it("keeps several tools side by side", () => {
    const { tool: read } = makeReadTool();
    const other = defineTool<{ n: number }, number>({
      id: "other",
      description: "other",
      access: "read",
      inputSchema: z.object({ n: z.number() }),
      execute: async () => 1,
    });
    const set = createToolSet({ tools: [read, other], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    expect(Object.keys(set).sort()).toEqual(["other", "read"]);
  });
});

describe("input validation", () => {
  it("passes the parsed input to the tool", async () => {
    const { tool, seen } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    const output = await executeOf(set["read"] as AiTool)({ path: "a.ts", limit: 10 }, { toolCallId: "call-1" });
    expect(output).toBe("contents of a.ts");
    expect(seen[0]?.workspace).toBeDefined();
  });

  it("refuses an input the schema rejects, and does not run the tool", async () => {
    const run = vi.fn(async () => "should not happen");
    const { tool } = makeReadTool({ run });
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });

    // A model that sends `path: 42` must not reach a filesystem call.
    await expect(executeOf(set["read"] as AiTool)({ path: 42 }, { toolCallId: "call-1" })).rejects.toThrow(
      /Invalid input for tool read/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("names the offending field in the error", async () => {
    const { tool } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    await expect(
      executeOf(set["read"] as AiTool)({ path: "a", limit: "many" }, { toolCallId: "call-1" }),
    ).rejects.toThrow(/limit/);
  });

  it("refuses to run without a call identity, rather than inventing one", async () => {
    // A fabricated `toolCallId` would never match a persisted id, so the replay
    // short-circuit would silently stop working — the exact failure the
    // mechanism exists to prevent.
    const { tool } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    await expect(executeOf(set["read"] as AiTool)({ path: "a" }, {})).rejects.toBeInstanceOf(MissingToolCallIdError);
  });
});

describe("abort propagation", () => {
  it("hands the SDK's abort signal to the tool", async () => {
    const { tool, seen } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    const controller = new AbortController();
    controller.abort();
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "call-1", abortSignal: controller.signal });
    expect(seen[0]?.signal.aborted).toBe(true);
  });

  it("merges the outer signal, so tearing down the turn stops a running tool", async () => {
    const { tool, seen } = makeReadTool();
    const outer = new AbortController();
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      signal: outer.signal,
    });
    outer.abort();
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "call-1" });
    expect(seen[0]?.signal.aborted).toBe(true);
  });

  it("aborts when either of two live signals fires", async () => {
    const { tool, seen } = makeReadTool();
    const outer = new AbortController();
    const perCall = new AbortController();
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      signal: outer.signal,
    });
    const promise = executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "call-1", abortSignal: perCall.signal });
    // The per-call signal alone must be enough; the tool is not waiting for the
    // whole turn to be torn down.
    perCall.abort();
    await promise;
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });
});

describe("the call identity in the tool context", () => {
  it("carries the SDK's toolCallId, so a tool can recognise its own replay", async () => {
    const { tool, seen } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "call-42" });
    expect(seen[0]?.toolCallId).toBe("call-42");
  });

  it("carries the attempt number, defaulting to 1", async () => {
    const { tool, seen } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "call-1" });
    expect(seen[0]?.attempt).toBe(1);
  });

  it("passes a retry's attempt number through", async () => {
    const { tool, seen } = makeReadTool();
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      attempt: 2,
    });
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "call-1" });
    expect(seen[0]?.attempt).toBe(2);
  });
});

describe("replay short-circuit", () => {
  function replaySetup() {
    const calls: unknown[] = [];
    const begin: unknown[] = [];
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async (_context, input) => {
        calls.push(input);
        return "fresh";
      },
    });
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      lookupExecutedToolCall: async (toolCallId) => (toolCallId === "known" ? { output: "recorded" } : undefined),
      beginToolCall: async (info) => {
        begin.push(info);
      },
    });
    return { set, calls, begin };
  }

  it("does not run the tool again for a known toolCallId", async () => {
    const { set, calls } = replaySetup();
    const output = await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "known" });
    expect(output).toBe("recorded");
    expect(calls).toEqual([]);
  });

  it("runs normally for an unknown toolCallId", async () => {
    const { set, calls } = replaySetup();
    const output = await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "fresh" });
    expect(output).toBe("fresh");
    expect(calls).toHaveLength(1);
  });

  it("does not mark a replayed call as newly started", async () => {
    // Marking it again would be harmless for a set-based lookup, but it would
    // reset any "in progress" timestamp the store keeps.
    const { set, begin } = replaySetup();
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "known" });
    expect(begin).toEqual([]);
  });

  it("marks the call as about-to-run BEFORE the tool executes", async () => {
    // The order is the point: after the tool ran, a crash would leave the call
    // unrecorded and a replay would run it a second time.
    const order: string[] = [];
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => {
        order.push("execute");
        return "done";
      },
    });
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      beginToolCall: async () => {
        order.push("begin");
      },
    });
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "c1" });
    expect(order).toEqual(["begin", "execute"]);
  });

  it("validates before the short-circuit lookup, so a bad replay is still refused", async () => {
    const calls: unknown[] = [];
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => {
        calls.push(1);
        return "x";
      },
    });
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      lookupExecutedToolCall: async () => ({ output: "recorded" }),
    });
    await expect(executeOf(set["read"] as AiTool)({ path: 99 }, { toolCallId: "known" })).rejects.toThrow(
      /Invalid input/,
    );
    expect(calls).toEqual([]);
  });
});

describe("the in-tool approve callback", () => {
  it("is not consulted for a read tool", async () => {
    // Plan.md §4.2: `read` runs free. Asking here would double-ask, because the
    // agent-level `toolApproval` already ran.
    const approve = vi.fn(async () => "deny" as const);
    const { tool } = makeReadTool();
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve });
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "c1" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("answers allow-once for a read tool without asking", async () => {
    // A read tool that calls `ctx.approve` itself must not be blocked.
    const probe = defineTool<{ path: string }, string>({
      id: "probe",
      description: "probe",
      access: "read",
      inputSchema: readSchema,
      execute: async (context) => context.approve({ toolId: "probe", summary: "s", detail: {} }),
    });
    const set2 = createToolSet({ tools: [probe], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "deny" });
    expect(await executeOf(set2["probe"] as AiTool)({ path: "a" }, { toolCallId: "c1" })).toBe("allow-once");
  });

  it("is consulted for a write tool, and its denial is returned to the caller", async () => {
    const approve = vi.fn(async () => "deny" as const);
    const tool = defineTool<{ path: string }, string>({
      id: "write",
      description: "write",
      access: "write",
      inputSchema: readSchema,
      execute: async (context) => {
        const decision = await context.approve({ toolId: "write", summary: "write a", detail: {} });
        return decision;
      },
    });
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve });
    expect(await executeOf(set["write"] as AiTool)({ path: "a" }, { toolCallId: "c1" })).toBe("deny");
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolId: "write" }));
  });
});

describe("tool errors reach the model as data", () => {
  it("returns a readable failure instead of throwing", async () => {
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => {
        throw new Error("ENOENT: no such file");
      },
    });
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });
    // Throwing would abort the step; the model needs to read the failure and
    // pick another path.
    expect(await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "c1" })).toEqual({
      ok: false,
      error: "ENOENT: no such file",
    });
  });

  it("reports the original throwable to the host as well", async () => {
    const onToolError = vi.fn();
    const boom = new Error("kaboom");
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => {
        throw boom;
      },
    });
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      onToolError,
    });
    await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "c1" });
    expect(onToolError).toHaveBeenCalledWith({ toolCallId: "c1", toolName: "read", error: boom });
  });
});

describe("output truncation", () => {
  it("leaves a small output alone", () => {
    const result = truncateToolOutput("one\ntwo\nthree");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("one\ntwo\nthree");
  });

  it("caps by lines and says so", () => {
    const input = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n");
    const result = truncateToolOutput(input);
    expect(result.truncated).toBe(true);
    expect(result.originalLines).toBe(5000);
    expect(result.text).toContain(TRUNCATION_MARKER);
    expect(result.text).toContain("5000 lines");
    // The kept body is within the cap plus the marker.
    expect(result.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMITS.maxLines + 3);
  });

  it("caps by bytes, not characters", () => {
    // 4 bytes per emoji: a character cap would let 4× the payload through.
    const input = "😀".repeat(DEFAULT_TOOL_OUTPUT_LIMITS.maxBytes);
    const result = truncateToolOutput(input);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMITS.maxBytes);
  });

  it("never exceeds the byte cap, counting the marker", () => {
    const input = "x".repeat(DEFAULT_TOOL_OUTPUT_LIMITS.maxBytes * 2);
    const result = truncateToolOutput(input, { maxLines: 1_000_000, maxBytes: 1_000 });
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(1_000);
  });

  it("reports the original size so the UI can show it", () => {
    const input = "a\nb\nc\nd";
    const result = truncateToolOutput(input, { maxLines: 2, maxBytes: 1_000 });
    expect(result.originalLines).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("honours caller-supplied limits, which is where the settings belong", () => {
    // Plan.md §14.3, item 10: the reference harness makes these configurable,
    // and the configuration belongs in the settings, not in the code.
    const result = truncateToolOutput("a\nb\nc", { maxLines: 2, maxBytes: 1_000 });
    expect(result.truncated).toBe(true);
  });

  it("truncates what the MODEL sees, not what the transcript keeps", async () => {
    const big = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => big,
    });
    const set = createToolSet({ tools: [tool], workspace: createMemoryWorkspace(), cwd: ".", approve: async () => "allow-once" });

    const executed = await executeOf(set["read"] as AiTool)({ path: "a" }, { toolCallId: "c1" });
    // The transcript and the database stay lossless.
    expect(executed).toBe(big);

    // Only the model-facing copy is capped, and it is visibly capped.
    const forModel = toModelOutputOf(set["read"] as AiTool)({ toolCallId: "c1", input: { path: "a" }, output: executed });
    expect(forModel.type).toBe("text");
    expect(forModel.value).toContain(TRUNCATION_MARKER);
    expect(forModel.value.length).toBeLessThan(big.length);
  });

  it("notifies the host that output was shortened", () => {
    const onTruncatedOutput = vi.fn();
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => "x".repeat(60_000),
    });
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      onTruncatedOutput,
    });
    toModelOutputOf(set["read"] as AiTool)({ toolCallId: "c1", input: { path: "a" }, output: "x".repeat(60_000) });
    expect(onTruncatedOutput).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "c1", toolName: "read" }),
    );
  });

  it("stays silent when nothing was truncated", () => {
    const onTruncatedOutput = vi.fn();
    const tool = defineTool<{ path: string }, string>({
      id: "read",
      description: "read",
      access: "read",
      inputSchema: readSchema,
      execute: async () => "short",
    });
    const set = createToolSet({
      tools: [tool],
      workspace: createMemoryWorkspace(),
      cwd: ".",
      approve: async () => "allow-once",
      onTruncatedOutput,
    });
    toModelOutputOf(set["read"] as AiTool)({ toolCallId: "c1", input: { path: "a" }, output: "short" });
    expect(onTruncatedOutput).not.toHaveBeenCalled();
  });
});

describe("renderToolOutput", () => {
  it("passes a string through unchanged", () => {
    expect(renderToolOutput("plain")).toBe("plain");
  });

  it("serialises an object", () => {
    expect(renderToolOutput({ files: 2 })).toBe('{"files":2}');
  });

  it("renders undefined as empty rather than the string 'undefined'", () => {
    expect(renderToolOutput(undefined)).toBe("");
  });

  it("survives a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    // A tool output we cannot stringify is still a fact to show, not a reason
    // to show nothing.
    expect(renderToolOutput(cyclic)).toContain("Object");
  });
});

describe("defaults", () => {
  it("are the reference harness limits", () => {
    expect(DEFAULT_TOOL_OUTPUT_LIMITS).toEqual({ maxLines: 2000, maxBytes: 51_200 });
  });
});
