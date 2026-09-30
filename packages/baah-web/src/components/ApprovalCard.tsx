/**
 * The approval card, with **three** answers.
 *
 * ## `once` / `always` / `reject`, and why none of them is "cancel"
 *
 * `Plan.md` §7.5 names exactly three, and the third is the one a UI gets wrong:
 *
 * - `once` — this call runs. Nothing is stored.
 * - `always` — a **stored grant** for the tool-proposed pattern. `§7.5` is explicit
 *   that the *tool* proposes the pattern, not the UI, so the card shows the
 *   pattern the engine would store and the user sees the grant they are creating.
 * - `reject` — the call does not run **and every other open approval of this
 *   session is rejected too**. `runtime/approval.ts` implements that sweep
 *   (`rejectAllOpen`); the card says so, because a promise the UI does not keep
 *   would be the one bug in this component.
 *
 * None of the three is labelled "Abbrechen". A cancel would be indistinguishable
 * from dismissing the card, and would leave the turn parked — which is not what
 * any of §7.5's three answers means.
 *
 * ## Two seams, one card
 *
 * `Plan.md` §7.6 splits approval in two and this block has to answer both:
 *
 * | seam | who decides | what the card sends |
 * |---|---|---|
 * | the SDK's `toolApproval` (the rule engine) | the rules, then the user | `answerApproval({ approvalId, approved })` — a **boolean** |
 * | the in-tool `ctx.approve` (`§4.2`) | the user, with a pattern | `ApprovalDecision` — one of four |
 *
 * The reachable seam today is the first, because no tool in the repo calls
 * `ctx.approve` (see `lib/runtime.ts`). So:
 *
 * - `once` → `answerApproval(approved: true)`.
 * - `always` → `answerApproval(approved: true)` **and** a recorded grant through
 *   the same rule engine, so the answer is not a lie: the second time the same
 *   call runs, no card appears.
 * - `reject` → `answerApproval(approved: false)`, and the engine's own
 *   `rejectAllOpen` sweeps the rest.
 *
 * The card is driven by the engine's `approval-requested` event, not by a
 * component-local guess, so a card and the decision it produced cannot drift apart.
 *
 * ## `todo` and `write` look different, on purpose
 *
 * `Plan.md` §7.2 gives `todo` its own action and core's `DEFAULT_APPROVAL_TARGETS`
 * documents why: without it, `todo` would fall through the `access` fallback to
 * `edit` and a rule written for `todo` would match nothing. The permission engine
 * distinguishes them; a card that rendered one generic "Werkzeug freigeben?" for
 * both would discard that at the moment the user reads it. The risk-specific
 * sentence is in `lib/approval.ts` and is asserted by a test.
 */
import { DEFAULT_APPROVAL_TARGETS } from "@all-the.rest/baah-core";

import { TEST_ATTRIBUTES, TEST_IDS } from "../lib/testids.ts";
import { approvalCardModel, grantPatternFor, REJECT_SCOPE_NOTE, requestFromToolPart, toolCallInputOf } from "./lib/approval.ts";
import type { LiveTurn } from "./lib/transcript.ts";
import type { RuntimeState } from "../runtime/index.ts";
import type { ApprovalChoice } from "./lib/approval.ts";

/** What an `always` answer stores: the action and the resource, as `§7.5` has it. */
export interface AlwaysGrant {
  readonly action: string;
  readonly resources: readonly string[];
}

export interface ApprovalCardProps {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly detail: string;
  readonly consequence: string;
  readonly reason: string | undefined;
  readonly grantPattern: string | undefined;
  /** Which risk class, for the card's own colour and heading. */
  readonly risk: string;
  /** The action the engine judges this tool under, and the resource it named. */
  readonly grant: AlwaysGrant | undefined;
  /** Resolving a choice. `always` also calls {@link ApprovalCardProps.onAlways}. */
  readonly onAnswer: (approvalId: string, approved: boolean) => void;
  /** Called for `always` **before** the answer, so the grant is stored. */
  readonly onAlways?: (grant: AlwaysGrant) => void;
}

/**
 * Build the card from the live fold and the runtime snapshot.
 *
 * Two sources, because neither alone is guaranteed to hold everything:
 *
 * - the live fold knows a question is **open** — the `approvalId`, the reason, and
 *   (on the measured path) the tool's name and input, because
 *   `@ai-sdk/openai-compatible@3` emits the input parts before the pause. Nothing in
 *   `ai`'s types promises that, so the name is also taken from the event itself,
 *   where it is declared.
 * - the snapshot holds the call's `input` under the part, whatever the stream did.
 *   See {@link toolCallInputOf} for why that is a fallback and not the primary.
 *
 * A card built from the fold alone would lose §7.5's `always` answer the moment the
 * SDK stopped emitting input parts; a card built from the snapshot alone has no way
 * to know that a question is open.
 *
 * `undefined` when nothing is pending.
 */
