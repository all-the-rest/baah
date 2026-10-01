/**
 * What a turn actually leaves in the store, and which message owns each row.
 *
 * ## Why this file exists, and what replaced what
 *
 * It is the *third* of the turn's write paths, and the two above it are tested
 * elsewhere: `turn-store.test.ts` is the decorator against a fake writer, and the
 * engine's own suite is in `packages/baah-core/test/`. What only this file can reach
 * is the real chain — a real `AgentTurn` against a scripted model, over
 * `createAppRuntime`, into `createMemoryDatabase()` — and read **back out of the
 * store** rather than out of a projection.
 *
 * That distinction is the whole file. `baah-storage` hands `parts.data` over as raw
 * JSON text on purpose (`Plan.md` §16.1), so a test that reads the row and parses the
 * blob is looking at what was *written*; a test that reads the transcript projection
 * is looking at what a reader made of it, and a reader can agree with a wrong row.
 *
 * It carries two tests that used to live in the deleted `tool-recorder.test.ts` and
 * one that did not exist anywhere:
 *
 * - the tool part's **stored** state is the engine's derivation, not the SDK's
 *   nominal `output-available` — which is the assertion that cannot be satisfied by
 *   the reader's identical rule;
 * - the user's prompt appears **once**, written by the engine (`#persistPrompt`) and
 *   not by a second writer in the app.
 *
 * ## The row that owns the tool card — the property this file is for
 *
 * `withTranscriptRows` creates the **assistant's** message row, because nothing else
 * does and `parts.message_id → messages.id` is a real foreign key. The engine writes
 * the turn row and the **user's** message row itself, through the same
 * `appendMessage`. So the row a tool part lands on is decided by which `messageId` the
 * engine's `upsertPart` names, and a decorator that treated the user's `appendMessage`
 * as "a row to create" would put the whole turn's cards on the user's own question.
 * That is a *visible* defect — every card in a turn moves into the wrong bubble — and
 * it is why the assertion below is on the **role of the owning message** and not
 * merely on "the card exists".
 *
 * The second half of the same property is the tool-only turn: a call arrives before
 * the engine has flushed a single delta, so there is no text part to bring the
 * message row into existence. The app used to solve that by buffering the tool part
 * in `components/lib/runtime.ts` until some other write reported the message id. The
 * buffer and the copy of the row it wrote are gone; `upsertPart` names the message,
 * so `ensureMessage` runs first. A turn with **no text at all** is the case that
 * proves it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, toolPartIdOf } from "@all-the.rest/baah-core";
import { createMemoryDatabase, type StorageDatabase, type Transcript } from "@all-the.rest/baah-storage";

import { fakeRegistry, finishPart, mockModel, textParts, toolCallParts } from "../../runtime/testing.ts";
import { createMemoryBackend, SettingsStorageError } from "../../lib/storage.ts";
import type { ProjectSessionStores } from "../../lib/ids.ts";
import { createAppRuntime, type AppRuntime } from "./runtime.ts";
import { storedMessages } from "./transcript.ts";

/**
 * A `read` that fails.
 *
 * Throwing is what makes these tests worth running end to end: `createSdkTool` catches
 * it and hands the model `{ ok: false, error }` as an ordinary **result**, so the SDK
 * reports `state: "output-available"` for a call that failed. That gap is the entire
 * reason anything derives a state from a value.
 */
const failingRead = defineTool<{ path: string }, string>({
  id: "read",
  description: "liest eine Datei",
  access: "read",
  inputSchema: z.object({ path: z.string() }),
  execute: async () => {
    throw new Error("File not found: gibt-es-nicht.md");
  },
});

/** A step that asks for a read that fails, one that answers. */
const failingReadScript: (readonly unknown[])[] = [
  [
    ...toolCallParts({ toolCallId: "call_1", toolName: "read", input: { path: "gibt-es-nicht.md" } }),
    finishPart("tool-calls"),
  ],
  [...textParts("t1", "Die Datei gibt es nicht."), finishPart()],
];

