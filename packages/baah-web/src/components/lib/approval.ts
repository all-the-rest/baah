/**
 * Approval cards: three answers, and what happens before them.
 *
 * ## `once` / `always` / `reject` — and what they mean
 *
 * `Plan.md` §7.5 names exactly three, and the third is the one a UI is most
 * likely to get wrong:
 *
 * | answer | effect | why it exists |
 * |---|---|---|
 * | `once` | this call runs, nothing is stored | the ordinary case |
 * | `always` | a **stored grant** for the tool-proposed pattern (§7.5) | a repeated action should stop asking |
 * | `reject` | the call does not run **and every other open approval of this session is rejected too** | a user who said "no" once must not have to click through nine more cards |
 *
 * `reject` is a **first-class answer, not a cancel.** A cancel would be "nevermind",
 * which is indistinguishable from dismissing the card, and would leave the turn
 * parked. `Plan.md` §7.5's own wording is about *rejecting*, and the engine's
 * channel implements the session-wide sweep (`runtime/approval.ts`,
 * `rejectAllOpen`). The card therefore offers three buttons and none of them is
 * labelled "Abbrechen".
 *
 * ## `todo` and `write` are different risks, and must not look alike
 *
 * `Plan.md` §7.2 gives `todo` its **own** action — it is our own tool and our own
 * action — and `packages/baah-core/src/agent/approval.ts` documents exactly why:
 * without the `todo` entry it would fall through the `access` fallback to `edit`,
 * and a rule written for `todo` would match nothing. The permission engine
 * distinguishes them; a UI that renders one generic "Werkzeug freigeben?" card for
 * both would throw that distinction away at the last possible moment, which is the
 * moment the user reads it.
 *
 * The difference is stated in the card:
 *
 * - `write`/`edit` — **a file on the user's disk changes.** The path is shown, the
 *   input is shown, and the consequence sentence says so.
 * - `todo` — **the session's task list is replaced.** `TodoStore.set` is a full
 *   replacement (`Plan.md` §16.2): anything the model leaves out is deleted. That
 *   is a different kind of loss from a file change, and the card says it.
 */
import type { ApprovalRequest } from "@all-the.rest/baah-core";
import type { UIMessage } from "ai";

import { isToolInvocationPart, toolNameOf } from "./parts.ts";

/** The three answers, in the order the card offers them. */
export type ApprovalChoice = "once" | "always" | "reject";

/** How risky the call is, for the card's own framing. */
export type ApprovalRisk = "file-write" | "task-list" | "read-secret" | "network" | "command" | "other";

/** One open request, as the card needs it. */
export interface ApprovalCardModel {
  readonly approvalId: string;
  readonly toolName: string;
  /** The tool's own `summary` — the sentence its definition wrote. */
  readonly summary: string;
  /** The exact input the model produced, rendered as text. */
  readonly detail: string;
  readonly risk: ApprovalRisk;
  /** German, and specific to the risk. Never the same sentence for every tool. */
  readonly consequence: string;
  /** The reason the rule engine gave, when it gave one. */
  readonly reason: string | undefined;
  /** True when the engine suggests a pattern for an `always` grant (§7.5). */
  readonly hasGrantPattern: boolean;
  /** The pattern an `always` answer would store. Shown before the decision. */
  readonly grantPattern: string | undefined;
}

/** `access` → risk, for the tools the app registers. */
const RISK_BY_TOOL: Readonly<Record<string, ApprovalRisk>> = {
  write: "file-write",
  edit: "file-write",
  patch: "file-write",
  todo: "task-list",
  read: "read-secret",
  webfetch: "network",
  websearch: "network",
  shell: "command",
  git: "command",
};

