/**
 * The one place sqlserver-mcp reads configuration.
 *
 * Dependency rule 10: `process.env` is touched under `config/` and nowhere else in this server.
 * `guard:deps` reports a violation anywhere else, so the loaded config is passed down rather than
 * re-read.
 */

import { createEnvReader, defaultEnvSource, type EnvReader } from "@mcp/core";

import {
  buildEnvironmentRegistry,
  canonicalEnvName,
  maskConnection,
  type EnvironmentRegistry
} from "./environments.js";

let reader: EnvReader | undefined;

/**
 * The environment snapshot, taken on first read rather than at import.
 *
 * `defaultEnvSource()` copies `process.env`, so *when* it is called decides what the server sees.
 * At module scope it runs during the entry point's import phase, before a single statement of
 * `index.ts` has executed. `postgres-mcp` shipped that bug (PG-ENV-002) and it silently turned off
 * its write gate. Reading lazily costs nothing and removes the ordering question. Keep it lazy.
 */
function env(): EnvReader {
  return (reader ??= createEnvReader(defaultEnvSource()));
}

/** Bounds every query is held to, read once at startup. */
export interface QueryLimits {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  /** Most catalogs one `run_read_query` call may fan out across. */
  readonly maxFanout: number;
}

export interface PoolLimits {
  /** Connections per (environment, database) pool. */
  readonly poolMax: number;
  /**
   * Most pools held open at once, across every environment and catalog.
   *
   * This server addresses a *set* of catalogs on one instance — dozens of them in the deployment it
   * was designed against — so an unbounded pool map is a connection leak with a business name.
   * Reaching the cap evicts the least recently used pool.
   */
  readonly maxPools: number;
  readonly idleTimeoutMs: number;
}

export interface ExecConfig {
  readonly enabled: boolean;
  /** Glob patterns over `schema.routine`. Empty = no narrowing (the flag alone gates it). */
  readonly allowlist: readonly string[];
  readonly timeoutMs: number;
}

export interface SqlserverConfig {
  readonly registry: EnvironmentRegistry;
  /** Environments whose connection string could not be parsed, reported by `list_environments`. */
  readonly invalidEnvironments: ReadonlyArray<{ name: string; sourceDetail: string; reason: string }>;
  readonly allowedEnvironments: readonly string[];
  /** Catalogs reachable at all. Empty = every catalog the login can see. */
  readonly allowedDatabases: readonly string[];
  /** Catalogs where `execute_routine` is refused unconditionally. */
  readonly readonlyDatabases: readonly string[];
  readonly limits: QueryLimits;
  readonly pools: PoolLimits;
  readonly exec: ExecConfig;
}

/**
 * Fail fast on missing configuration.
 *
 * A server that starts with half a config and fails on the first call is harder to diagnose than
 * one that refuses to start.
 */
export function loadConfig(): SqlserverConfig {
  const reader_ = env();
  const { registry, invalid } = buildEnvironmentRegistry(reader_);

  if (registry.environments.size === 0) {
    const detail =
      invalid.length > 0
        ? ` The following could not be parsed: ${invalid
            .map((entry) => `${entry.sourceDetail} (${entry.reason})`)
            .join("; ")}`
        : "";
    throw new Error(
      "No connection source. Set SQLSERVER_CONNECTION or one of SQLSERVER_ENV_* — see .env.example." +
        detail
    );
  }

  return {
    registry,
    invalidEnvironments: invalid,
    allowedEnvironments: reader_.list("SQLSERVER_ALLOWED_ENVIRONMENTS").map(canonicalEnvName),
    allowedDatabases: reader_.list("SQLSERVER_ALLOWED_DATABASES"),
    readonlyDatabases: reader_.list("SQLSERVER_READONLY_DATABASES"),
    limits: {
      defaultLimit: reader_.positiveNumber("SQLSERVER_DEFAULT_LIMIT", 500),
      maxLimit: reader_.positiveNumber("SQLSERVER_MAX_LIMIT", 2000),
      defaultTimeoutMs: reader_.positiveNumber("SQLSERVER_DEFAULT_TIMEOUT_MS", 30_000),
      maxTimeoutMs: reader_.positiveNumber("SQLSERVER_MAX_TIMEOUT_MS", 60_000),
      maxFanout: reader_.positiveNumber("SQLSERVER_MAX_FANOUT", 25)
    },
    pools: {
      poolMax: reader_.positiveNumber("SQLSERVER_POOL_MAX", 5),
      maxPools: reader_.positiveNumber("SQLSERVER_MAX_POOLS", 12),
      idleTimeoutMs: reader_.positiveNumber("SQLSERVER_POOL_IDLE_TIMEOUT_MS", 30_000)
    },
    exec: {
      // strictFlag, not boolean: exactly "true" or "1". Widening a gate that runs arbitrary
      // stored procedures is not a thing to do by accident.
      enabled: reader_.strictFlag("SQLSERVER_EXEC_ENABLED"),
      allowlist: reader_.list("SQLSERVER_EXEC_ALLOWLIST"),
      timeoutMs: reader_.positiveNumber("SQLSERVER_EXEC_TIMEOUT_MS", 120_000)
    }
  };
}

/**
 * Non-secret echo for `health_check` and the start-up log.
 *
 * Never return a credential from here: the value reaches stderr and the health payload. Report
 * whether a secret is *present*, not what it is — that is what `maskConnection` is for.
 */
export function describeConfig(config: SqlserverConfig): Record<string, unknown> {
  return {
    environments: [...config.registry.environments.keys()].sort(),
    defaultEnvironment: config.registry.defaultEnvironment,
    invalidEnvironmentCount: config.invalidEnvironments.length,
    allowedEnvironments: config.allowedEnvironments.length > 0 ? config.allowedEnvironments : "(all)",
    allowedDatabases: config.allowedDatabases.length > 0 ? config.allowedDatabases : "(all visible)",
    readonlyDatabases: config.readonlyDatabases,
    execEnabled: config.exec.enabled,
    execAllowlist: config.exec.allowlist.length > 0 ? config.exec.allowlist : "(no narrowing)",
    limits: config.limits,
    defaultConnection: maskConnection(
      (
        config.registry.environments.get(config.registry.defaultEnvironment) ??
        [...config.registry.environments.values()][0]
      )!.settings
    )
  };
}
