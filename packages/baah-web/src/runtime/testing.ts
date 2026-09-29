/**
 * Test doubles for the composition root.
 *
 * ## In `src/`, and that is deliberate
 *
 * These live beside the code rather than under a `test/` directory because the
 * composition root takes every one of its dependencies as a parameter — which is
 * the point of that design — and a fake the *other* block cannot import is a fake
 * nobody uses. The UI block's tests need a runtime just as much as mine do.
 *
 * They ship in `src/`, so they are part of the module graph. Nothing in `src/`
 * outside this file references them, so a bundle that never imports them never
 * includes them.
 *
 * ## What they are not
 *
 * Not a database. {@link RecordingTurnStore} records calls and answers
 * `listUnfinishedTurns` from a list the test seeds — the real adapter is another
 * agent's block (`Plan.md` §16.1), and importing storage here would be the second
 * path to the database this whole layer refuses to have.
 */

import {
  ProviderRegistry,
  type ToolCallRecord,
  type TurnOutcomeEntry,
  type TurnStore,
  type UnfinishedTurn,
} from "@all-the.rest/baah-core";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export interface RecordedDelta {
  readonly deltaId: string;
  readonly partId: string;
  readonly messageId: string;
  readonly sessionId: string;
  /** `text` or `reasoning` — the engine states it rather than the app guessing. */
  readonly partType: string;
  readonly contentText: string;
}

export interface RecordedPartClose {
  readonly sessionId: string;
  readonly messageId: string;
  readonly partId: string;
  readonly status: "completed" | "aborted";
}

export interface RecordedFinish {
  readonly turnId: string;
  readonly sessionId: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly error: string | undefined;
}

export interface RecordedHeartbeat {
  readonly turnId: string;
  /** Every write on the seam is session-scoped, including this one. */
  readonly sessionId: string;
  readonly at: string;
}

export interface RecordingTurnStoreOptions {
  /** What `listUnfinishedTurns` returns until the test changes it. */
  readonly unfinished?: readonly {
    readonly turnId: string;
    readonly heartbeatAt: string;
    readonly startedAt: string;
  }[];
  /** Make `flushDelta` reject — for the "a lost write is reported" test. */
  readonly failFlush?: boolean;
  /**
   * The error `flushDelta` rejects with, when `failFlush` is set.
   *
   * Injectable so a test can hand in an error that carries a key in its message —
   * the shape a provider's 401 produces — and then assert the runtime does not
   * forward it. A hard-coded `new Error("the database is gone")` cannot express
   * that, and a redaction test needs the leak to be *possible*.
   */
  readonly failFlushWith?: Error;
  /** What the session's log already carries, for `listTurnOutcomes`. */
  readonly outcomes?: readonly TurnOutcomeEntry[];
}

/**
 * A `TurnStore` that writes down what it was asked to do.
 *
 * Recording rather than asserting is the point: the interesting assertions are
 * *about the sequence* (one flush per step, in order, with the text as of that
 * step) and a fake that only counts calls cannot express them.
 */
export class RecordingTurnStore {
  readonly deltas: RecordedDelta[] = [];
  readonly finishes: RecordedFinish[] = [];
  readonly heartbeats: RecordedHeartbeat[] = [];
  readonly closedParts: RecordedPartClose[] = [];
  readonly closedTurns: { sessionId: string; turnId: string }[] = [];
  readonly beganToolCalls: { key: unknown; toolName: string; input: unknown }[] = [];
  readonly recordedToolCalls: { key: unknown; toolName: string; output: unknown }[] = [];
  readonly lookups: unknown[] = [];
  /** `listUnfinishedTurns` calls, in order — recovery reads, then the report reads. */
  listCalls = 0;

  #unfinished: { turnId: string; heartbeatAt: string; startedAt: string }[];
  #outcomes: TurnOutcomeEntry[];
  readonly #failFlush: Error | undefined;

  constructor(options: RecordingTurnStoreOptions = {}) {
    this.#unfinished = (options.unfinished ?? []).map((turn) => ({ ...turn }));
    this.#outcomes = (options.outcomes ?? []).map((entry) => ({ ...entry }));
    this.#failFlush = options.failFlush === true ? (options.failFlushWith ?? new Error("the database is gone")) : undefined;
  }