/** The sentence each risk gets. Specific, because the risks are not alike. */
const CONSEQUENCE: Readonly<Record<ApprovalRisk, string>> = {
  "file-write":
    "Dadurch ändert sich eine Datei auf deinem Datenträger. Der Schritt ist nicht rückgängig zu machen " +
    "außer durch eine weitere Änderung.",
  "task-list":
    "Die Aufgabenliste dieser Sitzung wird **vollständig ersetzt** — jeder Eintrag, den der Agent " +
    "nicht mitschickt, verschwindet. Das betrifft nur die Liste, keine Datei.",
  "read-secret":
    "Gelesen wird eine Datei, die üblicherweise Geheimnisse enthält (`.env`). Ihr Inhalt landet im " +
    "Kontext des Modells.",
  network: "Es wird eine Anfrage an einen externen Dienst gestellt. Der Inhalt dieser Eingabe verlässt den Browser.",
  command: "Es wird ein Kommando ausgeführt. Die Wirkung hängt von der Umgebung ab.",
  other: "Dieses Werkzeug verändert oder überträgt etwas. Prüfe die Eingabe, bevor du freigibst.",
};

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function renderDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail === undefined) return "(keine Eingabe)";
  try {
    return JSON.stringify(detail, null, 2) ?? String(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Build the card for a request.
 *
 * Everything the user is shown **before** the decision comes from the request
 * itself: the tool's own `summary` (`Plan.md` §4.2 — the tool knows best what it
 * wants), and the exact `detail` the model produced. A card that paraphrases the
 * input is a card that can describe a write to a file the model did not name.
 */
export function approvalCardModel(input: {
  readonly approvalId: string;
  readonly request: ApprovalRequest;
  /** §7.5: the pattern the *tool* proposes for an `always` grant. */
  readonly grantPattern: string | undefined;
}): ApprovalCardModel {
  const risk = RISK_BY_TOOL[input.request.toolId] ?? "other";
  return {
    approvalId: input.approvalId,
    toolName: input.request.toolId,
    summary: input.request.summary,
    detail: renderDetail(input.request.detail),
    risk,
    consequence: CONSEQUENCE[risk],
    reason: undefined,
    hasGrantPattern: input.grantPattern !== undefined,
    grantPattern: input.grantPattern,
  };
}

/**
 * The `ApprovalRequest` for a tool part, read off the SDK's shape.
 *
 * The approval arrives twice with different shapes: `approval-requested` on the
 * engine event carries `input` directly, while the `UIMessage` part carries it
 * under `input` with the id under `approval.id`. Both are read here so the card
 * does not care which path produced it.
 */
export function requestFromToolPart(part: {
  readonly toolName: string;
  readonly input: unknown;
  readonly approvalId: string;
  readonly reason: string | undefined;
}): ApprovalRequest {
  return {
    toolId: part.toolName,
    summary: summarise(part.toolName, part.input),
    detail: part.input,
  };
}

function summarise(toolName: string, input: unknown): string {
  const path = readString(input, "path");
  if (path !== undefined) return `${toolName} auf ${path}`;
  if (toolName === "todo") return "Aufgabenliste dieser Sitzung ersetzen";
  return `${toolName} ausführen`;
}

/**
 * The input the model produced for one tool call, read off the runtime's snapshot.
 *
 * ## Why there are two sources for the input
 *
 * The card needs the call's `input` twice: to show the exact `detail` before the
 * decision (`Plan.md` §4.2), and to resolve the **resource** the `always` answer
 * would grant (`§7.5`, read through `DEFAULT_APPROVAL_TARGETS`). The live fold is
 * the first source — and on the measured path it is enough, because
 * `@ai-sdk/openai-compatible@3` emits a tool's input parts *before* the approval
 * request, so a `tool-call` event does arrive.
 *
 * It is not a contract, though, and this function exists because of that:
 *
 * 1. Nothing in `ai`'s types promises the input parts are emitted before the pause.
 *    A `dynamic-tool` or a future SDK is free to hold them back, and then the fold
 *    has the `toolCallId` and the name and **no input at all** — which is a card
 *    with no `detail` and, worse, an `always` answer that would store a grant for
 *    nothing.
 * 2. The engine cannot fill the gap from its own events either: `OpenApproval` does
 *    carry an `input` and the loop spreads it into the event
 *    (`packages/baah-core/src/agent/loop.ts:1644`), but the `AgentEvent` union at
 *    `loop.ts:142` declares only four fields, so reading it would be a read of a
 *    field the type does not promise. That gap is a core finding and is named in the
 *    report.
 *
 * The snapshot is the **typed** way to get the same fact: `settle` publishes
 * `result.messages` before the bus fires (`runtime/index.ts`'s `settle`), and that
 * array holds the assistant message with the `approval-requested` part and its
 * `input` on it.
 *
 * The E2E suite cannot prove this fallback — it only exercises the path where the
 * fold already has the input. Measured: mutating this function so it never matches
 * leaves **all 43 E2E tests green** and turns 6 unit tests red, because
 * `ApprovalCard.test.ts` builds the fold without a `tool-call` event and asserts the
 * grant from the snapshot alone.
 */
export function toolCallInputOf(
  messages: readonly UIMessage[],
  toolCallId: string,
): { readonly toolName: string; readonly input: unknown } | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolInvocationPart(part)) continue;
      if (part.toolCallId !== toolCallId) continue;
      return { toolName: toolNameOf(part), input: part.input };
    }
  }
  return undefined;
}

/**
 * The `always` pattern, from the tool's own resource (`Plan.md` §7.5).
 *
 * §7.5: "Das Tool schlägt das Muster vor, nicht die UI." So this is the resource
 * the *permission engine* resolved for the action — which is the same table
 * `runtime/approval.ts` judges by. The UI proposes nothing of its own; it only
 * shows what the engine would store, so the user sees the grant they are about to
 * create.
 */
export function grantPatternFor(input: {
  readonly action: string;
  readonly resources: readonly string[];
}): string | undefined {
  if (input.resources.length === 0) return undefined;
  const patterns = input.resources.map((resource) => `{"action":"${input.action}","resource":${JSON.stringify(resource)},"effect":"allow"}`);
  return patterns.length === 1 ? (patterns[0] as string) : `${patterns.length} Regeln`;
}

/**
 * Does `reject` really reject everything else?
 *
 * Yes — `runtime/approval.ts` implements the sweep (`rejectAllOpen`), and this
 * returns what the card must therefore promise. The copy is in the button's
 * `title` and in the card's own sentence, because a promise the UI does not keep
 * would be the one bug this function is written to prevent.
 */
export const REJECT_SCOPE_NOTE =
  "Lehnt auch alle anderen offenen Freigaben dieser Sitzung ab.";
