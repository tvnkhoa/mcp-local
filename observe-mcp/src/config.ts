import process from "node:process";

import { PolicyViolationError } from "./errors.js";

export type ObserveConfig = {
  baseUrl: string;
  org: string;
  logStream: string;
  traceStream: string;
  /** True only when OBSERVE_TRACE_STREAM was explicitly set (i.e. distinct from the logs stream fallback). */
  traceStreamConfigured: boolean;
  /** Ready-to-use HTTP Authorization header value, e.g. "Basic <base64>". */
  authHeader: string;
  defaultSize: number;
  maxSize: number;
  defaultLookbackMs: number;
  maxLookbackMs: number;
  timeoutMs: number;
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

/**
 * Build the Basic auth header from env. Precedence:
 *   1. OBSERVE_AUTH_BASIC  — a pre-encoded token (with or without the "Basic " prefix)
 *   2. OBSERVE_USERNAME + OBSERVE_PASSWORD — encoded here
 * Throws a PolicyViolationError if neither is supplied. Credentials are never logged.
 */
function resolveAuthHeader(): string {
  const raw = process.env.OBSERVE_AUTH_BASIC?.trim();
  if (raw) {
    return raw.toLowerCase().startsWith("basic ") ? raw : `Basic ${raw}`;
  }

  const user = process.env.OBSERVE_USERNAME?.trim();
  const pass = process.env.OBSERVE_PASSWORD;
  if (user && pass !== undefined && pass !== "") {
    const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    return `Basic ${token}`;
  }

  throw new PolicyViolationError(
    "config_error",
    "No OpenObserve credentials configured. Set OBSERVE_AUTH_BASIC, or OBSERVE_USERNAME + OBSERVE_PASSWORD."
  );
}

export function loadConfig(): ObserveConfig {
  const baseUrl = stringFromEnv("OBSERVE_BASE_URL", "https://observe.easyserv.au:10443").replace(/\/+$/, "");
  const org = stringFromEnv("OBSERVE_ORG", "36619ZLzJ9IjUYKMqTT3MJC5A7Z");
  const logStream = stringFromEnv("OBSERVE_LOG_STREAM", "wecrm_dev");
  const traceStreamRaw = process.env.OBSERVE_TRACE_STREAM?.trim();
  const traceStreamConfigured = Boolean(traceStreamRaw);
  const traceStream = traceStreamConfigured ? (traceStreamRaw as string) : logStream;

  const defaultSize = numberFromEnv("OBSERVE_DEFAULT_SIZE", 100);
  const maxSize = Math.max(defaultSize, numberFromEnv("OBSERVE_MAX_SIZE", 1000));
  const defaultLookbackMs = numberFromEnv("OBSERVE_DEFAULT_LOOKBACK_MS", 3_600_000);
  const maxLookbackMs = Math.max(defaultLookbackMs, numberFromEnv("OBSERVE_MAX_LOOKBACK_MS", 604_800_000));
  const timeoutMs = numberFromEnv("OBSERVE_TIMEOUT_MS", 30_000);

  return {
    baseUrl,
    org,
    logStream,
    traceStream,
    traceStreamConfigured,
    authHeader: resolveAuthHeader(),
    defaultSize,
    maxSize,
    defaultLookbackMs,
    maxLookbackMs,
    timeoutMs
  };
}

/** A non-secret view of the config for echoing in responses / startup logs. */
export function describeConfig(config: ObserveConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    org: config.org,
    logStream: config.logStream,
    traceStream: config.traceStream,
    auth: maskSecret(config.authHeader),
    defaultSize: config.defaultSize,
    maxSize: config.maxSize,
    defaultLookbackMs: config.defaultLookbackMs,
    maxLookbackMs: config.maxLookbackMs,
    timeoutMs: config.timeoutMs
  };
}

/** Mask a secret, keeping only a short prefix so it can be recognized but not reused. */
export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  const [scheme] = value.split(" ", 1);
  if (scheme && scheme.toLowerCase() === "basic") {
    return "Basic ****";
  }
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}****`;
}
