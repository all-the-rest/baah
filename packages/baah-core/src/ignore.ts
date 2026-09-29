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
   */
  readonly gitignoreError?: string;
}

/** `true` when any segment starts with a dot (`.env`, `.git/config`, …). */
export function isHiddenPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment.length > 1 && segment.startsWith("."));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    return { error: `could not read ${GITIGNORE_PATH}: ${describe(error)}` };
  }
  try {
    return { filter: ignore().add(raw) };
  } catch (error) {
    return { error: `malformed ${GITIGNORE_PATH}: ${describe(error)}` };
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
