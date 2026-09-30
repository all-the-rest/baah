/**
 * What a storage failure is allowed to say — and where that text ends up.
 *
 * ## The defect this file is for
 *
 * `describeStorageFailure` in `src/agent/loop.ts` used to be
 *
 * ```ts
 * return error instanceof Error ? error.message : String(error);
 * ```
 *
 * and it had four call sites. The one that reached a screen is the
 * prompt-persist failure: its text becomes a `Classification.reason`, and the
 * app's `failureView` renders a `protocol-error`'s `reason` **verbatim**
 * (`packages/baah-web/src/components/lib/turn.ts`). The measured string was
 *
 * ```text
 * Die Antwort war unbrauchbar: the turn could not be persisted:
 *   401 from Google: key sk-live-… is invalid
 * ```
 *
 * `AGENTS.md` §2 puts it in one sentence: an arbitrary `Error.message` is the
 * one shape in this program that can carry a key. The store is injected, so its
 * message is not this package's text — a worker that forwards a provider
 * rejection hands back the provider's sentence, and Google's 401 quotes the key
 * back inside it.
 *
 * ## Why these are not "does the message survive" tests
 *
 * The obvious test — "the message is not in the output" — is exactly the shape
 * a redactor also passes, and a redactor is the alternative that was **not**
 * chosen. The argument against redaction is that the formats are not
 * enumerable, and no test can close that. What *can* be closed by exhaustion is
 * the other side: a whitelist of **fields** (`error.name`) needs no test per
 * format, because no format is ever read. So:
 *
 * - every test here asserts on a **class name** appearing, not only on a token
 *   being absent, because a constant string passes an absence test and a
 *   field-choice does not;
 * - the key fixtures are in **three formats a denylist would plausibly miss**,
 *   and the file says so, so a future redactor is not written believing it
 *   covered them;
 * - there is a **self-check** that the fixtures really do carry their token and
 *   that the old composition really would have leaked it. Without it, an
 *   assertion like "not to contain" is satisfied by a store that throws nothing
 *   at all — the trap `AGENTS.md` §6a names for every gate ("every gate needs a
 *   self-test with planted material").
 *
 * ## What is deliberately *not* claimed here
 *
 * The store's `code` (`sql_error`, `database_owned_by_another_context`, …) is
 * not in the text, and this file does not pretend otherwise. `TurnStore` is an
 * injected interface and carries no `code`; recovering one here would have the
 * engine vouch for a string an arbitrary implementation wrote. The layer that
 * owns that vocabulary already reads it — `describeReadFailure` in the web
 * runtime. The trade is written out at `describeStorageFailure`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, type ToolContext } from "../../src/tool.ts";
import { createMemoryWorkspace } from "../../src/workspace.ts";
import {
  buildApprovalTargets,
  createApprovalResolver,
  type PermissionEngine,
} from "../../src/agent/approval.ts";
import {
  AgentTurn,
  type AgentEvent,
  type TurnStore,
  type TurnOutcome,
  type TurnOutcomeEntry,
  type UnfinishedTurn,
} from "../../src/agent/loop.ts";
import type { Classification } from "../../src/stream/classify.ts";
import { createMockModel, finish, text, toolCall, type MockStep } from "./mock-model.ts";

/* ------------------------------------------------------------------ */
/* The tokens                                                          */
/* ------------------------------------------------------------------ */

/**
 * A marker that is unmistakably not a credential, in every token below.
 *
 * The realistic part of a leak fixture is the *surrounding sentence* and the
 * token's *shape*; the token's own entropy is what would make this file a
 * `§2` violation and what a repo-wide secret scanner would (rightly) fire on.
 */
const MARKER = "NOTAREALKEY";

/**
 * Three token shapes.
 *
 * **A denylist is expected to miss at least one of these**, and that is the
 * point of writing them down. A `sk-[A-Za-z0-9]{20,}` pattern catches the first
 * and nothing else; a base64-with-padding token inside a query string is a
 * different alphabet, and a JWT's third segment is a third. A redactor is an
 * argument about formats; a field choice needs no argument. If someone later
 * "improves" this by filtering the message, these three are the test that will
 * be pointed at, and one of them will get through.
 */
const TOKEN_SHAPES = [
  { shape: "a vendor 401 quoting the key in prose", token: `sk-live-${MARKER}` },
  { shape: "a base64 token in a URL query", token: `?key=QUJD${MARKER}==` },
  { shape: "a JWT's three dot-separated segments", token: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${MARKER}` },
] as const;

/**
 * The message a provider or a worker hands back for each shape.
 *
 * Written as whole sentences, because the leak was never "a token in a field" —
 * it was a token inside an `Error.message` that read like a real diagnosis. A
 * fixture that is only a token would make a naive `includes`-style redactor look
 * adequate, and it is not.
 */
function messageFor(token: string, shape: number): string {
  switch (shape) {
    case 0:
      return `401 from Google: key ${token} is invalid`;
    case 1:
      return `POST https://generativelanguage.example/v1beta/models${token} failed: connection reset`;
    default:
      return `401 {"error":{"message":"Incorrect API key provided: ${token}.","type":"invalid_request_error"}}`;
  }
}

