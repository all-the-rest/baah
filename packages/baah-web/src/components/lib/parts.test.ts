/**
 * The part projection: the three part types, the seven card states, and the two
 * trust rules that live in a tool card.
 *
 * ## Why these are unit tests and not Playwright tests
 *
 * The decisions in `parts.ts` are the dangerous ones — which state a card claims,
 * whether a truncation warning appears, whether an error is shown on a state that
 * has none. Testing them through a browser means a test that is slow, that can
 * flake on a Tailwind upgrade, and that still only asserts on a rendered string.
 * `AGENTS.md` §6 asks for measured behaviour, and these are measurable with no DOM
 * at all.
 *
 * The E2E suite then covers what only a browser can: that a real streamed tool call
 * arrives, and that the approval pauses the loop.
 */
import { describe, expect, it } from "vitest";

import {
  fileDiffs,
  isOutcomeMessage,
  isToolInFlight,
  isToolInvocationPart,
  partTestId,
  renderPart,
  toolCardState,
  toolNameOf,
  toolStateLabel,
  truncationNotice,
} from "./parts.ts";
import * as parts from "./parts.ts";
import type { UIMessage } from "ai";

type Part = UIMessage["parts"][number];

/** A tool part in a given state, without going through the SDK's generics. */
function toolPart(state: string, extra: Record<string, unknown> = {}): Part {
  return {
    type: "tool-read",
    toolCallId: "call-1",
    state,
    input: { path: "a.txt" },
    ...extra,
  } as unknown as Part;
}

/** The `kind` of a rendered tool part, with a failure rather than a cast. */
function asTool(rendered: ReturnType<typeof renderPart>): Extract<NonNullable<typeof rendered>, { kind: "tool" }> {
  if (rendered === undefined || rendered.kind !== "tool") throw new Error(`expected a tool part, got ${String(rendered?.kind)}`);
  return rendered;
}

describe("part classification", () => {
  it("finds a tool part under the static `tool-<name>` discriminator", () => {
    // Not `type === "tool"`. The SDK's static tool part is `` `tool-${NAME}` `` and
    // a dynamic one is `dynamic-tool`; a check against the literal "tool" finds
    // nothing at all, which is why `Plan.md` §6.1's three type names are the
    // *storage* types and not the UI part discriminators.
    const part = toolPart("input-available");
    expect(isToolInvocationPart(part)).toBe(true);
    expect(toolNameOf(part as never)).toBe("read");
  });

  it("finds a tool part under the dynamic discriminator", () => {
    const part = { type: "dynamic-tool", toolName: "grep", toolCallId: "c", state: "input-available" } as unknown as Part;
    expect(isToolInvocationPart(part)).toBe(true);
    expect(toolNameOf(part as never)).toBe("grep");
  });

  it("does not mistake a text part for a tool part", () => {
    expect(isToolInvocationPart({ type: "text", text: "hallo" } as Part)).toBe(false);
  });

  it("does not mistake a tool-named part without a state for an invocation", () => {
    // `toolCallId` and `state` are what make it a card. A part that happens to be
    // called `tool-…` but carries neither has nothing to render.
    const part = { type: "tool-read", toolCallId: "c" } as unknown as Part;
    expect(isToolInvocationPart(part)).toBe(false);
  });

  it("recognises the turn outcome as an `idle` message, not as a `UIMessage` role", () => {
    // `UIMessage["role"]` has no `idle`; that role belongs to `baah-storage`'s
    // `messages.role`, and the read port hands over the wider string.
    expect(isOutcomeMessage({ role: "idle" })).toBe(true);
    expect(isOutcomeMessage({ role: "assistant" })).toBe(false);
    expect(isOutcomeMessage({ role: "user" })).toBe(false);
  });
});