  /** The `TurnStore` shape. A value, so the fake stays test-owned. */
  get store(): TurnStore {
    return {
      flushDelta: async (input): Promise<void> => {
        if (this.#failFlush !== undefined) throw this.#failFlush;
        this.deltas.push({ ...input });
      },
      closePart: async (input): Promise<void> => {
        this.closedParts.push({ ...input });
      },
      closeTurnParts: async (input): Promise<void> => {
        this.closedTurns.push({ ...input });
      },
      finishTurn: async (input): Promise<void> => {
        this.finishes.push({ ...input });
        this.#outcomes.push({ turnId: input.turnId, outcome: input.outcome });
        // A turn with a terminal outcome is no longer *recoverable*. The real
        // store keeps it listed as unfinished on purpose (§3.1: an interrupted
        // turn stays re-sendable), which is why `listTurnOutcomes` exists as a
        // second read. Modelling both here keeps the idempotency test honest.
      },
      heartbeat: async (input): Promise<void> => {
        this.heartbeats.push({ ...input });
      },
      listUnfinishedTurns: async (): Promise<readonly UnfinishedTurn[]> => {
        this.listCalls += 1;
        return this.#unfinished.map((turn) => ({ ...turn }));
      },
      listTurnOutcomes: async (): Promise<readonly TurnOutcomeEntry[]> => {
        return this.#outcomes.map((entry) => ({ ...entry }));
      },
      recordToolCall: async (input): Promise<void> => {
        this.recordedToolCalls.push({ ...input });
      },
      getToolCall: async (key): Promise<ToolCallRecord | undefined> => {
        this.lookups.push(key);
        return undefined;
      },
      beginToolCall: async (input): Promise<void> => {
        this.beganToolCalls.push({ ...input });
      },
    };
  }

  /** Seed the log with outcomes a previous boot already wrote. */
  setOutcomes(entries: readonly TurnOutcomeEntry[]): void {
    this.#outcomes = entries.map((entry) => ({ ...entry }));
  }

  /** Replace the unfinished turns, as a crash would leave them. */
  setUnfinished(turns: readonly { turnId: string; heartbeatAt: string; startedAt: string }[]): void {
    this.#unfinished = turns.map((turn) => ({ ...turn }));
  }
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

/**
 * A `LanguageModel` built from the AI SDK's own test entrypoint.
 *
 * `ai/test` is used for the same reason core uses it: the class was renamed
 * across majors, so the name comes from the installed package rather than from
 * memory. Nothing here is a hand-rolled `LanguageModel`, which matters — a fake
 * that defined its own interface would only prove that the fake agrees with
 * itself.
 */
/**
 * A `LanguageModel` whose streams are scripted per request.
 *
 * **One entry per `doStream` call, not per part.** That is what makes a multi-step
 * turn scriptable: the loop asks the model once per step, so `[[step 1], [step 2]]`
 * is a two-step turn in which step 1 asks for a tool and step 2 answers. A model
 * that returned one long stream would be a one-step turn no matter how many parts it
 * contained.
 *
 * The last entry repeats if the loop asks for more streams than were scripted — a
 * test that under-scripts then sees a repeated step instead of an exception, which
 * is the friendlier failure for a fixture.
 */
export function mockModel(
  steps: readonly (readonly unknown[])[],
  options: {
    /**
     * A promise the stream waits on before it produces anything.
     *
     * This exists instead of `chunkDelayInMs` because a delay makes a test's
     * outcome depend on the machine's load: a turn that finishes "too early" turns
     * an in-flight guard into a test that passes having asserted nothing. A gate is
     * opened by the test, so "a turn is in flight" is a fact it established rather
     * than a race it hoped to win. A closed gate, by contrast, is how a stall is
     * staged.
     */
    readonly gate?: Promise<void>;
  } = {},
): LanguageModel {
  let call = 0;
  const scripted = steps.length === 0 ? [[finishPart()]] : steps;

  return new MockLanguageModelV4({
    doStream: async () => {
      const index = Math.min(call, scripted.length - 1);
      call += 1;
      // Awaited *before* the stream is created, so the turn is genuinely in flight
      // and genuinely has produced nothing.
      if (options.gate !== undefined) await options.gate;
      return {
        stream: simulateReadableStream({ chunks: scripted[index] as never[] }),
        request: {},
        response: { headers: {}, body: "" },
      };
    },
  }) as unknown as LanguageModel;
}

/** A gate that a test opens when it wants the gated turn to proceed. */
export function gate(): { readonly open: () => void; readonly promise: Promise<void> } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

/** A text block as the provider sends it. */
export function textParts(id: string, value: string): unknown[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: value },
    { type: "text-end", id },
  ];
}

/** A `finish` part carrying the provider's own reason — §5.4's terminal event. */
export function finishPart(unified = "stop"): unknown {
  return {
    type: "finish",
    finishReason: { unified, raw: unified },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
  };
}

/* ------------------------------------------------------------------ */
/* A registry that records what it was asked for                        */
/* ------------------------------------------------------------------ */

/**
 * A `ProviderRegistry` built on fakes, so the awaited `resolve` is exercised for
 * real rather than mocked away.
 *
 * The point is that `resolve` genuinely returns a `Promise` — it computes a
 * `crypto.subtle` digest before it can look at its cache — so a caller who forgets
 * the `await` gets a promise wearing a `LanguageModel` type. Reproducing that
 * needs the real registry, not a stub of it.
 */
export function fakeRegistry(options: { readonly model?: LanguageModel } = {}): {
  registry: ProviderRegistry;
  created: { apiKey: string; model: string; headers: Record<string, string> }[];
} {
  const created: { apiKey: string; model: string; headers: Record<string, string> }[] = [];
  const model = options.model ?? mockModel([[...textParts("t0", "hi"), finishPart()]]);

  const registry = new ProviderRegistry([
    {
      vendor: "openai",
      create({ apiKey, model: modelId, headers }) {
        created.push({ apiKey, model: modelId, headers });
        return model;
      },
    },
  ]);

  return { registry, created };
}
