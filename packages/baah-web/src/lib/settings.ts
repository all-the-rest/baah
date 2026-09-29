/**
 * Settings: the shape, the export file and the import boundary.
 *
 * ## The secret rule, and where it is enforced
 *
 * AGENTS.md §2: no API key in a file, a commit, a fixture, a log line or an
 * error message. `Plan.md` §8.2 turns that into a product rule: the export
 * excludes keys by default, behind an explicit opt-in checkbox.
 *
 * Enforcement here is **structural**, not a discipline:
 *
 * 1. The key lives in its own field, `apiKeys`, and nowhere else. A snapshot
 *    cannot carry a key inside a nested structure, so "forgot to strip it in a
 *    nested rule" is not expressible.
 * 2. {@link buildSettingsExport} destructures `apiKeys` **out** of the snapshot
 *    and only puts it back when the caller opted in. Removing the opt-in is a
 *    one-token change that a test pins.
 * 3. {@link diffSettings} reports key **slot names**, never values and never
 *    lengths — a diff is rendered on screen and ends up in screenshots.
 * 4. {@link parseSettingsImport} never puts input data into an error. Both the
 *    JSON-parse failure and the zod failure are rewritten into a typed error
 *    built from paths and codes (AGENTS.md §5: validate the boundary, never
 *    blind-cast).
 *
 * ## Why this is not SQLite
 *
 * See `storage.ts`: the `TurnStore` is injected, and a second path to the
 * database from the runtime is exactly what `Plan.md` §16.1 refused for the
 * adapter.
 */

import { z } from "zod";
import { createDefaultRules } from "@all-the.rest/baah-core";

/** Identifies the file format. A file without it is not one of ours. */
export const SETTINGS_FORMAT = "baah-settings";
/** The migration anchor `Plan.md` §8.2 asks for. */
export const SETTINGS_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Schemas — the single source of truth at both boundaries              */
/* ------------------------------------------------------------------ */

export const providerSelectionSchema = z.object({
  /** `openai`, `anthropic`, `google`, or `openai-compatible:<name>`. */
  vendor: z.string().min(1),
  model: z.string(),
  baseUrl: z.string().optional(),
  /** Label for an `openai-compatible` entry. Never a URL. */
  name: z.string().optional(),
});
export type ProviderSelection = z.infer<typeof providerSelectionSchema>;

/**
 * A permission rule, in the shape `Plan.md` §7.1 gives it.
 *
 * `action` is a plain string rather than core's `Action` union on purpose: this
 * is an *external* boundary (a file the user downloaded weeks ago), and
 * narrowing it to a union here would reject a future action instead of importing
 * it. Core's `evaluate` decides what it does with an unknown action — a rule that
 * matches nothing means `ask` (§7.1), which is the safe direction.
 */
export const permissionRuleSchema = z.object({
  action: z.string().min(1),
  resource: z.string(),
  effect: z.enum(["allow", "deny", "ask"]),
});
export type PermissionRuleSetting = z.infer<typeof permissionRuleSchema>;

/** The settings without the two fields that carry or gate a secret. */
export const settingsBodySchema = z.object({
  provider: providerSelectionSchema.optional(),
  theme: z.enum(["dark", "light", "system"]),
  instructions: z.string(),
  permissions: z.object({
    rules: z.array(permissionRuleSchema),
    grants: z.array(permissionRuleSchema),
  }),
});
export type SettingsBody = z.infer<typeof settingsBodySchema>;

/**
 * The persisted snapshot: body + version + the keys.
 *
 * `apiKeys` is `z.record(z.string(), z.string())` and therefore *known* to hold
 * secrets. Everything downstream treats a value that came out of it as
 * unloggable.
 */
export const settingsSchema = settingsBodySchema.extend({
  version: z.literal(SETTINGS_VERSION),
  apiKeys: z.record(z.string(), z.string()),
});
export type SettingsSnapshot = z.infer<typeof settingsSchema>;

/** The file `buildSettingsExport` writes. */
export const settingsExportFileSchema = z.object({
  format: z.literal(SETTINGS_FORMAT),
  /** The migration anchor. Not pinned to the current value — see below. */
  version: z.number().int().positive(),
  exportedAt: z.string(),
  settings: settingsBodySchema,
  /**
   * Only present when the user ticked "Keys mitschreiben (unsicher)"
   * (`Plan.md` §8.2). Absent means "this file has no keys in it", which is a
   * stronger statement than "the keys are empty" — a reader must be able to
   * tell the difference.
   */
  apiKeys: z.record(z.string(), z.string()).optional(),
});
export type SettingsExportFile = z.infer<typeof settingsExportFileSchema>;

/**
 * A fresh install.
 *
 * `permissions.rules` is `Plan.md` §7.4's default policy verbatim, from core —
 * not a copy of it. A copy is a second rule table that can drift, and §7.4's
 * policy is a decision, not a formatting detail.
 */
