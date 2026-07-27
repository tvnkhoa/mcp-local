/**
 * Filesystem path allowlist.
 *
 * Mechanism for the platform's "internal only, local first" posture: a server
 * declares the roots it may touch, and every incoming path is resolved and
 * checked against them before any I/O. This module performs no I/O itself.
 */

import path from "node:path";

import type { PlatformError, Result } from "@mcp/core";
import { err, isPathWithin, ok, policyViolation, toPosixPath, validationError } from "@mcp/core";

export interface PathAllowlistOptions {
  /** Compare case-insensitively. Defaults to true on win32. */
  readonly caseInsensitive?: boolean;
  /** Resolve relative candidates against this directory instead of cwd. */
  readonly baseDir?: string;
}

export interface PathAllowlist {
  /** Normalized POSIX-style roots, in declaration order. */
  readonly roots: readonly string[];
  /** Resolve and authorize a candidate path. */
  resolve(candidate: string): Result<string, PlatformError>;
  contains(candidate: string): boolean;
  describe(): Readonly<Record<string, unknown>>;
}

/**
 * Build an allowlist from absolute roots.
 *
 * Throws on an empty or relative root — a misconfigured allowlist is a
 * programmer/config error that must fail at startup, not at first use.
 */
export function createPathAllowlist(
  roots: readonly string[],
  options: PathAllowlistOptions = {}
): PathAllowlist {
  if (roots.length === 0) {
    throw new Error("createPathAllowlist: at least one root is required");
  }

  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";

  const normalizedRoots = roots.map((root) => {
    const trimmed = root.trim();
    if (trimmed === "") {
      throw new Error("createPathAllowlist: roots must not be empty strings");
    }
    if (!path.isAbsolute(trimmed)) {
      throw new Error(`createPathAllowlist: root must be absolute, received "${trimmed}"`);
    }
    return toPosixPath(path.resolve(trimmed));
  });

  const resolveCandidate = (candidate: string): string => {
    const base = options.baseDir ?? process.cwd();
    return toPosixPath(path.resolve(base, candidate));
  };

  const isAllowed = (resolved: string): boolean =>
    normalizedRoots.some((root) => isPathWithin(root, resolved, caseInsensitive));

  return {
    roots: normalizedRoots,

    resolve(candidate) {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        return err(validationError("Path must be a non-empty string."));
      }
      // A NUL byte truncates the path at the syscall layer — reject outright.
      if (candidate.includes("\0")) {
        return err(validationError("Path contains an illegal null byte."));
      }

      const resolved = resolveCandidate(candidate);
      if (!isAllowed(resolved)) {
        return err(
          policyViolation("Path is outside the configured allowlist.", {
            resolved,
            allowedRootCount: normalizedRoots.length
          })
        );
      }
      return ok(resolved);
    },

    contains(candidate) {
      if (typeof candidate !== "string" || candidate.trim() === "" || candidate.includes("\0")) {
        return false;
      }
      return isAllowed(resolveCandidate(candidate));
    },

    describe: () => ({
      allowedRootCount: normalizedRoots.length,
      roots: normalizedRoots,
      caseInsensitive
    })
  };
}
