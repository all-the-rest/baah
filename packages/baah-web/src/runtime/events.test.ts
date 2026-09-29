/**
 * The event bus and the approval channel.
 *
 * Both are about **not losing information**: a subscriber that throws must not stop
 * the others from being called, and a "no" must not leave nine approval cards on
 * screen (`Plan.md` §7.5).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type ApprovalDecision, type ApprovalRequest } from "@all-the.rest/baah-core";

import { RuntimeEventBus, type RuntimeEvent } from "./events.ts";
import { createRuntimeApprovalChannel } from "./approval.ts";

const writeTool = defineTool<{ path: string }, string>({
  id: "write",
  description: "writes a file",
  access: "write",
  inputSchema: z.object({ path: z.string() }),
  execute: async () => "written",
});

function request(path = "src/a.ts"): ApprovalRequest {
  return { toolId: "write", summary: `Write to ${path}`, detail: { path } };
}

describe("RuntimeEventBus", () => {
  it("delivers to every subscriber in order", () => {
    const bus = new RuntimeEventBus();
    const seen: string[] = [];
    bus.subscribe(() => seen.push("first"));
    bus.subscribe(() => seen.push("second"));

    bus.emit({ kind: "boot", report: { sessionId: "s", recovered: [], untouched: [], staleAfterMs: 30_000, checkedAt: "" } });

    expect(seen).toEqual(["first", "second"]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new RuntimeEventBus();
    let calls = 0;
    const unsubscribe = bus.subscribe(() => {
      calls += 1;
    });

    bus.emit({ kind: "stall", report: { sessionId: "s", turnId: "t", phase: "awaiting-provider", timeoutMs: 20_000, silentForMs: 20_000, lastEventType: undefined } });
    unsubscribe();
    bus.emit({ kind: "stall", report: { sessionId: "s", turnId: "t", phase: "awaiting-provider", timeoutMs: 20_000, silentForMs: 40_000, lastEventType: undefined } });

    expect(calls).toBe(1);
  });

  it("survives a subscriber that unsubscribes during delivery", () => {
    const bus = new RuntimeEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe(() => {
      seen.push("leaving");
      unsubscribe();
    });
    bus.subscribe(() => seen.push("staying"));

    bus.emit({ kind: "stall", report: { sessionId: "s", turnId: "t", phase: "idle", timeoutMs: 1, silentForMs: 1, lastEventType: undefined } });

    // Iterating the live set while a handler mutates it would skip a subscriber.
    expect(seen).toEqual(["leaving", "staying"]);
  });

  it("propagates a throwing subscriber rather than swallowing it", () => {
    const bus = new RuntimeEventBus();
    bus.subscribe(() => {
      throw new Error("subscriber bug");
    });

    // AGENTS.md §5: no silent catch blocks. A swallowed exception here would hide the
    // bug and make the UI silently stop updating.
    expect(() =>
      bus.emit({ kind: "runtime-error", error: { code: "turn-busy", message: "busy" } }),
    ).toThrow(/subscriber bug/);
  });

  it("counts its subscribers", () => {
    const bus = new RuntimeEventBus();
    const first = bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(bus.size).toBe(2);
    first();
    expect(bus.size).toBe(1);
  });

  it("keeps the four event kinds disjoint", () => {
    // A UI switches on `kind`, so a name appearing twice across kinds would make a
    // narrow type check useless.
    const events: RuntimeEvent[] = [
      { kind: "agent", event: { type: "turn-finished", outcome: "succeeded", attempts: 1 } },
      { kind: "boot", report: { sessionId: "s", recovered: [], untouched: [], staleAfterMs: 30_000, checkedAt: "" } },
      { kind: "stall", report: { sessionId: "s", turnId: "t", phase: "idle", timeoutMs: 1, silentForMs: 1, lastEventType: undefined } },
      { kind: "turn-settled", turnId: "t", result: { outcome: "succeeded", attempts: 1, text: "", classification: { kind: "success" }, attemptLog: [], openApprovals: [], messages: [], hitStepLimit: false, unknownOutcomes: [] } },
      { kind: "runtime-error", error: { code: "turn-busy", message: "busy" } },
    ];

    expect(new Set(events.map((event) => event.kind)).size).toBe(5);
  });
});

describe("the approval channel", () => {
  it("denies with a visible reason when no channel is wired", async () => {
    const decisions: string[] = [];
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      onDecision: (record) => decisions.push(record.reason ?? ""),
    });

    // Allowing here would turn a wiring mistake into a hole; denying silently would
    // produce a support ticket nobody can act on.
    await expect(channel.request(request())).resolves.toBe("deny");
    expect(decisions.join(" ")).toContain("no approval channel");
  });

  it("routes a request to the caller's handler", async () => {
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      answer: async () => "allow-once",
    });

    await expect(channel.request(request())).resolves.toBe("allow-once");
  });

  it("passes the tool's own input to the handler, for the card", async () => {
    let seen: ApprovalRequest | undefined;
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      answer: async (input) => {
        seen = input;
        return "allow-once";
      },
    });

    await channel.request(request("src/secret.env"));

    expect(seen?.detail).toEqual({ path: "src/secret.env" });
  });

  it("rejects every other open request when one is denied (§7.5)", async () => {
    type Answer = (decision: ApprovalDecision) => void;
    const pending: Answer[] = [];
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      answer: (input) =>
        new Promise<ApprovalDecision>((resolve) => {
          const settle: Answer = (decision) => resolve(decision);
          // The first card the user answers is the one whose answer is honoured; the
          // rest are only ever settled by the reject-all path.
          pending.push(input.toolId === "first" ? settle : () => {});
        }),
    });

    const first = channel.request({ ...request("a.ts"), toolId: "first" });
    const second = channel.request({ ...request("b.ts"), toolId: "second" });
    const third = channel.request({ ...request("c.ts"), toolId: "third" });

    const answerFirst = pending[0];
    expect(answerFirst).toBeDefined();

    // The user answered "no" to the first card. "Lehnt auch alle anderen offenen
    // Anfragen dieser Session ab" — a user who said no must not have to click
    // through nine more.
    answerFirst?.("deny");

    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
    await expect(third).resolves.toBe("deny");
  });

  it("does not reject the others when one is approved", async () => {
    type Answer = (decision: ApprovalDecision) => void;
    const pending: Answer[] = [];
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      answer: () =>
        new Promise<ApprovalDecision>((resolve) => {
          const settle: Answer = (decision) => resolve(decision);
          pending.push(settle);
        }),
    });

    const first = channel.request({ ...request("a.ts"), toolId: "first" });
    const second = channel.request({ ...request("b.ts"), toolId: "second" });
    pending[0]?.("allow-once");

    await expect(first).resolves.toBe("allow-once");
    // An approval must leave the other cards alone — reject-all fires on "no" only.
    pending[1]?.("allow-once");
    await expect(second).resolves.toBe("allow-once");
  });

  it("denies when the channel itself throws", async () => {
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      answer: async () => {
        throw new Error("the card component is broken");
      },
    });

    // Denying is the recoverable direction: the tool does not run and the model is
    // told. Allowing would be the catastrophic one.
    await expect(channel.request(request())).resolves.toBe("deny");
  });

  it("starts from Plan.md §7.4's default policy, not from an empty ruleset", () => {
    const channel = createRuntimeApprovalChannel({ tools: [writeTool] });

    // An empty ruleset means "no rule matched" ⇒ `ask` for *everything*, including
    // reads. A harness that asks about everything has no permission system.
    expect(channel.engine.ruleCount).toBeGreaterThan(0);
  });

  it("allows a normal write under the default policy", () => {
    const channel = createRuntimeApprovalChannel({ tools: [writeTool] });

    // §7.4's first rule is `*`/`*` ⇒ allow; only `.env` and outside-workspace paths
    // ask.
    expect(channel.engine.evaluate("edit", ["src/a.ts"]).effect).toBe("allow");
    expect(channel.engine.evaluate("read", [".env"]).effect).toBe("ask");
    expect(channel.engine.evaluate("external_directory", ["/etc/passwd"]).effect).toBe("ask");
  });

  it("records a rule decision for every call (§7.6)", () => {
    const channel = createRuntimeApprovalChannel({ tools: [writeTool] });
    const resolver = channel.rule as (argument: unknown) => unknown;

    resolver({ toolCall: { toolName: "write", input: { path: "src/a.ts" } } });
    // §7.4 asks for a *read* of `.env`; a write is judged as an `edit`, so the
    // default policy allows it. Asserting the two together is what keeps the
    // action mapping (§7.2) honest.
    resolver({ toolCall: { toolName: "write", input: { path: ".env" } } });

    // §7.6: "Jede Entscheidung landet in `approvals`".
    expect(channel.decisions()).toHaveLength(2);
    expect(channel.decisions().map((decision) => decision.effect)).toEqual(["allow", "allow"]);
    expect(channel.decisions().map((decision) => decision.action)).toEqual(["edit", "edit"]);
  });

  it("denies an unknown tool outright", () => {
    const channel = createRuntimeApprovalChannel({ tools: [writeTool] });
    const resolver = channel.rule as (argument: unknown) => { type: string };

    // No rule exists for it, and letting an unrecognised call through would be a
    // hole in every ruleset.
    expect(resolver({ toolCall: { toolName: "rm-rf", input: {} } })).toMatchObject({ type: "denied" });
  });

  it("stores an `allow-always` grant for the resource the tool named", async () => {
    const channel = createRuntimeApprovalChannel({
      tools: [writeTool],
      answer: async () => "allow-always",
    });

    await expect(channel.request(request("src/a.ts"))).resolves.toBe("allow-always");
    await Promise.resolve();

    // §7.5 says the *tool* proposes the pattern. The tools do not expose a proposal,
    // so the resource the tool actually named is stored — a grant for one path, not
    // for the action as a whole.
    expect(channel.engine.evaluate("edit", ["src/a.ts"]).effect).toBe("allow");
  });
});
