/**
 * The transcript model: what the view renders, from two sources that must not
 * be confused.
 *
 * ## Why there are two sources at all
 *
 * `Plan.md` §6.1's `parts` table is the truth, and a reload reads it through the
 * read port. But a **running** turn is not in that table yet — the engine flushes
 * a part every `DELTA_FLUSH_INTERVAL_MS` (100 ms) and closes it at the end, so a
 * live part is at most one interval behind. Reading the database to render the
 * live turn would show a sentence 100 ms stale and, worse, would make the *same*
 * text appear twice for the moment the flush lands.
 *
 * So:
 *
 * - **the settled transcript** comes from the store, through the read port. It is
 *   the reload answer and the only durable one.
 * - **the live turn** is folded from the engine's own events, which arrive before
 *   the flush and carry the `messageId` the part will be written under.
 *
 * The two are joined by `messageId`, never by position. A zip would be wrong
 * exactly in the case `truncated` exists for — and the read port's own header
 * makes the same argument about parts.
 *
 * ## Three things this file refuses to do
 *
 * 1. **Hide a streaming part.** `status: "streaming"` is in flight, and the text
 *    that is there is real. Rendering it greyed with a marker is honest; rendering
 *    nothing until it closes makes the UI look broken for a reason it has.
 * 2. **Turn a `database_closed` refusal into an empty transcript.** `readResult`
 *    below is a union, and the empty case is reachable only from a read that
 *    succeeded.
 * 3. **Invent a fourth part type.** `Plan.md` §6.1 allows three. A file diff is
 *    tool metadata (`Plan.md` §14.3), so it is rendered by the tool card, not
 *    here.
 *
 * ## Which half of the tool-card rule is where
 *
 * `toolStateForResult` and `toolResultFailure` are imported from
 * `@all-the.rest/baah-core`, not from `parts.ts`, and `parts.ts` no longer declares
 * them either. They are the **engine's**, because the engine is what writes a tool
 * part: `TurnStore.upsertPart` builds the row with `toolPartContent`, which is built
 * on these two. This file and `parts.ts` are the *readers* of that row, and the
 * reason they call the same function rather than re-implementing it is stated in
 * both headers and is the short version of `Plan.md` §16.1: two writers for one row
 * drift, and here the two are the row and the card drawn from it.
 */
import { toolResultFailure, toolStateForResult, type AgentEvent, type TurnOutcome } from "@all-the.rest/baah-core";
import type { Transcript } from "@all-the.rest/baah-storage";
import type { UIMessage } from "ai";

import { TEST_IDS } from "../../lib/testids.ts";
import type { TranscriptRead } from "../../runtime/index.ts";
import { renderPart, fileDiffs, toolStateLabel, truncationNotice, type RenderPart, type ToolCardState } from "./parts.ts";
import { asDisplayText } from "./trust.ts";

/* ------------------------------------------------------------------ */
/* Settled transcript                                                  */
/* ------------------------------------------------------------------ */

/** One message of the stored transcript, ready to render. */
export interface StoredMessage {
  readonly id: string;
  readonly role: string;
  /** `Plan.md` §6.2: the turn outcome is an `idle` message. */
  readonly outcome: TurnOutcome | undefined;
  readonly parts: readonly RenderPart[];
  /** Text of the turn's own error, when the turn recorded one. */
  readonly error: string | undefined;
}

/**
 * Project a stored transcript into renderable messages.
 *
 * The `streaming` half of §16.1's rule lives here: a part whose `status` is
 * `streaming` is rendered **with its text** and marked in flight, and its
 * position in the message is kept — dropping it would make a live turn look
 * empty, which is the failure `Plan.md` §16.1 was written against.
 */
