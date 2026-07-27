/**
 * Path string primitives.
 *
 * Pure string helpers only — no filesystem access. Anything that resolves or
 * validates a real path against an allowlist belongs in `@mcp/shared/fs`.
 */

/** Rewrite Windows separators to POSIX. All platform responses use forward slashes. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Collapse duplicate separators and strip a single trailing slash. */
export function normalizePosixPath(value: string): string {
  const posix = toPosixPath(value).replace(/\/{2,}/g, "/");
  return posix.length > 1 && posix.endsWith("/") ? posix.slice(0, -1) : posix;
}

/** True when `child` is `parent` or lies beneath it, respecting segment boundaries. */
export function isPathWithin(parent: string, child: string, caseInsensitive = false): boolean {
  const normalize = (value: string): string => {
    const normalized = normalizePosixPath(value);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const parentPath = normalize(parent);
  const childPath = normalize(child);
  if (childPath === parentPath) {
    return true;
  }
  // The trailing separator prevents "/foo" from matching "/foobar".
  return childPath.startsWith(parentPath.endsWith("/") ? parentPath : `${parentPath}/`);
}

/** Split a POSIX-style path into non-empty segments. */
export function pathSegments(value: string): string[] {
  return normalizePosixPath(value)
    .split("/")
    .filter((segment) => segment !== "");
}
