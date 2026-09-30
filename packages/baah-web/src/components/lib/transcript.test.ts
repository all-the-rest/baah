/**
 * The transcript projection: the live fold, and the three cases a read can end in.
 *
 * ## The case this file exists for
 *
 * `Plan.md` §16.1: a **closed database rejects** with `database_closed`, and a UI
 * that treats "empty" as "nothing was here" turns a read that failed into a
 * confident statement that the user's work is gone. So `transcriptModel` returns a
 * union, and the test below asserts the two are different — including the case
 * that is easiest to get wrong: a failed read that happens to coincide with no
 * live parts, where every other implementation renders "empty".
 */
import { describe, expect, it } from "vitest";

import {
  applyAgentEvent,
  EMPTY_LIVE_TURN,
  foldAgentEvents,
  liveParts,
  roleOf,
  storedMessages,
  transcriptModel,
  type LiveTurn,
} from "./transcript.ts";
import type { Transcript, TranscriptMessage } from "@all-the.rest/baah-storage";
import type { TranscriptRead } from "../../runtime/index.ts";

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    sessionId: "s",
    turnId: null,
    messages: [],
    truncated: false,
    limit: 100,
    ...overrides,
  };
}

/**
 * A stored message, typed as the port's own `TranscriptMessage`.
 *
 * The overrides are `Partial<TranscriptMessage>` rather than `Record<string, unknown>`
 * on purpose: the port's `role`, `status`, `outcome` and `type` are **unions** now
 * that this package reads `baah-storage`'s real types instead of a local copy of them
 * (`runtime/index.ts`, module header), and a fixture that could hand the projection
 * a value outside those unions would be testing a state the store cannot produce —
 * `baah-storage` validates every one of them in `messageRowSchema` / `partRowSchema`.
 * The trust boundary that is *not* covered by a type is the `data` blob, and the
 * tests below exercise it.
 */
function storedMessage(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: "m1",
    turnId: null,
    seq: 0,
    role: "assistant",
    status: null,
    outcome: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parts: [],
    ...overrides,
  };
}

