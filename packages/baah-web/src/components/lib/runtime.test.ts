/**
 * The read port, as the app consumes it.
 *
 * ## What this file pins, and why it is not a `runtime/index.ts` test
 *
 * `runtime/index.ts` has its own suite and this block does not own it, so the
 * behaviour is exercised here through the public surface — which is also the only
 * place it matters. `Plan.md` §16.1 names two things that will bite the UI:
 *
 * 1. **A live part comes back with `status: "streaming"` and its text.** At most
 *    100 ms behind the buffer. Rendering it as in flight — not hidden — is the
 *    requirement, and `components/lib/transcript.ts` has the projection; this file
 *    pins that the **port** hands the status and the text over, because a port that
 *    dropped either would leave the projection nothing to be honest about.
 * 2. **A closed database rejects with `database_closed`; it does not return an
 *    empty transcript.** So the runtime converts the rejection into a `failed`
 *    union member, and this file checks that the empty case is reachable **only**
 *    from a read that succeeded.
 */
import { describe, expect, it } from "vitest";

import {
  createRuntime,
  type RuntimeDependencies,
  type Transcript,
  type TranscriptReader,
} from "../../runtime/index.ts";
import { RecordingTurnStore, fakeRegistry } from "../../runtime/testing.ts";
import { createSettingsStore } from "../../lib/settings-store.ts";
import { createMemoryBackend } from "../../lib/storage.ts";
import { createMemoryWorkspace } from "@all-the.rest/baah-core";

const SESSION = "session-read-port";

function settingsWithKey(): ReturnType<typeof createSettingsStore> {
  const store = createSettingsStore({ backend: createMemoryBackend() });
  store.update({ provider: { vendor: "openai", model: "gpt-4o-mini" } });
  store.setApiKey("openai", "sk-test");
  return store;
}

function emptyTranscript(): Transcript {
  return { sessionId: SESSION, turnId: null, messages: [], truncated: false, limit: 100 };
}

function runtimeWith(overrides: Partial<RuntimeDependencies> & { readonly transcript?: TranscriptReader } = {}) {
  const { registry } = fakeRegistry();
  return createRuntime({
    store: new RecordingTurnStore().store,
    workspace: createMemoryWorkspace({ "a.txt": "hallo" }),
    settings: settingsWithKey(),
    registry,
    tools: [],
    sessionId: SESSION,
    ...overrides,
  });
}

describe("a successful read is passed through untouched", () => {
  it("returns the transcript under `kind: \"ok\"`", async () => {
    const runtime = runtimeWith({ transcript: { read: async () => emptyTranscript() } });
    const read = await runtime.readTranscript();
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.transcript.sessionId).toBe(SESSION);
  });

  it("forwards the turn narrowing and the limit", async () => {
    // `Plan.md` §16.1: the session is the required half and the turn an optional
    // narrowing inside it. Dropping one of them would read a different slice.
    const seen: unknown[] = [];
    const runtime = runtimeWith({
      transcript: {
        read: async (request) => {
          seen.push(request);
          return emptyTranscript();
        },
      },
    });
    await runtime.readTranscript({ turnId: "turn-7", limit: 25 });
    expect(seen[0]).toEqual({ sessionId: SESSION, turnId: "turn-7", limit: 25 });
  });

  it("omits absent options rather than passing `undefined` explicitly", async () => {
    // `exactOptionalPropertyTypes` is on in this repo, and the same reasoning
    // applies at a wire boundary: an explicit `undefined` is not the same as an
    // absent key.
    const seen: unknown[] = [];
    const runtime = runtimeWith({
      transcript: {
        read: async (request) => {
          seen.push(request);
          return emptyTranscript();
        },
      },
    });
    await runtime.readTranscript();
    expect(seen[0]).toEqual({ sessionId: SESSION });
  });
});

