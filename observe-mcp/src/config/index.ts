import process from "node:process";

import { PolicyViolationError } from "../middleware/errors.js";
import type { ResponseProfile } from "../middleware/responseFormatter.js";

import { createEnvReader, defaultEnvSource } from "@mcp/core";

/**
 * The one env reader for this server. The four `*FromEnv` helpers below used to
 * be hand-copied here and in the sibling servers; they now delegate to
 * @mcp/core, which is the only module in the platform permitted to touch
 * `process.env`.
 */
const env = createEnvReader(defaultEnvSource());

/** Per-profile character caps for the long `message`/`exception` fields. Infinity = no cap; exception 0 = drop. */
export type FieldCaps = { message: number; exception: number };

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
  /** Retry attempts for transient HTTP failures (network / 5xx / 429). 0 disables retries. */
  maxRetries: number;
  /** Explicit column projection for log/trace queries; empty = SELECT * (schema-safe default). */
  logColumns: string[];
  /** Per-profile caps applied to normalized log fields before serialization. */
  fieldCaps: Record<ResponseProfile, FieldCaps>;
};

function numberFromEnv(key: string, fallback: number): number {
  return env.positiveNumber(key, fallback);
}

function stringFromEnv(key: string, fallback: string): string {
  return env.string(key, fallback);
}

/** Like numberFromEnv but permits 0 (unlike lookback/size which must be positive). */
function nonNegFromEnv(key: string, fallback: number): number {
  return env.nonNegativeInteger(key, fallback);
}

/** Parse a comma-separated identifier list; drops blanks. Empty result = no projection. */
function csvFromEnv(key: string): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildFieldCaps(): Record<ResponseProfile, FieldCaps> {
  const INF = Number.POSITIVE_INFINITY;
  return {
    nano: { message: nonNegFromEnv("OBSERVE_MSG_MAX_NANO", 200), exception: nonNegFromEnv("OBSERVE_EXC_MAX_NANO", 0) },
    compact: { message: nonNegFromEnv("OBSERVE_MSG_MAX_COMPACT", 400), exception: nonNegFromEnv("OBSERVE_EXC_MAX_COMPACT", 800) },
    standard: { message: nonNegFromEnv("OBSERVE_MSG_MAX_STANDARD", 2000), exception: nonNegFromEnv("OBSERVE_EXC_MAX_STANDARD", 6000) },
    verbose: { message: nonNegFromEnv("OBSERVE_MSG_MAX_VERBOSE", INF), exception: nonNegFromEnv("OBSERVE_EXC_MAX_VERBOSE", INF) }
  };
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
  const maxRetries = nonNegFromEnv("OBSERVE_MAX_RETRIES", 2);
  const logColumns = csvFromEnv("OBSERVE_LOG_COLUMNS");
  const fieldCaps = buildFieldCaps();

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
    timeoutMs,
    maxRetries,
    logColumns,
    fieldCaps
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
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    logColumns: config.logColumns.length > 0 ? config.logColumns : "*"
  };
}

/** Mask a secret, keeping only a short prefix so it can be recognized but not reused. */
function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  const [scheme] = value.split(" ", 1);
  if (scheme && scheme.toLowerCase() === "basic") {
    return "Basic ****";
  }
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}****`;
}
