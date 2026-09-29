/**
 * Permission mapping onto the SDK's `toolApproval` (Plan.md §7.6).
 *
 * Two properties are load-bearing and easy to get backwards:
 *
 * 1. **Last matching rule wins.** A ruleset is an ordered list; a new, narrower
 *    rule goes to the *end*. A "first match wins" engine looks correct on a
 *    two-rule ruleset and inverts on a three-rule one, so the tests use three.
 * 2. **A denial is a result, not an error.** It has to reach the model as a
 *    `tool-output-denied` it can read and route around. A thrown error reads to
 *    the model as a malfunction it should retry.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildApprovalTargets,
  createApprovalResolver,
  createRuleEnginePermissionEngine,
  toApprovalStatus,
  type ApprovalTarget,
  type PermissionEngine,
} from "../../src/agent/approval.ts";
import { DEFAULT_RULES, type Effect, type PermissionRule } from "../../src/permission.ts";
import { defineTool, type ToolDefinition } from "../../src/tool.ts";
import type { ApprovalResolver } from "../../src/agent/approval.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function rules(...entries: ReadonlyArray<readonly [string, string, Effect]>): PermissionRule[] {
  return entries.map(([action, resource, effect]) => ({
    action: action as PermissionRule["action"],
    resource,
    effect,
  }));
}

function tool(id: string, access: ToolDefinition["access"] = "read"): ToolDefinition<unknown, unknown> {
  return defineTool<unknown, unknown>({
    id,
    description: id,
    access,
    inputSchema: z.object({}) as unknown as z.ZodType<unknown>,
    execute: async () => id,
  });
}

/** A stub engine: the point of §16.4 is that the engine depends on the shape. */
function stubEngine(effect: Effect, reason?: string) {
  const evaluate = vi.fn((action: string, resources: string[]) => {
    const result = reason === undefined ? { effect } : { effect, reason };
    void action;
    void resources;
    return result as { effect: Effect; reason?: string };
  });
  const recordAlways = vi.fn(async () => {});
  const engine: PermissionEngine = { evaluate, recordAlways };
  return { engine, evaluate, recordAlways };
}

function resolve(
  engine: PermissionEngine,
  toolName: string,
  input: unknown = { path: "src/a.ts" },
  targets?: ReadonlyMap<string, ApprovalTarget>,
) {
  const resolver = createApprovalResolver({
    engine,
    targets: targets ?? new Map([[toolName, { action: "read", resource: (i) => (i as { path?: string }).path }]]),
  });
  const status = (
    resolver as unknown as (argument: { toolCall: { toolName: string; input: unknown } }) => unknown
  )({ toolCall: { toolName, input } });
  return status;
}

/* ------------------------------------------------------------------ */
/* The status mapping                                                  */
/* ------------------------------------------------------------------ */

describe("toApprovalStatus", () => {
  it("maps allow to not-applicable", () => {
    expect(toApprovalStatus("allow", undefined)).toBe("not-applicable");
  });

  it("maps ask to user-approval", () => {
    expect(toApprovalStatus("ask", undefined)).toBe("user-approval");
  });

  it("maps deny to a denied status carrying the reason", () => {
    expect(toApprovalStatus("deny", "no secrets")).toEqual({ type: "denied", reason: "no secrets" });
  });

  it("still denies when the engine gave no reason", () => {
    // A refusal with no explanation is a refusal, not an allow.
    expect(toApprovalStatus("deny", undefined)).toEqual({ type: "denied" });
  });

  it("ignores a reason on an allow — the SDK has nowhere to put it", () => {
    // `{type:'not-applicable'}` is typed `reason?: never`; passing a reason would
    // be a type error and would emit a response part we never send.
    expect(toApprovalStatus("allow", "because")).toBe("not-applicable");
  });
});