describe("the live fold", () => {
  it("keeps reasoning out of the text buffer", () => {
    // `Plan.md` §5.1's lesson, one layer up. `runtime/index.ts`'s `handleEvent`
    // appends both deltas to one `text` buffer, so the snapshot cannot be the
    // source for a live transcript — the fold has to do better than the buffer.
    const live = foldAgentEvents([
      { type: "text-delta", text: "Antwort", messageId: "m" },
      { type: "reasoning-delta", text: "Denke", messageId: "m" },
    ]);
    expect(live.text["m"]).toBe("Antwort");
    expect(live.reasoning["m"]).toBe("Denke");
    const parts = liveParts(live);
    expect(parts.map((part) => part.kind)).toEqual(["reasoning", "text"]);
  });

  it("marks a part in flight while it streams and keeps its text", () => {
    const live = foldAgentEvents([{ type: "text-delta", text: "halb", messageId: "m" }]);
    const [part] = liveParts(live);
    if (part?.kind !== "text") throw new Error("expected a text part");
    // `Plan.md` §16.1: a live part comes back with its text, at most one flush
    // interval behind. Hide it and the model looks stuck.
    expect(part.text).toBe("halb");
    expect(part.inFlight).toBe(true);
  });

  it("clears the text on a new attempt and does not merge the old one", () => {
    // `Plan.md` §5.4: the failed attempt's text is kept in its own record and
    // never merged forward. Merging would show the user text the model never
    // finished — and would make a 200-but-failed response undiagnosable.
    const live = foldAgentEvents([
      { type: "attempt-started", attempt: 1, total: 3, retryAfterMs: 0 },
      { type: "text-delta", text: "Versuch eins", messageId: "m1" },
      { type: "attempt-started", attempt: 2, total: 3, retryAfterMs: 2_000 },
      { type: "text-delta", text: "Versuch zwei", messageId: "m2" },
    ]);
    expect(Object.values(live.text)).toEqual(["Versuch zwei"]);
    expect(live.attempt).toBe(2);
    expect(live.totalAttempts).toBe(3);
  });

  it("records a user stop as a flag and nothing else", () => {
    // The text survives a stop — it is the user's work and `Plan.md` §5.4 keeps it
    // visible. A stop must not clear it, and it is not an error state.
    const live = foldAgentEvents([
      { type: "text-delta", text: "teiltext", messageId: "m" },
      { type: "turn-stopped", stage: "attempt" },
    ]);
    expect(live.stopped).toBe(true);
    expect(live.stopStage).toBe("attempt");
    expect(live.text["m"]).toBe("teiltext");
  });

  it("tracks a tool through call → approval → result", () => {
    const live = foldAgentEvents([
      { type: "tool-call", toolCallId: "c1", toolName: "write", input: { path: "a.txt" } },
      { type: "approval-requested", approvalId: "ap1", toolCallId: "c1", toolName: "write", input: { path: "a.txt" }, reason: "Schreiben?" },
      { type: "approval-answered", approvalId: "ap1", approved: true },
      { type: "tool-result", toolCallId: "c1", toolName: "write", output: "geschrieben" },
    ]);
    const tool = live.tools[0];
    expect(tool?.state).toBe("output-available");
    expect(live.openApprovals).toHaveLength(0);
  });

  it("names the tool on the `approval-requested` event itself", () => {
    // A call that needs approval produces `tool-approval-request` **instead of**
    // `tool-call`, so there is no earlier event that named it and the fold's
    // placeholder would be the only name the card ever had. A card labelled `tool`
    // tells the user nothing, and `ApprovalCard` reads the name off this to pick the
    // risk class — so the placeholder would make a secret read look like an unknown
    // one.
    const live = foldAgentEvents([
      { type: "approval-requested", approvalId: "ap1", toolCallId: "c1", toolName: "read", input: { path: ".env" }, reason: "Secrets?" },
    ]);
    expect(live.tools[0]?.toolName).toBe("read");
    // And the `toolCallId` is on the open entry, because that is what
    // `lib/approval.ts` looks up in the runtime snapshot to find the call's input.
    expect(live.openApprovals[0]?.toolCallId).toBe("c1");
  });

  it("closes an open approval when it is answered", () => {
    const live = foldAgentEvents([
      { type: "approval-requested", approvalId: "ap1", toolCallId: "c1", toolName: "write", input: { path: "a.txt" }, reason: undefined },
    ]);
    expect(live.openApprovals).toHaveLength(1);
    const answered = applyAgentEvent(live, { type: "approval-answered", approvalId: "ap1", approved: false });
    expect(answered.openApprovals).toHaveLength(0);
    // A rejection is `output-denied`, not `output-error` — `Plan.md` §7.6: the
    // model reads the refusal and routes around it.
    expect(answered.tools[0]?.state).toBe("output-denied");
  });

  it("records an unknown outcome beside the tools, not as a tool state", () => {
    // `Plan.md` §5.1: the engine ran it again and reported it as failed, both of
    // which are lies the model would act on. Its own list is the point.
    const live = foldAgentEvents([
      { type: "tool-call", toolCallId: "c1", toolName: "write", input: { path: "a.txt" } },
      { type: "tool-outcome-unknown", toolCallId: "c1", toolName: "write", input: { path: "a.txt" } },
    ]);
    expect(live.unknownOutcomes).toHaveLength(1);
    expect(live.tools[0]?.state).toBe("input-available");
  });

  it("collects a storage warning as a warning", () => {
    const live = foldAgentEvents([
      { type: "storage-warning", operation: "heartbeat", attempt: 1, message: "database_closed" },
    ]);
    expect(live.storageWarnings).toHaveLength(1);
    expect(live.storageWarnings[0]?.operation).toBe("heartbeat");
  });

  it("counts the step from the engine's own event", () => {
    const live = foldAgentEvents([
      { type: "step-end", stepNumber: 0, text: "", toolCallCount: 0, finishReason: "stop" },
    ]);
    expect(live.step).toBe(1);
  });

  it("keeps two calls to the same tool apart by order and id", () => {
    const live = foldAgentEvents([
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a" } },
      { type: "tool-call", toolCallId: "c2", toolName: "read", input: { path: "b" } },
      { type: "tool-result", toolCallId: "c1", toolName: "read", output: "A" },
    ]);
    expect(live.tools.map((tool) => tool.toolCallId)).toEqual(["c1", "c2"]);
    expect(live.tools[0]?.output).toBe("A");
    expect(live.tools[1]?.state).toBe("input-available");
  });
});

