/**
 * The workspace abstraction.
 *
 * Every filesystem tool talks to this interface, never to a browser API
 * directly. That keeps the tools unit-testable in Node (see
 * `createMemoryWorkspace`) while the app wires a real implementation —
 * File System Access API, OPFS, or a WebContainer mount — at runtime.
 */

export type EntryKind = "file" | "directory";

export interface DirEntry {
  /** Path relative to the workspace root, `/`-separated. */
  path: string;
  /** Last path segment. */
  name: string;
  kind: EntryKind;
  size?: number;
}

export interface FileStat {
  kind: EntryKind;
  /** Bytes. 0 for directories. */
  size: number;
  /** Unix ms, or 0 when unknown. */
  lastModified: number;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** Hard cap on visited entries; protects the tab from pathological trees. */
  maxEntries?: number;
  /** Return `false` to skip a directory subtree. */
  filter?: (entry: DirEntry) => boolean;
}

/**
 * How many entries a walk yields before it gives up, unless the caller says
 * otherwise.
 *
 * The **single** source of that number in this package. It used to be an inline
 * `50_000` here *and* a second copy in `workspace/directory-workspace.ts`, and
 * both search tools carried a third; a limit that lives in three places is a
 * limit that will drift. Everything now reads this one.
 */
export const DEFAULT_MAX_ENTRIES: number = 50_000;

/**
 * What a walk yields, and what it knows about itself.
 *
 * ## Why this is not `AsyncIterable<DirEntry>`
 *
 * A bare async iterable can only report what it *produced*. It cannot report
 * what it *did not see*, and that is the fact a search tool needs: a `grep`
 * that stopped at the cap and found nothing is not the same answer as a `grep`
 * that looked everywhere and found nothing, and only the walk can tell them
 * apart. Measured consequence before this change: 50 051 files with the needle
 * in the alphabetically last one returned `total: 0`, `searchTruncated: false`
 * and the hint *"No line matches … widen path"* — a complete-knowledge claim
 * from an incomplete search.
 *
 * ## The two flags are updated *while* the iteration runs
 *
 * `truncated` and `visited` are plain, mutable fields on one object, not
 * `readonly` and not a promise. They are only meaningful **after** the
 * `for await` has finished, which is exactly when a consumer asks:
 *
 * ```ts
 * const walk = workspace.walk(".");
 * for await (const entry of walk.entries) { collect(entry); }
 * if (walkMayBeIncomplete(walk)) reportPartialAnswer();
 * ```
 *
 * Reading them before the loop ends is reading a number that is still moving.
 * The walk is still lazy: nothing is enumerated until `entries` is iterated.
 */
export interface WalkResult {
  /**
   * The entries. Lazily produced — iterating it *is* the walk.
   *
   * Consuming it with `for await … of` (including a `break` or a `throw` out
   * of the loop) releases every directory cursor the walk opened, because the
   * `for await` protocol calls `return()` on the iterator on early exit.
   */
  entries: AsyncIterable<DirEntry>;
  /**
   * `true` when the walk stopped at `maxEntries` **before the tree was
   * exhausted**.
   *
   * An abort is *not* truncation: the walk stopped for a reason the caller
   * passed in and already knows about. A tree of exactly `maxEntries` entries
   * is *not* truncation either — the walk saw all of it. Use
   * {@link walkMayBeIncomplete} for the deliberately conservative answer.
   */
  truncated: boolean;
  /** Entries yielded, for a caller that wants to report its own progress. */
  visited: number;
}

/**
 * The deliberately conservative reading of a finished walk: *may* this answer
 * be incomplete?
 *
 * `WalkResult.truncated` is the exact fact. This is the biased one, and the
 * bias has to survive the flag: a search tool that over-reports "possibly
 * incomplete" trains the model to ignore the field, which is worse than never
 * having it — so the error direction is deliberate and one-directional. A
 * consumer that consumed exactly `maxEntries` entries **cannot rule out** more,
 * and this returns `true` for it even when the walk itself finished.
 *
 * ## Why it lives here and not in the tool
 *
 * Because only the walk knows the two things the judgement needs: the cap it
 * applied and how many entries it handed out. A tool that re-derived either one
 * would be a third copy of a constant that already drifted twice — which is
 * exactly the bug this replaced. So the tools call this, and the *number* has
 * one home in the codebase.
 */
