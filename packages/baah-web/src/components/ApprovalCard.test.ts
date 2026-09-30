/**
 * The approval card's own assembly, with no DOM.
 *
 * ## Why the model function is tested and the component is not
 *
 * `approvalViewFromState` is where two sources are **joined**: the live fold (which
 * knows a question is open) and the runtime snapshot (which knows the call's
 * `input`). Everything that can be wrong about the card — the risk class, the
 * resource, the grant pattern, whether §7.5's `always` answer is offered at all — is
 * decided there, and all of it is decidable with two plain objects.
 *
 * Rendering `<ApprovalCard>` would test the same decisions through a browser, slower
 * and less precisely: a missing button is a `count() === 0`, while here it is
 * `expect(view.grant).toEqual({ action: "read", resources: [".env"] })` — which also
 * says *why* the button is there.
 *
 * The E2E suite then checks that the card reaches the screen with all three answers,
 * which is the one thing a model function cannot prove.
 */
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { approvalViewFromState } from "./ApprovalCard.tsx";
import { foldAgentEvents, EMPTY_LIVE_TURN, type LiveTurn } from "./lib/transcript.ts";
import type { RuntimeState } from "../runtime/index.ts";

/** The snapshot, with only what the card reads filled in. */
function snapshot(messages: readonly UIMessage[]): RuntimeState {
  return {
    sessionId: "s1",
    turnId: "t1",
    status: "idle",
    attempt: 1,
    totalAttempts: 3,
    step: 1,
    messages,
    text: "",
    classification: undefined,
    outcome: "awaiting-approval",
    unknownOutcomes: [],
    hitStepLimit: false,
    boot: undefined,
    stall: undefined,
    lastError: undefined,
    providers: [],
  };
}

/** The assistant message a paused turn leaves in the snapshot. */
const pending: UIMessage[] = [
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

/** A turn folded up to the pause — no `tool-call` event ever arrived. */
const paused: LiveTurn = foldAgentEvents([
  { type: "approval-requested", approvalId: "ap1", toolCallId: "c1", toolName: "read", reason: "Secrets?" },
]);

describe("approvalViewFromState", () => {
  it("says nothing when no approval is open", () => {
    expect(approvalViewFromState(EMPTY_LIVE_TURN, snapshot([]))).toBeUndefined();
  });

  it("builds the card for the open approval, not for every tool on screen", () => {
    const view = approvalViewFromState(paused, snapshot(pending));
    expect(view?.approvalId).toBe("ap1");
    expect(view?.toolCallId).toBe("c1");
    // The name comes off the event, because a call that needs approval produced no
    // `tool-call` event and the fold's own placeholder would be all there was.
    expect(view?.toolName).toBe("read");
  });

  it("offers `always` with the exact grant the engine would store", () => {
    // `Plan.md` §7.5: the tool proposes the pattern, not the UI. The action and the
    // resource come from core's own `DEFAULT_APPROVAL_TARGETS`, and a grant stored
    // under a different action would never match — the user would keep being asked
    // after saying "immer".
    const view = approvalViewFromState(paused, snapshot(pending));
    expect(view?.grant).toEqual({ action: "read", resources: [".env"] });
    expect(view?.grantPattern).toBe('{"action":"read","resource":".env","effect":"allow"}');
  });

  it("takes the input from the snapshot, which is the only place it exists", () => {
    // The `AgentEvent` union declares no `input` on `approval-requested`, so a fold
    // that never saw a `tool-call` has none — and the measured path is the only
    // reason this is not the everyday case. The card must work either way: without
    // the snapshot the detail is "(keine Eingabe)" and §7.5's third answer is gone.
    // This is the fallback's own test; the mutation table records that making this
    // lookup always fail leaves all 43 E2E tests green.
    const view = approvalViewFromState(paused, snapshot(pending));
    expect(view?.detail).toContain('"path": ".env"');
    expect(view?.summary).toContain(".env");
  });

  it("says so plainly when the snapshot has no matching call", () => {
    // A read that is approved on a path the engine never named: no resource, so no
    // grant the user did not see. The card stays, the third answer does not appear,
    // and the detail does not pretend to an input.
    const view = approvalViewFromState(paused, snapshot([]));
    expect(view?.grant).toBeUndefined();
    expect(view?.grantPattern).toBeUndefined();
    expect(view?.detail).toBe("(keine Eingabe)");
  });

  it("picks the risk class off the tool, so a secret read and a write differ", () => {
    // `Plan.md` §7.2, and the reason a generic "Werkzeug freigeben?" would be wrong:
    // the two risks are not the same kind of thing.
    const read = approvalViewFromState(paused, snapshot(pending));
    expect(read?.risk).toBe("read-secret");

    const writing = foldAgentEvents([
      { type: "approval-requested", approvalId: "ap2", toolCallId: "c2", toolName: "write", reason: undefined },
    ]);
    const write = approvalViewFromState(writing, snapshot([]));
    expect(write?.risk).toBe("file-write");
    expect(write?.consequence).not.toBe(read?.consequence);
  });

  it("shows the first open approval, and only that one", () => {
    // Two cards at once would need two answers to be correct at the same moment, and
    // §7.5's `reject` sweeps the rest anyway — so the card answers the oldest.
    const two = foldAgentEvents([
      { type: "approval-requested", approvalId: "ap1", toolCallId: "c1", toolName: "read", reason: undefined },
      { type: "approval-requested", approvalId: "ap2", toolCallId: "c2", toolName: "read", reason: undefined },
    ]);
    expect(approvalViewFromState(two, snapshot(pending))?.approvalId).toBe("ap1");
  });
});
