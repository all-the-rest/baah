/**
 * The permission rule engine (Plan.md §7).
 *
 * Pure and Node-testable on purpose: it decides whether a tool call runs, and
 * the one place that can be fully verified without a browser. The engine feeds
 * the verdict into the AI SDK's `toolApproval` (Plan.md §7.6) — this module
 * never touches the UI, IndexedDB or the filesystem.
 *
 * Three rules carry the whole model:
 *
 * 1. **A ruleset is an ordered list and the last matching rule wins.** New,
 *    narrower rules therefore go to the end.
 * 2. **No match means `ask`** — never a silent allow. A resource that nobody
 *    thought about when the rules were written must not be a hole.
 * 3. **Stored grants never override a configured `deny`** (§7.5). They live in
 *    a separate list that can only turn `ask` into `allow`.
 *
 * Honesty about what this is: in a browser-only app the user *is* the trust
 * boundary. There is no server that could sign an approval, so this is a UX
 * guardrail against accidents, not a security control (Plan.md §7.6).
 */

/** What happens to a tool call. */
export type Effect = "allow" | "deny" | "ask";

/**
 * The user's answer to a request (Plan.md §7.5).
 *
 * Deliberately only three values: `once` for this call, `always` to persist the
 * pattern the *tool* proposed, and `reject`, which also drops the other open
 * requests of the session so nobody has to click away ten cards after a "no".
 */
export type Reply = "once" | "always" | "reject";

/**
 * The things a tool call can touch (Plan.md §7.2).
 *
 * `edit` deliberately covers `write` and `patch` as well — one action for
 * "the model wants to change this file".
 *
 * `todo` is our own addition and is listed here for that reason. The reference
 * harness has no todo tool at all (Plan.md §14.3, item 11), so the action
 * cannot be copied from a predecessor — but it still needs its own name, because
 * folding it into `edit` leaves a user with no way to write a rule about it.
 * Its resource is the session's todo list, which no user can meaningfully name,
 * so it is matched as `*` like `question`.
 */
export type Action =
  | "read"
  | "edit"
  | "glob"
  | "grep"
  | "shell"
  | "subagent"
  | "skill"
  | "question"
  | "todo"
  | "webfetch"
  | "websearch"
  | "network"
  | "external_directory";

/**
 * `*` is the catch-all action used by the default policy ("any action at all").
 * It is matched with the same wildcard rules as a resource, so a future
 * `web*` style rule would work without a change here.
 */
export type ActionPattern = Action | "*";

export interface PermissionRule {
  readonly action: ActionPattern;
  /** Wildcard pattern; see {@link matchResource}. */
  readonly resource: string;
  readonly effect: Effect;
}

/** One thing a tool call touches: the action plus the resource string. */
export interface ResourceRequest {
  readonly action: Action;
  /** Path, glob, regex, command string, URL, agent id, … depending on `action`. */
  readonly resource: string;
}

/** Backslashes are normalised so a Windows-style path matches the same rule. */
function normalizeResource(value: string): string {
  return value.replace(/\\/g, "/");
}

const REGEX_SPECIAL = new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
  "/",
  "-",
]);

/**
 * Compile a resource pattern into an anchored `RegExp`.
 *
 * `*` matches zero or more characters **including `/`** (a rule for `*.env`
 * must cover `.env` in a subdirectory), `?` matches exactly one character,
 * everything else is literal. A pattern ending in `" *"` matches the bare value
 * as well (`git status *` ⇒ `git status`).
 */
function compilePattern(pattern: string): RegExp {
  const normalized = normalizeResource(pattern);
  const hasBareSuffix = normalized.endsWith(" *");
  const body = hasBareSuffix ? normalized.slice(0, -2) : normalized;

  let source = "^";
  for (const character of body) {
    if (character === "*") source += "[\\s\\S]*";
    else if (character === "?") source += "[\\s\\S]";
    else source += REGEX_SPECIAL.has(character) ? `\\${character}` : character;
  }
  // The optional `" …"` tail is what makes the bare command match.
  if (hasBareSuffix) source += "(?: [\\s\\S]*)?";
  return new RegExp(`${source}$`);
}

/**
 * Match a whole resource value against a pattern.
 *
 * The match is **whole-value**: there is no partial-segment shortcut, so
 * `*.env` deliberately also matches `secret.env` but `env` only matches
 * `env`, and a rule for `/etc` never covers `/etc/passwd` unless it says so.
 */
