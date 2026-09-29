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
  walk(directory?: string, options?: WalkOptions): AsyncIterable<DirEntry>;
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

    async *walk(directory = ".", options = {}) {
      const maxEntries = options.maxEntries ?? 50_000;
      let visited = 0;
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
        visited += 1;
        if (visited > maxEntries) return;
        yield entry;
      }
    },
  };

  return workspace;
}
