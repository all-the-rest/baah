/**
 * Permission mapping onto the AI SDK's `toolApproval` (Plan.md §7.6).
 *
 * ## Where the decision is made
 *
 * §7.6 splits the work explicitly: **the engine decides, the SDK executes.**
 * The SDK owns the pause, the `approval-requested` part, the resume through
 * `addToolApprovalResponse` and the `tool-output-denied` delivery; we own the
 * rule evaluation. This module is the seam, and it is deliberately the only
 * place that speaks both vocabularies.
 *
 * ## The mapping (Plan.md §7.6)
 *
 * | our `evaluate()` | SDK status | effect |
 * |---|---|---|
 * | `allow` | `'not-applicable'` | runs through without asking |
 * | `ask`   | `'user-approval'`  | the SDK pauses, the UI shows a card |
 * | `deny`  | `{ type: 'denied', reason }` | the model *reads* the refusal |
 *
 * `deny` is the interesting one, and the reason it is a status rather than a
 * throw is worth stating: a thrown tool error reads to the model as a
 * malfunction it should try again, while a denial is a legitimate answer it
 * should respect and route around.
 *
 * ## Why the tool list is passed in
 *
 * The SDK's generic approval function receives `tools` — the **AI SDK's**
 * `ToolSet`, not our `ToolDefinition`s. So the resource a call touches
 * (`Plan.md` §7.2: the path for `read`, the regex for `grep`, the command
 * string for `shell`, the URL for `webfetch`) has to be resolved from the
 * *model's* input, and the `access` class from *our* tool list. Both are
 * therefore looked up by tool name in maps built once, up front.
 *
 * ## Narrow interface on purpose (Plan.md §16.4)
 *
 * The engine is written against {@link PermissionEngine}, two methods wide.
 * `src/permission.ts` is the preferred implementation and this module wires it
 * through {@link createRuleEnginePermissionEngine}, but the turn runner only
 * ever sees the interface — which is what lets it be tested against a stub.
 */

import type { ToolApprovalConfiguration, ToolApprovalStatus } from "ai";

import {
  applyReply,
  evaluate,
  type Action,
  type Effect,
  type PermissionRule,
  type Reply,
  type ResourceRequest,
} from "../permission.ts";
import type { AiToolSet, AnyToolDefinition } from "./tools.ts";

/**
 * What the turn runner needs from a permission system.
 *
 * `evaluate` reduces several resources to one effect (any `deny`, then any
 * `ask`, else `allow` — §7.3); "last matching rule wins" and "no match means
 * `ask`" are properties of the implementation, not of this seam.
 */
export interface PermissionEngine {
  evaluate(action: string, resources: string[]): { effect: Effect; reason?: string };
  /** Persist the tool-proposed pattern after an `"always"` reply (§7.5). */
  recordAlways(action: string, resources: string[]): Promise<void>;
}

/** Which permission action a tool call is judged under (Plan.md §7.2). */
export type ApprovalAction = Action;

/**
 * How one tool is judged.
 *
 * `resource` is a *reader* over the model's input, not a constant: the same
 * `read` tool is judged on a different path every call, and a constant would
 * make every rule for every file match at once.
 */
export interface ApprovalTarget {
  action: ApprovalAction;
  /**
   * Pull the resource(s) out of the validated tool input.
   *
   * Returning `undefined` means "nothing nameable", which is not the same as
   * `"*"` — `*` is a real resource that the catch-all rule matches, and
   * `undefined` lets the engine fall back to asking.
   */
  resource: (input: unknown) => string | string[] | undefined;
}

/** Read a string field off an untrusted input object. */
function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The target table from Plan.md §7.2, keyed by tool id.
 *
 * These are the *defaults for the standard tool set*. A tool that needs a
 * different judgement (a subagent naming its own agent id, a skill naming a
 * skill id) registers its own via {@link buildApprovalTargets}'s
 * `overrides` — the table stays the default, not a closed set.
 */
