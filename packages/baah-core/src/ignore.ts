/**
 * Shared ignore rules for the search tools (`glob`, `grep`).
 *
 * `Plan.md` §14.5 decides that the candidate list for a search is built from
 * `ignore@7` — i.e. the workspace `.gitignore` — plus a hard-coded set of
 * paths that are never useful to an agent. This module is that filter, in
 * `baah-core` so that every search tool shares one definition.
 *
 * Node-free: it only talks to the `Workspace` interface (AGENTS.md §2).
 */

import ignore, { type Ignore } from "ignore";

import { normalizePath } from "./path.ts";
import type { EntryKind, Workspace } from "./workspace.ts";

/** Workspace-root-relative name of the ignore file we honour. */
export const GITIGNORE_PATH = ".gitignore";

/** Directories whose contents are never source code the model can act on. */
const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".nyc_output",
];

/** Lockfiles: huge, machine-generated, and never worth a context slot. */
const DEFAULT_IGNORED_FILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
];

/** Binary and media payloads — search results must stay text. */
const DEFAULT_IGNORED_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "tar",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "mp4",
  "mov",
];

/**
 * The gitignore-syntax rules applied whether or not the workspace has a
 * `.gitignore`. Exported so the rule set is inspectable and testable instead of
 * an opaque blob.
 */
export const DEFAULT_IGNORE_RULES: readonly string[] = [
  ...DEFAULT_IGNORED_DIRECTORIES.map((name) => `${name}/`),
  ...DEFAULT_IGNORED_FILES,
  ...DEFAULT_IGNORED_EXTENSIONS.map((extension) => `*.${extension}`),
];

export interface IgnoreFilterOptions {
  /** Apply the workspace-root `.gitignore`. Default `true`. */
  respectGitignore?: boolean;
  /**
   * Include dotfiles and dot-directories. Default `false`, so `.env`,
   * `.git/config` and friends are skipped unless a tool asks for them
   * explicitly (the `read` tool must never surface a secret by accident).
   */
  includeHidden?: boolean;
}

/**
 * A predicate over workspace-relative POSIX paths.
 *
 * `kind` is optional. When it is `"file"` only the plain spelling is tested,
 * so a `dir/` rule is not applied to a file that happens to carry the same
 * name. When it is `"directory"` — or unknown — both spellings are tested,
 * because a directory must be filtered out for a walk to prune its subtree.
 */
export interface IgnoreFilter {
  (path: string, kind?: EntryKind): boolean;
  /** `true` when a workspace-root `.gitignore` was found and applied. */
  readonly gitignoreApplied: boolean;
  /**
   * Why the `.gitignore` could not be used. Search continues with the default
   * rules; the reason is reported instead of being swallowed.
   *
   * **The reason is a failure's class name, never its own text** — the same
   * contract as `describeStorageFailure` in `agent/loop.ts`, for the same
   * reason: this string is interpolated into the `note` of a `glob`/`grep`
   * result, and a tool result is rendered (the tool card), persisted (the
   * transcript row) and read by the model. See {@link describeFailure}.
   */
  readonly gitignoreError?: string;
}

/** `true` when any segment starts with a dot (`.env`, `.git/config`, …). */
export function isHiddenPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment.length > 1 && segment.startsWith("."));
}