export function storedMessages(transcript: Transcript): StoredMessage[] {
  return transcript.messages
    .map((message) => ({
      id: message.id,
      role: message.role,
      // **Straight through, not re-narrowed.** `outcome` is `TurnOutcome | null` and
      // `role` is `MessageRole` because they are `baah-storage`'s own types now
      // (`Transcript`), and that package validates both at its boundary —
      // `messageRowSchema.outcome: turnOutcomeSchema.nullable()` in `protocol.ts`.
      // A second `switch` here would be a second validation of a value the producer
      // has already validated, and the *test* for it needed a cast to construct the
      // impossible value it described.
      //
      // That is **not** true of the `data` blob, which the port hands over as raw
      // JSON text on purpose (`§16.1`): nothing validates what is inside it, so
      // `normaliseStoredState` below still has to be defensive about a `state` string
      // it did not type. The line is drawn there, and it is drawn because that is
      // where the trust boundary is.
      outcome: message.outcome ?? undefined,
      error: message.error ?? undefined,
      parts: message.parts
        .map((part) => renderStoredPart(part.type, part.contentText, part.status, part.data))
        .filter((part): part is RenderPart => part !== undefined),
    }))
    // An `idle` outcome message with no parts is a real thing (§6.2) and is kept:
    // it is the only place a turn's outcome is recorded.
    .filter((message) => message.role !== "idle" || message.outcome !== undefined || message.parts.length > 0);
}

/**
 * One stored part.
 *
 * `data` is **raw JSON text** (`baah-storage` hands it over unparsed on purpose —
 * only the layer that knows the shape may parse it), so the tool branch parses it
 * with a guard and the text branch does not touch it.
 */
function renderStoredPart(
  type: string,
  contentText: string,
  status: string | null,
  data: string | null,
): RenderPart | undefined {
  if (type === "text") {
    if (contentText === "") return undefined;
    return { kind: "text", text: contentText, inFlight: status === "streaming", provenance: "model" };
  }
  if (type === "reasoning") {
    if (contentText === "") return undefined;
    return { kind: "reasoning", text: contentText, inFlight: status === "streaming", provenance: "model" };
  }
  if (type === "tool") {
    return storedToolPart(contentText, status, data);
  }
  // The schema's `CHECK` allows exactly three types, so this is unreachable
  // against a migrated database. Rendered as a note rather than dropped: a
  // database written by a *newer* build must not silently lose content here.
  return { kind: "unsupported", type };
}

/**
 * A stored `tool` part.
 *
 * The stored shape is the SDK's UI part, because the loop writes
 * `toolCallPart(...)` / `output-available` straight from the stream
 * (`packages/baah-core/src/agent/loop.ts`). So the `data` blob is read with the
 * same guards the live path uses and the same state vocabulary — one projection
 * for both, so a reloaded card and a live card cannot disagree about what a
 * state means.
 */
/**
 * A stored `tool` part.
 *
 * The stored shape is the SDK's UI part, because the loop writes
 * `toolCallPart(...)` and the `output-available` variant straight off the stream
 * (`packages/baah-core/src/agent/loop.ts`). So the `data` blob is read with the same
 * guards the live path uses, and the state goes through the **same** normaliser — one
 * vocabulary for a live card and a reloaded one, because two implementations of
 * "what does `approval-responded` mean" is how they start disagreeing.
 *
 * ## The tool name lives in the *discriminator*, not in a field
 *
 * `toolCallPart` writes `{ type: "tool-read", toolCallId, state, input }`. There is
 * **no `toolName` property** — the name is the `tool-${NAME}` discriminator, which is
 * why core's own `isToolPart` has to check `part.type.startsWith("tool-")`. A reader
 * looking for `data.toolName` finds nothing and renders a card labelled `tool`, which
 * is how the first version of this file mislabelled every stored card. The name is
 * therefore recovered from the discriminator, with the `toolName` field read only as
 * the `dynamic-tool` case's own convention.
 *
 * `contentText` is the fallback for the input: a tool part stores the model's framing
 * text in `content_text` (`Plan.md` §6.1 calls it the denormalised searchable
 * projection), so a part whose `data` is missing still has something to show rather
 * than rendering as an empty box.
 */