/** A `StorageError`-shaped rejection whose message is a provider's. */
function storageRejection(token: string, shape: number): Error {
  const error = new Error(messageFor(token, shape)) as Error & { code: string };
  error.name = "StorageError";
  error.code = "database_closed";
  return error;
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

/** Which write rejects, and with what. `undefined` = succeed. */
interface Failures {
  appendMessage?: unknown;
  heartbeat?: unknown;
  recordToolCall?: unknown;
  upsertPart?: unknown;
}

function createFailingStore(failures: Failures): TurnStore {
  const outcomes: TurnOutcomeEntry[] = [];
  const fail = (value: unknown): void => {
    if (value !== undefined) throw value;
  };
  return {
    async appendTurn() {},
    async appendMessage() {
      fail(failures.appendMessage);
    },
    async upsertPart() {
      fail(failures.upsertPart);
    },
    async flushDelta() {},
    async closePart() {},
    async closeTurnParts() {},
    async finishTurn(input) {
      outcomes.push({ turnId: input.turnId, outcome: input.outcome as TurnOutcome });
    },
    async heartbeat() {
      fail(failures.heartbeat);
    },
    async listUnfinishedTurns(): Promise<readonly UnfinishedTurn[]> {
      return [];
    },
    async listTurnOutcomes(): Promise<readonly TurnOutcomeEntry[]> {
      return outcomes;
    },
    async recordToolCall() {
      fail(failures.recordToolCall);
    },
    async getToolCall() {
      return undefined;
    },
    async beginToolCall() {},
  };
}

/* ------------------------------------------------------------------ */
/* The turn driver                                                     */
/* ------------------------------------------------------------------ */

const echoTool = defineTool<{ value: string }, { ok: boolean }>({
  id: "echo",
  description: "Echo a value back.",
  access: "read",
  inputSchema: z.object({ value: z.string() }),
  execute: async (_context: ToolContext, input: { value: string }) => ({ ok: input.value.length > 0 }),
}) as ReturnType<typeof defineTool>;

const TOOLS = [echoTool];

const allowAll: PermissionEngine = {
  evaluate: () => ({ effect: "allow" }),
  recordAlways: async () => {},
};

/** One step that streams a sentence. */
const ANSWER: MockStep = { parts: [...text("t1", "Hello"), finish("stop")] };

/** One tool call, then the answer — so the record and the part write both run. */
const TOOL_STEPS: readonly MockStep[] = [
  {
    parts: [
      { type: "tool-input-start", id: "c1", toolName: "echo" },
      toolCall({ toolCallId: "c1", toolName: "echo", input: { value: "one" } }),
      finish("tool-calls"),
    ],
  },
  ANSWER,
];

interface RunResult {
  readonly events: readonly AgentEvent[];
  readonly classification: Classification | undefined;
}

async function runTurn(store: TurnStore, steps: readonly MockStep[]): Promise<RunResult> {
  const events: AgentEvent[] = [];
  const turn = new AgentTurn({
    model: createMockModel({ steps }),
    instructions: "You are a test harness.",
    tools: TOOLS,
    workspace: createMemoryWorkspace(),
    cwd: ".",
    sessionId: "s1",
    turnId: "t1",
    store,
    approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools: TOOLS }) }),
    onEvent: (event) => events.push(event),
    approve: async () => "allow-once",
    sleep: async () => {},
    random: () => 0.5,
    now: () => 1_000,
  });
  const result = await turn.run("hi");
  return { events, classification: result.classification };
}

/** The `reason` a `protocol-error` carries, or `""` for any other kind. */
function reasonOf(classification: Classification | undefined): string {
  return classification?.kind === "protocol-error" ? classification.reason : "";
}

function warningsOf(events: readonly AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "storage-warning" }> =>
      event.type === "storage-warning",
  );
}

/* ================================================================== */
/* The call site that reached the screen                                */
/* ================================================================== */