export function matchResource(pattern: string, resource: string): boolean {
  return compilePattern(pattern).test(normalizeResource(resource));
}

/** Does this rule apply to this request? */
export function matchRule(rule: PermissionRule, request: ResourceRequest): boolean {
  return (
    matchResource(rule.action, request.action) && matchResource(rule.resource, request.resource)
  );
}

/**
 * Last matching rule wins; nothing matches means `ask`.
 *
 * Note that the *action* is matched with the same wildcard matcher, so
 * `{"action": "*", …}` really does mean "every action".
 */
export function decide(rules: readonly PermissionRule[], request: ResourceRequest): Effect {
  let effect: Effect = "ask";
  for (const rule of rules) {
    if (matchRule(rule, request)) effect = rule.effect;
  }
  return effect;
}

/**
 * {@link decide} plus the stored "always" grants.
 *
 * A grant can upgrade `ask` to `allow`; it can never overrule a configured
 * `deny`, because the two lists are kept apart (Plan.md §7.5).
 */
export function decideWithGrants(
  rules: readonly PermissionRule[],
  grants: readonly PermissionRule[],
  request: ResourceRequest,
): Effect {
  const base = decide(rules, request);
  if (base !== "ask") return base;
  const granted = decide(grants, request);
  return granted === "ask" ? "ask" : granted;
}

function isRequestList(
  resources: ResourceRequest | readonly ResourceRequest[],
): resources is readonly ResourceRequest[] {
  return Array.isArray(resources);
}

/**
 * Decide a whole tool call that may touch several resources (Plan.md §7.3).
 *
 * **Any `deny` denies, else any `ask` asks, else allow** — so a single denied
 * file in a multi-file edit fails the whole call.
 */
export function evaluate(
  rules: readonly PermissionRule[],
  resources: ResourceRequest | readonly ResourceRequest[],
  grants: readonly PermissionRule[] = [],
): Effect {
  const requests = isRequestList(resources) ? resources : [resources];
  let sawAsk = false;

  for (const request of requests) {
    const effect = decideWithGrants(rules, grants, request);
    if (effect === "deny") return "deny";
    if (effect === "ask") sawAsk = true;
  }

  return sawAsk ? "ask" : "allow";
}

/**
 * The default policy of every session (Plan.md §7.4): allow in general, but ask
 * for secrets (`.env` and friends) and for anything outside the workspace.
 * `.env.example` is the exception — it is meant to be read.
 */
export const DEFAULT_RULES: readonly PermissionRule[] = Object.freeze([
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
] as const satisfies readonly PermissionRule[]);

/** A fresh, mutable copy — callers append their own rules to it. */
export function createDefaultRules(): PermissionRule[] {
  return DEFAULT_RULES.map((rule) => ({ ...rule }));
}

/** The first `count` whitespace-separated tokens, for a command pattern. */
function leadingTokens(value: string, count: number): string {
  return value.split(/\s+/).filter((token) => token !== "").slice(0, count).join(" ");
}

/**
 * The pattern that gets persisted when the user answers a request with
 * `"always"`.
 *
 * **The tool proposes this, not the UI** (Plan.md §7.5): only the tool knows
 * what a future call needs, and it is the only place that can tell `git status`
 * from `git commit`. The UI shows the proposal and may not invent a pattern.
 *
 * The proposals are deliberately asymmetric:
 * - `shell` takes the two leading tokens, so `git status` and `git status -sb`
 *   share one grant.
 * - everything else is the exact value. A grant for editing `src/app.ts` does
 *   not silently cover `src/other.ts`; the next file asks again. Too narrow
 *   is a prompt, too broad is a data loss.
 */
export function proposeSavePattern(action: Action, resource: string): string {
  const value = normalizeResource(resource);
  if (action !== "shell") return value;
  const tokens = leadingTokens(value, 2);
  return tokens === "" ? value : `${tokens} *`;
}

/**
 * Fold the user's answer into the list of stored grants.
 *
 * The configured rules are never touched, which is exactly what makes a grant
 * unable to overrule a `deny`. `once` and `reject` leave the list unchanged —
 * `reject` additionally rejects the other open requests of the session, but
 * that is engine state, not a rule (Plan.md §7.5).
 */
export function applyReply(
  grants: readonly PermissionRule[],
  reply: Reply,
  action: Action,
  resource: string,
): PermissionRule[] {
  if (reply !== "always") return [...grants];
  return [...grants, { action, resource: proposeSavePattern(action, resource), effect: "allow" }];
}
