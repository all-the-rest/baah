/**
 * POSIX-style path helpers.
 *
 * We deliberately do NOT use `node:path`: this package must run in a browser
 * (see AGENTS.md §2). Workspace paths are always `/`-separated, relative to the
 * workspace root, and never contain a drive letter.
 */

const SEPARATOR = "/";

export function isAbsolutePath(path: string): boolean {
  return path.startsWith(SEPARATOR);
}

/** Collapse `.`/`..`/duplicate separators. Keeps a leading `/` for absolute paths. */
export function normalizePath(path: string): string {
  const absolute = isAbsolutePath(path);
  const out: string[] = [];

  for (const segment of path.split(SEPARATOR)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }

  const joined = out.join(SEPARATOR);
  if (absolute) return `${SEPARATOR}${joined}`;
  return joined === "" ? "." : joined;
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part !== "").join(SEPARATOR));
}

/** Resolve `target` against `base`. An absolute `target` wins. */
export function resolvePath(base: string, target: string): string {
  if (isAbsolutePath(target)) return normalizePath(target);
  return joinPath(base, target);
}

export function dirnamePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/" || normalized === ".") return normalized;
  const index = normalized.lastIndexOf(SEPARATOR);
  if (index < 0) return ".";
  if (index === 0) return SEPARATOR;
  return normalized.slice(0, index);
}

export function basenamePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/" || normalized === ".") return normalized;
  return normalized.slice(normalized.lastIndexOf(SEPARATOR) + 1);
}

export function extnamePath(path: string): string {
  const base = basenamePath(path);
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index);
}

/** `relativePath("/a/b", "/a/b/c/d")` → `"c/d"`. */
export function relativePath(from: string, to: string): string {
  const parts = (path: string): string[] =>
    normalizePath(path)
      .split(SEPARATOR)
      .filter((segment) => segment !== "" && segment !== ".");

  const fromParts = parts(from);
  const toParts = parts(to);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }

  const up = fromParts.slice(common).map(() => "..");
  const down = toParts.slice(common);
  const result = [...up, ...down].join(SEPARATOR);
  return result === "" ? "." : result;
}

/**
 * Guard against escaping the workspace root. Returns the resolved
 * root-relative path or throws.
 *
 * The workspace path space is always root-relative: `root` is a directory
 * inside the workspace (usually `"."`), and a leading `/` on `target` means
 * "from the workspace root". Every filesystem tool must route user input
 * through this.
 */
export function assertInsideRoot(root: string, target: string): string {
  const normalizedRoot = normalizePath(root);
  const rootDir = normalizedRoot === "/" ? "." : normalizedRoot;

  const targetPath = normalizePath(target);

  // A leading "/" means "from the workspace root", regardless of cwd.
  const combined = isAbsolutePath(targetPath)
    ? normalizePath(targetPath.slice(1) || ".")
    : rootDir === "."
      ? targetPath
      : normalizePath(`${rootDir}/${targetPath}`);

  if (combined === ".." || combined.startsWith("../")) {
    throw new Error(`Path escapes the workspace root: ${target}`);
  }
  return combined;
}