describe("the stored transcript", () => {
  it("renders a streaming part with its text and marks it in flight", () => {
    // The `§16.1` rule, on the read side: a live part comes back with
    // `status: "streaming"` **and** its text. The UI has to show it.
    const messages = storedMessages(
      transcript({
        messages: [
          storedMessage({
            parts: [{ id: "p1", seq: 0, type: "text", contentText: "halb fertig", status: "streaming", data: null, updatedAt: "" }],
          }),
        ],
      }),
    );
    const [part] = messages[0]?.parts ?? [];
    if (part?.kind !== "text") throw new Error("expected a text part");
    expect(part.text).toBe("halb fertig");
    expect(part.inFlight).toBe(true);
  });

  it("marks a completed part as not in flight", () => {
    const messages = storedMessages(
      transcript({
        messages: [
          storedMessage({
            parts: [{ id: "p1", seq: 0, type: "reasoning", contentText: "überlegt", status: "completed", data: null, updatedAt: "" }],
          }),
        ],
      }),
    );
    expect(messages[0]?.parts[0]?.kind).toBe("reasoning");
    if (messages[0]?.parts[0]?.kind !== "reasoning") throw new Error("expected a reasoning part");
    expect(messages[0]?.parts[0]?.inFlight).toBe(false);
  });

  it("keeps the `idle` outcome message, because that is where the outcome lives", () => {
    // `Plan.md` §6.2: the turn outcome is an `idle` message, not a column. A
    // projection that dropped it would lose the only record of how a turn ended.
    // **All three** outcomes, because the one that matters most in practice is the
    // one a user sees after a reload: `interrupted` is what `recoverStaleTurns`
    // leaves behind (`Plan.md` §5.1), and it is a row, not a badge.
    for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
      const messages = storedMessages(
        transcript({ messages: [storedMessage({ role: "idle", outcome })] }),
      );
      expect(messages, outcome).toHaveLength(1);
      expect(messages[0]?.outcome, outcome).toBe(outcome);
    }
  });

  it("passes the store's role through, so a row nothing else could produce still renders", () => {
    // `Plan.md` §14.3 names eleven roles and this view has three bubbles, so
    // `roleOf` folds the rest. The union is the port's, so the fold is total and a
    // new role is a compile error here rather than an `undefined` on screen.
    const messages = storedMessages(
      transcript({ messages: [storedMessage({ role: "compaction" })] }),
    );
    expect(messages[0]?.role).toBe("compaction");
    expect(roleOf(messages[0]?.role ?? "")).toBe("system");
  });

  it("gives a reloaded card the truncation notice and the diffs a live card has", () => {
    // These two were `undefined` / `[]` here, so a card that had been *seen* complete
    // and was then re-read from the store came back with the warning and the diffs
    // missing — the "one projection for both" claim was true only for the state. The
    // stored blob carries `input` and `output` in the same shape, so the same two
    // functions apply.
    const messages = storedMessages(
      transcript({
        messages: [
          storedMessage({
            parts: [
              {
                id: "p1",
                seq: 0,
                type: "tool",
                contentText: "",
                status: "completed",
                updatedAt: "",
                data: JSON.stringify({
                  type: "tool-grep",
                  toolCallId: "c1",
                  state: "output-available",
                  input: { pattern: "x" },
                  output: { searchTruncated: true, metadata: { files: [{ file: "a.ts", additions: 2 }] } },
                }),
              },
            ],
          }),
        ],
      }),
    );
    const part = messages[0]?.parts[0];
    if (part?.kind !== "tool") throw new Error("expected a tool part");
    expect(part.truncation?.field).toBe("searchTruncated");
    expect(part.diffs).toHaveLength(1);
    expect(part.diffs[0]?.file).toBe("a.ts");
  });

  it("promotes a stored failure envelope to `output-error`", () => {
    // The same value-based derivation the live card uses. The engine persists no
    // tool parts, so this is the *only* place a failed tool's state survives — and
    // the E2E scenario reads the card back from here after the fold is cleared, so
    // this is the second path through the same decision.
    const messages = storedMessages(
      transcript({
        messages: [
          storedMessage({
            parts: [
              {
                id: "p1",
                seq: 0,
                type: "tool",
                contentText: "",
                status: "completed",
                updatedAt: "",
                data: JSON.stringify({
                  type: "tool-read",
                  toolCallId: "call_missing",
                  state: "output-available",
                  input: { path: "gibt-es-nicht.md" },
                  output: { ok: false, error: "File not found: gibt-es-nicht.md" },
                }),
              },
            ],
          }),
        ],
      }),
    );
    const part = messages[0]?.parts[0];
    if (part?.kind !== "tool") throw new Error("expected a tool part");
    expect(part.state).toBe("output-error");
    expect(part.stateLabel).toBe("Fehlgeschlagen");
    expect(part.errorText).toBe("File not found: gibt-es-nicht.md");
  });
});