describe("a closed database is a refusal, never an empty transcript", () => {
  const closed = { code: "database_closed", message: "the database is closed" };

  it("becomes `kind: \"failed\"`", async () => {
    // The `Plan.md` §16.1 rule, at the layer the UI consumes. A rejection that
    // reached the view as "no messages" would tell the user their conversation is
    // gone, which is the opposite of what happened.
    const runtime = runtimeWith({
      transcript: {
        read: async () => {
          throw closed;
        },
      },
    });
    const read = await runtime.readTranscript();
    expect(read.kind).toBe("failed");
  });

  it("names the store's code, which is the part the user can act on", async () => {
    // A `StorageError` message names SQL or a driver. `database_closed` says "the
    // tab's database went away" — and that is the actionable half.
    const runtime = runtimeWith({
      transcript: {
        read: async () => {
          throw closed;
        },
      },
    });
    const read = await runtime.readTranscript();
    if (read.kind !== "failed") throw new Error("expected failed");
    expect(read.reason).toContain("database_closed");
  });

  it("does not forward an arbitrary error message", async () => {
    // The same redaction `toRuntimeError` applies: an arbitrary `Error.message` is
    // the one shape in this program that can carry an API key — Google's 401 quotes
    // it back — and a read failure is rendered, screenshotted and pasted into issues.
    const runtime = runtimeWith({
      transcript: {
        read: async () => {
          throw new Error("sk-live-SECRET was rejected");
        },
      },
    });
    const read = await runtime.readTranscript();
    if (read.kind !== "failed") throw new Error("expected failed");
    expect(read.reason).not.toContain("SECRET");
  });

  it("says explicitly that this is not an empty conversation", async () => {
    // The two sentences a view needs: nothing was lost, and this view cannot say
    // what is in it. The second is the load-bearing one — "cannot say what is in
    // it" is what stops the view from falling through to its empty state.
    const runtime = runtimeWith({
      transcript: {
        read: async () => {
          throw closed;
        },
      },
    });
    const read = await runtime.readTranscript();
    if (read.kind !== "failed") throw new Error("expected failed");
    expect(read.reason).toContain("Nothing was lost");
    expect(read.reason).toContain("cannot say what is in it");
  });

  it("uses the class name for an error with no code", async () => {
    const runtime = runtimeWith({
      transcript: {
        read: async () => {
          throw new TypeError("network");
        },
      },
    });
    const read = await runtime.readTranscript();
    if (read.kind !== "failed") throw new Error("expected failed");
    expect(read.reason).toContain("TypeError");
  });
});

describe("a missing read port is a third state, not an empty session", () => {
  it("answers `kind: \"unavailable\"`", async () => {
    // Optional on the dependency for a reason: every existing caller would have to
    // grow a port it does not have. A wiring gap and a wired-and-empty session are
    // different facts about the program, and the UI says so in both cases.
    const runtime = runtimeWith();
    const read = await runtime.readTranscript();
    expect(read.kind).toBe("unavailable");
  });

  it("says the running turn is unaffected", async () => {
    // The message a user needs: the read port only backs the reload view.
    const runtime = runtimeWith();
    const read = await runtime.readTranscript();
    if (read.kind !== "unavailable") throw new Error("expected unavailable");
    expect(read.reason).toContain("running turn is unaffected");
  });
});

describe("the empty case is reachable only from a read that succeeded", () => {
  it("is reachable at all", async () => {
    // The other direction of the mutation: a port that refused every empty read
    // would make a genuinely new session indistinguishable from a broken one.
    const runtime = runtimeWith({ transcript: { read: async () => emptyTranscript() } });
    const read = await runtime.readTranscript();
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.transcript.messages).toHaveLength(0);
  });
});

describe("a refused read does not become a runtime error", () => {
  it("leaves the snapshot's `lastError` alone", async () => {
    // A refused restore belongs in the transcript view, which is where it is
    // rendered. Publishing a `runtime-error` would put a *settings-shaped* failure
    // in front of a user who did nothing wrong and is waiting for a restore to
    // finish — `runtime/index.ts` classifies by origin and the origin here is the
    // read, not an action.
    const runtime = runtimeWith({
      transcript: {
        read: async () => {
          throw { code: "database_closed" };
        },
      },
    });
    await runtime.readTranscript();
    expect(runtime.getState().lastError).toBeUndefined();
  });
});

describe("a live part comes back with its text and its status", () => {
  it("carries `status: \"streaming\"` and the text through the port", async () => {
    // `Plan.md` §16.1, and the reason the UI renders such a part rather than hiding
    // it: the tail is real, it is at most `DELTA_FLUSH_INTERVAL_MS` behind, and a
    // view that waits for the part to close makes a streaming model look broken.
    const transcript: Transcript = {
      sessionId: SESSION,
      turnId: "turn-1",
      truncated: false,
      limit: 100,
      messages: [
        {
          id: "m1",
          turnId: "turn-1",
          seq: 0,
          role: "assistant",
          status: "streaming",
          outcome: null,
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          parts: [
            {
              id: "p1",
              seq: 0,
              type: "text",
              contentText: "halb fertiger Satz",
              status: "streaming",
              data: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    };
    const runtime = runtimeWith({ transcript: { read: async () => transcript } });
    const read = await runtime.readTranscript({ turnId: "turn-1" });
    if (read.kind !== "ok") throw new Error("expected ok");
    const part = read.transcript.messages[0]?.parts[0];
    expect(part?.status).toBe("streaming");
    expect(part?.contentText).toBe("halb fertiger Satz");
  });
});
