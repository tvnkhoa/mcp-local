/**
 * observe-mcp's multi-environment registry.
 *
 * Before this module the server was single-environment: one flat set of
 * `OBSERVE_BASE_URL` / `OBSERVE_ORG` / `OBSERVE_LOG_STREAM` vars produced one
 * client, so querying a second OpenObserve org meant registering `dist/index.js`
 * a second time in the agent config with a near-duplicate env block. That split
 * the tool namespace and duplicated the credentials.
 *
 * Now a single process holds a map of environments, and every tool takes an
 * optional `environment` argument. Modelled on `postgres-mcp`'s
 * `config/environments.ts` — same ascending-priority discovery, the same
 * allowlist-filters-at-registration rule, the same validate-the-requested-default
 * fallback chain, and the same habit of recording `source` + `sourceDetail` on
 * every entry so `list_environments` can say where a value came from.
 *
 * Unlike postgres there is no write capability to gate: this server is read-only,
 * so there is no analogue of `POSTGRES_WRITABLE_ENVIRONMENTS` or its prod demotion.
 */

import process from "node:process";

import { PolicyViolationError } from "../middleware/errors.js";
import { resolveAuthHeader, type AuthSource } from "./index.js";

export interface ObserveEnvironment {
  /** Normalized environment name, e.g. "ssdev_au" | "dev" | "prod" | "default". */
  name: string;
  baseUrl: string;
  org: string;
  logStream: string;
  traceStream: string;
  /** True only when a traces stream was set explicitly (i.e. not the logs-stream fallback). */
  traceStreamConfigured: boolean;
  /**
   * Ready-to-use HTTP Authorization header value. Never logged and never echoed:
   * `maskEnvironment` omits it structurally rather than stripping it.
   */
  authHeader: string;
  source: "flat" | "env-family";
  /** The env var name this environment came from. */
  sourceDetail: string;
}

export interface EnvironmentRegistry {
  environments: Map<string, ObserveEnvironment>;
  defaultEnvironment: string;
}

/**
 * Map common .NET / deployment environment names onto short canonical ones, and
 * lowercase everything else. Project-specific names (`ssdev_au`,
 * `wecrm_au_prod`) pass through unchanged apart from case.
 */
export function canonicalEnvName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "development" || lower === "dev") {
    return "dev";
  }
  if (lower === "staging" || lower === "stage" || lower === "stg") {
    return "staging";
  }
  if (lower === "production" || lower === "prod") {
    return "prod";
  }
  return lower;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The OBSERVE_ENV_<NAME> spec parser
// ---------------------------------------------------------------------------

type ParsedSpec = {
  baseUrl?: string;
  org?: string;
  logStream?: string;
  traceStream?: string;
  username?: string;
  password?: string;
  authBasic?: string;
};

/**
 * Accepted spec keys, keyed by their lowercased form. Both camel and snake
 * spellings are accepted because this value is hand-written into an agent config
 * and there is no reason to be strict about which convention the author used.
 */
const SPEC_KEYS: Readonly<Record<string, keyof ParsedSpec>> = {
  baseurl: "baseUrl",
  base_url: "baseUrl",
  url: "baseUrl",
  org: "org",
  organization: "org",
  orgid: "org",
  org_id: "org",
  logstream: "logStream",
  log_stream: "logStream",
  stream: "logStream",
  tracestream: "traceStream",
  trace_stream: "traceStream",
  username: "username",
  password: "password",
  authbasic: "authBasic",
  auth_basic: "authBasic"
};

const SPEC_KEY_HELP = "baseUrl, org, logStream, traceStream, username, password, authBasic";

/**
 * Parse one `OBSERVE_ENV_<NAME>` value: `baseUrl=...;org=...;logStream=...`.
 *
 * Each pair is split on its FIRST `=` only. A URL contains `:` and `//` but
 * never `=`, so `baseUrl=https://host:10443` survives intact; splitting on every
 * `=` would corrupt any value that contained one.
 *
 * An unrecognized key throws rather than being ignored: a typo'd `logstrem=` that
 * silently produced an environment with no stream would surface much later as a
 * confusing query failure.
 */
