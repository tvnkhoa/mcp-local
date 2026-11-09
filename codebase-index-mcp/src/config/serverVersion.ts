/**
 * Resolve the version this server reports in its MCP handshake.
 *
 * Split out of the former root-level `serverUtils.ts`, whose two functions had no
 * relationship to each other beyond both being needed at start-up. This half is
 * configuration resolution, so it lives with the rest of it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NPM_PACKAGE_VERSION } from "./envConfig.js";

export function resolveServerVersion(moduleDir: string): string {
  const npmVersion = NPM_PACKAGE_VERSION;
  if (npmVersion.length > 0) {
    return npmVersion;
  }

  try {
    const packageJsonPath = nearestPackageJson(moduleDir);
    if (packageJsonPath === null) return "unknown";
    const text = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Keep a deterministic fallback for environments where package.json is unavailable.
  }

  return "unknown";
}

/**
 * The nearest `package.json` at or above `moduleDir`, at most `maxUp` levels up; null if none.
 * MCP-ISSUE-124: the entry runs from `dist/` (tsc) or `dist/bundle/` (esbuild), so a fixed `../` misses one of them.
 */
export function nearestPackageJson(moduleDir: string, maxUp = 3): string | null {
  let dir = path.resolve(moduleDir);
  for (let i = 0; i <= maxUp; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The file of the running entry, seen from a module that is `relToEntry` away from it in the tsc layout.
 * MCP-ISSUE-124: bundled, the module is no longer its own file — its code lives in the entry itself, so
 * `import.meta.url` IS the entry. Unbundled, the module's file is named `ownStem` and the entry is relative to it.
 */
export function runningEntryPath(moduleUrl: string, ownStem: string, relToEntry: string): string {
  const here = fileURLToPath(moduleUrl);
  const stem = path.basename(here, path.extname(here));
  return stem === ownStem ? path.resolve(path.dirname(here), relToEntry) : here;
}
