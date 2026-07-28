/**
 * Where the workspace is, and where each server's files are inside it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerDescriptor } from "./types.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The workspace root — the directory holding the root `package.json` and `tsconfig.base.json`.
 *
 * Resolved relative to this module, which means the number of `..` segments is tied to where the
 * module sits at *runtime*. Three works for both layouts this package is loaded in:
 *
 *   packages/manifest/dist/paths.js  (built — what `scripts/` loads)
 *   packages/manifest/src/paths.ts   (tsx — what the tests load)
 *
 * It stops working if `dist` ever becomes nested (`dist/src/...`, which happens the moment a
 * `.ts` file outside `rootDir` is included) or if the package moves. Neither is detectable by
 * type-checking, so `manifest.test.ts` asserts the resolved directory really is the workspace
 * root by looking for its markers. That assertion is the reason this comment can be short.
 */
export const WORKSPACE_ROOT = path.resolve(MODULE_DIR, "..", "..", "..");

/** Absolute path to a server's built entry point. */
export function serverEntryPath(server: ServerDescriptor): string {
  return path.join(WORKSPACE_ROOT, server.dir, ...server.entry.split("/"));
}

/** Absolute path to a server's package directory. */
export function serverDirPath(server: ServerDescriptor): string {
  return path.join(WORKSPACE_ROOT, server.dir);
}