/**
 * The same turn with **no text at all** on the second step.
 *
 * The engine's prompt write and the tool part are then the only two things in the
 * store, and nothing but the tool part's own write can bring the assistant's message
 * row into existence. This is the script the deleted app-side buffer existed for.
 */
const toolOnlyScript: (readonly unknown[])[] = [
  [...toolCallParts({ toolCallId: "call_1", toolName: "read", input: { path: "gibt-es-nicht.md" } }), finishPart("tool-calls")],
  [finishPart()],
];

/** The app's own composition, with a memory database and a scripted model. */
async function appWithScriptedTurn(
  steps: readonly (readonly unknown[])[],
  overrides: { readonly openDatabase?: (() => Promise<StorageDatabase>) | undefined } = {},
): Promise<AppRuntime> {
  const { registry } = fakeRegistry({ model: mockModel(steps) });
  const app = await createAppRuntime({
    ...(overrides.openDatabase === undefined
      ? { openDatabase: async (storage) => storage.createMemoryDatabase() }
      : { openDatabase: async () => overrides.openDatabase?.() ?? (undefined as never) }),
    sessionStorage: createMemoryBackend(),
    settingsBackend: createMemoryBackend(),
    registry,
    tools: [failingRead],
  });
  // `resolveModel` reads the key out of the settings and refuses without one
  // (§9: a browser reads no environment). `fakeRegistry` is keyed on `openai`, so the
  // slot is `openai` too.
  app.settings.update({ provider: { vendor: "openai", model: "mock" } });
  app.settings.setApiKey("openai", "sk-test-not-a-real-key");
  return app;
}

/** The whole stored transcript, or a thrown error naming why the read failed. */
async function read(app: AppRuntime): Promise<Transcript> {
  const result = await app.runtime.readTranscript();
  if (result.kind !== "ok") throw new Error(`read failed: ${result.reason}`);
  return result.transcript;
}

/** The message that owns a part id, or `undefined` if no message does. */
function ownerOf(store: Transcript, partId: string): { role: string; id: string } | undefined {
  const message = store.messages.find((entry) => entry.parts.some((part) => part.id === partId));
  return message === undefined ? undefined : { role: message.role, id: message.id };
}