describe("a failed read is not an empty conversation", () => {
  const failed: TranscriptRead = {
    kind: "failed",
    reason: "database_closed: the stored transcript could not be read.",
  };

  it("never reports `empty` for a refusal", () => {
    // The mutation this kills: treating a rejection as an empty result, which turns
    // "the read did not happen" into "nothing was here" — the one answer the user
    // would act on.
    const model = transcriptModel({ read: failed, live: EMPTY_LIVE_TURN });
    expect(model.empty).toBe(false);
    expect(model.readProblem).toContain("database_closed");
  });

  it("says so even when a read failed with no messages and no live parts", () => {
    // The easiest case to get wrong: every other implementation renders `empty`
    // here, because `messages.length === 0`.
    const model = transcriptModel({ read: failed, live: EMPTY_LIVE_TURN });
    expect(model.entries).toHaveLength(0);
    expect(model.empty).toBe(false);
  });

  it("reports `empty` only for a successful read with nothing in it", () => {
    const model = transcriptModel({ read: { kind: "ok", transcript: transcript() }, live: EMPTY_LIVE_TURN });
    expect(model.empty).toBe(true);
    expect(model.readProblem).toBeUndefined();
  });

  it("distinguishes an unwired read port from an empty session", () => {
    // Both are "nothing to show", and they are different facts about the program.
    const unwired = transcriptModel({
      read: { kind: "unavailable", reason: "no read port wired" },
      live: EMPTY_LIVE_TURN,
    });
    expect(unwired.empty).toBe(false);
    expect(unwired.readProblem).toContain("read port");
  });

  it("distinguishes a not-yet-read state from a failed one", () => {
    // A **pending** read is a request outstanding, not a problem. It used to be
    // rendered with the warning panel, and the in-memory build hid that by being
    // fast — real SQLite makes the read a `postMessage` round trip to the worker, so
    // the window is now long enough for a human to read an ordinary loading state as
    // an error. The two facts need different words and different styling.
    const pending = transcriptModel({ read: undefined, live: EMPTY_LIVE_TURN });
    expect(pending.pending).toBe(true);
    expect(pending.readProblem).toBeUndefined();
    // And it must not claim the session is empty while it is in flight.
    expect(pending.empty).toBe(false);
  });

  it("reports `pending: false` for every read that came back, whatever it said", () => {
    // The other direction: a model that reported `pending` for a resolved read would
    // leave a "wird geladen" line up for ever next to a full transcript.
    for (const read of [
      { kind: "ok", transcript: transcript() },
      { kind: "unavailable", reason: "no read port wired" },
      failed,
    ] as const) {
      expect(transcriptModel({ read, live: EMPTY_LIVE_TURN }).pending, read.kind).toBe(false);
    }
  });

  it("shows the live turn even when the read failed", () => {
    // A running turn is the user's work in progress; a failed read must not hide it
    // behind an error panel.
    const live = foldAgentEvents([{ type: "text-delta", text: "läuft", messageId: "m" }]);
    const model = transcriptModel({ read: failed, live });
    expect(model.live).toBe(true);
    expect(model.entries).toHaveLength(1);
  });

  it("carries the store's `truncated` flag", () => {
    const model = transcriptModel({ read: { kind: "ok", transcript: transcript({ truncated: true }) }, live: EMPTY_LIVE_TURN });
    expect(model.truncated).toBe(true);
  });
});

describe("roles", () => {
  it("maps the three renderable roles and folds the rest into `system`", () => {
    expect(roleOf("user")).toBe("user");
    expect(roleOf("assistant")).toBe("assistant");
    // `Plan.md` §14.3 lists eleven message types; the rest render as system notes
    // rather than getting their own bubble.
    expect(roleOf("synthetic")).toBe("system");
    expect(roleOf("idle")).toBe("system");
  });
});

describe("the fold is a pure reducer", () => {
  it("does not mutate the state it is given", () => {
    // A mutating reducer would make `applyAgentEvent` unusable from
    // `setState(prev => …)`, and the bug would only appear as a stale render.
    const before: LiveTurn = foldAgentEvents([{ type: "text-delta", text: "a", messageId: "m" }]);
    const snapshot = JSON.stringify(before);
    applyAgentEvent(before, { type: "text-delta", text: "b", messageId: "m" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