export function defaultSettings(): SettingsSnapshot {
  return {
    version: SETTINGS_VERSION,
    theme: "dark",
    instructions: "",
    permissions: { rules: createDefaultRules(), grants: [] },
    apiKeys: {},
  };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface SettingsExportOptions {
  /**
   * The opt-in. `false` by default and **not** inferred from anything: §8.2 calls
   * for a separate, warning checkbox in the UI, so the default has to be the
   * safe one at the API level too.
   */
  readonly includeApiKeys?: boolean;
  /** Injected so a test can pin `exportedAt`. */
  readonly now?: () => number;
}

/**
 * The export file.
 *
 * `apiKeys` is destructured away from the body rather than deleted afterwards,
 * because a "delete the field" implementation is one `delete` away from being
 * wrong, and the destructure makes the key structurally absent from `settings`.
 */
export function buildSettingsExport(
  snapshot: SettingsSnapshot,
  options: SettingsExportOptions = {},
): SettingsExportFile {
  const { apiKeys, version: _version, ...body } = snapshot;
  const includeApiKeys = options.includeApiKeys ?? false;
  const exportedAt = new Date((options.now ?? Date.now)()).toISOString();

  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt,
    settings: body,
    ...(includeApiKeys ? { apiKeys: { ...apiKeys } } : {}),
  };
}

