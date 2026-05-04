import path from "node:path";

import type { WatchConfig } from "./types.js";

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z-_]{35}/g,
  /-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*[\"'][^\"']+[\"']/gi
];

export function parseAllowedRoots(raw: string | undefined): string[] {
  const input = raw?.trim();
  if (!input) {
    return [];
  }

  return input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => normalizePath(x));
}

export function assertPathAllowed(repoPath: string, allowedRoots: string[]): void {
  const normalizedRepoPath = normalizePath(repoPath);

  if (allowedRoots.length === 0) {
    throw new Error("CODEBASE_INDEX_ALLOWED_ROOTS must be configured.");
  }

  const isAllowed = allowedRoots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return normalizedRepoPath === normalizedRoot || normalizedRepoPath.startsWith(`${normalizedRoot}${path.sep}`);
  });

  if (!isAllowed) {
    throw new Error("repoPath is outside allowed roots.");
  }
}

export function redactSensitive(input: string): string {
  let value = input;
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, "[REDACTED]");
  }
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return fallback;
}

export function parseWatchConfigFromEnv(env: NodeJS.ProcessEnv): WatchConfig {
  const debounceMs = clamp(readNumber(env.CODEBASE_INDEX_WATCH_DEBOUNCE_MS, 1200), 200, 30_000);
  const maxQueuedEvents = clamp(readNumber(env.CODEBASE_INDEX_WATCH_MAX_QUEUED_EVENTS, 2000), 100, 50_000);
  const maxFilesPerRun = clamp(readNumber(env.CODEBASE_INDEX_WATCH_MAX_FILES_PER_RUN, 4000), 100, 100_000);
  const batchSize = clamp(readNumber(env.CODEBASE_INDEX_WATCH_BATCH_SIZE, 200), 20, 2_000);
  return { debounceMs, maxQueuedEvents, maxFilesPerRun, batchSize };
}

export function parseAutoWatchRepos(raw: string | undefined): { repoId: string; repoPath: string }[] {
  const input = raw?.trim();
  if (!input) {
    return [];
  }

  const items = input
    .split(/[\n;,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const parsed: { repoId: string; repoPath: string }[] = [];
  for (const item of items) {
    const idx = item.indexOf("=");
    if (idx <= 0 || idx >= item.length - 1) {
      continue;
    }
    const repoId = item.slice(0, idx).trim();
    const repoPath = item.slice(idx + 1).trim();
    if (!repoId || !repoPath) {
      continue;
    }
    parsed.push({ repoId, repoPath: normalizePath(repoPath) });
  }

  return parsed;
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizePath(value: string): string {
  return path.resolve(value);
}
