import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { PoolConfig } from "pg";

import { PolicyViolationError } from "../middleware/errors.js";
import { resolveAliases } from "./aliases.js";

export type EnvCapability = "read" | "write";

export interface EnvironmentConfig {
  /** Normalized environment name, e.g. "dev" | "staging" | "prod" | "default". */
  name: string;
  connectionString: string;
  poolConfig: PoolConfig;
  capabilities: EnvCapability[];
  source: "env" | "appsettings" | "legacy";
  /** env var name or appsettings file path the connection came from. */
  sourceDetail: string;
}

export interface EnvironmentRegistry {
  environments: Map<string, EnvironmentConfig>;
  defaultEnvironment: string;
}

/** Map common .NET environment names onto our short canonical names. */
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

/**
 * Parse a connection string into pg PoolConfig.
 * Accepts both a postgres:// URI and the Npgsql-style `Server=...;Database=...;` format.
 * (Moved out of index.ts so every environment is parsed identically.)
 */
export function parseConnection(raw: string): PoolConfig {
  const trimmed = raw.trim();

  // URI mode: postgresql://user:pass@host:5432/db
  if (/^postgres(ql)?:\/\//i.test(trimmed)) {
    return { connectionString: trimmed };
  }

  // Npgsql-style mode: Server=...;Port=...;Database=...;Username=...;Password=...;
  const kv: Record<string, string> = {};
  for (const part of trimmed.split(";")) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    const idx = item.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = item.slice(0, idx).trim().toLowerCase();
    const value = item.slice(idx + 1).trim();
    kv[key] = value;
  }

  const host = kv.server ?? kv.host;
  const database = kv.database;
  const user = kv.username ?? kv.user ?? kv["user id"] ?? kv.userid ?? kv.uid;
  const password = kv.password ?? kv.pwd;
  const portRaw = kv.port;
  const port = portRaw ? Number(portRaw) : undefined;

  if (!host || !database || !user) {
    throw new Error(
      "Connection string is missing required fields. Provide either postgres:// URI or Server/Port/Database/Username format."
    );
  }

  return {
    host,
    database,
    user,
    password,
    ...(Number.isFinite(port) ? { port } : {})
  };
}

/** Pull `ConnectionStrings[connectionName]` out of a parsed appsettings object. */
function readConnectionFromAppsettings(parsed: unknown, connectionName: string): string | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const cs = (parsed as Record<string, unknown>).ConnectionStrings;
  if (!cs || typeof cs !== "object") {
    return undefined;
  }
  const value = (cs as Record<string, unknown>)[connectionName];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Derive the env name from an appsettings file name: appsettings.Staging.json → staging. */
function envNameFromAppsettingsFile(fileName: string): string {
  const match = /^appsettings(?:\.([^.]+))?\.json$/i.exec(fileName);
  if (!match) {
    return "";
  }
  return match[1] ? canonicalEnvName(match[1]) : "default";
}

/**
 * Scan each allowlisted root for appsettings*.json files and extract the
 * connection string named `connectionName`. Non-recursive (one level per root) —
 * .NET keeps appsettings next to the startup project. Failures are skipped silently
 * (a missing/gitignored file just means "no environment from here").
 */
function discoverFromAppsettings(
  roots: string[],
  connectionName: string
): Map<string, { connectionString: string; filePath: string }> {
  const result = new Map<string, { connectionString: string; filePath: string }>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const envName = envNameFromAppsettingsFile(entry);
      if (!envName) {
        continue;
      }
      const filePath = path.join(root, entry);
      let connectionString: string | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        connectionString = readConnectionFromAppsettings(parsed, connectionName);
      } catch {
        continue;
      }
      if (!connectionString) {
        continue;
      }
      // First file wins per env; appsettings.{Env}.json is more specific than base.
      if (!result.has(envName)) {
        result.set(envName, { connectionString, filePath });
      }
    }
  }

  return result;
}

/** Collect POSTGRES_ENV_<NAME> overrides from the environment. */
function discoverFromEnvVars(): Map<string, { connectionString: string; varName: string }> {
  const result = new Map<string, { connectionString: string; varName: string }>();
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^POSTGRES_ENV_(.+)$/.exec(key);
    if (!match || !value || value.trim().length === 0) {
      continue;
    }
    const envName = canonicalEnvName(match[1]);
    result.set(envName, { connectionString: value.trim(), varName: key });
  }
  return result;
}

/**
 * Build the multi-environment registry from (in priority order):
 *   1. POSTGRES_ENV_<NAME> env vars (override everything)
 *   2. appsettings*.json under POSTGRES_APPSETTINGS_ROOTS
 *   3. legacy POSTGRES_CONNECTION (single-env backward compatibility)
 *
 * Writability is governed by POSTGRES_WRITABLE_ENVIRONMENTS; "prod" is force-demoted to
 * read-only regardless of configuration.
 */
