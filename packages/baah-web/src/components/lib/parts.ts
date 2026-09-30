/**
 * What the transcript renders, derived from `UIMessage["parts"]`.
 *
 * ## Three part types, and no fourth
 *
 * `Plan.md` §6.1 and §14.3: `text | reasoning | tool`, nothing else. File diffs
 * are **tool metadata** (`data.metadata.files`), not a part type, so
 * {@link RenderPart} has no `diff` kind — a diff is something a tool card shows,
 * and a fourth variant here would be a re-introduction of the thing the plan
 * removed.
 *
 * The turn's outcome is an `idle` **message** (§6.2), not a part and not a
 * separate construct, so it is handled one level up in `turn.ts` and in
 * {@link isOutcomeMessage} here.
 *
 * ## Why the projection is a pure function and not a component
 *
 * Every decision that can be wrong — which state a card is in, whether a
 * truncation warning is shown, whether a part is still being written — is made
 * here, in a function that takes data and returns data. That is what makes those
 * decisions testable in vitest with no DOM and no browser, which is where the
 * mutations in the report are killed. A card component that computed them inline
 * would be testable only by rendering it, and "we could not install jsdom" is not
 * an acceptable reason for the dangerous decisions to be untested.
 *
 * ## What this file does *not* decide: whether a failed tool is a failure
 *
 * `toolStateForResult` and `toolResultFailure` are the **engine's**, imported from
 * `@all-the.rest/baah-core` and re-used here rather than re-implemented, and
 * `ToolCardState` is the engine's union imported for the same reason. That is the
 * whole point of the split: the rule that turns a *result* into a state is applied
 * in exactly two places in this program — the engine's `toolPartContent`, which
 * decides what a **stored** row says, and `renderPart` below, which decides what a
 * **rendered** card says — and both call the one function. A third copy here would
 * be free to agree with the row until the day it did not, and the symptom would be a
 * reloaded card that disagrees with a live one, which is the one drift a card must
 * not be able to have.
 *
 * What stays here is the **render-side** half, which the engine has no opinion
 * about: {@link STATE_COPY} (the German sentence per state), {@link toolStateLabel},
 * {@link toolCardState} (narrowing an SDK string), the truncation rule, the diffs
 * and the {@link RenderPart} projection. Those read a `UIMessage` part or a stored
 * blob — data, not an event — so they are not a second copy of the writer's rule.
 */
import { toolResultFailure, toolStateForResult, type ToolCardState } from "@all-the.rest/baah-core";
import type { UIMessage } from "ai";

import { TEST_IDS } from "../../lib/testids.ts";
import { asDisplayText, type Provenance } from "./trust.ts";

/* ------------------------------------------------------------------ */
/* Part classification                                                  */
/* ------------------------------------------------------------------ */

/** `Plan.md` §6.1's three part types, as the loop emits them. */
export type PartKind = "text" | "reasoning" | "tool";

/** A `UIMessage` part narrowed to the tool invocation shape. */
export type ToolInvocationPart = Extract<
  UIMessage["parts"][number],
  { toolCallId: string; state: string }
>;

/**
 * Is this a tool invocation?
 *
 * Mirrors the engine's own guard (`packages/baah-core/src/agent/loop.ts`,
 * `isToolPart`): a **static** tool part's discriminator is `` `tool-${NAME}` ``,
 * not `tool`, and a dynamic one is literally `dynamic-tool`. Reading only
 * `type === "tool"` — the shape a reader infers from `plan.md`'s prose — finds
 * nothing at all, which is the one bug this guard has to be immune to.
 */
export function isToolInvocationPart(part: UIMessage["parts"][number]): part is ToolInvocationPart {
  return (
    (part.type === "dynamic-tool" || part.type.startsWith("tool-")) &&
    "toolCallId" in part &&
    "state" in part
  );
}

/** The tool's name, from either discriminator. */
export function toolNameOf(part: ToolInvocationPart): string {
  return part.type === "dynamic-tool"
    ? part.toolName
    : part.type.slice("tool-".length);
}

/**
 * `Plan.md` §6.2: the turn outcome is an `idle` message.
 *
 * `UIMessage["role"]` is the SDK's own union, which does **not** include `idle` —
 * that role belongs to `baah-storage`'s `messages.role`, and the two are different
 * tables. A `UIMessage` reaching the UI therefore never has it, and this function
 * accepts the wider `string` the read port hands over instead of narrowing the
 * SDK's type. Writing `message.role === "idle"` on a `UIMessage` is a compile
 * error, which is the SDK being right and the plan being about a different layer.
 */
