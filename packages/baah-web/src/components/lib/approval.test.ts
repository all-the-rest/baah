/**
 * The approval card: three answers, and the risk distinction.
 *
 * ## What these tests are for
 *
 * Two claims that are easy to state and easy to get wrong:
 *
 * 1. **`reject` is a first-class answer, not a cancel.** It rejects *every* other
 *    open approval of the session (`Plan.md` §7.5, implemented as `rejectAllOpen`
 *    in `runtime/approval.ts`). A card that offers "Abbrechen" instead would be
 *    indistinguishable from dismissing the card and would leave the turn parked.
 * 2. **`todo` and `write` are different risks.** `Plan.md` §7.2 gives `todo` its
 *    own action — core's `DEFAULT_APPROVAL_TARGETS` documents exactly why — and a
 *    generic card for both would throw that distinction away at the moment the user
 *    reads it.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@all-the.rest/baah-core";

import {
  approvalCardModel,
  grantPatternFor,
  REJECT_SCOPE_NOTE,
  requestFromToolPart,
  toolCallInputOf,
} from "./approval.ts";
import type { ApprovalChoice } from "./approval.ts";
import type { UIMessage } from "ai";

const writeRequest: ApprovalRequest = {
  toolId: "write",
  summary: "write auf src/app.ts",
  detail: { path: "src/app.ts", content: "…" },
};

const todoRequest: ApprovalRequest = {
  toolId: "todo",
  summary: "Aufgabenliste dieser Sitzung ersetzen",
  detail: { todos: [{ content: "x", status: "pending" }] },
};

describe("three answers, and none of them is a cancel", () => {
  it("names exactly the three `§7.5` answers", () => {
    // A fourth would be a product decision nobody made; a second one would be a
    // duplicate of one of these under another name.
    const choices: readonly ApprovalChoice[] = ["once", "always", "reject"];
    expect(choices).toHaveLength(3);
  });

  it("states the sweep `reject` performs", () => {
    // The engine really does this (`rejectAllOpen`), so the UI has to say so: a
    // sweep the user is not told about is a sweep they cannot undo.
    expect(REJECT_SCOPE_NOTE).toContain("alle anderen offenen Freigaben");
    expect(REJECT_SCOPE_NOTE).toContain("Sitzung");
  });

  it("does not use the word that means 'cancel'", () => {
    // "Abbrechen" would read as "never mind", which is not one of `§7.5`'s three
    // answers and would leave the turn parked.
    expect(REJECT_SCOPE_NOTE).not.toContain("Abbrechen");
  });
});

describe("what will happen, before the decision", () => {
  it("shows the tool's own summary and the exact input", () => {
    // `Plan.md` §4.2: the tool knows best what it wants. A card that paraphrases
    // the input is a card that can describe a write to a file the model did not name.
    const card = approvalCardModel({ approvalId: "ap1", request: writeRequest, grantPattern: undefined });
    expect(card.summary).toBe("write auf src/app.ts");
    expect(card.detail).toContain("src/app.ts");
  });

  it("renders a non-object input as text rather than as `[object Object]`", () => {
    const card = approvalCardModel({
      approvalId: "ap1",
      request: { toolId: "read", summary: "s", detail: "HINWEIS.md" },
      grantPattern: undefined,
    });
    expect(card.detail).toBe("HINWEIS.md");
  });

  it("states the absence of an input instead of rendering nothing", () => {
    const card = approvalCardModel({
      approvalId: "ap1",
      request: { toolId: "read", summary: "s", detail: undefined },
      grantPattern: undefined,
    });
    expect(card.detail).toBe("(keine Eingabe)");
  });
});

describe("todo and write are different risks and must not look alike", () => {
  it("classifies a write as a file write", () => {
    expect(approvalCardModel({ approvalId: "a", request: writeRequest, grantPattern: undefined }).risk).toBe("file-write");
  });

  it("classifies a todo write as a task-list write", () => {
    // `Plan.md` §7.2: `todo` is its own action, our own tool. Core's
    // `DEFAULT_APPROVAL_TARGETS` documents that without the entry it would fall
    // through the `access` fallback to `edit` and a rule for `todo` would match
    // nothing — so the UI has to keep the two apart too.
    expect(approvalCardModel({ approvalId: "a", request: todoRequest, grantPattern: undefined }).risk).toBe("task-list");
  });

  it("gives the two risks different consequence sentences", () => {
    const write = approvalCardModel({ approvalId: "a", request: writeRequest, grantPattern: undefined });
    const todo = approvalCardModel({ approvalId: "a", request: todoRequest, grantPattern: undefined });
    expect(write.consequence).not.toBe(todo.consequence);
    // A file write changes a file. A todo write replaces a list, and the list is
    // *replaced* — anything the model leaves out disappears (`Plan.md` §16.2).
    expect(write.consequence).toContain("Datei");
    expect(todo.consequence).toContain("ersetzt");
  });

  it("classifies a `.env` read as a secret read", () => {
    // `Plan.md` §7.4: `.env` reads ask by default. That is the one approval a
    // default policy produces, and the card has to say what is at stake.
    const card = approvalCardModel({
      approvalId: "a",
      request: { toolId: "read", summary: "read auf .env", detail: { path: ".env" } },
      grantPattern: undefined,
    });
    expect(card.risk).toBe("read-secret");
    expect(card.consequence).toContain("Geheimnisse");
  });

  it("falls back to 'other' for a tool with no classification", () => {
    // The consequence sentence still has to say that something happens.
    const card = approvalCardModel({
      approvalId: "a",
      request: { toolId: "invented", summary: "s", detail: {} },
      grantPattern: undefined,
    });
    expect(card.risk).toBe("other");
    expect(card.consequence).toContain("Prüfe die Eingabe");
  });
});

describe("the `always` grant", () => {
  it("proposes a pattern rather than a wildcard", () => {
    // `Plan.md` §7.5: "Das Tool schlägt das Muster vor, nicht die UI — es weiß am
    // besten, was es braucht." A `*` here would be a grant for the action as a
    // whole, which is the broad thing `§7.5` does not ask for.
    const pattern = grantPatternFor({ action: "edit", resources: ["src/app.ts"] });
    expect(pattern).toContain("src/app.ts");
    expect(pattern).not.toContain('"resource":"*"');
  });

  it("uses the `todo` action, so a rule written for it matches", () => {
    // The action is what a rule matches on. `write` and `todo` sharing an action
    // would be the exact bug core's table documents.
    expect(grantPatternFor({ action: "todo", resources: ["*"] })).toContain('"action":"todo"');
  });

  it("proposes nothing when there is no nameable resource", () => {
    // No pattern means no `always` button — offering one would store a grant the
    // user never saw described.
    expect(grantPatternFor({ action: "edit", resources: [] })).toBeUndefined();
  });

  it("counts multiple resources rather than listing them all in one rule", () => {
    // A ruleset is an **ordered list** and the last match wins (`§7.1`), so two
    // resources are two rules — a single `*` would be a broader grant than the user
    // agreed to.
    expect(grantPatternFor({ action: "edit", resources: ["a", "b"] })).toBe("2 Regeln");
  });
});

describe("building the request off the engine's event", () => {
  it("names the path in the summary", () => {
    const request = requestFromToolPart({
      toolName: "write",
      input: { path: "src/a.ts" },
      approvalId: "ap1",
      reason: undefined,
    });
    expect(request.toolId).toBe("write");
    expect(request.summary).toContain("src/a.ts");
  });

  it("names the list for a todo write, which has no path", () => {
    // A `todo` request's input is a list, not a path — reading `path` off it yields
    // nothing, and a summary of "todo ausführen" would say less than the tool does.
    const request = requestFromToolPart({
      toolName: "todo",
      input: { todos: [] },
      approvalId: "ap1",
      reason: undefined,
    });
    expect(request.summary).toBe("Aufgabenliste dieser Sitzung ersetzen");
  });
});

describe("toolCallInputOf — the snapshot's copy of a pending call's input", () => {
  const messages = [
    {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "lies .env" }],
    },
    {
      id: "m2",
      role: "assistant",
      parts: [
        {
          type: "tool-read",
          toolCallId: "c1",
          state: "approval-requested",
          input: { path: ".env" },
          approval: { id: "ap1" },
        },
      ],
    },
  ] as unknown as UIMessage[];

  it("finds the call's input and its name in the snapshot", () => {
    // The measured path also has this in the event fold, because
    // `@ai-sdk/openai-compatible@3` emits the input parts before pausing. Nothing in
    // `ai`'s types promises that, so this is the fallback — and the E2E suite cannot
    // tell the two apart, which is why it is tested here. The `AgentEvent` union
    // declares no `input` on `approval-requested`, so without the snapshot an
    // `always` answer would have no resource to grant.
    expect(toolCallInputOf(messages, "c1")).toEqual({ toolName: "read", input: { path: ".env" } });
  });

  it("reads the name out of the discriminator, not a `toolName` field", () => {
    // `toolCallPart` writes `{ type: "tool-read", … }` and there is no `toolName`
    // property. The same trap `lib/transcript.ts` documents for a stored card.
    const named = [
      { id: "m2", role: "assistant", parts: [{ type: "tool-read", toolCallId: "c9", state: "input-available", input: {} }] },
    ] as unknown as UIMessage[];
    expect(toolCallInputOf(named, "c9")?.toolName).toBe("read");
  });

  it("also handles the dynamic discriminator", () => {
    const dynamic = [
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "dynamic-tool", toolName: "grep", toolCallId: "c2", state: "input-available", input: { pattern: "x" } }],
      },
    ] as unknown as UIMessage[];
    expect(toolCallInputOf(dynamic, "c2")).toEqual({ toolName: "grep", input: { pattern: "x" } });
  });

  it("returns nothing for an unknown call, rather than a wrong input", () => {
    // A card built from a lookup that fell through to the wrong call would show the
    // user a `detail` for a call they did not make.
    expect(toolCallInputOf(messages, "nope")).toBeUndefined();
    expect(toolCallInputOf([], "c1")).toBeUndefined();
  });
});