/** Serialise for a download. Two-space indent, because a settings file gets read. */
export function serialiseSettingsExport(
  snapshot: SettingsSnapshot,
  options: SettingsExportOptions = {},
): string {
  return `${JSON.stringify(buildSettingsExport(snapshot, options), null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* Import — the validation boundary                                    */
/* ------------------------------------------------------------------ */

export type SettingsImportErrorCode = "invalid_json" | "invalid_shape" | "unsupported_version";

/**
 * One validation problem: **where** and **which rule**, never the value.
 *
 * `path` and `code` come from zod and cannot contain input data. `message` comes
 * from the schema too — zod phrases a mismatch as "expected string, received
 * number", not as the input — which is why it is safe to render.
 */
export interface SettingsImportIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class SettingsImportError extends Error {
  constructor(
    readonly code: SettingsImportErrorCode,
    readonly issues: readonly SettingsImportIssue[],
  ) {
    super(
      issues.length === 0
        ? `settings import rejected (${code})`
        : `settings import rejected (${code}): ${issues
            .map((issue) => `${issue.path === "" ? "<root>" : issue.path}: ${issue.message}`)
            .join("; ")}`,
    );
    this.name = "SettingsImportError";
  }
}

/**
 * Parse an exported settings file into a snapshot.
 *
 * ## The three rejections, and why each is separate
 *
 * - `invalid_json` — `JSON.parse` failed. **The V8 message is dropped.** V8's
 *   syntax errors quote the offending text (`Unexpected token 's', "sk-live-…"
 *   is not valid JSON`), so forwarding `error.message` here would put an API key
 *   from a malformed file into an exception, which lands in an error boundary and
 *   therefore in a log. The raw `SyntaxError` is the one place in this file where
 *   a browser message carries user data, and it is the one place that is not
 *   forwarded.
 * - `invalid_shape` — zod said no. Reported per issue, from paths and codes.
 * - `unsupported_version` — the file is from a **newer** baah. Refused rather than
 *   guessed at, because `version` is the migration anchor (§8.2) and importing a
 *   future file would silently drop whatever it added.
 *
 * An older version would be the case for a migration chain; there is only one
 * version so far, so it is the same code with a different message.
 */
export function parseSettingsImport(raw: string): SettingsSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    // No `error` in the message, deliberately — see above.
    throw new SettingsImportError("invalid_json", [
      { path: "", code: "invalid_json", message: "the file is not valid JSON" },
    ]);
  }

  const parsed = settingsExportFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new SettingsImportError(
      "invalid_shape",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  if (parsed.data.version > SETTINGS_VERSION) {
    throw new SettingsImportError("unsupported_version", [
      {
        path: "version",
        code: "unsupported_version",
        message: `the file has version ${parsed.data.version}, this build understands ${SETTINGS_VERSION}`,
      },
    ]);
  }

  return {
    version: SETTINGS_VERSION,
    ...parsed.data.settings,
    apiKeys: parsed.data.apiKeys ?? {},
  };
}

/* ------------------------------------------------------------------ */
/* Diff — the import preview (`Plan.md` §8.2: "was ändert sich?")       */
/* ------------------------------------------------------------------ */

export interface SettingsFieldChange {
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export interface RuleSetDelta {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/**
 * What an import would change.
 *
 * ## No values, anywhere
 *
 * `apiKeys` reports slot names and the count of nothing else. Not the value, not
 * its length, not a hash: a diff is rendered on screen, screenshotted, pasted
 * into an issue. The name is what the user needs ("your `anthropic` key will be
 * replaced"); everything else about the value is not theirs to see twice.
 */
export interface SettingsDiff {
  readonly identical: boolean;
  readonly provider: SettingsFieldChange;
  readonly model: SettingsFieldChange;
  readonly baseUrl: SettingsFieldChange;
  readonly theme: SettingsFieldChange;
  readonly instructions: { readonly changed: boolean; readonly fromChars: number; readonly toChars: number };
  readonly permissions: { readonly rules: RuleSetDelta; readonly grants: RuleSetDelta };
  readonly apiKeys: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly replaced: readonly string[];
    readonly unchanged: readonly string[];
  };
}

export function diffSettings(current: SettingsSnapshot, next: SettingsSnapshot): SettingsDiff {
  const slots = new Set([...Object.keys(current.apiKeys), ...Object.keys(next.apiKeys)]);
  const added: string[] = [];
  const removed: string[] = [];
  const replaced: string[] = [];
  const unchanged: string[] = [];

  for (const slot of [...slots].sort()) {
    const before = current.apiKeys[slot];
    const after = next.apiKeys[slot];
    if (before === undefined && after !== undefined) added.push(slot);
    else if (before !== undefined && after === undefined) removed.push(slot);
    else if (before === after) unchanged.push(slot);
    else replaced.push(slot);
  }

  const diff: SettingsDiff = {
    identical: false,
    provider: {
      from: current.provider?.vendor,
      to: next.provider?.vendor,
    },
    model: { from: current.provider?.model ?? "", to: next.provider?.model ?? "" },
    baseUrl: { from: current.provider?.baseUrl, to: next.provider?.baseUrl },
    theme: { from: current.theme, to: next.theme },
    instructions: {
      changed: current.instructions !== next.instructions,
      fromChars: current.instructions.length,
      toChars: next.instructions.length,
    },
    permissions: {
      rules: deltaRules(current.permissions.rules, next.permissions.rules),
      grants: deltaRules(current.permissions.grants, next.permissions.grants),
    },
    apiKeys: { added, removed, replaced, unchanged },
  };

  return { ...diff, identical: !hasAnyChange(diff) };
}

function hasAnyChange(diff: SettingsDiff): boolean {
  if (diff.provider.from !== diff.provider.to) return true;
  if (diff.model.from !== diff.model.to) return true;
  if (diff.baseUrl.from !== diff.baseUrl.to) return true;
  if (diff.theme.from !== diff.theme.to) return true;
  if (diff.instructions.changed) return true;
  if (diff.permissions.rules.added + diff.permissions.rules.removed + diff.permissions.rules.changed > 0) {
    return true;
  }
  if (diff.permissions.grants.added + diff.permissions.grants.removed + diff.permissions.grants.changed > 0) {
    return true;
  }
  const keys = diff.apiKeys;
  return keys.added.length + keys.removed.length + keys.replaced.length > 0;
}

/**
 * Compare two rule sets as **ordered lists**.
 *
 * Order is the whole semantics of a ruleset (`Plan.md` §7.1: "ein Ruleset ist
 * eine geordnete Liste. Die letzte passende Regel gewinnt"), so the comparison has
 * to be positional. Counting *membership* differences instead would report a
 * reordering as no change at all — and a reordering of an allow/deny pair flips
 * which rule wins, so that is a permission change wearing the costume of a no-op.
 *
 * `changed` therefore means "the same rules in a different order", which is a
 * distinct third case: nothing added, nothing removed, and the outcome is still
 * different.
 */
function deltaRules(
  before: readonly PermissionRuleSetting[],
  after: readonly PermissionRuleSetting[],
): RuleSetDelta {
  const render = (rule: PermissionRuleSetting): string =>
    JSON.stringify([rule.action, rule.resource, rule.effect]);
  const beforeKeys = before.map(render);
  const afterKeys = after.map(render);

  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);

  let added = 0;
  for (const entry of afterSet) if (!beforeSet.has(entry)) added += 1;
  let removed = 0;
  for (const entry of beforeSet) if (!afterSet.has(entry)) removed += 1;

  // Same content, different order — a change, because the last match wins.
  const sameMembers = added === 0 && removed === 0;
  const sameOrder =
    sameMembers && beforeKeys.length === afterKeys.length && beforeKeys.every((key, index) => key === afterKeys[index]);

  return { added, removed, changed: sameMembers && !sameOrder ? 1 : 0 };
}

/* ------------------------------------------------------------------ */
/* The redacted view                                                   */
/* ------------------------------------------------------------------ */

/**
 * What a UI may render from the settings.
 *
 * The point of the type is that a component cannot reach a key even by accident:
 * there is no field to spread. `keySlots` is what the settings screen shows —
 * "which keys are stored" — which is the only thing about a key anyone is
 * entitled to see.
 */
export interface SettingsSummary {
  readonly provider: ProviderSelection | undefined;
  readonly theme: SettingsSnapshot["theme"];
  readonly instructionsLength: number;
  readonly ruleCount: number;
  readonly grantCount: number;
  readonly keySlots: readonly string[];
}

export function summariseSettings(snapshot: SettingsSnapshot): SettingsSummary {
  return {
    provider: snapshot.provider === undefined ? undefined : { ...snapshot.provider },
    theme: snapshot.theme,
    instructionsLength: snapshot.instructions.length,
    ruleCount: snapshot.permissions.rules.length,
    grantCount: snapshot.permissions.grants.length,
    keySlots: Object.keys(snapshot.apiKeys).sort(),
  };
}