export function isOutcomeMessage(message: { readonly role: string }): boolean {
  return message.role === "idle";
}

/* ------------------------------------------------------------------ */
/* The tool card state                                                 */
/* ------------------------------------------------------------------ */

/**
 * The card's state, as the **engine** declares it.
 *
 * **Imported, not re-declared.** The seven states `plan.md` §15.5 asks to be
 * distinguishable, plus the two the SDK adds and the plan does not name, are
 * `ToolCardState` in `@all-the.rest/baah-core` — the same union that types a
 * **stored** tool part's `state` and that `toolStateForResult` returns. This file
 * used to carry its own copy of the union, which is how a state the engine grew
 * would have ended up with a German label on a live card and none on a reloaded
 * one. {@link STATE_COPY} is a `Record<ToolCardState, string>`, so an eighth state
 * is now a **compile error here** rather than an `undefined` at runtime.
 *
 * | state | what the user is told |
 * |---|---|
 * | `input-streaming` | the arguments are still arriving |
 * | `input-available` | approved, about to run |
 * | `approval-requested` | waiting for the user — the card is actionable |
 * | `approval-responded` | the decision is in, the tool has not reported yet |
 * | `output-available` | it ran and returned something |
 * | `output-error` | it ran and failed |
 * | `output-denied` | refused by a rule or by the user — **not** an error |
 *
 * `output-denied` is the one that is easy to get wrong: it is a legitimate
 * answer the model reads and routes around (`plan.md` §7.6), so it must not
 * wear the same colour as `output-error`.
 */
export type { ToolCardState };

/** The states a card can be in, and what the user is told about each. */
const STATE_COPY: Readonly<Record<ToolCardState, string>> = {
  "input-streaming": "Argumente kommen an …",
  "input-available": "Freigegeben, startet gleich",
  "approval-requested": "Wartet auf deine Freigabe",
  "approval-responded": "Entscheidung übertragen, Ergebnis folgt …",
  "output-available": "Ausgeführt",
  "output-error": "Fehlgeschlagen",
  "output-denied": "Abgelehnt",
};

/** The state, narrowed. Unknown strings become `input-available`, never a lie. */
export function toolCardState(part: ToolInvocationPart): ToolCardState {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
    case "output-available":
    case "output-error":
    case "output-denied":
      return part.state;
    default:
      return "input-available";
  }
}

/** German label for a card state. Never a raw SDK identifier. */
export function toolStateLabel(state: ToolCardState): string {
  return STATE_COPY[state];
}

/* ------------------------------------------------------------------ */
/* A tool result that is a failure (`toToolErrorResult`)                */
/* ------------------------------------------------------------------ */

/**
 * `toolResultFailure` and `toolStateForResult` are **not** declared here.
 *
 * They were, and this is the tombstone. Both are the engine's
 * (`@all-the.rest/baah-core`, `agent/loop.ts` — `toolPartContent` is built on
 * them), both are **imported** at the top of this file, and the reasons the rule
 * exists are the engine's to state, in the place that writes the row:
 *
 * - `createSdkTool` catches everything `definition.execute` throws and returns
 *   `toToolErrorResult`'s `{ ok: false, error }` as an ordinary **result**, so the
 *   SDK reports `state: "output-available"` for a tool that failed. Only the
 *   **value** is the evidence, and a card driven by `part.state` alone renders a
 *   failed `read` as `Ausgeführt` — the exact lie `Plan.md` §5 was written against.
 * - `tool-outcome-unknown` also returns `ok: false` **with** an `error` string. It
 *   is not a failure, and it is excluded by its own discriminator, first.
 *
 * What this file keeps is the half the engine cannot have: {@link STATE_COPY} and
 * the projection that decides what a **rendered** card shows. The module header has
 * why the two halves are two places and the rule is one.
 */

/**
 * The card state for a result, promoting a failure envelope to `output-error`.
 *
 * Only `output-available` is reconsidered. Every other state is a fact the engine
 * reported on purpose — `output-denied` is a refusal, not a malfunction
 * (`Plan.md` §7.6) — and re-deciding one of those from a value would let a tool's
 * own payload overrule the engine.
 */


/** `true` while the call has not produced an outcome yet. */
export function isToolInFlight(state: ToolCardState): boolean {
  return state === "input-streaming" || state === "input-available" || state === "approval-responded";
}

/* ------------------------------------------------------------------ */
/* Truncation — plan.md §4 and the tools' own `searchTruncated`         */
/* ------------------------------------------------------------------ */