describe("the prompt-persist failure, which is the one that reached the screen", () => {
  it("names the failure's class and not the store's text", async () => {
    /**
     * The path, end to end: `appendMessage` rejects → `#persistPrompt` catches →
     * a `protocol-error` whose `reason` is composed → the app renders that
     * `reason` verbatim. Nothing else in core can put a key on a screen, and
     * this test is the one that would have caught it.
     *
     * The assertion is a **`toBe`**, not a `not.toContain`. A `not.toContain`
     * would also be satisfied by an implementation that returned the empty
     * string, and this pins the *useful* half — the class, which is what a
     * reader is left with — so the fix cannot be "delete the text and say
     * nothing".
     */
    const { classification } = await runTurn(
      createFailingStore({ appendMessage: storageRejection(TOKEN_SHAPES[0].token, 0) }),
      [ANSWER],
    );

    expect(classification?.kind).toBe("protocol-error");
    expect(reasonOf(classification)).toBe("the turn could not be persisted: StorageError");
  });

  it("the same path, on the heartbeat, on the tool record and on the part write", async () => {
    /**
     * The second path, and the reason it exists as a separate test.
     *
     * A fix applied to `#persistPrompt` alone would pass every test in the
     * describe block above and leave three call sites forwarding the message.
     * All three are driven here from the same store, and the *class* is
     * asserted per operation — so "the message survived" is not the only thing
     * that fails if one of them is left alone, the other two being right does
     * not compensate.
     */
    const failure = storageRejection(TOKEN_SHAPES[0].token, 0);
    const { events } = await runTurn(
      createFailingStore({ heartbeat: failure, recordToolCall: failure, upsertPart: failure }),
      TOOL_STEPS,
    );

    const warnings = warningsOf(events);
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning.message).toBe("StorageError");
      expect(warning.message).not.toContain(failure.message);
    }
  });
});

/* ================================================================== */
/* The key, in formats a denylist misses                                */
/* ================================================================== */

describe("a key in any format is dropped, because no format is read", () => {
  for (const [index, { shape, token }] of TOKEN_SHAPES.entries()) {
    it(`drops ${shape}`, async () => {
      const failure = storageRejection(token, index);
      const { classification, events } = await runTurn(
        createFailingStore({ appendMessage: failure, heartbeat: failure }),
        [ANSWER],
      );

      // Both call sites in one test, for the reason above: the reason is the
      // screen and the warning is the transcript, and a fix to one is not a fix
      // to the other.
      const rendered = [reasonOf(classification), ...warningsOf(events).map((event) => event.message)];
      expect(rendered.length).toBeGreaterThan(0);
      for (const text of rendered) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(MARKER);
        // And the useful half is still there, so "dropped" cannot be satisfied
        // by an empty string.
        expect(text).toContain("StorageError");
      }
    });
  }

  it("the fixtures really do carry their token — a leak assertion is not vacuous", () => {
    /**
     * The self-check, and the one a reader should check first.
     *
     * Every assertion above is of the form "not to contain". A store that threw
     * nothing, a call site that stopped reporting, or a fixture whose token
     * never made it into the message would each make all of them pass. So the
     * planted material is verified here, together with the **exact string the
     * old implementation composed** — the one the report measured.
     */
    for (const [index, { token }] of TOKEN_SHAPES.entries()) {
      const error = storageRejection(token, index);
      expect(error.message).toContain(token);
      expect(`the turn could not be persisted: ${error.message}`).toContain(token);
      expect(String(error)).toContain(token);
    }
  });
});

/* ================================================================== */
/* The two branches a coincidence would survive                        */
/* ================================================================== */

