import process from "node:process";

import { PolicyViolationError } from "../middleware/errors.js";
import type { ResponseProfile } from "../middleware/responseFormatter.js";

import { createEnvReader, defaultEnvSource } from "@mcp/core";

/**
 * The one env reader for this server. The four `*FromEnv` helpers below used to
 * be hand-copied here and in the sibling servers; they now delegate to
 * @mcp/core, which is the only module in the platform permitted to touch
 * `process.env`.
 *
 * Connection settings are NOT here — they are per-environment and live in
 * `./environments.ts`. This module owns only what is global to the process:
 * result/window limits, response field caps, the namespace-classification
 * prefixes, and the shared credential fallback.
 */
const env = createEnvReader(defaultEnvSource());

/** Per-profile character caps for the long `message`/`exception` fields. Infinity = no cap; exception 0 = drop. */
export type FieldCaps = { message: number; exception: number };

/**
 * Process-wide limits, shared by every environment.
 *
 * Deliberately not per-environment: making these per-env would multiply the
 * configuration surface by the number of environments to solve a problem nobody
 * has — a caller who wants a bigger page passes `limit`, which is what the
 * clamps are for.
 */
export type ObserveLimits = {
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
  /** Namespace prefixes treated as first-party application code (the code↔log link). */
  appNamespacePrefixes: string[];
  /** Namespace prefixes treated as framework/library noise. */
  frameworkNamespacePrefixes: string[];
};

function numberFromEnv(key: string, fallback: number): number {
  return env.positiveNumber(key, fallback);
}

/** Like numberFromEnv but permits 0 (unlike lookback/size which must be positive). */
function nonNegFromEnv(key: string, fallback: number): number {
  return env.nonNegativeInteger(key, fallback);
}

/** Parse a comma-separated list; drops blanks. Empty/unset yields `fallback`. */
function csvFromEnv(key: string, fallback: string[] = []): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Serilog's `SourceContext` is exported as the OTLP instrumentation scope name,
 * which for .NET is the fully-qualified type name. That makes it the one field in
 * a log row that points at code — but only after the framework noise is removed:
 * ranked by volume, the top scopes are all `Microsoft.AspNetCore.*` /
 * `Microsoft.EntityFrameworkCore.*` plumbing, which identifies nothing.
 *
 * Both lists are prefixes, matched in TypeScript rather than in SQL — a `NOT LIKE`
 * chain assembled from environment-supplied strings would put config values into
 * a query, which this server does not do anywhere else.
 */
const DEFAULT_APP_NAMESPACE_PREFIXES = [
  "CRM.",
  "SS.",
  "SSNet.",
  "WEC",
  "WeCRM.",
  "CommunicationHub.",
  "OSB.",
  "Bmw.",
  "WecSocialAds."
];

/**
 * Every prefix past `OpenTelemetry` was added from a real 7-day capture: these are
 * the third-party libraries that actually emit log scopes in these systems and
 * would otherwise be reported as first-party namespace roots. `Ocelot` (gateway),
 * `Rebus` (bus) and `Elsa` (workflow engine) are the ones most likely to be
 * mistaken for application code, because nothing about the name says "vendor".
 */
const DEFAULT_FRAMEWORK_NAMESPACE_PREFIXES = [
  "Microsoft.",
  "System.",
  "Npgsql",
  "MassTransit",
  "Quartz",
  "Hangfire",
  "Serilog",
  "OpenTelemetry",
  "Rebus",
  "Ocelot",
  "Elsa.",
  "Grpc.",
  "Amazon.",
  "AWSSDK",
  "Azure.",
  "Polly",
  "StackExchange.",
  "MediatR",
  "FluentValidation",
  "Refit",
  "IdentityServer",
  "FFmpeg."
];

function buildFieldCaps(): Record<ResponseProfile, FieldCaps> {
  const INF = Number.POSITIVE_INFINITY;
  return {
    nano: { message: nonNegFromEnv("OBSERVE_MSG_MAX_NANO", 200), exception: nonNegFromEnv("OBSERVE_EXC_MAX_NANO", 0) },
    compact: { message: nonNegFromEnv("OBSERVE_MSG_MAX_COMPACT", 400), exception: nonNegFromEnv("OBSERVE_EXC_MAX_COMPACT", 800) },
    standard: { message: nonNegFromEnv("OBSERVE_MSG_MAX_STANDARD", 2000), exception: nonNegFromEnv("OBSERVE_EXC_MAX_STANDARD", 6000) },
    verbose: { message: nonNegFromEnv("OBSERVE_MSG_MAX_VERBOSE", INF), exception: nonNegFromEnv("OBSERVE_EXC_MAX_VERBOSE", INF) }
  };
}

/** Per-environment credential override; any field may be absent. */
export type AuthSource = {
  authBasic?: string;
  username?: string;
  password?: string;
};