export function approvalViewFromState(live: LiveTurn, state: RuntimeState): ApprovalCardProps | undefined {
  const open = live.openApprovals[0];
  if (open === undefined) return undefined;
  const tool = live.tools.find((entry) => entry.approvalId === open.approvalId);
  // The name prefers the event, which is declared and therefore reliable; the
  // snapshot is the fallback for a call the fold never named.
  const stored = toolCallInputOf(state.messages, open.toolCallId);
  const toolName = tool?.toolName ?? stored?.toolName ?? open.toolName;
  const toolCallId = tool?.toolCallId ?? "";
  const input = tool?.input ?? stored?.input;
  const request = requestFromToolPart({
    toolName,
    input,
    approvalId: open.approvalId,
    reason: open.reason,
  });
  const model = approvalCardModel({
    approvalId: open.approvalId,
    request,
    // The pattern is rendered from the engine's own action and resource, so the
    // string on the card is exactly what will be stored.
    grantPattern: describeGrant(toolName, input),
  });
  return {
    approvalId: model.approvalId,
    toolCallId,
    toolName: model.toolName,
    summary: model.summary,
    detail: model.detail,
    consequence: model.consequence,
    reason: model.reason,
    grantPattern: model.grantPattern,
    risk: model.risk,
    grant: grantFor(toolName, input),
    onAnswer: () => undefined,
  };
}

/**
 * The action and the resource an `always` answer would store.
 *
 * Both come from core's own tables, and that is the point: `runtime/approval.ts`
 * builds its targets from `DEFAULT_APPROVAL_TARGETS` and judges through
 * `createRuleEnginePermissionEngine`, so a grant stored under a different action or
 * a guessed resource would **never match** and the user would keep being asked
 * after saying "immer". A second copy of the action table here would be a second
 * thing that can drift, which is the mistake core's own header warns about.
 *
 * `undefined` when the tool has no target or the input names no resource — and an
 * `always` button is then not offered, because a grant the user was never shown
 * would be a grant they did not agree to.
 */
function grantFor(toolName: string, input: unknown): AlwaysGrant | undefined {
  const target = DEFAULT_APPROVAL_TARGETS[toolName];
  if (target === undefined) return undefined;
  const resolved = target.resource(input);
  const resources = resolved === undefined ? [] : Array.isArray(resolved) ? resolved : [resolved];
  if (resources.length === 0) return undefined;
  return { action: target.action, resources };
}

/**
 * The rule an `always` answer writes, rendered as JSON.
 *
 * `lib/approval.ts`'s `grantPatternFor` is the one place that formats a rule, and
 * the UI must not format it a second time — a card showing a rule in a different
 * shape from the stored one is a card the user cannot check.
 */
function describeGrant(toolName: string, input: unknown): string | undefined {
  const grant = grantFor(toolName, input);
  if (grant === undefined) return undefined;
  return grantPatternFor({ action: grant.action, resources: [...grant.resources] });
}

/** The card. */
export function ApprovalCard(props: ApprovalCardProps) {
  /**
   * One entry point for all three answers, and the order matters.
   *
   * The grant is recorded **before** the answer is sent, for `always`. The other
   * way round leaves a window in which the answer has resumed the turn and the
   * grant is not yet stored — a second call arriving in that window would ask
   * again, and the user was told it would not.
   */
  const answer = (choice: ApprovalChoice): void => {
    if (choice === "always" && props.grant !== undefined) props.onAlways?.(props.grant);
    props.onAnswer(props.approvalId, choice !== "reject");
  };

  // `always` is only offered when a grant exists. A button that stored nothing
  // would be a fourth answer in disguise.
  const canGrant = props.grant !== undefined;

  return (
    <section
      data-testid={TEST_IDS.approvalCard}
      {...{ [TEST_ATTRIBUTES.approvalId]: props.approvalId }}
      data-baah-approval-risk={props.risk}
      role="group"
      aria-label={`Freigabe für ${props.toolName}`}
      className="my-2 rounded-box border-2 border-warning/70 bg-warning/10 p-3"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <span data-testid={TEST_IDS.approvalCardTool} className="font-mono font-semibold">
          {props.toolName}
        </span>
        <span className="text-sm">{props.summary}</span>
      </header>

      {/*
       * What will happen, before the decision. Not a paraphrase of the input — the
       * tool's own `description` and the exact `input` the model produced, which is
       * what `§4.2` says a card is for.
       */}
      <pre className="mt-2 max-h-40 overflow-auto rounded-field bg-base-300/40 p-2 text-xs whitespace-pre-wrap break-words">
        {props.detail}
      </pre>

      <p className="mt-2 text-xs">{props.consequence}</p>

      {props.reason !== undefined && (
        <p data-testid={TEST_IDS.approvalCardReason} className="mt-1 text-xs opacity-80">
          Regel: {props.reason}
        </p>
      )}

      {props.grantPattern !== undefined && (
        <p className="mt-1 font-mono text-xs opacity-70">
          „Immer erlauben“ speichert: <code>{props.grantPattern}</code>
        </p>
      )}

      {/*
       * Three answers, and the third is a **first-class answer**: it rejects every
       * other open approval of this session (`§7.5`, implemented as `rejectAllOpen`
       * in `runtime/approval.ts`). The copy says so, because a sweep the UI does
       * not mention is a sweep the user cannot undo.
       */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid={TEST_IDS.approvalAllow}
          className="btn btn-primary btn-sm"
          onClick={() => answer("once")}
        >
          Einmal erlauben
        </button>
        {canGrant && (
          <button
            type="button"
            data-baah-approval-choice="always"
            className="btn btn-outline btn-sm"
            onClick={() => answer("always")}
          >
            Immer erlauben
          </button>
        )}
        <button
          type="button"
          data-testid={TEST_IDS.approvalDeny}
          data-baah-approval-choice="reject"
          title={REJECT_SCOPE_NOTE}
          className="btn btn-error btn-outline btn-sm"
          onClick={() => answer("reject")}
        >
          Ablehnen
        </button>
      </div>
      <p className="mt-1 text-xs opacity-70">{REJECT_SCOPE_NOTE}</p>
    </section>
  );
}
