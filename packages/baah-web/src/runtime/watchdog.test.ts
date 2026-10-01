/**
 * The stall watchdog, against a clock the test owns.
 *
 * The interesting property is not "it fires after 20 s" — it is **which silences it
 * counts**. A watchdog that fires during a tool call tells a user reading a question
 * card that their model has stalled, which is both false and the fastest way to get
 * the whole event type ignored.
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventBody } from "@all-the.rest/baah-core";

import { StallWatchdog, type StallReport } from "./watchdog.ts";

/** A controllable timer queue, so no test waits on wall-clock time. */
function fakeClock(): {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => current,
    setTimer: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance: (ms) => {
      current += ms;
      // Fire everything that is now due, in time order. A timer scheduled *by* a
      // callback is picked up by a later `advance`, which is the behaviour real
      // timers have and the one the watchdog's re-arm depends on.
      for (let pass = 0; pass < 100; pass += 1) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        const [id, timer] = due[0] as [number, { at: number; callback: () => void }];
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
}

function setup(options: { readonly timeoutMs?: number } = {}): {
  watchdog: StallWatchdog;
  clock: ReturnType<typeof fakeClock>;
  reports: StallReport[];
  feed: (...events: AgentEvent[]) => void;
} {
  const clock = fakeClock();
  const reports: StallReport[] = [];
  const watchdog = new StallWatchdog({
    sessionId: "s1",
    turnId: "t1",
    onStall: (report) => reports.push(report),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const feed = (...events: AgentEvent[]): void => {
    for (const event of events) watchdog.observe(event);
  };
  return { watchdog, clock, reports, feed };
}

/**
 * The events the loop emits, built with only the fields the watchdog reads.
 *
 * `sessionId` is added by the wrapper below rather than typed into each arm, and
 * that is not laziness: sixteen literals naming a session is sixteen chances to
 * name the wrong one, and the watchdog does not read the field — what this file
 * needs is "an event of this type exists". One place stamps it.
 */
function event(type: AgentEvent["type"]): AgentEvent {
  return { ...body(type), sessionId: "s1" };
}

/** The event's own content, without the session every event carries. */
function body(type: AgentEvent["type"]): AgentEventBody {
  switch (type) {
    case "attempt-started":
      return { type, attempt: 1, total: 3, retryAfterMs: 0 };
    case "text-delta":
      return { type, text: "x", messageId: "m1" };
    case "reasoning-delta":
      return { type, text: "x", messageId: "m1" };
    case "tool-call":
      return { type, toolCallId: "c1", toolName: "read", input: {} };
    case "tool-result":
      return { type, toolCallId: "c1", toolName: "read", output: {} };
    case "tool-error":
      return { type, toolCallId: "c1", toolName: "read", error: "boom" };
    case "tool-output-denied":
      return { type, toolCallId: "c1", toolName: "write", reason: undefined };
    case "approval-requested":
      return { type, approvalId: "a1", toolCallId: "c1", toolName: "write", input: { path: "a.txt" }, reason: undefined };
    case "approval-answered":
      return { type, approvalId: "a1", approved: true };
    case "step-end":
      return { type, stepNumber: 0, text: "x", toolCallCount: 0, finishReason: "stop" };
    case "attempt-failed":
      return {
        type,
        attempt: 1,
        classification: { kind: "http-error", status: 500, retryable: true },
      };
    case "waiting":
      return { type, reason: "no response", retryAfterMs: 20_000 };
    case "turn-stopped":
      return { type, stage: "attempt" };
    case "turn-finished":
      return { type, outcome: "succeeded", attempts: 1 };
    case "error":
      return { type, error: new Error("x"), classification: { kind: "success" } };
    default:
      throw new Error(`unhandled event type: ${type}`);
  }
}

describe("the stall watchdog", () => {
  it("defaults to the engine's 20 s window", () => {
    const { watchdog } = setup();
    expect(watchdog.timeoutMs).toBe(20_000);
  });

  it("fires after the window of silence following an attempt", () => {
    const { clock, reports, feed } = setup();

    feed(event("attempt-started"));
    clock.advance(19_999);
    expect(reports).toHaveLength(0);

    clock.advance(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ sessionId: "s1", turnId: "t1", phase: "awaiting-provider" });
    expect(reports[0]?.silentForMs).toBe(20_000);
  });

  it("does not fire while the model is producing", () => {
    const { clock, reports, feed } = setup();

    feed(event("attempt-started"));
    // A delta every 10 s for a minute: each one pushes the window out.
    for (let second = 0; second < 6; second += 1) {
      clock.advance(10_000);
      feed(event("text-delta"));
    }

    // 60 s of a healthy stream, and never once a false alarm.
    expect(reports).toHaveLength(0);
  });

  it("does not fire during a tool call — a human is not a timeout", () => {
    const { clock, reports, feed, watchdog } = setup();

    feed(event("attempt-started"));
    feed(event("tool-call"));
    // Five windows with a tool executing. A `question` waits for a person here,
    // and a watchdog that fires would call that a stalled model.
    clock.advance(100_000);

    expect(reports).toHaveLength(0);
    expect(watchdog.phase).toBe("awaiting-human");
    expect(watchdog.armed).toBe(false);
  });

  it("re-arms when the tool comes back", () => {
    const { clock, reports, feed, watchdog } = setup();

    feed(event("attempt-started"));
    feed(event("tool-call"));
    clock.advance(60_000);
    expect(reports).toHaveLength(0);

    feed(event("tool-result"));
    expect(watchdog.armed).toBe(true);
    clock.advance(20_000);
    expect(reports).toHaveLength(1);
  });

  it("stays silent while an approval card is open", () => {
    const { clock, reports, feed } = setup();

    feed(event("step-end"));
    feed(event("approval-requested"));
    clock.advance(120_000);

    expect(reports).toHaveLength(0);
  });

  it("arms again once the approval is answered, because the turn resumes", () => {
    const { clock, reports, feed, watchdog } = setup();

    feed(event("step-end"));
    feed(event("approval-requested"));
    feed(event("approval-answered"));
    expect(watchdog.armed).toBe(true);

    clock.advance(20_000);
    expect(reports).toHaveLength(1);
  });

  it("never fires after the turn ended", () => {
    const { clock, reports, feed } = setup();

    feed(event("attempt-started"));
    feed(event("turn-finished"));
    clock.advance(60_000);

    expect(reports).toHaveLength(0);
  });

  it("never fires after a stop — a stop is a user action, not a stall", () => {
    const { clock, reports, feed } = setup();

    feed(event("attempt-started"));
    feed(event("turn-stopped"));
    clock.advance(60_000);

    expect(reports).toHaveLength(0);
  });

  it("reports once per silence, not once per timer tick", () => {
    const { clock, reports, feed } = setup();

    feed(event("attempt-started"));
    clock.advance(100_000);

    // One window elapsed, one report. A watchdog that re-armed itself on fire would
    // emit a stream of identical events and train the user to ignore them.
    expect(reports).toHaveLength(1);
  });

  it("names the last event seen, so the UI can say what it was waiting after", () => {
    const { clock, reports, feed } = setup();

    feed(event("attempt-started"));
    feed(event("step-end"));
    clock.advance(20_000);

    expect(reports[0]?.lastEventType).toBe("step-end");
  });

  it("counts a backoff as silence-window time only after the window restarts", () => {
    const { clock, reports, feed } = setup();

    // §5.4's backoff is 0 / 2 / 8 s. An `attempt-failed` is not a stall, but the
    // next attempt re-arms — and 8 s is inside a 20 s window, so no false positive.
    feed(event("attempt-started"));
    feed(event("attempt-failed"));
    clock.advance(8_000);
    feed(event("attempt-started"));
    clock.advance(19_999);

    expect(reports).toHaveLength(0);
    clock.advance(1);
    expect(reports).toHaveLength(1);
  });

  it("disarms on demand", () => {
    const { clock, reports, feed, watchdog } = setup();

    feed(event("attempt-started"));
    watchdog.disarm();
    clock.advance(60_000);

    expect(reports).toHaveLength(0);
    expect(watchdog.armed).toBe(false);
    expect(clock.pending()).toBe(0);
  });
});