export function parseEnvironmentSpec(value: string, varName: string): ParsedSpec {
  const spec: ParsedSpec = {};

  for (const part of value.split(";")) {
    const item = part.trim();
    if (!item) {
      // Tolerate a trailing or doubled ";".
      continue;
    }
    const idx = item.indexOf("=");
    if (idx <= 0) {
      throw new PolicyViolationError(
        "config_error",
        `${varName}: "${item}" is not a key=value pair. Expected e.g. baseUrl=https://host:10443;org=abc;logStream=my_stream.`
      );
    }
    const rawKey = item.slice(0, idx).trim().toLowerCase();
    const rawValue = item.slice(idx + 1).trim();
    const key = SPEC_KEYS[rawKey];
    if (!key) {
      throw new PolicyViolationError(
        "config_error",
        `${varName}: unknown key "${item.slice(0, idx).trim()}". Accepted keys: ${SPEC_KEY_HELP}.`
      );
    }
    if (rawValue === "") {
      throw new PolicyViolationError("config_error", `${varName}: key "${rawKey}" has an empty value.`);
    }
    spec[key] = rawValue;
  }

  return spec;
}

/**
 * Control variables that must never be mistaken for an environment. The family
 * matcher is `/^OBSERVE_ENV_(.+)$/`, so a control var named `OBSERVE_ENV_NAME`
 * would silently register an environment called "name". The real control vars are
 * deliberately named outside the `OBSERVE_ENV_` namespace (`OBSERVE_PRIMARY_ENV_NAME`,
 * `OBSERVE_DEFAULT_ENVIRONMENT`, `OBSERVE_ALLOWED_ENVIRONMENTS`); this set is a
 * second line of defence for anything added later without noticing the collision.
 */
const RESERVED_ENV_SUFFIXES = new Set(["name", "names", "default", "allowed", "primary", "prefix"]);

/** Strip trailing slashes so `${baseUrl}${path}` never produces a doubled slash. */
function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/**
 * Collect the `OBSERVE_ENV_<NAME>` family from the environment.
 *
 * Two variables whose suffixes canonicalize to the same name throw rather than one
 * silently winning: `OBSERVE_ENV_PROD` and `OBSERVE_ENV_PRODUCTION` both mean `prod`
 * (likewise DEV/DEVELOPMENT, STAGE/STAGING/STG, or any two spellings differing only
 * in case). `Object.entries(process.env)` has no guaranteed order, so the survivor
 * would not even be predictable — an operator who renamed a variable and left the old
 * one set would lose an entire environment, sometimes. This module already refuses a
 * typo'd spec KEY; a colliding environment NAME deserves the same treatment.
 */
function discoverFromEnvFamily(): Map<string, { spec: ParsedSpec; varName: string }> {
  const result = new Map<string, { spec: ParsedSpec; varName: string }>();
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^OBSERVE_ENV_(.+)$/.exec(key);
    if (!match || !value || value.trim().length === 0) {
      continue;
    }
    const suffix = match[1];
    if (RESERVED_ENV_SUFFIXES.has(suffix.trim().toLowerCase())) {
      continue;
    }
    const name = canonicalEnvName(suffix);
    const clash = result.get(name);
    if (clash) {
      const [a, b] = [clash.varName, key].sort();
      throw new PolicyViolationError(
        "config_error",
        `${a} and ${b} both define environment '${name}'. Remove one — which of the two would win is not defined.`
      );
    }
    result.set(name, { spec: parseEnvironmentSpec(value.trim(), key), varName: key });
  }
  return result;
}

/** Read the legacy flat vars as an optional single environment. */
function discoverFromFlatVars(): ParsedSpec | null {
  const baseUrl = process.env.OBSERVE_BASE_URL?.trim();
  const org = process.env.OBSERVE_ORG?.trim();
  const logStream = process.env.OBSERVE_LOG_STREAM?.trim();
  const traceStream = process.env.OBSERVE_TRACE_STREAM?.trim();

  if (!baseUrl && !org && !logStream) {
    return null;
  }
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(org ? { org } : {}),
    ...(logStream ? { logStream } : {}),
    ...(traceStream ? { traceStream } : {})
  };
}

/**
 * Build the environment registry from (in ascending priority):
 *   1. the flat `OBSERVE_BASE_URL` / `OBSERVE_ORG` / `OBSERVE_LOG_STREAM` trio,
 *      registered under `OBSERVE_PRIMARY_ENV_NAME` (default "default")
 *   2. the `OBSERVE_ENV_<NAME>` family
 *
 * Membership is filtered by `OBSERVE_ALLOWED_ENVIRONMENTS`; the answering default
 * is chosen by `OBSERVE_DEFAULT_ENVIRONMENT`.
 *
 * There are deliberately NO fallback values for baseUrl / org / logStream. The
 * previous version defaulted them to a specific host, org id and stream name;
 * when that deployment moved, a misconfigured install silently queried an org
 * that no longer existed instead of failing at startup.
 */