/** The stored `data` blob, parsed. The writer's output and nothing else. */
function storedData(store: Transcript, partId: string): Record<string, unknown> {
  const part = store.messages.flatMap((message) => message.parts).find((entry) => entry.id === partId);
  if (part === undefined || part.data === null) throw new Error(`no stored part for ${partId}`);
  const parsed: unknown = JSON.parse(part.data);
  if (typeof parsed !== "object" || parsed === null) throw new Error("stored data is not an object");
  return parsed as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Which message owns the tool card                                    */
/* ------------------------------------------------------------------ */

describe("a tool card lands on the assistant's message, not the user's", () => {
  it("puts the card on the assistant row and the question on the user's own", async () => {
    /**
     * **The role property, end to end.** Three messages come back — the user's
     * question, the assistant's turn, and the `idle` outcome — and the card belongs
     * to the middle one.
     *
     * The engine writes the user's row itself (`AgentTurn.#persistPrompt`) through
     * the *same* `appendMessage` the decorator's `ensureMessage` would use. An
     * unfiltered treatment of that call — or a decorator that created a second row for
     * an id the engine had already appended — puts the card in the user's bubble, and
     * the transcript then shows the agent's answer with the user's question wearing
     * its cards.
     */
    const app = await appWithScriptedTurn(failingReadScript);
    await app.runtime.send({ prompt: "lies die Datei" });

    const transcript = await read(app);
    const partId = toolPartIdOf("call_1");
    const owner = ownerOf(transcript, partId);
    expect(owner, `no message owns ${partId}`).toBeDefined();
    expect(owner?.role, "the card must hang off the assistant's row").toBe("assistant");

    // And the user's row is untouched: one message, one part, and it is the question.
    const user = transcript.messages.filter((message) => message.role === "user");
    expect(user).toHaveLength(1);
    expect(user[0]?.parts).toHaveLength(1);
    expect(user[0]?.parts[0]?.type).toBe("text");
    expect(user[0]?.parts[0]?.contentText).toBe("lies die Datei");
    expect(user[0]?.parts.some((part) => part.id === partId)).toBe(false);
  });

  it("keeps the question and the answer in one message, card before prose", async () => {
    // The ordering falls out of `seq`: the card is written at `tool-call` and the text
    // at the first delta, and `Plan.md` §5.1's loop is "step 1 asks for a tool, step 2
    // answers with the result". It is the order the live fold shows, which is why a
    // reload does not reshuffle the conversation.
    const app = await appWithScriptedTurn(failingReadScript);
    await app.runtime.send({ prompt: "lies die Datei" });

    const transcript = await read(app);
    const owner = transcript.messages.find((message) => message.parts.some((part) => part.id === toolPartIdOf("call_1")));
    expect(owner?.parts.map((part) => part.type)).toEqual(["tool", "text"]);
  });

  it("still stores the card when the turn never says a word", async () => {
    /**
     * The case the deleted app-side **buffer** existed for, and the one that proves the
     * replacement. Nothing flushes a delta, so no other write can create the
     * assistant's message row; only the tool part's own write does, because
     * `TurnStore.upsertPart` names the message and the decorator creates the row
     * before delegating.
     *
     * The old code answered this by queueing the write in `components/lib/runtime.ts`
     * until *some other* write reported the id — which for this turn is never, so the
     * queue was drained only by the next turn's first flush. A card on the next turn's
     * message is a card in the wrong place, and nothing reported it.
     */
    const app = await appWithScriptedTurn(toolOnlyScript);
    await app.runtime.send({ prompt: "lies die Datei" });

    const transcript = await read(app);
    const partId = toolPartIdOf("call_1");
    expect(ownerOf(transcript, partId)?.role).toBe("assistant");
    // No text part was ever flushed, so the card is the whole message.
    const owner = transcript.messages.find((message) => message.parts.some((part) => part.id === partId));
    expect(owner?.parts.map((part) => part.type)).toEqual(["tool"]);
  });
});

/* ------------------------------------------------------------------ */
/* The row itself                                                      */
/* ------------------------------------------------------------------ */

describe("the tool part the engine writes", () => {
  it("stores `output-error` for a tool that really failed", async () => {
    /**
     * **Asserted on the row, not on the projection.** The SDK reports
     * `output-available` for this call — core hands the failure back as a result — so a
     * row written from the nominal state would bake "Ausgeführt" into the transcript
     * permanently: right until a reload, wrong after it.
     *
     * `transcript.test.ts` covers the reader's identical rule on the same value, and
     * that test would still pass if the *writer* were wrong. This one cannot: it parses
     * the `data` blob the store holds.
     */
    const app = await appWithScriptedTurn(failingReadScript);
    await app.runtime.send({ prompt: "lies die Datei" });

    const data = storedData(await read(app), toolPartIdOf("call_1"));
    expect(data["state"]).toBe("output-error");
    expect(data["errorText"]).toContain("File not found");
    // The name is in the **discriminator**, not in a `toolName` field — that is what
    // the engine's own `toolCallPart` writes, and it is why core's `isToolPart` has to
    // check `part.type.startsWith("tool-")`.
    expect(data["type"]).toBe("tool-read");
    expect(data).not.toHaveProperty("toolName");
  });

  it("and the read port reports the same verdict, so a reloaded card agrees with a live one", async () => {
    // The other half. It passes with either rule in place — which is the point: it
    // exists so that *removing* the reader's half cannot change what the row says, and
    // removing the writer's half is caught by the test above.
    const app = await appWithScriptedTurn(failingReadScript);
    await app.runtime.send({ prompt: "lies die Datei" });

    const transcript = await read(app);
    const rendered = storedMessages(transcript)
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "tool" && part.toolCallId === "call_1");
    expect(rendered).toMatchObject({ state: "output-error", stateLabel: "Fehlgeschlagen" });
  });

  it("is one row for the whole call, not one per event", async () => {
    // Three events report the same call — call, result, and again on a replay — and the
    // part id is **derived** from the `toolCallId` (`toolPartIdOf`, the engine's), so
    // they fold into one row instead of three. Three minted ids would be three cards in
    // the transcript for one tool call.
    //
    // What this does **not** prove, and it is worth saying: a second writer aimed at
    // the same row would also leave one row behind, because it would compute the same
    // id. What catches that is the wiring — see the last test in this file.
    const app = await appWithScriptedTurn(failingReadScript);
    await app.runtime.send({ prompt: "lies die Datei" });

    const transcript = await read(app);
    const cards = transcript.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.id === toolPartIdOf("call_1"));
    expect(cards).toHaveLength(1);
    expect(transcript.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The app has no tool-part sink                                       */
/* ------------------------------------------------------------------ */

describe("the app runtime offers nothing for a second writer to write through", () => {
  it("has no tool-part sink and no assistant-message id", async () => {
    /**
     * The wiring half of "two writers, one row", and the half a row count cannot see.
     *
     * `AppRuntime.recordToolInvocation` and `AppRuntime.assistantMessageId` are gone,
     * so there is no second path into the table: the seam is the only writer, which is
     * what `Plan.md` §16.1 refused for the `TurnStore` adapter and why the same
     * argument applies to the tool part.
     *
     * A source gate could assert the same thing, and this is the runtime form of it —
     * it is immune to a reformat, it needs no comment stripper, and it fails the moment
     * the member comes back, whoever adds it.
     */
    const app = await appWithScriptedTurn(failingReadScript);
    expect(Object.keys(app)).not.toContain("recordToolInvocation");
    expect("recordToolInvocation" in app).toBe(false);
    expect("assistantMessageId" in app).toBe(false);
    // The one sink that remains is the store the engine writes through, and the
    // read-only view of it that the tests above use.
    expect(typeof app.database.upsertPart).toBe("function");
  });
});

/* ------------------------------------------------------------------ */
/* The default path is the worker path                                 */
/* ------------------------------------------------------------------ */

describe("the default database path", () => {
  it("is the worker, and refuses to run without one", async () => {
    /**
     * The mutation "keep the memory database even when `openDatabase` works" is
     * killed by the reload scenario in the E2E suite — and by **nothing** in the unit
     * suite, which was measured, not assumed. So this is the second path, and it is a
     * fact about the environment rather than a fact about a rendered transcript.
     *
     * vitest has no `Worker` and no OPFS, so the default path **cannot succeed here**.
     * A `createMemoryDatabase()` in its place would resolve happily — that is
     * precisely what the mutation does, and precisely what makes the mutation invisible
     * to a unit test.
     */
    await expect(
      createAppRuntime({ settingsBackend: createMemoryBackend(), sessionStorage: createMemoryBackend() }),
    ).rejects.toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* The second load                                                     */
/* ------------------------------------------------------------------ */

/**
 * `Plan.md` §1 DoD 4, at the level a unit test can reach.
 *
 * The E2E proves it in Chromium against real OPFS; this proves the two halves it
 * needs, without a browser, so a regression is caught by `pnpm check` rather than by
 * an E2E run:
 *
 * 1. **the same session is reused**, and creating it a second time does not throw —
 *    `createSession` is a plain `INSERT … RETURNING`, not an upsert, so an
 *    unconditional create turns *every* reload into a boot failure;
 * 2. **the rows written by the first load are readable by the second**, which is what
 *    "survives a reload" means.
 */
describe("a second load of the same session", () => {
  /** One app runtime over a database and a session store the test keeps. */
  async function openOver(
    database: StorageDatabase,
    projectSessions: ProjectSessionStores,
    steps: readonly (readonly unknown[])[],
  ): Promise<AppRuntime> {
    const { registry } = fakeRegistry({ model: mockModel(steps) });
    const app = await createAppRuntime({
      openDatabase: async () => database,
      // **The project→session map is its own backend, and the test hands it in.**
      // It used to be one `localStorage` value — "the session this browser talks to"
      // — and became a map keyed by project id when projects arrived. A test that
      // injected only the legacy backend would be injecting a store the app does not
      // read, and the second load would mint a fresh session and pass for a reload
      // that never happened. The legacy backend is still passed, because the sandbox
      // project adopts from it exactly once.
      projectSessions,
      settingsBackend: createMemoryBackend(),
      registry,
      tools: [failingRead],
    });
    // `resolveModel` reads the key out of the settings and refuses without one
    // (§9: a browser reads no environment).
    app.settings.update({ provider: { vendor: "openai", model: "mock" } });
    app.settings.setApiKey("openai", "sk-test-not-a-real-key");
    return app;
  }

  const oneStep: (readonly unknown[])[] = [[...textParts("t1", "Die erste Antwort."), finishPart()]];

  it("reopens without throwing, and the earlier transcript is still there", async () => {
    // No `sessionId` passed anywhere: the app resolves it from storage, which is what
    // the browser does. `createMemoryDatabase` is the injected stand-in for
    // `openDatabase`, and the *same instance* is handed to both loads — which is the
    // whole point, since a fresh `Map` would model a fresh browser, not a reload.
    const database = createMemoryDatabase();
    // **One** set of stores, shared by both loads. A fresh `createMemoryBackend()`
    // inside `openOver` would model a fresh browser rather than a reload, and the
    // assertion below would then be comparing two unrelated sessions.
    const projectSessions: ProjectSessionStores = {
      projects: createMemoryBackend(),
      legacy: createMemoryBackend(),
    };
    const first = await openOver(database, projectSessions, oneStep);
    // The engine writes the prompt itself (`AgentTurn.#persistPrompt`), so the question
    // is in the transcript with no help from the app — which is what makes this test
    // also a check that the app did **not** write it a second time.
    await first.runtime.send({ prompt: "erste Frage" });

    // The second load. This is where the mutation "create the session
    // unconditionally" dies: `createSession` is an `INSERT … RETURNING`, so the second
    // call raises a `UNIQUE` violation and the app would show its boot-failure screen
    // on **every** reload.
    const second = await openOver(database, projectSessions, oneStep);

    expect(second.runtime.sessionId).toBe(first.runtime.sessionId);
    // And the project is the same project — the reload must not have created a second
    // `workspaces` row, which is what a re-minted project id would look like.
    expect(second.project.projectId).toBe(first.project.projectId);
    const transcript = await read(second);
    const text = transcript.messages
      .flatMap((message) => message.parts)
      .map((part) => part.contentText)
      .join("\n");
    expect(text).toContain("Die erste Antwort.");
    expect(text).toContain("erste Frage");
    // And the question appears **once**. Two writers for one prompt would both land,
    // with different ids and different `seq` numbers, and the transcript would show the
    // question twice.
    expect(text.split("erste Frage")).toHaveLength(2);
    // Nothing was degraded: the id was remembered, so the history is reachable.
    expect(second.bootProblems).toEqual([]);
  });

  it("reports a storage that would not keep the id, instead of losing the history quietly", async () => {
    // The other half of DoD 4, and the part that is easy to omit: if the id cannot be
    // remembered, the next load opens a **new** session and the rows of this one become
    // unreachable. That is said out loud (`AGENTS.md` §5) rather than discovered by a
    // user who reloads.
    const hostile = createMemoryBackend();
    hostile.write = () => {
      throw new SettingsStorageError("write-failed", "quota");
    };
    // The **project map** is what the app writes the pointer into, so that is the
    // backend that has to be hostile. Making the legacy one hostile instead would
    // leave the new path untouched and the test would pass without proving anything:
    // the pointer would be written successfully to the map the app actually reads.
    const app = await openOver(
      createMemoryDatabase(),
      { projects: hostile, legacy: createMemoryBackend() },
      oneStep,
    );

    expect(app.bootProblems).toHaveLength(1);
    expect(app.bootProblems[0]).toContain("nicht gespeichert");
  });
});
