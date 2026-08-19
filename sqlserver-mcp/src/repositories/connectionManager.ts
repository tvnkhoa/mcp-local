/**
 * One connection pool per **(environment, catalog)**.
 *
 * This is the structural difference from `postgres-mcp`, which keys pools by environment alone.
 * A SQL Server instance holds many catalogs and a single login reaches all of them, so the unit of
 * work here is a catalog, not a server. Two consequences follow, and both are handled below:
 *
 *  - the catalog comes from the *call*, so pools are created on demand and keyed `env::database`;
 *  - the set of catalogs is open-ended, so the map is bounded and evicts least-recently-used.
 */

import sql from "mssql";

import { PolicyViolationError } from "../middleware/errors.js";

/** What the catalog cache remembers per database: the instance's own spelling, and its state. */
export interface CatalogInfo {
  readonly name: string;
  readonly state: string;
}
import type { PoolLimits, SqlserverConfig } from "../config/index.js";
import {
  assertEnvironment,
  canonicalEnvName,
  maskConnection,
  withDatabase,
  type EnvironmentConfig,
  type SqlConnectionSettings
} from "../config/environments.js";

/**
 * Catalog names this server will act on.
 *
 * The driver receives the name as a config field, not as statement text, so this is not the last
 * line of defence against injection. It exists because the name also reaches `QUOTENAME`-style
 * contexts in introspection filters and error messages, and because a name containing `]` or `;`
 * is far likelier to be a mistake — or an attempt — than a real catalog.
 */
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$#@.\- ]{0,127}$/;

/** Must match the worker count in `tools/queryTools.ts` — see the pool-cap floor below. */
export const MAX_FANOUT_CONCURRENCY = 4;

/** How long the per-environment catalog list is reused. Catalogs are created rarely. */
const CATALOG_CACHE_TTL_MS = 300_000;

export interface ResolvedTarget {
  readonly environment: EnvironmentConfig;
  readonly database: string;
}

export class ConnectionManager {
  private readonly config: SqlserverConfig;
  private readonly limits: PoolLimits;
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly pools = new Map<string, Promise<sql.ConnectionPool>>();
  private readonly catalogCache = new Map<
    string,
    { names: Map<string, CatalogInfo>; expiresAt: number }
  >();

  constructor(config: SqlserverConfig) {
    this.config = config;
    // Floored at the fan-out concurrency. Eviction takes from the head (least recently used) and
    // every in-flight call has just re-inserted its pool at the tail, so a cap of at least the
    // number of concurrent workers means an in-use pool can never be the one closed. Without the
    // floor an operator setting SQLSERVER_MAX_POOLS=2 would see fan-out queries fail with a
    // connection error that looks like the database's fault.
    this.limits = { ...config.pools, maxPools: Math.max(config.pools.maxPools, MAX_FANOUT_CONCURRENCY) };
  }

  get defaultEnvironment(): string {
    return this.config.registry.defaultEnvironment;
  }

  /**
   * Resolve `(environment?, database?)` against configuration and both allowlists.
   *
   * Omitting `database` means "the catalog the connection string names", which keeps every tool
   * usable without knowing anything about the instance's layout.
   */
  resolve(environment?: string, database?: string): ResolvedTarget {
    const name =
      environment !== undefined && environment.trim() !== ""
        ? canonicalEnvName(environment)
        : this.config.registry.defaultEnvironment;

    const env = assertEnvironment(this.config.registry, this.config.allowedEnvironments, name);

    const requested = database?.trim();
    if (requested === undefined || requested === "") {
      return { environment: env, database: env.settings.database };
    }

    if (!DATABASE_NAME.test(requested)) {
      throw new PolicyViolationError(
        "invalid_database_name",
        `"${requested}" is not a usable SQL Server catalog name.`
      );
    }

    const allowed = this.config.allowedDatabases;
    if (
      allowed.length > 0 &&
      !allowed.some((entry) => entry.toLowerCase() === requested.toLowerCase())
    ) {
      throw new PolicyViolationError(
        "database_not_allowed",
        `Database "${requested}" is not in SQLSERVER_ALLOWED_DATABASES.`
      );
    }

    return { environment: env, database: requested };
  }