export function buildEnvironmentRegistry(): EnvironmentRegistry {
  const environments = new Map<string, ObserveEnvironment>();

  const allowed = splitCsv(process.env.OBSERVE_ALLOWED_ENVIRONMENTS).map(canonicalEnvName);
  const allowedSet = allowed.length > 0 ? new Set(allowed) : null;

  const register = (
    name: string,
    spec: ParsedSpec,
    source: ObserveEnvironment["source"],
    sourceDetail: string
  ): void => {
    // Filter here rather than after the fact: a non-allowlisted environment must
    // not exist in the map at all, so no code path can reach it.
    if (allowedSet && !allowedSet.has(name)) {
      return;
    }

    const missing = (["baseUrl", "org", "logStream"] as const).filter((k) => !spec[k]);
    if (missing.length > 0) {
      throw new PolicyViolationError(
        "config_error",
        `Environment '${name}' (from ${sourceDetail}) is missing required ${missing.length === 1 ? "key" : "keys"}: ${missing.join(", ")}.`
      );
    }

    const authSource: AuthSource = {
      authBasic: spec.authBasic,
      username: spec.username,
      password: spec.password
    };

    const traceStreamConfigured = Boolean(spec.traceStream);
    environments.set(name, {
      name,
      baseUrl: normalizeBaseUrl(spec.baseUrl as string),
      org: spec.org as string,
      logStream: spec.logStream as string,
      traceStream: traceStreamConfigured ? (spec.traceStream as string) : (spec.logStream as string),
      traceStreamConfigured,
      authHeader: resolveAuthHeader(authSource, name),
      source,
      sourceDetail
    });
  };

  const flat = discoverFromFlatVars();
  if (flat) {
    const primaryName = canonicalEnvName(process.env.OBSERVE_PRIMARY_ENV_NAME?.trim() || "default");
    register(primaryName, flat, "flat", "OBSERVE_BASE_URL/OBSERVE_ORG/OBSERVE_LOG_STREAM");
  }

  for (const [name, info] of discoverFromEnvFamily()) {
    register(name, info.spec, "env-family", info.varName);
  }

  if (environments.size === 0) {
    // Distinguish "nothing configured" from "everything filtered out", because the
    // fix is different: set some variables, versus widen the allowlist.
    if (allowedSet) {
      throw new PolicyViolationError(
        "config_error",
        `No OpenObserve environments matched OBSERVE_ALLOWED_ENVIRONMENTS (${allowed.join(", ")}).`
      );
    }
    throw new PolicyViolationError(
      "config_error",
      "No OpenObserve environments configured. Set OBSERVE_ENV_<NAME>, or OBSERVE_BASE_URL + OBSERVE_ORG + OBSERVE_LOG_STREAM."
    );
  }

  // Validate the requested default rather than trusting it: a typo should degrade
  // to a sensible environment, not make every call fail with UNKNOWN_ENVIRONMENT.
  const requestedDefault = process.env.OBSERVE_DEFAULT_ENVIRONMENT
    ? canonicalEnvName(process.env.OBSERVE_DEFAULT_ENVIRONMENT)
    : undefined;
  let defaultEnvironment: string;
  if (requestedDefault && environments.has(requestedDefault)) {
    defaultEnvironment = requestedDefault;
  } else if (environments.has("dev")) {
    defaultEnvironment = "dev";
  } else if (environments.has("default")) {
    defaultEnvironment = "default";
  } else {
    defaultEnvironment = [...environments.keys()][0];
  }

  return { environments, defaultEnvironment };
}

/** Throw a PolicyViolationError unless the named environment exists. */
export function assertEnvironment(registry: EnvironmentRegistry, name: string): ObserveEnvironment {
  const env = registry.environments.get(name);
  if (!env) {
    const known = [...registry.environments.keys()].join(", ");
    throw new PolicyViolationError(
      "unknown_environment",
      `Environment '${name}' is not configured. Known environments: ${known}.`
    );
  }
  return env;
}

/**
 * A non-secret view of an environment, for `list_environments` and startup logs.
 *
 * The auth header is not stripped from a wider object — it is never selected, so
 * it is structurally absent from the return type and cannot be leaked by someone
 * later spreading the source object into a response.
 */
export function maskEnvironment(
  env: ObserveEnvironment,
  isDefault: boolean
): {
  name: string;
  baseUrl: string;
  org: string;
  logStream: string;
  traceStream: string;
  traceStreamConfigured: boolean;
  source: string;
  sourceDetail: string;
  isDefault: boolean;
} {
  return {
    name: env.name,
    baseUrl: env.baseUrl,
    org: env.org,
    logStream: env.logStream,
    traceStream: env.traceStream,
    traceStreamConfigured: env.traceStreamConfigured,
    source: env.source,
    sourceDetail: env.sourceDetail,
    isDefault
  };
}