function storedToolPart(contentText: string, status: string | null, data: string | null): RenderPart {
  const parsed = parseData(data);
  const toolName = storedToolName(parsed);
  const toolCallId = readString(parsed, "toolCallId") ?? "unknown";
  const stored = readString(parsed, "state") ?? (status === "streaming" ? "input-streaming" : "output-available");
  const output = readValue(parsed, "output");
  // The same value-based derivation the live card uses (`lib/parts.ts`): a row
  // written from a `tool-result` whose value is `toToolErrorResult`'s envelope is a
  // failure, whether or not the writer got round to normalising the state. A
  // reloaded card and a live one therefore say the same thing about a failed tool,
  // which is the whole point of keeping the two on one function.
  const state = toolStateForResult(normaliseStoredState(stored), output);
  const shown = state === "output-available" ? output : undefined;

  return {
    kind: "tool",
    toolCallId,
    toolName,
    state,
    stateLabel: toolStateLabel(state),
    input: asDisplayText(readValue(parsed, "input")) || contentText,
    output: shown === undefined ? undefined : asDisplayText(shown),
    errorText:
      state === "output-error" ? (readString(parsed, "errorText") ?? toolResultFailure(output) ?? "") : undefined,
    // Both were `undefined` / `[]` here before, which meant a reloaded card silently
    // lost the truncation warning and every file diff — the two things the live card
    // shows. The stored blob carries `input` and `output` in the same shape, so the
    // same two functions apply; leaving them out made "one projection for both" true
    // only for the state.
    truncation: shown === undefined ? undefined : truncationNotice(toolName, shown),
    diffs: fileDiffs(readValue(parsed, "input"), shown),
    approvalId: undefined,
    outputProvenance: "tool-authored",
  };
}

