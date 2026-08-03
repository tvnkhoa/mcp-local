/**
 * Where the workspace is, and where each server's files are inside it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerDescriptor } from "./types.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The two files that, together, identify the workspace root and nothing else.
 *
 * `package.json` alone is not enough — every package and every server has one, so an upward search
 * for it stops at `packages/manifest/`. `tsconfig.base.json` exists only at the root.
 */
const ROOT_MARKERS = ["tsconfig.base.json", "package.json"] as const;

/**
 * Find the workspace root by walking up from this module until both markers are present.
 *
 * **Why a search and not `path.resolve(MODULE_DIR, "..", "..", "..")`** (backlog B-09): counting
 * `..` segments ties correctness to where this module sits at *runtime*. Three happened to work
 * for both layouts the package is loaded in —
 *
 *   packages/manifest/dist/paths.js  (built — what `scripts/` loads)
 *   packages/manifest/src/paths.ts   (tsx — what the tests load)
 *
 * — and broke **silently** if `dist` ever nested (`dist/src/...`, which happens the moment a `.ts`
 * file outside `rootDir` is included) or if the package moved. Type-checking cannot see it, and
 * everything the installer writes into `~/.claude.json` is resolved from this value, so the
 * failure mode was an agent config full of paths pointing nowhere.
 *
 * A marker search is correct at any depth. It throws rather than returning a wrong answer,
 * because every caller of this value writes a path somewhere a human will later have to unpick.
 */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (ROOT_MARKERS.every((marker) => existsSync(path.join(dir, marker)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Cannot locate the workspace root from ${start}: walked to the filesystem root without ` +
          `finding a directory containing ${ROOT_MARKERS.join(" and ")}. @mcp/manifest is being ` +
          "loaded from outside the workspace, or the root markers have been renamed."
      );
    }
    dir = parent;
  }
}

/** The workspace root — the directory holding the root `package.json` and `tsconfig.base.json`. */
export const WORKSPACE_ROOT = findWorkspaceRoot(MODULE_DIR);

/** Absolute path to a server's built entry point. */
export function serverEntryPath(server: ServerDescriptor): string {
  return path.join(WORKSPACE_ROOT, server.dir, ...server.entry.split("/"));
}

/** Absolute path to a server's package directory. */
export function serverDirPath(server: ServerDescriptor): string {
  return path.join(WORKSPACE_ROOT, server.dir);
}