describe("the resolver", () => {
  it("passes allow straight through", () => {
    const { engine } = stubEngine("allow");
    expect(resolve(engine, "read")).toBe("not-applicable");
  });

  it("pauses the loop for ask", () => {
    const { engine } = stubEngine("ask");
    expect(resolve(engine, "read")).toBe("user-approval");
  });

  it("refuses a denied call, with the reason", () => {
    const { engine } = stubEngine("deny", "path is outside the workspace");
    expect(resolve(engine, "read")).toEqual({
      type: "denied",
      reason: "path is outside the workspace",
    });
  });

  it("substitutes a default reason for an unexplained denial", () => {
    // A refusal the user cannot read is a refusal they file as a bug.
    const { engine } = stubEngine("deny");
    expect(resolve(engine, "read")).toEqual({ type: "denied", reason: "denied by a permission rule" });
  });

  it("denies an unknown tool outright", () => {
    // No rule for it, and §7.1's answer to "no match" is ask — but a tool we do
    // not know cannot even be shown in a card, so it is denied.
    const { engine, evaluate } = stubEngine("allow");
    const status = resolve(engine, "mystery", {}, new Map());
    expect(status).toEqual({ type: "denied", reason: "unknown tool: mystery" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("passes the action and the resources to the engine", () => {
    const { engine, evaluate } = stubEngine("allow");
    resolve(engine, "read", { path: "src/index.ts" });
    expect(evaluate).toHaveBeenCalledWith("read", ["src/index.ts"]);
  });

  it("passes an empty resource list when the target cannot name one", () => {
    const { engine, evaluate } = stubEngine("allow");
    resolve(engine, "read", {}, new Map([["read", { action: "read", resource: () => undefined }]]));
    expect(evaluate).toHaveBeenCalledWith("read", []);
  });

  it("passes every resource of a multi-resource call", () => {
    const { engine, evaluate } = stubEngine("ask");
    resolve(
      engine,
      "edit",
      {},
      new Map([["edit", { action: "edit", resource: () => ["a.ts", "b.ts"] }]]),
    );
    expect(evaluate).toHaveBeenCalledWith("edit", ["a.ts", "b.ts"]);
  });

  it("records the decision, so the caller can persist it", () => {
    // §7.6: "Jede Entscheidung landet in `approvals`."
    const { engine } = stubEngine("ask");
    const resolver = createApprovalResolver({
      engine,
      targets: new Map([["read", { action: "read", resource: () => "a.ts" }]]),
    });
    (resolver as unknown as (a: { toolCall: unknown }) => unknown)({
      toolCall: { toolName: "read", input: {} },
    });
    expect(resolver.decisions).toEqual([
      { toolName: "read", action: "read", resources: ["a.ts"], effect: "ask", reason: undefined, status: "user-approval" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The real rule engine                                                */
/* ------------------------------------------------------------------ */

describe("the rule engine behind the narrow interface (Plan.md §7.1)", () => {
  it("last matching rule wins, not the first", () => {
    // Three rules, so an engine that stopped at the first match would pass a
    // two-rule test and invert here.
    const engine = createRuleEnginePermissionEngine({
      rules: rules(["read", "*", "deny"], ["read", "src/*", "allow"], ["read", "src/secret.ts", "deny"]),
    });
    expect(engine.evaluate("read", ["src/public.ts"])).toEqual({ effect: "allow" });
    expect(engine.evaluate("read", ["src/secret.ts"]).effect).toBe("deny");
    expect(engine.evaluate("read", ["other/file.ts"]).effect).toBe("deny");
  });

  it("appends a later rule to override an earlier one", () => {
    const base = rules(["read", "*.env", "ask"]);
    const before = createRuleEnginePermissionEngine({ rules: base });
    expect(before.evaluate("read", ["a.env"]).effect).toBe("ask");

    const after = createRuleEnginePermissionEngine({ rules: [...base, rules(["read", "a.env", "allow"])[0]!] });
    expect(after.evaluate("read", ["a.env"]).effect).toBe("allow");
  });

  it("no match means ask, never a silent allow", () => {
    // The rule that must not regress: an unmatched resource is a hole, not a
    // permission.
    const engine = createRuleEnginePermissionEngine({ rules: [] });
    expect(engine.evaluate("read", ["anything.ts"])).toEqual({ effect: "ask" });
  });

  it("any deny wins across several resources (Plan.md §7.3)", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["edit", "a.ts", "allow"], ["edit", "b.ts", "deny"]) });
    expect(engine.evaluate("edit", ["a.ts", "b.ts"]).effect).toBe("deny");
  });

  it("any ask wins when nothing is denied", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["edit", "a.ts", "allow"], ["edit", "b.ts", "ask"]) });
    expect(engine.evaluate("edit", ["a.ts", "b.ts"]).effect).toBe("ask");
  });

  it("a stored grant can upgrade an ask to an allow", () => {
    const engine = createRuleEnginePermissionEngine({
      rules: rules(["shell", "rm *", "ask"]),
      grants: rules(["shell", "rm *", "allow"]),
    });
    expect(engine.evaluate("shell", ["rm -rf build"])).toEqual({ effect: "allow" });
  });

  it("a stored grant can NEVER overrule a configured deny (Plan.md §7.5)", () => {
    // The reason grants live in a separate list: this is the whole point of it.
    const engine = createRuleEnginePermissionEngine({
      rules: rules(["shell", "rm *", "deny"]),
      grants: rules(["shell", "rm *", "allow"]),
    });
    expect(engine.evaluate("shell", ["rm -rf build"]).effect).toBe("deny");
  });

  it("evaluates a call with no nameable resource as `*`", () => {
    // Otherwise a tool with an unresolvable resource would have no ruleset to
    // match and would silently fall through.
    const engine = createRuleEnginePermissionEngine({ rules: rules(["*", "*", "allow"]) });
    expect(engine.evaluate("todo", []).effect).toBe("allow");
  });
});

describe("the three-way reply (Plan.md §7.5)", () => {
  it("once leaves the grants untouched", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["shell", "ls *", "ask"]) });
    const before = engine.state().grants.length;
    engine.reply("once", "shell", "ls -la");
    expect(engine.state().grants).toHaveLength(before);
    expect(engine.evaluate("shell", ["ls -la"]).effect).toBe("ask");
  });

  it("reject leaves the grants untouched", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["shell", "ls *", "ask"]) });
    engine.reply("reject", "shell", "ls -la");
    expect(engine.state().grants).toHaveLength(0);
  });

  it("always records a grant, so the next identical call is allowed", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["shell", "ls *", "ask"]) });
    engine.reply("always", "shell", "ls -la");
    expect(engine.state().grants.length).toBeGreaterThan(0);
    expect(engine.evaluate("shell", ["ls -la"]).effect).toBe("allow");
  });

  it("recordAlways is the async path used by the resolver", async () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["shell", "git status *", "ask"]) });
    await engine.recordAlways("shell", ["git status"]);
    expect(engine.evaluate("shell", ["git status"]).effect).toBe("allow");
  });

  it("a grant covers every resource it was recorded for", async () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["edit", "a.ts", "ask"], ["edit", "b.ts", "ask"]) });
    await engine.recordAlways("edit", ["a.ts", "b.ts"]);
    expect(engine.evaluate("edit", ["a.ts", "b.ts"]).effect).toBe("allow");
  });
});