  /**
   * Catalog names on the instance, keyed lower-case to the instance's own spelling, cached briefly
   * per environment.
   *
   * A Map rather than a Set because two callers need different halves of it: the allowlist check
   * only asks `has()`, while `find_cross_database_references` needs the real casing to echo back —
   * `sys.sql_expression_dependencies` records whatever spelling a developer typed, and handing that
   * back makes the name unusable as a `database` argument on the next call.
   *
   * Needed by the three-part-name allowlist check in `run_read_query`: `Payroll.dbo.Salaries` and
   * `dbo.Customer.Name` are the same shape, so the only way to tell a cross-catalog read from an
   * ordinary schema-qualified column is to know which names are real catalogs. Cached because that
   * check runs on every query while the answer changes about never.
   */
  async catalogNames(target: ResolvedTarget): Promise<ReadonlyMap<string, CatalogInfo>> {
    const key = target.environment.name;
    const cached = this.catalogCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.names;
    }
    const pool = await this.pool(target);
    const result = await pool
      .request()
      .query<{ name: string; state: string }>("select name, state_desc as state from sys.databases");
    const names = new Map(
      result.recordset.map((row) => [row.name.toLowerCase(), { name: row.name, state: row.state }])
    );
    this.catalogCache.set(key, { names, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
    return names;
  }

  /** True when `execute_routine` must be refused for this catalog whatever the feature flag says. */
  isReadOnlyDatabase(database: string): boolean {
    return this.config.readonlyDatabases.some(
      (entry) => entry.toLowerCase() === database.toLowerCase()
    );
  }

  async pool(target: ResolvedTarget): Promise<sql.ConnectionPool> {
    const key = `${target.environment.name}::${target.database.toLowerCase()}`;

    const existing = this.pools.get(key);
    if (existing !== undefined) {
      // Re-insert to mark it most-recently-used.
      this.pools.delete(key);
      this.pools.set(key, existing);
      return existing;
    }

    // The *promise* is cached, not the resolved pool: two concurrent fan-out branches asking for
    // the same catalog must share one connect, not race to open two pools.
    const creating = this.connect(withDatabase(target.environment.settings, target.database));
    this.pools.set(key, creating);

    try {
      await creating;
    } catch (error) {
      this.pools.delete(key);
      throw await this.explainConnectFailure(target, error);
    }

    await this.evictOverflow();
    return creating;
  }

  /**
   * Turn "login failed" into "no such catalog" when that is what it actually was.
   *
   * SQL Server answers a connect to a database that does not exist with error 4060, which the
   * driver surfaces as `ELOGIN` / `Login failed for user '…'` — the *same* code and the same shape
   * as a wrong password. So a typo'd catalog name was reported as `unauthorized`, sending the
   * caller off to check credentials that were never wrong. The message cannot tell the two apart;
   * this server can, because it already knows which catalogs exist.
   *
   * If the catalog list itself cannot be read, the login really is suspect and `unauthorized`
   * stands — that fallback is the honest answer, not a guess.
   */
  private async explainConnectFailure(target: ResolvedTarget, error: unknown): Promise<unknown> {
    if ((error as { code?: unknown } | null)?.code !== "ELOGIN") {
      return error;
    }
    try {
      const known = await this.catalogNames({
        environment: target.environment,
        database: target.environment.settings.database
      });
      const info = known.get(target.database.toLowerCase());
      if (info === undefined) {
        return new PolicyViolationError(
          "not_found",
          `No catalog named "${target.database}" on this instance. ` +
            "Catalog names are deployment-specific — call `list_databases` rather than guessing one."
        );
      }
      // An OFFLINE catalog answers ELOGIN too, and it is *in* sys.databases — so the existence
      // check above passes and the caller was still told to go check their password. Same
      // misdiagnosis as a typo'd name, one catalog over. `list_databases` already reports the
      // state; this is the same fact, said at the moment it matters.
      if (info.state !== "ONLINE") {
        return new PolicyViolationError(
          "conflict",
          `Catalog "${info.name}" is ${info.state}, so it cannot be opened. ` +
            "This is the catalog's state, not a credentials problem — `list_databases` reports it."
        );
      }
    } catch {
      // Fall through: if we cannot list catalogs, the credentials are the likelier problem.
    }
    return error;
  }

  private async connect(settings: SqlConnectionSettings): Promise<sql.ConnectionPool> {
    const pool = new sql.ConnectionPool({
      server: settings.server,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      password: settings.password,
      connectionTimeout: settings.connectTimeoutMs ?? 15_000,
      requestTimeout: this.config.limits.maxTimeoutMs,
      pool: {
        max: this.limits.poolMax,
        min: 0,
        idleTimeoutMillis: this.limits.idleTimeoutMs
      },
      options: {
        instanceName: settings.instanceName,
        // Spread rather than assign: mssql merges `options` OVER its own default
        // (`Object.assign({ encrypt: … ?? true }, config.options)`), so an explicit `undefined`
        // key would still win and switch TLS off. The key has to be absent, not undefined.
        ...(settings.encrypt === undefined ? {} : { encrypt: settings.encrypt }),
        trustServerCertificate: settings.trustServerCertificate,
        appName: settings.applicationName ?? "sqlserver-mcp",
        // Without this the driver leaves the ARITHABORT session setting at the default the
        // connection happens to get, and SQL Server compiles a *different* plan for the same query
        // depending on it — the classic "fast in SSMS, slow from the app" divergence.
        enableArithAbort: true
      }
    });

    // A failed pool must not stay attached: mssql emits `error` on a dead pool, and an unhandled
    // 'error' event on an EventEmitter takes the process down.
    pool.on("error", () => undefined);

    return pool.connect();
  }

  /** Close the least recently used pools until the map is within its cap. */
  private async evictOverflow(): Promise<void> {
    while (this.pools.size > this.limits.maxPools) {
      const oldest = this.pools.keys().next();
      if (oldest.done === true) {
        return;
      }
      const evicted = this.pools.get(oldest.value);
      this.pools.delete(oldest.value);
      if (evicted !== undefined) {
        await evicted.then((pool) => pool.close()).catch(() => undefined);
      }
    }
  }

  /** Environment inventory for `list_environments`. Connections are masked. */
  list(): Array<Record<string, unknown>> {
    const openCatalogs = new Map<string, number>();
    for (const key of this.pools.keys()) {
      const envName = key.slice(0, key.indexOf("::"));
      openCatalogs.set(envName, (openCatalogs.get(envName) ?? 0) + 1);
    }

    const configured = [...this.config.registry.environments.values()].map((env) => ({
      name: env.name,
      isDefault: env.name === this.config.registry.defaultEnvironment,
      allowed:
        this.config.allowedEnvironments.length === 0 ||
        this.config.allowedEnvironments.includes(env.name),
      source: env.sourceDetail,
      connection: maskConnection(env.settings),
      openPools: openCatalogs.get(env.name) ?? 0
    }));

    const broken = this.config.invalidEnvironments.map((entry) => ({
      name: entry.name,
      isDefault: false,
      allowed: false,
      source: entry.sourceDetail,
      connection: null,
      openPools: 0,
      error: entry.reason
    }));

    return [...configured, ...broken];
  }

  async closeAll(): Promise<void> {
    const pending = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pending.map((p) => p.then((pool) => pool.close()).catch(() => undefined)));
  }
}