describe("the card state", () => {
  it("passes the seven documented states through", () => {
    const states = [
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied",
    ] as const;
    for (const state of states) {
      expect(toolCardState(toolPart(state) as never)).toBe(state);
    }
  });

  it("falls back to `input-available` for a state it does not know", () => {
    // Never a lie about an outcome. An unknown state from a newer build renders as
    // "about to run", which is the only one of the seven that claims nothing.
    expect(toolCardState(toolPart("something-new") as never)).toBe("input-available");
  });

  it("gives every state its own German sentence", () => {
    const labels = [
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied",
    ].map((state) => toolStateLabel(state as never));
    expect(new Set(labels).size).toBe(labels.length);
    // `Plan.md` §7.6: a refusal is a legitimate answer and must not wear the
    // failure's colour.
    expect(toolStateLabel("output-denied")).not.toBe(toolStateLabel("output-error"));
  });

  it("counts exactly the three states as in flight", () => {
    expect(isToolInFlight("input-streaming")).toBe(true);
    expect(isToolInFlight("input-available")).toBe(true);
    expect(isToolInFlight("approval-responded")).toBe(true);
    // A card waiting for a human is not in flight — the user is.
    expect(isToolInFlight("approval-requested")).toBe(false);
    expect(isToolInFlight("output-available")).toBe(false);
    expect(isToolInFlight("output-error")).toBe(false);
    expect(isToolInFlight("output-denied")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Truncation — `Plan.md` §4 and the tools' own `searchTruncated`       */
/* ------------------------------------------------------------------ */

describe("truncationNotice", () => {
  it("reads `searchTruncated` off a search tool's output", () => {
    const notice = truncationNotice("grep", { searchTruncated: true, matches: [] });
    expect(notice?.field).toBe("searchTruncated");
    // The sentence has to say what to do about it, not just that it happened.
    expect(notice?.message).toMatch(/unvollständig/);
  });

  it("reads the plain `truncated` flag too", () => {
    expect(truncationNotice("read", { truncated: true })?.field).toBe("truncated");
  });

  it("prefers `searchTruncated` when both are set", () => {
    // The search-specific flag is the one that carries the "treat as a sample"
    // instruction; the generic one does not.
    expect(truncationNotice("glob", { truncated: true, searchTruncated: true })?.field).toBe("searchTruncated");
  });

  it("says nothing when the tool did not set a flag", () => {
    expect(truncationNotice("grep", { searchTruncated: false, matches: [1] })).toBeUndefined();
    expect(truncationNotice("grep", {})).toBeUndefined();
    expect(truncationNotice("grep", undefined)).toBeUndefined();
    expect(truncationNotice("grep", "text")).toBeUndefined();
  });

  it("stays silent for a tool that cannot report a truncated search", () => {
    // `write` has no search, so a field of that name on its output is not a
    // truncation notice. The tool list is the filter, and it is a list.
    expect(truncationNotice("write", { searchTruncated: true })).toBeUndefined();
    expect(truncationNotice("shell", { truncated: true })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* File diffs — `Plan.md` §6.1 / §14.3, in the part's metadata           */
/* ------------------------------------------------------------------ */

describe("fileDiffs", () => {
  const diff = {
    file: "src/app.ts",
    patch: "@@ -1 +1 @@",
    additions: 1,
    deletions: 0,
    status: "modified",
  };

  it("reads the diffs off the call's **input**", () => {
    const found = fileDiffs({ metadata: { files: [diff] } }, undefined);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ file: "src/app.ts", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, status: "modified" });
  });

  it("also reads the diffs off the call's **output**", () => {
    // Which side carries the diff depends on the tool: a tool that reports what it
    // changed puts it in its output, and the engine stores the input-side data.
    // Checking only one of them is a coin flip on which tools display anything.
    expect(fileDiffs(undefined, { metadata: { files: [diff] } })).toHaveLength(1);
  });

  it("reports an absent field as `undefined` rather than a zero", () => {
    const found = fileDiffs({ metadata: { files: [{ file: "a.ts" }] } }, undefined);
    expect(found[0]?.additions).toBeUndefined();
    expect(found[0]?.deletions).toBeUndefined();
    expect(found[0]?.status).toBeUndefined();
  });

  it("returns nothing for malformed data, and never throws", () => {
    // A diff is decoration on a card. A malformed one must not take the card down.
    expect(fileDiffs(undefined, undefined)).toEqual([]);
    expect(fileDiffs("text", 7)).toEqual([]);
    expect(fileDiffs({ metadata: null }, null)).toEqual([]);
    expect(fileDiffs({ metadata: { files: "no" } }, undefined)).toEqual([]);
    expect(fileDiffs({ metadata: { files: [null, {}, { file: 3 }] } }, undefined)).toEqual([]);
  });

  it("ignores a non-finite count", () => {
    const found = fileDiffs({ metadata: { files: [{ file: "a.ts", additions: Number.NaN }] } }, undefined);
    expect(found[0]?.additions).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* renderPart                                                          */
/* ------------------------------------------------------------------ */

describe("renderPart", () => {
  it("drops a part with no visible content", () => {
    // An empty `step-start`, an empty text delta. Rendering an empty bubble for each
    // would make the transcript look broken for a reason it has.
    expect(renderPart({ type: "text", text: "" } as Part)).toBeUndefined();
    expect(renderPart({ type: "reasoning", text: "" } as Part)).toBeUndefined();
    expect(renderPart({ type: "step-start" } as unknown as Part)).toBeUndefined();
    expect(renderPart({ type: "source-url", sourceId: "s", url: "https://x.invalid" } as unknown as Part)).toBeUndefined();
  });

  it("keeps a streaming text part's text and marks it in flight", () => {
    // `Plan.md` §16.1: hide the tail and the model looks stuck.
    const rendered = renderPart({ type: "text", text: "halb", state: "streaming" } as unknown as Part);
    if (rendered?.kind !== "text") throw new Error("expected a text part");
    expect(rendered.text).toBe("halb");
    expect(rendered.inFlight).toBe(true);
    // The model's own words, not a tool's — the two must never share a provenance.
    expect(rendered.provenance).toBe("model");
  });

  it("projects a reasoning part as reasoning, not as text", () => {
    // `Plan.md` §5.1's lesson: a reasoning delta rendered as text shows the model's
    // thinking as something it said. The kind is what keeps them apart.
    const rendered = renderPart({ type: "reasoning", text: "überlege" } as Part);
    expect(rendered?.kind).toBe("reasoning");
  });

  it("marks a tool's output as tool-authored", () => {
    const rendered = asTool(renderPart(toolPart("output-available", { output: "file content" }) as never));
    // The output is a file's content until proven otherwise. `Plan.md` §4.1's
    // injection surface is exactly this.
    expect(rendered.outputProvenance).toBe("tool-authored");
  });

  it("shows an error only on `output-error`", () => {
    const onError = asTool(renderPart(toolPart("output-error", { errorText: "kaputt" }) as never));
    expect(onError.errorText).toBe("kaputt");
    // A stale error next to a successful result would be a second lie.
    const onSuccess = asTool(renderPart(toolPart("output-available", { output: "ok", errorText: "alt" }) as never));
    expect(onSuccess.errorText).toBeUndefined();
  });

  it("carries the approval id off the state that has one", () => {
    const rendered = asTool(
      renderPart(toolPart("approval-requested", { approval: { id: "ap-1", requestReason: "Schreiben?" } }) as never),
    );
    expect(rendered.approvalId).toBe("ap-1");
  });

  it("reads the approval id defensively, or not at all", () => {
    // A malformed `approval` must not produce an id that `answerApproval` would then
    // send and the engine would not find.
    expect(asTool(renderPart(toolPart("approval-requested") as never)).approvalId).toBeUndefined();
    expect(asTool(renderPart(toolPart("approval-requested", { approval: null }) as never)).approvalId).toBeUndefined();
    expect(asTool(renderPart(toolPart("approval-requested", { approval: { id: 3 } }) as never)).approvalId).toBeUndefined();
  });

  it("shows the truncation notice only once there is an output to be truncated", () => {
    const withOutput = asTool(renderPart(toolPart("output-available", { output: { searchTruncated: true } }) as never));
    expect(withOutput.truncation?.field).toBe("searchTruncated");
    const beforeOutput = asTool(renderPart(toolPart("input-available", { input: { searchTruncated: true } }) as never));
    // The flag is on the *input* here, and an input that has not run yet cannot be a
    // truncated result.
    expect(beforeOutput.truncation).toBeUndefined();
  });

  it("reports an unknown part type instead of dropping it", () => {
    // A database written by a newer build must not silently lose content here.
    const rendered = renderPart({ type: "some-future-part" } as unknown as Part);
    expect(rendered?.kind).toBe("unsupported");
  });
});

/* ------------------------------------------------------------------ */
/* A thrown tool error arrives as a *result*                            */
/* ------------------------------------------------------------------ */

/**
 * `toToolErrorResult` (`packages/baah-core/src/tool.ts:118`) turns every throw out
 * of `definition.execute` into `{ ok: false, error }` on purpose, so the model can
 * read the failure instead of the step dying. The consequence for the UI is that a
 * failing tool's part is `output-available` and the **state alone lies**.
 *
 * ## These are assertions about what the user sees, not about the rule
 *
 * `toolResultFailure` and `toolStateForResult` are the **engine's**
 * (`@all-the.rest/baah-core`, `agent/loop.ts`) and are tested there, against the
 * stored row, in `packages/baah-core/test/agent/tool-part.test.ts`. What belongs to
 * *this* package is the half above them: that {@link renderPart} turns a failure
 * envelope into a card that says `Fehlgeschlagen`, carries the reason, and does not
 * also print the envelope as output — on the same function the engine uses, so a
 * reloaded card and a live card cannot disagree.
 *
 * Every assertion below therefore goes through `renderPart`. A test that called
 * `toolStateForResult` directly would be a second copy of the engine's suite in the
 * wrong package, and it is what the mutation "re-point `parts.ts` at its own copy"
 * would have needed in order to stay green.
 */
describe("a failure envelope on a tool result", () => {
  const failure = { ok: false, error: "File not found: gibt-es-nicht.md" } as const;

  it("renders `Fehlgeschlagen` with the envelope's message, and no output beside it", () => {
    // The bug this whole path exists for: a card that says `Ausgefuehrt` for a `read`
    // of a file that does not exist is a lie the user acts on. And the envelope is not
    // also printed as the output: its whole content is the error string, so the card
    // would say the same sentence twice.
    const rendered = asTool(renderPart(toolPart("output-available", { output: failure }) as never));
    expect(rendered.state).toBe("output-error");
    expect(rendered.stateLabel).toBe("Fehlgeschlagen");
    expect(rendered.errorText).toBe("File not found: gibt-es-nicht.md");
    expect(rendered.output).toBeUndefined();
  });

  it("leaves a genuine result alone", () => {
    const rendered = asTool(
      renderPart(toolPart("output-available", { output: { ok: true, path: "a.txt" } }) as never),
    );
    expect(rendered.state).toBe("output-available");
    expect(rendered.errorText).toBeUndefined();
    expect(rendered.output).toContain("a.txt");
  });

  it("does not badge a failure the envelope says nothing about", () => {
    // `AGENTS.md`'s rule in miniature: a `Fehlgeschlagen` with a blank reason is a
    // claim the user cannot check, so an envelope with no message is not treated as
    // a failure at all.
    for (const output of [{ ok: false }, { ok: false, error: "" }, undefined, "plain text"]) {
      const rendered = asTool(renderPart(toolPart("output-available", { output }) as never));
      expect(rendered.state, JSON.stringify(output)).toBe("output-available");
      expect(rendered.errorText, JSON.stringify(output)).toBeUndefined();
    }
  });

  it("does not claim `tool-outcome-unknown`, which is not a failure", () => {
    // `packages/baah-core/src/agent/tools.ts:449-462` returns `ok: false` **with**
    // an `error` and its own `outcome: "unknown"`. That is "the tab died mid-call",
    // and `Plan.md` §5.1 gives it its own node. Painting `Fehlgeschlagen` onto it
    // would be the second of the two lies the scenario exists to separate — so the
    // envelope's `error` string must not reach the card as one.
    const unknown = {
      ok: false,
      outcome: "unknown",
      toolCallId: "call-1",
      toolName: "write",
      error: "began but never reported a result",
    } as const;
    const rendered = asTool(renderPart(toolPart("output-available", { output: unknown }) as never));
    expect(rendered.state).toBe("output-available");
    expect(rendered.errorText).toBeUndefined();
  });

  it("never overrules a state the engine decided on purpose", () => {
    // `output-denied` is a refusal, not a malfunction (`Plan.md` §7.6). A tool whose
    // own payload looks like a failure envelope must not be able to relabel it — and
    // a card that is waiting for the user must not turn into a failure either.
    for (const state of ["output-denied", "approval-requested", "input-available", "approval-responded"]) {
      const rendered = asTool(renderPart(toolPart(state, { output: failure }) as never));
      expect(rendered.state, state).toBe(state);
      expect(rendered.errorText, state).toBeUndefined();
    }
  });

  it("keeps the SDK's own `errorText` when the state is already `output-error`", () => {
    // The two paths carry different values: `tool-error` carries the message as a
    // string, `tool-result` carries the envelope. Neither may end up rendering an
    // `output-error` with nothing on it.
    const rendered = asTool(renderPart(toolPart("output-error", { errorText: "kaputt" }) as never));
    expect(rendered.errorText).toBe("kaputt");
  });

  it("never lets a failure envelope print a truncation notice or a diff", () => {
    // A file's contents on a path that does not exist is not a truncated read; a
    // card showing both would claim two things at once.
    const rendered = asTool(
      renderPart(
        toolPart("output-available", { output: { ok: false, error: "x", searchTruncated: true, metadata: { files: [{ file: "a" }] } } }) as never,
      ),
    );
    expect(rendered.truncation).toBeUndefined();
    expect(rendered.diffs).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The rule has one implementation                                      */
/* ------------------------------------------------------------------ */

/**
 * `toolStateForResult` and `toolResultFailure` are the **engine's**, and
 * `ToolCardState` is the engine's union. `parts.ts` imports all three. A copy here
 * would be free to agree with the stored row until the day it did not, and the
 * symptom would be a reloaded card disagreeing with a live one — which is why this
 * is a gate and not a note.
 *
 * ## Two checks, because either alone has a hole
 *
 * - **The module's own surface.** A behaviour test cannot tell "imported" from
 *   "re-declared and re-exported", and a non-exported local copy would satisfy every
 *   render test in this file while forking the rule. So the *source* is read: no
 *   declaration of either name may appear in `parts.ts`. The pattern is on the
 *   declaration keyword, not on a call site, which is what makes it survive a
 *   reformat — the failure mode `AGENTS.md` §6a records for
 *   `verify-replay-window.test.ts`.
 * - **The imported value.** `parts.ts` is not asked to declare them, and the engine
 *   still answers: if the import were ever repointed at a local file, the next
 *   `tsc` fails on the missing export rather than on a card that quietly changed.
 *
 * **No comment/string stripper here, deliberately.** The other five source gates in
 * this repo carry one each, and `AGENTS.md` §6a says the duplication is a consequence
 * of the layering rule. This check does not need it: a *declaration* keyword followed
 * by the name is code by construction, and prose about a function is not a
 * declaration. The reader is exercised against **planted** material, so a check that
 * silently matched nothing cannot pass.
 */
const OWNED_BY_THE_ENGINE = ["toolResultFailure", "toolStateForResult", "ToolCardState"];

/** `/src/**`, so the file under test is read as the bundler will ship it. */
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PARTS = "/src/components/lib/parts.ts";

/** A local declaration of one of the engine's names. */
function localDeclarations(source: string): string[] {
  const found: string[] = [];
  for (const name of OWNED_BY_THE_ENGINE) {
    // `function f(`, `const f =`, `type T =` — a type alias and an interface too, so
    // the union cannot be re-declared without this noticing.
    const declaration = new RegExp(
      String.raw`(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+${name}\b`,
    );
    if (declaration.test(source)) found.push(name);
  }
  return found;
}

describe("the tool-card rule is not re-declared here", () => {
  it("the scan really reads the sources — a glob that matches nothing passes vacuously", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(10);
    expect(files, PARTS).toContain(PARTS);
    expect(SOURCES[PARTS]?.length ?? 0).toBeGreaterThan(0);
  });

  it("finds no local declaration of an engine name in `parts.ts`", () => {
    expect(
      localDeclarations(SOURCES[PARTS] ?? ""),
      "the rule that turns a tool *result* into a card state is the engine's " +
        "(`@all-the.rest/baah-core`, `agent/loop.ts` — `toolPartContent` is built on it), and it " +
        "is applied in exactly two places: the row the engine writes and the card this package " +
        "draws from it. A third copy would be free to disagree with the row, and the symptom " +
        "would be a reloaded card that no longer matches a live one.",
    ).toEqual([]);
  });

  it("does not export the two functions either, so nothing can import them from here", () => {
    // The cheap second path, and it is a real one on its own: a re-pointed import in
    // `transcript.ts` would compile against a local export and this fails.
    for (const name of OWNED_BY_THE_ENGINE) {
      expect(parts, name).not.toHaveProperty(name);
    }
    // …and the render-side half is still here, or the tests above would be vacuous.
    expect(typeof parts.renderPart).toBe("function");
    expect(typeof parts.toolStateLabel).toBe("function");
  });

  it("the reader sees what it is meant to catch", () => {
    const planted = [
      `export function toolStateForResult(state: string, output: unknown): string {`,
      `  return state;`,
      `}`,
      `const toolResultFailure = (output: unknown) => output;`,
      `export type ToolCardState = "output-error";`,
    ].join("\n");
    expect(localDeclarations(planted)).toEqual(["toolResultFailure", "toolStateForResult", "ToolCardState"]);

    // …and it does not fire on the import that is supposed to be there, on a call,
    // or on prose about the function.
    const innocent = [
      `import { toolResultFailure, toolStateForResult, type ToolCardState } from "@all-the.rest/baah-core";`,
      `const state = toolStateForResult(part.state, part.output);`,
      `const failure = toolResultFailure(output);`,
      `const copy: Readonly<Record<ToolCardState, string>> = STATE_COPY;`,
      `// parts.ts used to declare toolResultFailure and toolStateForResult itself`,
      `const named = { toolStateForResult: 1 };`,
    ].join("\n");
    expect(localDeclarations(innocent)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* partTestId                                                          */
/* ------------------------------------------------------------------ */

describe("partTestId", () => {
  it("names the two nodes `lib/testids.ts` has ids for", () => {
    // Reasoning and an unknown part type have no id in the shared list, and the
    // function returns `""` rather than inventing a parallel one.
    expect(partTestId({ kind: "text", text: "a", inFlight: false, provenance: "model" })).toBe("baah-transcript-text");
    expect(partTestId({ kind: "reasoning", text: "a", inFlight: false, provenance: "model" })).toBe("");
    expect(partTestId({ kind: "unsupported", type: "x" })).toBe("");
  });

  it("names a tool card with the card's own id", () => {
    expect(partTestId(asTool(renderPart(toolPart("input-available") as never)))).toBe("baah-tool-card");
  });
});