export function buildEnvironmentRegistry(): EnvironmentRegistry {
  // Idempotent, and called here as well as from `index.ts` on purpose: this is the one function
  // that turns "no variables I recognise" into a thrown startup error, so it must not depend on
  // having been reached through the entry point. A test importing it directly gets the same
  // alias handling a real boot does.
  resolveAliases();

  const connectionName = (process.env.POSTGRES_CONNECTION_NAME ?? "CommunicationHubDb").trim();
  const appsettingsRoots = splitCsv(process.env.POSTGRES_APPSETTINGS_ROOTS).map((p) => path.resolve(p));

  const fromAppsettings = discoverFromAppsettings(appsettingsRoots, connectionName);
  const fromEnvVars = discoverFromEnvVars();

  const environments = new Map<string, EnvironmentConfig>();

  const allowed = splitCsv(process.env.POSTGRES_ALLOWED_ENVIRONMENTS).map(canonicalEnvName);
  const allowedSet = allowed.length > 0 ? new Set(allowed) : null;

  // Writable set defaults to dev + staging (+ the legacy single-connection "default"
  // env) when not specified. Without "default" here, a legacy POSTGRES_CONNECTION-only
  // setup could never write even with POSTGRES_WRITE_ENABLED=true. "prod" is still
  // force-demoted to read-only below regardless of this set.
  const writableRaw = process.env.POSTGRES_WRITABLE_ENVIRONMENTS;
  const writable = new Set(
    (writableRaw === undefined ? ["dev", "staging", "default"] : splitCsv(writableRaw)).map(canonicalEnvName)
  );

  const register = (
    name: string,
    connectionString: string,
    source: EnvironmentConfig["source"],
    sourceDetail: string
  ): void => {
    if (allowedSet && !allowedSet.has(name)) {
      return;
    }
    // prod is never writable, no matter what POSTGRES_WRITABLE_ENVIRONMENTS says.
    const canWrite = name !== "prod" && writable.has(name);
    const capabilities: EnvCapability[] = canWrite ? ["read", "write"] : ["read"];
    environments.set(name, {
      name,
      connectionString,
      poolConfig: parseConnection(connectionString),
      capabilities,
      source,
      sourceDetail
    });
  };

  // appsettings first (lower priority), then env vars override.
  for (const [name, info] of fromAppsettings) {
    register(name, info.connectionString, "appsettings", info.filePath);
  }
  for (const [name, info] of fromEnvVars) {
    register(name, info.connectionString, "env", info.varName);
  }

  // Legacy single-connection fallback keeps the original behavior working unchanged.
  if (environments.size === 0) {
    const legacy = process.env.POSTGRES_CONNECTION;
    if (!legacy) {
      throw new Error(
        "No database environments configured. Set POSTGRES_CONNECTION, or POSTGRES_ENV_<NAME>, or POSTGRES_APPSETTINGS_ROOTS."
      );
    }
    register("default", legacy, "legacy", "POSTGRES_CONNECTION");
  } else if (process.env.POSTGRES_CONNECTION && !environments.has("default")) {
    // Honor the legacy var as an explicit "default" env alongside discovered ones.
    register("default", process.env.POSTGRES_CONNECTION, "legacy", "POSTGRES_CONNECTION");
  }

  if (environments.size === 0) {
    throw new Error("No database environments matched POSTGRES_ALLOWED_ENVIRONMENTS.");
  }

  // Resolve default environment.
  const requestedDefault = process.env.POSTGRES_DEFAULT_ENVIRONMENT
    ? canonicalEnvName(process.env.POSTGRES_DEFAULT_ENVIRONMENT)
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

/** Throw a PolicyViolationError unless the named env exists and (optionally) is writable. */
export function assertEnvironment(
  registry: EnvironmentRegistry,
  name: string,
  requireWrite = false
): EnvironmentConfig {
  const env = registry.environments.get(name);
  if (!env) {
    const known = [...registry.environments.keys()].join(", ");
    throw new PolicyViolationError(
      "UNKNOWN_ENVIRONMENT",
      `Environment '${name}' is not configured. Known environments: ${known}.`
    );
  }
  if (requireWrite && !env.capabilities.includes("write")) {
    throw new PolicyViolationError(
      "ENVIRONMENT_READ_ONLY",
      `Environment '${name}' is read-only. Writes are only permitted on: ${
        [...registry.environments.values()]
          .filter((e) => e.capabilities.includes("write"))
          .map((e) => e.name)
          .join(", ") || "(none)"
      }.`
    );
  }
  return env;
}

/** Hide credentials when echoing connection info back to the caller. */
export function maskConnectionInfo(config: EnvironmentConfig): {
  host: string | null;
  database: string | null;
  user: string | null;
} {
  const pc = config.poolConfig;
  if (pc.connectionString) {
    try {
      const url = new URL(pc.connectionString);
      return {
        host: url.hostname || null,
        database: url.pathname.replace(/^\//, "") || null,
        user: url.username || null
      };
    } catch {
      return { host: null, database: null, user: null };
    }
  }
  return {
    host: pc.host ?? null,
    database: pc.database ?? null,
    user: pc.user ?? null
  };
}