/** The seven card states, narrowed from a stored string. */
const CARD_STATES: ReadonlySet<ToolCardState> = new Set<ToolCardState>([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * The tool's name, out of a stored part's `data`.
 *
 * `toolCallPart` puts the name in the discriminator (`` `tool-${NAME}` ``) and a
 * dynamic part carries a `toolName` field, so both are read and the **discriminator
 * wins** — a `tool-read` part is a `read` part whatever else the blob happens to say.
 * `unknown` is the fallback rather than a generic `tool`, because a card labelled
 * `tool` tells the user nothing and a card labelled `unknown` tells them the record
 * is incomplete.
 */
function storedToolName(parsed: Record<string, unknown> | undefined): string {
  const type = readString(parsed, "type");
  if (type === "dynamic-tool") return readString(parsed, "toolName") ?? "unknown";
  if (type !== undefined && type.startsWith("tool-")) return type.slice("tool-".length);
  return readString(parsed, "toolName") ?? "unknown";
}

/**
 * Narrow a stored state string, defaulting to `input-available`.
 *
 * The default is the **conservative** one: an unknown state from a newer build
 * renders as "about to run", not as "failed" and not as "done". Claiming an
 * outcome the data does not carry is the one rendering error this file refuses.
 */
function normaliseStoredState(state: string): ToolCardState {
  return CARD_STATES.has(state as ToolCardState) ? (state as ToolCardState) : "input-available";
}

function parseData(data: string | null): Record<string, unknown> | undefined {
  if (data === null || data === "") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) return undefined;
    return value as Record<string, unknown>;
  } catch {
    // A `data` blob that is not JSON is not a reason to lose the part. The card
    // shows what could be read and says the rest is unreadable.
    return undefined;
  }
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readValue(record: Record<string, unknown> | undefined, key: string): unknown {
  return record?.[key];
}

/* ------------------------------------------------------------------ */
/* The live turn                                                       */
/* ------------------------------------------------------------------ */

/** A tool invocation as the running turn reports it. */
export interface LiveTool {
  readonly toolCallId: string;
  readonly toolName: string;
  /** `input-available` and later, the validated input the model produced. */
  readonly input: unknown;
  readonly state: string;
  /** Present from `tool-result`. */
  readonly output: unknown;
  /** Present from `tool-error`. */
  readonly errorText: string | undefined;
  /** Present from `approval-requested`; the id `answerApproval` takes. */
  readonly approvalId: string | undefined;
  readonly approvalReason: string | undefined;
}

/** A `tool-outcome-unknown` seen during this turn. */
export interface LiveUnknownOutcome {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** A `storage-warning` seen during this turn. */
export interface LiveStorageWarning {
  readonly operation: string;
  readonly message: string;
}

/** Everything the live turn knows, folded from the engine's events. */
export interface LiveTurn {
  /** `messageId` → text. The `UIMessage` id the part will be written under. */
  readonly text: Readonly<Record<string, string>>;
  readonly reasoning: Readonly<Record<string, string>>;
  /** `messageId` → whether that part is still streaming. */
  readonly streaming: Readonly<Record<string, boolean>>;
  /** In arrival order, so two calls to the same tool keep their sequence. */
  readonly tools: readonly LiveTool[];
  readonly unknownOutcomes: readonly LiveUnknownOutcome[];
  readonly storageWarnings: readonly LiveStorageWarning[];
  /** A `turn-stopped` — the user's decision, and never a timeout. */
  readonly stopped: boolean;
  readonly stopStage: "attempt" | "approval-resume" | undefined;
  /** The last `approval-requested` that is still open. */
  readonly openApprovals: readonly {
    readonly approvalId: string;
    /**
     * The call the question is about.
     *
     * Carried on the open entry and not only on the tool, because the tool entry may
     * not exist yet: `ApprovalCard` uses this to find the call's `input` in the
     * runtime snapshot, and that lookup is the only typed way to get it — see
     * `lib/approval.ts`.
     */
    readonly toolCallId: string;
    readonly toolName: string;
    readonly reason: string | undefined;
  }[];
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly step: number;
}

/** The state before any event: a live turn that has said nothing yet. */
export const EMPTY_LIVE_TURN: LiveTurn = Object.freeze({
  text: {},
  reasoning: {},
  streaming: {},
  tools: [],
  unknownOutcomes: [],
  storageWarnings: [],
  stopped: false,
  stopStage: undefined,
  openApprovals: [],
  attempt: 0,
  totalAttempts: 0,
  step: 0,
});

/**
 * Fold one engine event into the live turn.
 *
 * ## The events that are deliberately *not* state
 *
 * - `text-delta` and `reasoning-delta` go into **separate** maps. `Plan.md` §5.1's
 *   lesson is the one this prevents: a reasoning delta persisted as text shows
 *   the model's thinking as something it said, and the same confusion here would
 *   make the user read the model's deliberation as its answer.
 * - `turn-stopped` sets a **flag** and nothing else. It does not set an error, it
 *   does not clear the text, and it is not a classification — the loop's own
 *   invariant is that an interrupted turn with no classification *is* a stop.
 * - `attempt-failed` is a classification, not an outcome: §5.4 says the failed
 *   attempt's text is kept and never merged forward, and the next attempt
 *   replaces the live text.
 * - `tool-error` sets `errorText` on the card and leaves `state` to the reducer
 *   below; `tool-output-denied` sets `output-denied`, which is a legitimate
 *   answer the model routes around, not a failure.
 */
export function applyAgentEvent(live: LiveTurn, event: AgentEvent): LiveTurn {
  switch (event.type) {
    case "attempt-started":
      // A new attempt starts with a clean slate. §5.4: the failed attempt's text
      // is never merged into the new one — carrying it forward would show the
      // user text the model never finished, and would make a 200-but-failed
      // response undiagnosable.
      return { ...live, text: {}, reasoning: {}, streaming: {}, tools: [], attempt: event.attempt, totalAttempts: event.total };

    case "step-end":
      return { ...live, step: event.stepNumber + 1 };

    case "text-delta":
      return {
        ...live,
        text: { ...live.text, [event.messageId]: (live.text[event.messageId] ?? "") + event.text },
        streaming: { ...live.streaming, [event.messageId]: true },
      };

    case "reasoning-delta":
      return {
        ...live,
        reasoning: { ...live.reasoning, [event.messageId]: (live.reasoning[event.messageId] ?? "") + event.text },
      };

    case "tool-call":
      return { ...live, tools: upsertTool(live.tools, event.toolCallId, (tool) => ({ ...tool, input: event.input })) };

    case "tool-result":
      return { ...live, tools: upsertTool(live.tools, event.toolCallId, (tool) => ({ ...tool, output: event.output, state: "output-available" })) };

    case "tool-error":
      return {
        ...live,
        tools: upsertTool(live.tools, event.toolCallId, (tool) => ({ ...tool, errorText: event.error, state: "output-error" })),
      };

    case "tool-output-denied":
      return { ...live, tools: upsertTool(live.tools, event.toolCallId, (tool) => ({ ...tool, state: "output-denied" })) };

    case "tool-outcome-unknown":
      return {
        ...live,
        // Its own list, not a tool state. `Plan.md` §5.1: the engine ran it a
        // second time and reported it as failed, both of which are lies the model
        // would act on. A card that claims neither is the whole point.
        unknownOutcomes: [
          ...live.unknownOutcomes,
          { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
        ],
      };

    case "approval-requested":
      return {
        ...live,
        // `toolName` is set here as well as the state, and it has to be: a call that
        // needs approval produces `tool-approval-request` **instead of** `tool-call`,
        // so there is no earlier event that named the tool and `upsertTool`'s
        // placeholder (`"tool"`) would be all the card had. A card labelled `tool`
        // tells the user nothing — and `ApprovalCard` reads the name off this to
        // decide the risk class, so the placeholder would make a secret read look
        // like an unknown one.
        //
        // The **input** is not set here, and the reason is that this file no longer
        // has to look for it. The `approval-requested` event intersects core's
        // `OpenApproval` (`packages/baah-core/src/agent/loop.ts`), so the input the
        // card has to show is part of the event's own type and cannot drift away
        // from it again. `ApprovalCard` still reads the input from the runtime
        // snapshot, where the `tool-call` event put it — the two are the same value
        // and the snapshot lookup is the path that is pinned by tests. See
        // `lib/approval.ts`.
        tools: upsertTool(live.tools, event.toolCallId, (tool) => ({
          ...tool,
          toolName: event.toolName,
          state: "approval-requested",
          approvalId: event.approvalId,
          approvalReason: event.reason,
        })),
        openApprovals: [
          ...live.openApprovals.filter((open) => open.approvalId !== event.approvalId),
          { approvalId: event.approvalId, toolCallId: event.toolCallId, toolName: event.toolName, reason: event.reason },
        ],
      };

    case "approval-answered":
      return {
        ...live,
        tools: live.tools.map((tool) =>
          tool.approvalId === event.approvalId ? { ...tool, state: event.approved ? "approval-responded" : "output-denied" } : tool,
        ),
        openApprovals: live.openApprovals.filter((open) => open.approvalId !== event.approvalId),
      };

    case "turn-stopped":
      return { ...live, stopped: true, stopStage: event.stage };

    case "storage-warning":
      return {
        ...live,
        storageWarnings: [...live.storageWarnings, { operation: event.operation, message: event.message }],
      };

    case "turn-finished":
    case "attempt-failed":
    case "error":
    case "waiting":
      // No live state. `attempt-failed` and `error` are classifications the turn
      // banner renders from `TurnResult`, and `turn-finished` is the signal to
      // read the settled transcript back instead of continuing to fold events.
      return live;

    default:
      return live;
  }
}

function upsertTool(
  tools: readonly LiveTool[],
  toolCallId: string,
  update: (tool: LiveTool) => LiveTool,
): readonly LiveTool[] {
  const index = tools.findIndex((tool) => tool.toolCallId === toolCallId);
  const next: LiveTool = update(
    index === -1
      ? { toolCallId, toolName: "tool", input: undefined, state: "input-available", output: undefined, errorText: undefined, approvalId: undefined, approvalReason: undefined }
      : (tools[index] as LiveTool),
  );
  if (index === -1) return [...tools, next];
  return tools.map((tool, at) => (at === index ? next : tool));
}

/**
 * Fold a whole stream of events.
 *
 * Exported so a test can feed a scripted list and assert on the result, which is
 * the only way the ordering guarantees above are checked.
 */
export function foldAgentEvents(events: readonly AgentEvent[]): LiveTurn {
  return events.reduce<LiveTurn>(applyAgentEvent, EMPTY_LIVE_TURN);
}

/* ------------------------------------------------------------------ */
/* The whole transcript                                                */
/* ------------------------------------------------------------------ */

/** One entry of the rendered transcript. */
export type TranscriptEntry =
  | { readonly kind: "message"; readonly id: string; readonly role: string; readonly parts: readonly RenderPart[]; readonly outcome: TurnOutcome | undefined }
  /** The live turn, assembled from events. Rendered after every stored message. */
  | { readonly kind: "live"; readonly parts: readonly RenderPart[] };

/** The live turn as renderable parts, in arrival order. */
export function liveParts(live: LiveTurn): RenderPart[] {
  const parts: RenderPart[] = [];

  for (const [messageId, text] of Object.entries(live.reasoning)) {
    if (text === "") continue;
    parts.push({ kind: "reasoning", text, inFlight: live.streaming[messageId] === true, provenance: "model" });
  }
  for (const [messageId, text] of Object.entries(live.text)) {
    if (text === "") continue;
    // A part that is `streaming` is shown **with** its text and marked in
    // flight. `Plan.md` §16.1: the read may be 100 ms behind, and a UI that
    // hides the tail makes the model look stuck.
    parts.push({ kind: "text", text, inFlight: live.streaming[messageId] === true, provenance: "model" });
  }
  for (const tool of live.tools) {
    parts.push(liveToolPart(tool));
  }

  return parts;
}

function liveToolPart(tool: LiveTool): RenderPart {
  // `renderPart` is the single place that knows a tool card's state vocabulary
  // and its truncation rule, so the live card is built from the same function the
  // stored card is. A second implementation here would be a second place for the
  // `searchTruncated` warning to be forgotten.
  const shaped = {
    type: `tool-${tool.toolName}` as const,
    toolCallId: tool.toolCallId,
    state: tool.state,
    input: tool.input,
    ...(tool.output === undefined ? {} : { output: tool.output }),
    ...(tool.errorText === undefined ? {} : { errorText: tool.errorText }),
    ...(tool.approvalId === undefined
      ? {}
      : { approval: { id: tool.approvalId, ...(tool.approvalReason === undefined ? {} : { requestReason: tool.approvalReason }) } }),
  };
  return renderPart(shaped as UIMessage["parts"][number]) as RenderPart;
}

/**
 * The transcript, with the live turn appended.
 *
 * Two `null`s do real work here:
 *
 * - `read` may be `undefined` **or** `failed`. Both render as an explicit
 *   "not read" panel. A read that failed is not an empty conversation, and
 *   `Plan.md` §16.1 is explicit that this distinction is the difference between
 *   an honest UI and a confident lie.
 * - `read` may be `ok` with **zero** messages. That is the only "nothing here".
 */
export interface TranscriptModel {
  readonly entries: readonly TranscriptEntry[];
  /** `true` only for a successful read that found nothing. */
  readonly empty: boolean;
  /** The store holds more messages than were read. */
  readonly truncated: boolean;
  /**
   * Set when the transcript **could not** be read. Never an empty transcript, and
   * never a read that has not happened yet — see {@link TranscriptModel.pending}.
   */
  readonly readProblem: string | undefined;
  /**
   * The read has not come back yet.
   *
   * ## A third state, and the reason this is not `readProblem`
   *
   * `unavailable` and `failed` are both **problems**, and both render as a
   * warning. A read in flight is neither: it is a request outstanding, and the
   * answer is on its way. Rendering it with the warning panel is how a normal
   * loading state becomes an error the user is asked to act on.
   *
   * This became visible when the app moved from `createMemoryDatabase()` to real
   * SQLite: the read is a `postMessage` round trip to the worker rather than a
   * resolved promise, so the window is now long enough for a human to see it. The
   * in-memory build hid the state by being fast, which is not a design.
   */
  readonly pending: boolean;
  /** `true` when the live turn is contributing parts. */
  readonly live: boolean;
}

export function transcriptModel(input: {
  readonly read: TranscriptRead | undefined;
  readonly live: LiveTurn;
}): TranscriptModel {
  const entries: TranscriptEntry[] = [];
  let truncated = false;
  let readProblem: string | undefined;
  let stored: readonly StoredMessage[] = [];

  const pending = input.read === undefined;

  if (input.read === undefined) {
    // Nothing to report and nothing to claim. See {@link TranscriptModel.pending}.
  } else if (input.read.kind === "unavailable") {
    readProblem = input.read.reason;
  } else if (input.read.kind === "failed") {
    readProblem = input.read.reason;
  } else {
    stored = storedMessages(input.read.transcript);
    truncated = input.read.transcript.truncated;
    for (const message of stored) {
      entries.push({
        kind: "message",
        id: message.id,
        role: message.role,
        parts: message.parts,
        outcome: message.outcome,
      });
    }
  }

  const live = liveParts(input.live);
  if (live.length > 0) entries.push({ kind: "live", parts: live });

  return {
    entries,
    // "Nothing was here" needs all three: a read that *succeeded*, no live parts,
    // and no read still in flight. A pending read must not claim the session is
    // empty, and a failed one must not either.
    empty: entries.length === 0 && readProblem === undefined && !pending,
    truncated,
    readProblem,
    pending,
    live: live.length > 0,
  };
}

/** The `data-baah-role` value for a stored message. */
export function roleOf(role: string): "user" | "assistant" | "system" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

/** The container's testid, so a spec never hard-codes a class. */
export const TRANSCRIPT_TEST_ID = TEST_IDS.transcript;
