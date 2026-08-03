/**
 * Resolve the version this server reports in its MCP handshake.
 *
 * Split out of the former root-level `serverUtils.ts`, whose two functions had no
 * relationship to each other beyond both being needed at start-up. This half is
 * configuration resolution, so it lives with the rest of it.
 */

import fs from "node:fs";
import path from "node:path";

import { NPM_PACKAGE_VERSION } from "./envConfig.js";

export function resolveServerVersion(moduleDir: string): string {
  const npmVersion = NPM_PACKAGE_VERSION;
  if (npmVersion.length > 0) {
    return npmVersion;
  }

  try {
    const packageJsonPath = path.resolve(moduleDir, "..", "package.json");
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