/**
 * What a `.gitignore` failure is **called**, never what it said.
 *
 * ## The shape it replaced, and why it was the same defect
 *
 * This used to be
 *
 * ```ts
 * return error instanceof Error ? error.message : String(error);
 * ```
 *
 * byte for byte the shape `describeStorageFailure` in `agent/loop.ts` was fixed
 * for, in a different module — so it is worth writing down that the two are the
 * same *kind* of line and **not** the same severity, because the difference is
 * who threw.
 *
 * The store is the component that talks to the provider, so its rejections are
 * the provider's sentences: a worker that forwards a provider rejection hands
 * back text that can quote the key, and that text was rendered in the status
 * bar. The workspace is the component that talks to the *filesystem*, and it
 * never holds the key — `AGENTS.md` §2 keeps the key in the app's settings and
 * no `Workspace` method takes one. So no message reachable from here is a
 * credential today, and saying otherwise would be a bigger claim than the
 * measurement supports.
 *
 * It is still the same defect, for two reasons that are not about keys:
 *
 * 1. **The field is rendered.** `gitignoreError` becomes the `note` of the
 *    `glob`/`grep` result, and a tool result reaches a screen three times over:
 *    the model's context (the default framing is `JSON.stringify`), the
 *    transcript row (`recordToolCall` persists the part's output), and the tool
 *    card's "Ausgabe" block (`asDisplayText` is `JSON.stringify(output, null,
 *    2)`). A rule that only holds while nobody renders the field is not a rule.
 * 2. **A foreign text is not this package's text.** The `Workspace` is an
 *    injected interface, and a third-party implementation's message is a
 *    sentence this repository did not write and does not control.
 *
 * ## Why the class name is the better field *here*, not merely the safer one
 *
 * For a read failure the name is the whole diagnosis: a `DOMException` from the
 * File System Access API is `NotAllowedError`, `NotFoundError` or
 * `SecurityError`, and `workspace/errors.ts` in this package already says so
 * ("a failure as a `DOMException` whose *name* carries the meaning"). The class
 * name keeps all three and drops only the browser's prose.
 *
 * The one loss is `WorkspaceError`, whose four `code`s (`not_found`,
 * `not_a_file`, `exists`, `unsupported`) collapse into the name — the same
 * mislocated diagnosis as the store's nine `StorageErrorCode`s, and affordable
 * for the same reason: the prefix above the call site already names the
 * operation (".gitignore"), which is the half a user can act on.
 *
 * ## The `ignore().add()` catch
 *
 * Unreachable with the installed `ignore@7.0.10`: measured over thirteen hostile
 * rule sets (lone trailing backslash, unterminated character class, `\0`, a lone
 * surrogate, an overflowing `{n}` quantifier), neither `add()` nor `ignores()`
 * throws — `add()` filters through `checkPattern` and the per-rule `RegExp` is
 * compiled lazily, on the first `ignores()`. It stays as the guard against a
 * future regression that the `loadGitignore` doc names, and it obeys the same
 * rule so that a regression cannot open a second channel silently.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.name === "" ? "Error" : error.name;
  return "non-Error value";
}

/**
 * A `dir/` rule only matches when the tested path is written with a trailing
 * slash, so probe that spelling for directories.
 */
function matches(manager: Ignore, relative: string, kind: EntryKind | undefined): boolean {
  if (manager.ignores(relative)) return true;
  if (kind === undefined || kind === "directory") {
    return manager.ignores(`${relative}/`);
  }
  return false;
}

interface LoadedGitignore {
  filter?: Ignore;
  error?: string;
}

/**
 * Reads the workspace `.gitignore`. Never throws: a missing file is normal, a
 * workspace implementation may refuse the read, and a rule set the parser
 * rejects must not take a search down. (`ignore@7.0.10` is very lenient — the
 * `add()` guard is defence against a future regression, not a hot path.)
 */
async function loadGitignore(workspace: Workspace): Promise<LoadedGitignore> {
  let raw: string;
  try {
    if (!(await workspace.exists(GITIGNORE_PATH))) return {};
    raw = await workspace.readText(GITIGNORE_PATH);
  } catch (error) {
    return { error: `could not read ${GITIGNORE_PATH}: ${describeFailure(error)}` };
  }
  try {
    return { filter: ignore().add(raw) };
  } catch (error) {
    return { error: `malformed ${GITIGNORE_PATH}: ${describeFailure(error)}` };
  }
}

/**
 * Build the shared ignore predicate for one search.
 *
 * The default rules are a hard floor: a `.gitignore` can add ignores, but it
 * cannot un-ignore `node_modules` or a `.png` — otherwise one careless rule
 * would flood the model with vendored code.
 */
export async function createIgnoreFilter(
  workspace: Workspace,
  options: IgnoreFilterOptions = {},
): Promise<IgnoreFilter> {
  const includeHidden = options.includeHidden ?? false;
  const respectGitignore = options.respectGitignore ?? true;

  const defaults = ignore().add(DEFAULT_IGNORE_RULES);
  const loaded = respectGitignore ? await loadGitignore(workspace) : {};
  const gitignore = loaded.filter;

  const predicate = (path: string, kind?: EntryKind): boolean => {
    const normalized = normalizePath(path);

    // The workspace root is never ignored.
    if (normalized === "." || normalized === "/") return false;
    // Anything that climbs out of the workspace is out of scope by definition.
    if (normalized === ".." || normalized.startsWith("../")) return true;

    const relative = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    if (relative === "") return false;

    if (!includeHidden && isHiddenPath(relative)) return true;
    if (matches(defaults, relative, kind)) return true;
    if (gitignore && matches(gitignore, relative, kind)) return true;
    return false;
  };

  return Object.assign(predicate, {
    gitignoreApplied: gitignore !== undefined,
    ...(loaded.error !== undefined ? { gitignoreError: loaded.error } : {}),
  });
}