describe("no class is special, and a non-Error is not stringified", () => {
  it("a TypeError's message is dropped too", async () => {
    /**
     * The direction that a "one lucky coincidence" hides.
     *
     * A redactor written as `error instanceof TypeError ? error.name : redact(…)`
     * passes every test above — none of them throws a `TypeError` — and leaks
     * the moment the store fails with one. This test is the second path, and it
     * is here rather than in a shared table because the class has to be a
     * `TypeError` **and** the message has to carry a token: either alone would
     * be satisfiable by an implementation that ignored the message.
     */
    const typeError = new TypeError(messageFor(TOKEN_SHAPES[1].token, 1));
    typeError.name = "TypeError";
    const { classification, events } = await runTurn(
      createFailingStore({ appendMessage: typeError, heartbeat: typeError }),
      [ANSWER],
    );

    expect(reasonOf(classification)).toBe("the turn could not be persisted: TypeError");
    expect(reasonOf(classification)).not.toContain(TOKEN_SHAPES[1].token);
    for (const warning of warningsOf(events)) {
      expect(warning.message).toBe("TypeError");
      expect(warning.message).not.toContain(TOKEN_SHAPES[1].token);
    }
  });

  it("a thrown string is described by its shape, never by String(value)", async () => {
    /**
     * The other branch of the original `error instanceof Error ? … : String(…)`.
     *
     * A thrown string **is** the foreign text, so `String(value)` was the same
     * leak with one fewer ceremony — and the original test
     * (`describes a thrown non-Error instead of dropping it`, in
     * `storage-warning.test.ts`) asserted the leak as a feature. The
     * description is a constant, which is also what makes it a *diagnosis*: a
     * store that rejects with something that is not an `Error` is broken in a
     * way worth naming.
     */
    const thrown = `401 from Google: key ${TOKEN_SHAPES[0].token} is invalid`;
    const { events } = await runTurn(createFailingStore({ heartbeat: thrown }), [ANSWER]);

    const warnings = warningsOf(events);
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning.message).toBe("non-Error value");
      expect(warning.message).not.toContain(TOKEN_SHAPES[0].token);
    }
  });

  it("an Error with an empty name still describes itself", async () => {
    // The degenerate case, so the class half is never an empty string — an
    // empty `message` renders as a sentence with a hole in it, and a UI cannot
    // tell that apart from "no warning arrived".
    const nameless = new Error(`key ${TOKEN_SHAPES[0].token}`);
    nameless.name = "";
    const { events } = await runTurn(createFailingStore({ heartbeat: nameless }), [ANSWER]);

    expect(warningsOf(events)[0]?.message).toBe("Error");
  });

  it("a subclass with no name of its own is not the empty-name case", async () => {
    /**
     * The second path for the fallback, and the one a reader guesses wrong.
     *
     * `class StorageFailure extends Error {}` — every custom error in this
     * program is this shape — already reads `"Error"`, because it inherits
     * `Error.prototype.name`. So this is *not* what the `name === ""` fallback
     * is for, and saying so as a fact rather than as a claim in a comment is
     * what stops the fallback from being deleted as dead code on the strength
     * of this case.
     *
     * It also kills a neighbouring mutation on its own: replacing the whole
     * function with the constant `"Error"` passes the empty-name test above and
     * fails here, because the inherited name is the only value that is right.
     */
    class StorageFailure extends Error {}
    const { events } = await runTurn(
      createFailingStore({ heartbeat: new StorageFailure(`key ${TOKEN_SHAPES[0].token}`) }),
      [ANSWER],
    );

    expect(new StorageFailure("x").name).toBe("Error");
    expect(warningsOf(events)[0]?.message).toBe("Error");
    // The message is still not forwarded — inheriting the right name is not a
    // licence to read the text.
    expect(warningsOf(events)[0]?.message).not.toContain(TOKEN_SHAPES[0].token);
  });
});

/* ================================================================== */
/* The diagnostic half, which is the other half of the trade            */
/* ================================================================== */

describe("the operation is what carries the diagnosis", () => {
  it("all three writes name themselves, so a reader knows which one failed", async () => {
    /**
     * The other side of the trade, measured.
     *
     * `describeStorageFailure` gives up the text, and the reason that is
     * affordable is that the *operation* — a field of ours, on the event — still
     * says which write failed. That claim is only worth something if the field
     * is present and correct on every variant, so all three are observed here
     * from one turn rather than one at a time: a handler attached to a subset
     * of the call sites would pass a per-operation test and fail this.
     */
    const failure = storageRejection(TOKEN_SHAPES[0].token, 0);
    const { events } = await runTurn(
      createFailingStore({ heartbeat: failure, recordToolCall: failure, upsertPart: failure }),
      TOOL_STEPS,
    );

    const operations = [...new Set(warningsOf(events).map((event) => event.operation))].toSorted();
    expect(operations).toEqual(["heartbeat", "record-tool-call", "upsert-part"]);
  });

  it("a warning still names its attempt and its tool call, and is not a verdict", async () => {
    // Preserved behaviour, stated here so the text change is not mistaken for a
    // change to the event's shape: the operation, the attempt and the subject
    // travel with it, and the turn still succeeds.
    const failure = storageRejection(TOKEN_SHAPES[0].token, 0);
    const store = createFailingStore({ upsertPart: failure, recordToolCall: failure, heartbeat: failure });
    const events: AgentEvent[] = [];
    const turn = new AgentTurn({
      model: createMockModel({ steps: TOOL_STEPS }),
      instructions: "You are a test harness.",
      tools: TOOLS,
      workspace: createMemoryWorkspace(),
      cwd: ".",
      sessionId: "s1",
      turnId: "t1",
      store,
      approval: createApprovalResolver({ engine: allowAll, targets: buildApprovalTargets({ tools: TOOLS }) }),
      onEvent: (event) => events.push(event),
      approve: async () => "allow-once",
      sleep: async () => {},
      random: () => 0.5,
      now: () => 1_000,
    });
    const result = await turn.run("hi");

    expect(result.outcome).toBe("succeeded");
    const partWarnings = warningsOf(events).filter((event) => event.operation === "upsert-part");
    expect(partWarnings[0]).toMatchObject({ attempt: 1, toolCallId: "c1", toolName: "echo" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});
