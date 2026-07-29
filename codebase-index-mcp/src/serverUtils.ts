/**
 * Server utility functions
 */

import fs from "node:fs";
import path from "node:path";

import { NPM_PACKAGE_VERSION } from "./config/envConfig.js";

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

export function parseRepoResourceUri(
  uri: string,
  maxResultLimit: number
): { repoId: string; resource: "context" | "schema" | "routes" | "risk"; limit?: number } | null {
  const match = uri.match(/^repo:\/\/([^/]+)\/(context|schema|routes|risk)(?:\?(.*))?$/i);
  if (!match) {
    return null;
  }

  const repoId = decodeURIComponent(match[1]);
  const resource = match[2].toLowerCase() as "context" | "schema" | "routes" | "risk";
  const query = match[3] ?? "";
  const params = new URLSearchParams(query);
  const rawLimit = params.get("limit");

  return {
    repoId,
    resource,
    limit: rawLimit ? clamp(Number(rawLimit), 1, maxResultLimit) : undefined
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
