import { Pool } from "pg";

import {
  assertEnvironment,
  buildEnvironmentRegistry,
  canonicalEnvName,
  maskConnectionInfo,
  type EnvironmentConfig,
  type EnvironmentRegistry
} from "../config/environments.js";

export interface ConnectionManagerOptions {
  poolMax: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
}

/**
 * Owns one lazily-created pg Pool per environment. Replaces the previous single
 * module-level `pool`. Pools are created on first use for a given environment so
 * configuring three environments does not open three connection pools up front.
 */
export class ConnectionManager {
  private readonly registry: EnvironmentRegistry;
  private readonly options: ConnectionManagerOptions;
  private readonly pools = new Map<string, Pool>();

  constructor(options: ConnectionManagerOptions, registry?: EnvironmentRegistry) {
    this.options = options;
    this.registry = registry ?? buildEnvironmentRegistry();
  }

  get defaultEnvironment(): string {
    return this.registry.defaultEnvironment;
  }

  resolveEnvName(name?: string): string {
    // Canonicalize so .NET-style names (e.g. "Production", "development") map to the
    // same keys the registry was built with ("prod", "dev"), instead of failing as
    // UNKNOWN_ENVIRONMENT or — worse — bypassing the prod read-only demotion.
    return name && name.trim().length > 0 ? canonicalEnvName(name) : this.registry.defaultEnvironment;
  }

  getEnvironment(name?: string, requireWrite = false): EnvironmentConfig {
    return assertEnvironment(this.registry, this.resolveEnvName(name), requireWrite);
  }

  getPool(name?: string, requireWrite = false): Pool {
    const env = this.getEnvironment(name, requireWrite);
    const existing = this.pools.get(env.name);
    if (existing) {
      return existing;
    }
    const pool = new Pool({
      ...env.poolConfig,
      max: this.options.poolMax,
      idleTimeoutMillis: this.options.idleTimeoutMs,
      statement_timeout: this.options.statementTimeoutMs,
      application_name: this.options.applicationName
    });
    this.pools.set(env.name, pool);
    return pool;
  }

  list(): Array<{
    name: string;
    capabilities: EnvironmentConfig["capabilities"];
    source: EnvironmentConfig["source"];
    sourceDetail: string;
    connection: ReturnType<typeof maskConnectionInfo>;
    isDefault: boolean;
  }> {
    return [...this.registry.environments.values()].map((env) => ({
      name: env.name,
      capabilities: env.capabilities,
      source: env.source,
      sourceDetail: env.sourceDetail,
      connection: maskConnectionInfo(env),
      isDefault: env.name === this.registry.defaultEnvironment
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