export const DEFAULT_APPROVAL_TARGETS: Readonly<Record<string, ApprovalTarget>> = Object.freeze({
  // normalised path
  read: { action: "read", resource: (input) => readString(input, "path") },
  list: { action: "read", resource: (input) => readString(input, "path") },
  // target path — covers write and patch (§7.2)
  write: { action: "edit", resource: (input) => readString(input, "path") },
  edit: { action: "edit", resource: (input) => readString(input, "path") },
  // the pattern itself
  glob: { action: "glob", resource: (input) => readString(input, "pattern") },
  // the regex, deliberately NOT the search path (§7.2)
  grep: { action: "grep", resource: (input) => readString(input, "pattern") },
  // the command string
  shell: { action: "shell", resource: (input) => readString(input, "command") },
  // url / query
  webfetch: { action: "webfetch", resource: (input) => readString(input, "url") },
  websearch: { action: "websearch", resource: (input) => readString(input, "query") },
  // the agent id / skill id
  task: { action: "subagent", resource: (input) => readString(input, "subagent_type") },
  subagent: { action: "subagent", resource: (input) => readString(input, "subagent_type") },
  skill: { action: "skill", resource: (input) => readString(input, "name") },
  // always "*" — a question has no resource to match a rule against
  question: { action: "question", resource: () => "*" },
  // Our own tool, so our own action (Plan.md §7.2). The resource is the
  // session's todo list, which no user can meaningfully name — but the *action*
  // is what a rule needs in order to control todo writes at all. Without it
  // `todo` would fall through the `access` fallback to `edit`, and
  // `{"action":"todo","resource":"*","effect":"ask"}` would match nothing.
  todo: { action: "todo", resource: () => "*" },
});

/**
 * A target for a tool with no table entry, derived from its `access` class.
 *
 * This keeps §7.2's grouping without hard-coding every future tool: `read` is
 * judged as a read, `write` as an edit (which is how the plan folds `write` and
 * `patch` together), `execute` as a shell command, `network` as a fetch. The
 * resource is left unresolvable rather than guessed, so a rule written for a
 * concrete path does not accidentally match.
 */
function targetForAccess(definition: AnyToolDefinition): ApprovalTarget {
  switch (definition.access) {
    case "read":
      return { action: "read", resource: () => undefined };
    case "write":
      return { action: "edit", resource: () => undefined };
    case "execute":
      return { action: "shell", resource: () => undefined };
    case "network":
      return { action: "webfetch", resource: () => undefined };
  }
}

export interface ApprovalTargetOptions {
  /** Our tools, used for the `access`-class fallback. */
  tools: readonly AnyToolDefinition[];
  /** Per-tool targets that beat {@link DEFAULT_APPROVAL_TARGETS}. */
  overrides?: Readonly<Record<string, ApprovalTarget>>;
}

/** Resolve every tool id to its {@link ApprovalTarget}, once. */
export function buildApprovalTargets(options: ApprovalTargetOptions): Map<string, ApprovalTarget> {
  const resolved = new Map<string, ApprovalTarget>();
  for (const definition of options.tools) {
    resolved.set(
      definition.id,
      options.overrides?.[definition.id] ??
        DEFAULT_APPROVAL_TARGETS[definition.id] ??
        targetForAccess(definition),
    );
  }
  return resolved;
}

/** Translate our effect into the SDK's approval status. */
export function toApprovalStatus(effect: Effect, reason: string | undefined): ToolApprovalStatus {
  switch (effect) {
    case "allow":
      // The string form, not `{ type: 'not-applicable' }`: the object variant
      // carries a `reason` that the SDK emits on a *response* part, and a
      // response we never send should not carry an explanation.
      return "not-applicable";
    case "ask":
      return "user-approval";
    case "deny":
      return reason === undefined ? { type: "denied" } : { type: "denied", reason };
  }
}

export interface ApprovalResolverOptions {
  engine: PermissionEngine;
  /** Name → target, from {@link buildApprovalTargets}. */
  targets: ReadonlyMap<string, ApprovalTarget>;
  /**
   * Reason for a `deny` the engine did not explain. A refusal the user cannot
   * read is a refusal they will file as a bug.
   */
  defaultDenyReason?: string;
}

/**
 * The value handed to `ToolLoopAgent`'s `toolApproval`, typed as the SDK's own
 * function type so a change in the installed SDK fails here.
 */
export type ApprovalResolver = Extract<
  ToolApprovalConfiguration<AiToolSet, unknown>,
  (...args: never[]) => unknown
>;

/** The single argument the SDK's generic approval function receives. */
type ApprovalResolverArgument = Parameters<ApprovalResolver>[0];

export interface ApprovalDecisionRecord {
  toolName: string;
  action: ApprovalAction;
  resources: string[];
  effect: Effect;
  reason: string | undefined;
  status: ToolApprovalStatus;
}

