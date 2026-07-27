import process from "node:process";

import { PolicyViolationError } from "../errors.js";

export type BitbucketConfig = {
  baseUrl: string;
  /** Workspace slug (required). All repo paths are scoped under this by default. */
  workspace: string;
  /** Optional default repo slug so callers can omit `repoSlug`. */
  defaultRepo?: string;
  /** Ready-to-use HTTP Authorization header value, e.g. "Bearer <token>". */
  authHeader: string;
  /** create_pull_request is refused unless this is true (BITBUCKET_WRITE_ENABLED). */
  writeEnabled: boolean;
  timeoutMs: number;
  /** Retry attempts for transient HTTP failures (network / 5xx / 429). 0 disables retries. */
  maxRetries: number;
  defaultPagelen: number;
  maxPagelen: number;
};

function numberFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function stringFromEnv(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.trim();
}

/** Like numberFromEnv but permits 0 (unlike sizes which must be positive). */
function nonNegFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/** Feature flag: ON only when the value is exactly "true" or "1". */
function parseBoolEnv(key: string): boolean {
  const raw = process.env[key];
  return raw === "true" || raw === "1";
}

/**
 * Build the Authorization header from env. Precedence:
 *   1. BITBUCKET_ACCESS_TOKEN — a Repository/Workspace/Project Access Token (Bearer)
 *   2. BITBUCKET_EMAIL + BITBUCKET_API_TOKEN — Atlassian API token via Basic auth
 * Throws a PolicyViolationError if neither is supplied. Credentials are never logged.
 */
function resolveAuthHeader(): string {
  const token = process.env.BITBUCKET_ACCESS_TOKEN?.trim();
  if (token) {
    return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
  }

  const email = process.env.BITBUCKET_EMAIL?.trim();
  const apiToken = process.env.BITBUCKET_API_TOKEN?.trim();
  if (email && apiToken) {
    const encoded = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
    return `Basic ${encoded}`;
  }

  throw new PolicyViolationError(
    "config_error",
    "No Bitbucket credentials configured. Set BITBUCKET_ACCESS_TOKEN (access token), or BITBUCKET_EMAIL + BITBUCKET_API_TOKEN (Atlassian API token)."
  );
}

export function loadConfig(): BitbucketConfig {
  const baseUrl = stringFromEnv("BITBUCKET_BASE_URL", "https://api.bitbucket.org/2.0").replace(/\/+$/, "");

  const workspace = process.env.BITBUCKET_WORKSPACE?.trim();
  if (!workspace) {
    throw new PolicyViolationError(
      "config_error",
      "No Bitbucket workspace configured. Set BITBUCKET_WORKSPACE to your workspace slug."
    );
  }

  const defaultRepoRaw = process.env.BITBUCKET_DEFAULT_REPO?.trim();

  // Bitbucket caps pagelen at 100, so floor to an integer and never exceed that.
  const defaultPagelen = Math.min(100, Math.floor(numberFromEnv("BITBUCKET_DEFAULT_PAGELEN", 25)));
  const maxPagelen = Math.min(100, Math.max(defaultPagelen, Math.floor(numberFromEnv("BITBUCKET_MAX_PAGELEN", 100))));

  return {
    baseUrl,
    workspace,
    defaultRepo: defaultRepoRaw && defaultRepoRaw.length > 0 ? defaultRepoRaw : undefined,
    authHeader: resolveAuthHeader(),
    writeEnabled: parseBoolEnv("BITBUCKET_WRITE_ENABLED"),
    timeoutMs: numberFromEnv("BITBUCKET_TIMEOUT_MS", 30_000),
    maxRetries: nonNegFromEnv("BITBUCKET_MAX_RETRIES", 2),
    defaultPagelen,
    maxPagelen
  };
}

/** A non-secret view of the config for echoing in responses / startup logs. */
export function describeConfig(config: BitbucketConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    workspace: config.workspace,
    defaultRepo: config.defaultRepo ?? null,
    auth: maskSecret(config.authHeader),
    writeEnabled: config.writeEnabled,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    defaultPagelen: config.defaultPagelen,
    maxPagelen: config.maxPagelen
  };
}

/** Mask a secret, keeping only the scheme so it can be recognized but not reused. */
export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  const [scheme] = value.split(" ", 1);
  if (scheme && scheme.toLowerCase() === "bearer") {
    return "Bearer ****";
  }
  if (scheme && scheme.toLowerCase() === "basic") {
    return "Basic ****";
  }
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}****`;
}