export function walkMayBeIncomplete(result: WalkResult, maxEntries: number = DEFAULT_MAX_ENTRIES): boolean {
  return result.truncated || result.visited >= maxEntries;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface Workspace {
  readonly id: string;
  /** Human-readable name shown in the UI, e.g. the picked folder name. */
  readonly label: string;

  stat(path: string): Promise<FileStat | null>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  /**
   * Write `content` as UTF-8 text, creating the file if needed and creating
   * any missing parent directories on the way (like `mkdir -p`). An existing
   * file is overwritten.
   *
   * Implementations MUST reject:
   * - the workspace root itself (`.`),
   * - a target that is an existing **directory**,
   * - a path whose parent segment is an existing **file**.
   *
   * Tools rely on this contract instead of re-implementing it.
   */
  writeText(path: string, content: string): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  remove(path: string, options?: RemoveOptions): Promise<void>;
  /**
   * Depth-first walk of `directory`, capped at
   * {@link DEFAULT_MAX_ENTRIES} entries.
   *
   * Returns a {@link WalkResult} rather than the entries directly, because a
   * caller that cannot see the truncation cannot report an honest answer.
   */
  walk(directory?: string, options?: WalkOptions): WalkResult;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_a_file" | "not_a_directory" | "exists" | "unsupported",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const encoder = new TextEncoder();

/** UTF-8 byte length. `String#length` counts UTF-16 units, which is not a size. */
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** `"."`, `""` and `"/"` all denote the workspace root, which is not writable. */
export function isWorkspaceRoot(path: string): boolean {
  return path === "." || path === "" || path === "/";
}

interface MemoryNode {
  kind: EntryKind;
  content: string;
  lastModified: number;
}

/**
 * In-memory workspace used by unit tests. Node-free, deterministic.
 *
 * ```ts
 * const ws = createMemoryWorkspace({ "src/a.ts": "export const a = 1;\n" });
 * ```
 */
export function createMemoryWorkspace(
  files: Record<string, string> = {},
  label = "memory",
): Workspace {
  const nodes = new Map<string, MemoryNode>();

  const ensureParents = (path: string): void => {
    const segments = path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const existing = nodes.get(current);
      if (existing && existing.kind !== "directory") {
        throw new WorkspaceError(`Not a directory: ${current}`, "not_a_directory");
      }
      if (!existing) {
        nodes.set(current, { kind: "directory", content: "", lastModified: 0 });
      }
    }
  };

  for (const [path, content] of Object.entries(files)) {
    ensureParents(path);
    nodes.set(path, { kind: "file", content, lastModified: 0 });
  }

  const requireFile = (path: string): MemoryNode => {
    const node = nodes.get(path);
    if (!node) throw new WorkspaceError(`File not found: ${path}`, "not_found");
    if (node.kind !== "file") {
      throw new WorkspaceError(`Not a file: ${path}`, "not_a_file");
    }
    return node;
  };

  const workspace: Workspace = {
    id: "memory",
    label,

    async stat(path) {
      const node = nodes.get(path);
      if (!node) return null;
      return {
        kind: node.kind,
        size: node.kind === "file" ? byteLength(node.content) : 0,
        lastModified: node.lastModified,
      };
    },

    async exists(path) {
      return nodes.has(path);
    },

    async readText(path) {
      return requireFile(path).content;
    },

    async writeText(path, content) {
      if (isWorkspaceRoot(path)) {
        throw new WorkspaceError(
          `Cannot write to the workspace root: ${path}`,
          "unsupported",
        );
      }
      const existing = nodes.get(path);
      if (existing && existing.kind === "directory") {
        throw new WorkspaceError(`Not a file: ${path}`, "not_a_file");
      }
      ensureParents(path);
      nodes.set(path, { kind: "file", content, lastModified: Date.now() });
    },

    async list(path) {
      const prefix = path === "." || path === "" ? "" : `${path}/`;
      const seen = new Map<string, DirEntry>();
      for (const [nodePath, node] of nodes) {
        if (!nodePath.startsWith(prefix)) continue;
        const rest = nodePath.slice(prefix.length);
        if (rest === "") continue;
        const [first, ...remaining] = rest.split("/");
        if (first === undefined) continue;
        const childPath = prefix + first;
        const kind: EntryKind = remaining.length > 0 ? "directory" : node.kind;
        seen.set(childPath, {
          path: childPath,
          name: first,
          kind,
          ...(kind === "file" ? { size: byteLength(node.content) } : {}),
        });
      }
      return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
    },

    async remove(path, options) {
      const node = nodes.get(path);
      if (!node) throw new WorkspaceError(`Not found: ${path}`, "not_found");
      if (node.kind === "directory" && !options?.recursive) {
        const children = [...nodes.keys()].filter((key) => key.startsWith(`${path}/`));
        if (children.length > 0) {
          throw new WorkspaceError(`Directory not empty: ${path}`, "exists");
        }
      }
      nodes.delete(path);
      if (node.kind === "directory") {
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(`${path}/`)) nodes.delete(key);
        }
      }
    },

    walk(directory = ".", options = {}) {
      return walkMemory(nodes, directory, options);
    },
  };

  return workspace;
}

/**
 * The memory workspace's walk.
 *
 * Shared shape with the directory walker on purpose: both write `truncated`
 * the moment they refuse to yield an entry they could have yielded, and both
 * leave it `false` when the tree ran out first. That agreement is what makes
 * the two implementations interchangeable for a caller that reads the flag.
 */
function walkMemory(
  nodes: ReadonlyMap<string, MemoryNode>,
  directory: string,
  options: WalkOptions,
): WalkResult {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // One object, written by the generator below and read by the caller after
  // the loop has ended — see the note on `WalkResult`.
  const result: WalkResult = {
    entries: { async *[Symbol.asyncIterator]() {} },
    truncated: false,
    visited: 0,
  };

  result.entries = {
    async *[Symbol.asyncIterator]() {
      const root = directory === "." || directory === "" ? "" : `${directory}/`;
      const keys = [...nodes.keys()].sort();
      for (const key of keys) {
        if (options.signal?.aborted) return;
        if (root !== "" && !key.startsWith(root)) continue;
        const node = nodes.get(key);
        if (!node) continue;
        const entry: DirEntry = {
          path: key,
          name: key.slice(key.lastIndexOf("/") + 1),
          kind: node.kind,
          ...(node.kind === "file" ? { size: byteLength(node.content) } : {}),
        };
        if (options.filter && !options.filter(entry)) continue;
        // The cap is checked *before* the yield, so `truncated` means "there
        // was another entry and we did not take it" — a statement about the
        // tree, not about a counter that happened to land on the limit.
        if (result.visited >= maxEntries) {
          result.truncated = true;
          return;
        }
        result.visited += 1;
        yield entry;
      }
    },
  };

  return result;
}