/**
 * Build the `toolApproval` function for `ToolLoopAgent`.
 *
 * Decisions are recorded on the returned array so the caller can persist them
 * (§7.6: "Jede Entscheidung landet in `approvals`") without the resolver having
 * to know about storage.
 */
export function createApprovalResolver(
  options: ApprovalResolverOptions,
): ApprovalResolver & { decisions: ApprovalDecisionRecord[] } {
  const defaultDenyReason = options.defaultDenyReason ?? "denied by a permission rule";
  const decisions: ApprovalDecisionRecord[] = [];

  const resolve = (argument: ApprovalResolverArgument): ToolApprovalStatus => {
    const toolName = argument.toolCall.toolName;
    const target = options.targets.get(toolName);

    // An unknown tool is denied outright. There is no rule for it, and letting
    // an unrecognised call through would be a hole in every ruleset.
    if (target === undefined) {
      const reason = `unknown tool: ${toolName}`;
      decisions.push({
        toolName,
        action: "question",
        resources: [],
        effect: "deny",
        reason,
        status: { type: "denied", reason },
      });
      return { type: "denied", reason };
    }

    const resolved = target.resource(argument.toolCall.input);
    const resources = resolved === undefined ? [] : Array.isArray(resolved) ? resolved : [resolved];
    const verdict = options.engine.evaluate(target.action, resources);
    const reason = verdict.effect === "deny" ? (verdict.reason ?? defaultDenyReason) : verdict.reason;
    const status = toApprovalStatus(verdict.effect, reason);

    decisions.push({ toolName, action: target.action, resources, effect: verdict.effect, reason, status });
    return status;
  };

  // `decisions` rides along on the function object so callers get both from one
  // value; the callable part is exactly the SDK's function type.
  return Object.assign(resolve, { decisions }) as ApprovalResolver & {
    decisions: ApprovalDecisionRecord[];
  };
}

/* ------------------------------------------------------------------ *
 * The concrete rule engine
 * ------------------------------------------------------------------ */

export interface RuleEngineOptions {
  /** Ordered rules; the last matching one wins (Plan.md §7.1). */
  rules: readonly PermissionRule[];
  /** Stored `"always"` grants, kept separate so they can never beat a `deny`. */
  grants?: readonly PermissionRule[];
}

export interface RulePermissionEngine extends PermissionEngine {
  /** Current rules and grants — for persisting them. */
  state(): { rules: readonly PermissionRule[]; grants: readonly PermissionRule[] };
  /** Fold a user reply into the grants (§7.5). */
  reply(reply: Reply, action: ApprovalAction, resource: string): void;
  /** An `ask` decided with no nameable resource still has to be judgeable. */
  readonly ruleCount: number;
}

/**
 * `src/permission.ts` behind the narrow {@link PermissionEngine} interface.
 *
 * This is the only file that names the concrete exports of the rule engine,
 * which is what §16.4 asks for.
 */
export function createRuleEnginePermissionEngine(
  options: RuleEngineOptions,
): RulePermissionEngine {
  let rules: readonly PermissionRule[] = [...options.rules];
  let grants: readonly PermissionRule[] = [...(options.grants ?? [])];

  return {
    get ruleCount() {
      return rules.length + grants.length;
    },

    evaluate(action, resources) {
      // A call with no nameable resource is still decidable, and §7.1 is
      // explicit that "no match" means `ask`. Evaluating against `*` lets the
      // default policy's catch-all rule match while any narrower rule correctly
      // does not.
      const requests: ResourceRequest[] = (resources.length === 0 ? ["*"] : resources).map(
        (resource) => ({ action: action as Action, resource }),
      );
      const effect = evaluate(rules, requests, grants);
      return effect === "deny" ? { effect, reason: `denied by rule for ${action}` } : { effect };
    },

    async recordAlways(action, resources) {
      for (const resource of resources.length === 0 ? ["*"] : resources) {
        grants = applyReply(grants, "always", action as Action, resource);
      }
    },

    state: () => ({ rules, grants }),

    reply(reply, action, resource) {
      // `applyReply` only writes for "always", which is what keeps a stored
      // grant structurally unable to overrule a configured `deny` (§7.5).
      grants = applyReply(grants, reply, action as Action, resource);
    },
  };
}
