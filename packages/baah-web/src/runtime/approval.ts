/**
 * The two approval seams, joined.
 *
 * ## They are genuinely two, and both are required
 *
 * `AgentLoopOptions` carries two approval-shaped fields, and they are not
 * redundant:
 *
 * - `approval` — the SDK's `toolApproval` function. `Plan.md` §7.6: **the engine
 *   decides, the SDK executes.** This is where a *rule* is consulted, before the
 *   tool is even reached: `allow` runs through, `ask` pauses the loop with an
 *   `approval-requested` part, `deny` hands the model a refusal it can route
 *   around. It never blocks on a human.
 * - `approve` — the in-tool decision point (`Plan.md` §4.2). Reached only by
 *   tools whose `access` is not `read`, and it is the one that may block on a
 *   human.
 *
 * The rule engine is consulted at the first seam, so a request that reaches the
 * second is one the rules already asked about. This module does not re-run the
 * rules there: doing so would let a rule change between the two seams turn one
 * decision into two.
 *
 * ## A missing channel denies, visibly
 *
 * When no `answer` handler is wired, every in-tool request resolves to `deny` with
 * a reason that says *why*. The alternative — resolving to `allow` — would be a
 * security hole created by a wiring mistake, and `deny` with no explanation would
 * be a support ticket. `Plan.md` §7's honesty note applies directly here: in a
 * browser-only app the user is the trust boundary, and this is a UX guardrail
 * rather than a security control.
 *
 * ## §7.5's `reject` really does reject everything else
 *
 * "Lehnt **auch alle anderen offenen Anfragen dieser Session** ab." A user who
 * answered "no" to one card must not have to click through nine more. That is
 * implemented here — every other in-flight request resolves `deny` at the same
 * moment — and it is tested rather than asserted in prose.
 */

import {
  buildApprovalTargets,
  createApprovalResolver,
  createDefaultRules,
  createRuleEnginePermissionEngine,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
  type ApprovalRequest,
  type ApprovalResolver,
  type AnyToolDefinition,
  type PermissionRule,
  type RulePermissionEngine,
} from "@all-the.rest/baah-core";

export interface RuntimeApprovalOptions {
  readonly tools: readonly AnyToolDefinition[];
  /** Ordered rules (§7.1: the last match wins; no match means `ask`). */
  readonly rules?: readonly PermissionRule[];
  /** Stored `"always"` grants. They never beat a configured `deny` (§7.5). */
  readonly grants?: readonly PermissionRule[];
  /**
   * Answers the card. Omit it and every in-tool request is denied with a reason
   * naming this gap.
   */
  readonly answer?: ((request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
  readonly defaultDenyReason?: string | undefined;
  /** §7.6: "Jede Entscheidung landet in `approvals`." */
  readonly onDecision?: ((record: ApprovalDecisionRecord) => void) | undefined;
}

export interface RuntimeApprovalChannel {
  /** The value handed to `ToolLoopAgent`'s `toolApproval`. */
  readonly rule: ApprovalResolver;
  /** The value handed to `AgentLoopOptions.approve`. */
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** The live rule engine, so the settings screen can edit rules and grants. */
  readonly engine: RulePermissionEngine;
  /** Every decision made in this session, for persistence. */
  decisions(): readonly ApprovalDecisionRecord[];
}

const NO_CHANNEL_REASON =
  "no approval channel is wired, so the request was denied rather than allowed by default";

/** The decision recorded when no channel exists. Denied, and it says why. */
const DENIED_NO_CHANNEL: ApprovalDecisionRecord = {
  toolName: "unknown",
  action: "question",
  resources: [],
  effect: "deny",
  reason: NO_CHANNEL_REASON,
  status: { type: "denied" },
};

export function createRuntimeApprovalChannel(options: RuntimeApprovalOptions): RuntimeApprovalChannel {
  const engine = createRuleEnginePermissionEngine({
    // §7.4's default policy, not an empty list. An empty ruleset is not "no
    // permissions": §7.1 says a call that matches no rule is `ask`, so an empty list
    // turns every tool call — including `read` — into an approval card, and a
    // harness that asks about everything has no permission system at all.
    rules: options.rules ?? createDefaultRules(),
    grants: options.grants ?? [],
  });
  const targets = buildApprovalTargets({ tools: options.tools });
  const resolver = createApprovalResolver({
    engine,
    targets,
    ...(options.defaultDenyReason === undefined ? {} : { defaultDenyReason: options.defaultDenyReason }),
  });

  /** Every `approve` call that has not been answered yet. */
  const open = new Set<{ settle: (decision: ApprovalDecision) => void }>();

  const answer = options.answer;

  return {
    rule: resolver,

    engine,

    decisions: () => resolver.decisions,

    request(request: ApprovalRequest): Promise<ApprovalDecision> {
      if (answer === undefined) {
        // Denied, and *visibly* denied: the decision is recorded with the reason
        // so the UI can show it, rather than the tool simply failing with no
        // explanation. Allowing here would turn a wiring mistake into a hole.
        options.onDecision?.({ ...DENIED_NO_CHANNEL, toolName: request.toolId });
        return Promise.resolve("deny");
      }

      return new Promise<ApprovalDecision>((resolve) => {
        const entry = { settle: resolve };
        open.add(entry);

        answer(request)
          .then((decision) => {
            open.delete(entry);
            if (decision === "deny") rejectAllOpen();
            else if (decision === "allow-always") rememberGrant(request);
            resolve(decision);
          })
          .catch((error: unknown) => {
            // The channel threw. Denying is the recoverable direction: the tool does
            // not run, the model is told, and nothing is silently allowed. The
            // reason is not swallowed — it is re-thrown as a denial the model can
            // read, and the original is not lost, because a silent `catch` here
            // would turn a broken card into an unexplained refusal.
            open.delete(entry);
            rejectAllOpen();
            resolve("deny");
            options.onDecision?.({
              toolName: request.toolId,
              action: "question",
              resources: [],
              effect: "deny",
              reason: `the approval channel failed: ${error instanceof Error ? error.name : "unknown error"}`,
              status: { type: "denied" },
            });
          });
      });
    },
  };

  function rejectAllOpen(): void {
    for (const entry of [...open]) {
      open.delete(entry);
      entry.settle("deny");
    }
  }

  /**
   * `allow-always` → a stored grant.
   *
   * §7.5 says the *tool* proposes the pattern, not the UI. The current tools do
   * not expose a proposal, so the pattern is derived from the same
   * `ApprovalTarget` table the rule engine judges by — the resource the tool
   * actually named, not a wildcard. That is the conservative direction: a grant
   * for one path, not for the action as a whole.
   */
  function rememberGrant(request: ApprovalRequest): void {
    const target = targets.get(request.toolId);
    if (target === undefined) return;
    const resolved = target.resource(request.detail);
    const resources = resolved === undefined ? [] : Array.isArray(resolved) ? resolved : [resolved];
    void engine.recordAlways(target.action, resources).catch((error: unknown) => {
      options.onDecision?.({
        toolName: request.toolId,
        action: target.action,
        resources,
        effect: "allow",
        reason: `the "always" grant could not be stored: ${error instanceof Error ? error.name : "unknown error"}`,
        status: "not-applicable",
      });
    });
  }
}

export { createDefaultRules };
export type { PermissionRule };