/**
 * Turn one credential source into a Basic auth header, or null if it holds nothing.
 * Within a source: a pre-encoded token wins over a username/password pair.
 */
function headerFrom(source: AuthSource): string | null {
  const raw = source.authBasic?.trim();
  if (raw) {
    return raw.toLowerCase().startsWith("basic ") ? raw : `Basic ${raw}`;
  }
  const user = source.username?.trim();
  const pass = source.password;
  if (user && pass !== undefined && pass !== "") {
    return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  }
  return null;
}

/** True when a source names any credential field at all, complete or not. */
function declaresCredential(source: AuthSource): boolean {
  return Boolean(source.authBasic?.trim() || source.username?.trim() || (source.password ?? "").trim());
}

/**
 * Build the Basic auth header for an environment.
 *
 * Precedence is per-source, not per-field: the environment's own credentials are
 * resolved **completely** before the process-wide variables are consulted at all.
 * Mixing the two — checking every `authBasic` first, then every username/password —
 * looks equivalent and is not: a shared `OBSERVE_AUTH_BASIC` would then beat an
 * environment's explicit username/password, so the one environment configured to
 * use a different account would silently authenticate as the shared one.
 *
 * Within a source, a pre-encoded token beats a username/password pair. Credentials
 * are never logged, and `maskEnvironment` never selects the resulting header.
 *
 * Per-environment credentials exist so one org can use a different account; the
 * common case is one account for every org, which is what the fallback keeps out
 * of every `OBSERVE_ENV_*` value.
 *
 * An INCOMPLETE per-environment credential is an error, not a reason to fall back.
 * `username=prod_reader` with the password forgotten would otherwise start cleanly
 * and query that org with the shared account — the same silent wrong-account
 * authentication the per-source precedence above exists to prevent, arrived at from
 * the other direction. Someone who named an account for one environment meant it.
 */
export function resolveAuthHeader(source: AuthSource = {}, envName?: string): string {
  const perEnvironment = headerFrom(source);
  if (perEnvironment) {
    return perEnvironment;
  }
  if (declaresCredential(source)) {
    const where = envName ? `environment '${envName}'` : "this environment";
    throw new PolicyViolationError(
      "config_error",
      `Incomplete credentials for ${where}: set username AND password together, or use authBasic. ` +
        "Refusing to fall back to the shared OBSERVE_USERNAME/OBSERVE_PASSWORD, which would authenticate as a different account than the one named here."
    );
  }

  const shared = headerFrom({
    authBasic: process.env.OBSERVE_AUTH_BASIC,
    username: process.env.OBSERVE_USERNAME,
    password: process.env.OBSERVE_PASSWORD
  });
  if (shared) {
    return shared;
  }

  throw new PolicyViolationError(
    "config_error",
    `No OpenObserve credentials configured${envName ? ` for environment '${envName}'` : ""}. Set OBSERVE_AUTH_BASIC, or OBSERVE_USERNAME + OBSERVE_PASSWORD.`
  );
}

export function loadLimits(): ObserveLimits {
  const defaultSize = numberFromEnv("OBSERVE_DEFAULT_SIZE", 100);
  const maxSize = Math.max(defaultSize, numberFromEnv("OBSERVE_MAX_SIZE", 1000));
  const defaultLookbackMs = numberFromEnv("OBSERVE_DEFAULT_LOOKBACK_MS", 3_600_000);
  const maxLookbackMs = Math.max(defaultLookbackMs, numberFromEnv("OBSERVE_MAX_LOOKBACK_MS", 604_800_000));

  return {
    defaultSize,
    maxSize,
    defaultLookbackMs,
    maxLookbackMs,
    timeoutMs: numberFromEnv("OBSERVE_TIMEOUT_MS", 30_000),
    maxRetries: nonNegFromEnv("OBSERVE_MAX_RETRIES", 2),
    logColumns: csvFromEnv("OBSERVE_LOG_COLUMNS"),
    fieldCaps: buildFieldCaps(),
    appNamespacePrefixes: csvFromEnv("OBSERVE_APP_NAMESPACE_PREFIXES", DEFAULT_APP_NAMESPACE_PREFIXES),
    frameworkNamespacePrefixes: csvFromEnv(
      "OBSERVE_FRAMEWORK_NAMESPACE_PREFIXES",
      DEFAULT_FRAMEWORK_NAMESPACE_PREFIXES
    )
  };
}

/** A non-secret view of the process limits, for the startup log. */
export function describeLimits(limits: ObserveLimits): Record<string, unknown> {
  return {
    defaultSize: limits.defaultSize,
    maxSize: limits.maxSize,
    defaultLookbackMs: limits.defaultLookbackMs,
    maxLookbackMs: limits.maxLookbackMs,
    timeoutMs: limits.timeoutMs,
    maxRetries: limits.maxRetries,
    logColumns: limits.logColumns.length > 0 ? limits.logColumns : "*"
  };
}