/** The tools that can report an incomplete search. */
const TRUNCATING_TOOLS: ReadonlySet<string> = new Set(["grep", "glob", "list", "read"]);

export interface TruncationNotice {
  /** The flag as the tool reported it. */
  readonly field: string;
  /** German sentence, shown above the results. */
  readonly message: string;
}

/** The two sentences, so a card can say which flag it is talking about. */
const TRUNCATION_COPY = {
  searchTruncated:
    "Die Suche war unvollständig — nicht alle Treffer sind hier. " +
    "Behandle das Ergebnis als Ausschnitt, nicht als „nichts gefunden“.",
  truncated: "Die Ausgabe wurde gekürzt. Der Rest steht nicht in dieser Karte.",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Did this tool output report an incomplete search?
 *
 * ## Why this is load-bearing and not a nicety
 *
 * `grep` sets `searchTruncated: true` when the walk hit its entry cap, when the
 * scan hit its 5 s timeout, or when the call was aborted
 * (`packages/baah-tools/grep/src/index.ts`). `glob` sets it from
 * `walkMayBeIncomplete`, which **over-reports on purpose** — a model that once
 * heard "complete" about a partial search acts on a partial search
 * (`Plan.md` §16.1). So the honest UI shows the flag every time it is set, and
 * the model gets the same warning in its own words via the tool's `description`.
 *
 * The check is on the **output value**, not on the tool name: a tool that
 * gains the flag later must not need this file edited, and a tool that stops
 * setting it must not keep a warning. Both directions are wrong, so the value
 * decides.
 */
export function truncationNotice(toolName: string, output: unknown): TruncationNotice | undefined {
  if (!TRUNCATING_TOOLS.has(toolName)) return undefined;
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as Record<string, unknown>;
  if (record.searchTruncated === true) {
    return { field: "searchTruncated", message: TRUNCATION_COPY.searchTruncated };
  }
  if (record.truncated === true) {
    return { field: "truncated", message: TRUNCATION_COPY.truncated };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* File diffs — plan.md §6.1: in the tool part's metadata              */
/* ------------------------------------------------------------------ */

/** One entry of `metadata.files` (`Plan.md` §6.1, `§14.3`). */
export interface FileDiff {
  readonly file: string;
  readonly patch: string | undefined;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly status: string | undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The file diffs a tool part carries, or an empty array.
 *
 * Read from `input.metadata.files` **and** `output.metadata.files`, because the
 * two live on opposite sides of the call: a tool that reports what it changed
 * puts the diff in its *output*, and the engine stores the part's `data` from
 * the input at `tool-call` time (`packages/baah-core/src/agent/loop.ts`,
 * `toolCallPart`). Checking only one of them is a coin flip on which tools
 * display anything at all.
 *
 * Returns an empty array — never a throw — for a `data` blob that is not JSON or
 * not the documented shape. A diff is decoration on a card; a malformed one must
 * not take the card down.
 */
export function fileDiffs(input: unknown, output: unknown): readonly FileDiff[] {
  return [...readFiles(input), ...readFiles(output)];
}

function readFiles(value: unknown): FileDiff[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const metadata = record["metadata"];
  if (typeof metadata !== "object" || metadata === null) return [];
  const files = (metadata as Record<string, unknown>)["files"];
  if (!Array.isArray(files)) return [];
  const diffs: FileDiff[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) continue;
    const file = entry as Record<string, unknown>;
    const path = readString(file, "file");
    if (path === undefined) continue;
    diffs.push({
      file: path,
      patch: readString(file, "patch"),
      additions: readCount(file, "additions"),
      deletions: readCount(file, "deletions"),
      status: readString(file, "status"),
    });
  }
  return diffs;
}

/* ------------------------------------------------------------------ */
/* The render model                                                    */
/* ------------------------------------------------------------------ */

/** What the transcript draws for one part. */
export type RenderPart =
  | {
      readonly kind: "text";
      readonly text: string;
      /** `state: "streaming"` on a live part. §16.1: render it, do not hide it. */
      readonly inFlight: boolean;
      readonly provenance: Provenance;
    }
  | {
      readonly kind: "reasoning";
      readonly text: string;
      readonly inFlight: boolean;
      readonly provenance: Provenance;
    }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly state: ToolCardState;
      readonly stateLabel: string;
      readonly input: string;
      readonly output: string | undefined;
      readonly errorText: string | undefined;
      readonly truncation: TruncationNotice | undefined;
      readonly diffs: readonly FileDiff[];
      readonly approvalId: string | undefined;
      /** Where the tool's *output* came from. `Plan.md` §4.1: it read a file. */
      readonly outputProvenance: Provenance;
    }
  | {
      /** A part type this build does not know. Rendered as a note, not dropped. */
      readonly kind: "unsupported";
      readonly type: string;
    };

/** `true` while a text or reasoning part is still being written. */
function isStreaming(part: { readonly state?: "streaming" | "done" }): boolean {
  return part.state === "streaming";
}

/**
 * `errorText`, read through a record lookup.
 *
 * The SDK's tool-part union declares `errorText: string` on `output-error` and
 * `errorText?: never` on the other six, so a direct read on the whole union is
 * `string | undefined` and a cast-free narrowing needs the guard. `never` is
 * assignable to nothing, which is why `?? ""` type-checks — and why a cast here
 * would be the wrong kind of shortcut.
 */
function readErrorText(part: ToolInvocationPart): string | undefined {
  if (!("errorText" in part)) return undefined;
  const value = part.errorText;
  return typeof value === "string" ? value : undefined;
}

/** The approval id, present on the three states that carry an `approval`. */
function readApprovalId(part: ToolInvocationPart): string | undefined {
  if (!("approval" in part)) return undefined;
  const approval = part.approval;
  if (typeof approval !== "object" || approval === null) return undefined;
  const id = (approval as { readonly id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Project one `UIMessage` part into the render model.
 *
 * `undefined` for a part with no visible content at all — an empty
 * `step-start`, a `custom` part from a provider. A part that is *present but
 * empty* is a real case for a tool (the input has not arrived) and is handled
 * inside the tool branch.
 */
export function renderPart(part: UIMessage["parts"][number]): RenderPart | undefined {
  if (part.type === "text") {
    if (part.text === "") return undefined;
    return {
      kind: "text",
      text: part.text,
      inFlight: isStreaming(part),
      provenance: "model",
    };
  }

  if (part.type === "reasoning") {
    if (part.text === "") return undefined;
    return {
      kind: "reasoning",
      text: part.text,
      inFlight: isStreaming(part),
      provenance: "model",
    };
  }

  if (isToolInvocationPart(part)) {
    const rawState = toolCardState(part);
    const toolName = toolNameOf(part);
    const rawOutput = part.state === "output-available" ? part.output : undefined;
    // A thrown tool error arrives as a *result* (see `toolResultFailure`), so the
    // state the SDK reports and the state the user should see can differ. The
    // derived one is the state the card renders — everywhere, including a card
    // read back from the store, so a reloaded card cannot disagree with a live one.
    const state = toolStateForResult(rawState, rawOutput);
    const derivedError = toolResultFailure(rawOutput);
    const failed = state === "output-error";
    // The output is only shown for a result that *is* one. The failure envelope's
    // whole content is its `error` string, and printing the envelope as well would
    // put the same sentence on the card twice.
    const output = state === "output-available" ? rawOutput : undefined;
    return {
      kind: "tool",
      toolCallId: part.toolCallId,
      toolName,
      state,
      stateLabel: toolStateLabel(state),
      input: asDisplayText(part.input),
      output: output === undefined ? undefined : asDisplayText(output),
      // `errorText` is only rendered for `output-error`. Reading it off any other
      // state would put a stale error next to a successful result — the SDK
      // leaves the field off most union members, and `in`-narrowing to
      // `"approval" in part` is how the approval id is reached safely.
      //
      // Three sources, in order: the derived envelope, the SDK's own `errorText`,
      // then the empty string. The envelope wins because it is the one that is
      // present; the SDK's field is the fallback for an engine that reported the
      // failure through the state instead of the value.
      errorText: failed ? (derivedError ?? readErrorText(part) ?? "") : undefined,
      truncation: output === undefined ? undefined : truncationNotice(toolName, output),
      diffs: fileDiffs(part.input, output),
      approvalId: readApprovalId(part),
      // A tool's output is a file's content until proven otherwise. `Plan.md` §4.1's
      // injection surface is exactly this.
      outputProvenance: "tool-authored",
    };
  }

  if (part.type === "step-start" || part.type === "source-url" || part.type === "source-document") {
    return undefined;
  }

  return { kind: "unsupported", type: part.type };
}

/** The testid of a part's outermost node, for the specs. */
export function partTestId(part: RenderPart): string {
  switch (part.kind) {
    case "text":
      return TEST_IDS.transcriptText;
    case "tool":
      return TEST_IDS.toolCard;
    case "reasoning":
    case "unsupported":
      // Reasoning has no testid in `lib/testids.ts`; it is asserted by role and
      // by its own attribute rather than by inventing a parallel set.
      return "";
  }
}