/* ------------------------------------------------------------------ */
/* Target resolution (Plan.md §7.2)                                    */
/* ------------------------------------------------------------------ */

describe("buildApprovalTargets", () => {
  it("uses the §7.2 table for the standard tools", () => {
    const targets = buildApprovalTargets({
      tools: [tool("read"), tool("write"), tool("glob"), tool("grep"), tool("shell")],
    });
    expect(targets.get("read")?.action).toBe("read");
    expect(targets.get("write")?.action).toBe("edit");
    expect(targets.get("glob")?.action).toBe("glob");
    expect(targets.get("grep")?.action).toBe("grep");
    expect(targets.get("shell")?.action).toBe("shell");
  });

  it("judges read on the path", () => {
    const targets = buildApprovalTargets({ tools: [tool("read")] });
    expect(targets.get("read")?.resource({ path: "src/a.ts" })).toBe("src/a.ts");
  });

  it("judges grep on the regex, not the search path (§7.2 says so explicitly)", () => {
    const targets = buildApprovalTargets({ tools: [tool("grep")] });
    expect(targets.get("grep")?.resource({ pattern: "TODO", path: "src" })).toBe("TODO");
  });

  it("judges shell on the command string", () => {
    const targets = buildApprovalTargets({ tools: [tool("shell")] });
    expect(targets.get("shell")?.resource({ command: "git status" })).toBe("git status");
  });

  it("judges glob on the pattern", () => {
    const targets = buildApprovalTargets({ tools: [tool("glob")] });
    expect(targets.get("glob")?.resource({ pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("gives question and todo the `*` resource", () => {
    const targets = buildApprovalTargets({ tools: [tool("question"), tool("todo")] });
    expect(targets.get("question")?.resource({})).toBe("*");
    expect(targets.get("todo")?.resource({})).toBe("*");
  });

  it("todo is its own action, not a fallback to edit", () => {
    // The gap this closes: without a `todo` action a user cannot write a rule
    // about todo writes at all, because the access fallback maps it to `edit`.
    const targets = buildApprovalTargets({ tools: [tool("todo", "write")] });
    expect(targets.get("todo")?.action).toBe("todo");
  });

  it("a todo rule actually controls a todo call", () => {
    // End to end through the real rule engine: the rule must match, or the
    // action name is decoration.
    const engine = createRuleEnginePermissionEngine({ rules: rules(["todo", "*", "ask"]) });
    const targets = buildApprovalTargets({ tools: [tool("todo", "write")] });
    const resolver = createApprovalResolver({ engine, targets });
    const status = (
      resolver as unknown as (a: { toolCall: unknown }) => unknown
    )({ toolCall: { toolName: "todo", input: { todos: [] } } });
    expect(status).toBe("user-approval");
  });

  it("a todo deny actually blocks a todo call", () => {
    // Order matters: the catch-all allow goes FIRST, the todo deny after it, so
    // the last matching rule is the deny. Written the other way round the
    // catch-all would win and the test would pass for the wrong reason.
    const engine = createRuleEnginePermissionEngine({ rules: rules(["*", "*", "allow"], ["todo", "*", "deny"]) });
    const targets = buildApprovalTargets({ tools: [tool("todo", "write")] });
    const resolver = createApprovalResolver({ engine, targets });
    const status = (
      resolver as unknown as (a: { toolCall: unknown }) => unknown
    )({ toolCall: { toolName: "todo", input: { todos: [] } } });
    expect(status).toEqual({ type: "denied", reason: "denied by rule for todo" });
  });

  it("falls back to the access class for a tool with no table entry", () => {
    const targets = buildApprovalTargets({
      tools: [tool("mystery", "execute"), tool("fetchish", "network"), tool("reader", "read"), tool("writer", "write")],
    });
    expect(targets.get("mystery")?.action).toBe("shell");
    expect(targets.get("fetchish")?.action).toBe("webfetch");
    expect(targets.get("reader")?.action).toBe("read");
    expect(targets.get("writer")?.action).toBe("edit");
  });

  it("a fallback target names no resource, so a narrow rule cannot match by accident", () => {
    const targets = buildApprovalTargets({ tools: [tool("mystery", "execute")] });
    expect(targets.get("mystery")?.resource({ command: "rm -rf /" })).toBeUndefined();
  });

  it("an override beats the table", () => {
    const targets = buildApprovalTargets({
      tools: [tool("read")],
      overrides: { read: { action: "read", resource: () => "custom" } },
    });
    expect(targets.get("read")?.resource({ path: "ignored" })).toBe("custom");
  });

  it("returns a map keyed by tool id, one entry per tool", () => {
    const targets = buildApprovalTargets({ tools: [tool("read"), tool("write"), tool("shell")] });
    expect(targets.size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* The default policy                                                  */
/* ------------------------------------------------------------------ */

describe("the default policy (Plan.md §7.4)", () => {
  it("allows an ordinary read", () => {
    const engine = createRuleEnginePermissionEngine({ rules: DEFAULT_RULES });
    expect(engine.evaluate("read", ["src/index.ts"]).effect).toBe("allow");
  });

  it("asks before reading a secret", () => {
    const engine = createRuleEnginePermissionEngine({ rules: DEFAULT_RULES });
    expect(engine.evaluate("read", [".env"]).effect).toBe("ask");
  });

  it("asks before reading a secret in a subdirectory", () => {
    const engine = createRuleEnginePermissionEngine({ rules: DEFAULT_RULES });
    expect(engine.evaluate("read", ["config/.env"]).effect).toBe("ask");
  });

  it("allows .env.example — it is meant to be read", () => {
    const engine = createRuleEnginePermissionEngine({ rules: DEFAULT_RULES });
    expect(engine.evaluate("read", [".env.example"]).effect).toBe("allow");
  });

  it("asks for anything outside the workspace", () => {
    const engine = createRuleEnginePermissionEngine({ rules: DEFAULT_RULES });
    expect(engine.evaluate("external_directory", ["/etc"]).effect).toBe("ask");
  });

  it("the last-wins order is what makes .env.example readable", () => {
    // `*.env.*` matches `.env.example` too, so the allow has to come after it.
    const engine = createRuleEnginePermissionEngine({ rules: DEFAULT_RULES });
    expect(engine.evaluate("read", ["app/.env.example"]).effect).toBe("allow");
  });
});

describe("a denial is a result the model can read, not an error", () => {
  it("is delivered as a status, so no exception is thrown", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["*", "*", "allow"], ["read", "secret/*", "deny"]) });
    const targets = buildApprovalTargets({ tools: [tool("read")] });
    const resolver = createApprovalResolver({ engine, targets });

    let thrown: unknown;
    let status: unknown;
    try {
      status = (resolver as unknown as (a: { toolCall: unknown }) => unknown)({
        toolCall: { toolName: "read", input: { path: "secret/keys.txt" } },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    // `denied` is what the SDK turns into a `tool-output-denied` part, which the
    // model reads and can route around. A throw would read as a malfunction.
    expect(status).toEqual(expect.objectContaining({ type: "denied" }));
  });

  it("is not `not-applicable` — that would let the call through", () => {
    const engine = createRuleEnginePermissionEngine({ rules: rules(["read", "*", "deny"]) });
    const targets = buildApprovalTargets({ tools: [tool("read")] });
    const resolver = createApprovalResolver({ engine, targets });
    const status = (resolver as unknown as (a: { toolCall: unknown }) => unknown)({
      toolCall: { toolName: "read", input: { path: "a.ts" } },
    });
    expect(status).not.toBe("not-applicable");
    expect(status).not.toBe("user-approval");
  });
});

describe("the resolver satisfies the SDK's own configuration type", () => {
  it("is assignable to ToolLoopAgent's toolApproval without a cast", () => {
    // A compile-time check with a runtime confirmation: if the SDK's
    // `toolApproval` signature changed, this assignment would stop typechecking
    // rather than failing at runtime.
    const { engine } = stubEngine("allow");
    const targets = buildApprovalTargets({ tools: [tool("read")] });
    const resolver = createApprovalResolver({ engine, targets });

    const agentOptions: { toolApproval?: ApprovalResolver } = { toolApproval: resolver };
    expect(typeof agentOptions.toolApproval).toBe("function");
  });
});
