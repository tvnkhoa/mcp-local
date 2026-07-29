/**
 * Legacy environment variable names, still honoured (S-43).
 *
 * This server used three unrelated prefixes: `CH_*` (named for the CommunicationHub app it was
 * first written against), `PG_*` and `MCP_DB_*`. S-43 converged them on `POSTGRES_*`.
 *
 * A rename alone would have been a silent breaking change. Every existing install carries the old
 * names in `~/.claude.json`, and for a database server the failure mode is bad: "no connection
 * source configured" is what an operator sees, which reads as a broken machine rather than a
 * renamed variable. So the old names keep working, and `resolveAliases()` is called before anything
 * reads configuration.
 *
 * Rules:
 *   - the canonical name always wins when both are set;
 *   - falling back to a legacy name warns once, on stderr, naming the replacement;
 *   - `POSTGRES_ENV_*` is a family, so its alias is the old *prefix* `PG_ENV_`.
 *
 * The table is duplicated from `packages/manifest/src/envSpecs/postgres.ts` because a server must
 * not import the workspace tooling packages (dependency rule 5, enforced as
 * `servers/tooling-import`). `scripts/lib/envAliases.test.mjs` compares the two and fails on drift —
 * the mechanism that ADR 0002 says a duplicated table needs.
 */

/** canonical name → the former names it replaced. */
export const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  POSTGRES_CONNECTION: ["CH_DB_CONNECTION"],
  POSTGRES_APPSETTINGS_ROOTS: ["CH_APPSETTINGS_ROOTS"],
  POSTGRES_CONNECTION_NAME: ["CH_CONNECTION_NAME"],
  POSTGRES_ALLOWED_ENVIRONMENTS: ["PG_ALLOWED_ENVIRONMENTS"],
  POSTGRES_WRITABLE_ENVIRONMENTS: ["PG_WRITABLE_ENVIRONMENTS"],
  POSTGRES_DEFAULT_ENVIRONMENT: ["PG_DEFAULT_ENVIRONMENT"],
  POSTGRES_DEFAULT_LIMIT: ["MCP_DB_DEFAULT_LIMIT"],
  POSTGRES_MAX_LIMIT: ["MCP_DB_MAX_LIMIT"],
  POSTGRES_DEFAULT_TIMEOUT_MS: ["MCP_DB_DEFAULT_TIMEOUT_MS"],
  POSTGRES_MAX_TIMEOUT_MS: ["MCP_DB_MAX_TIMEOUT_MS"],
  POSTGRES_EXPLAIN_COST_WARN: ["PG_EXPLAIN_COST_WARN"],
  POSTGRES_WRITE_ENABLED: ["PG_WRITE_ENABLED"],
  POSTGRES_WRITE_APPROVAL_SECRET: ["PG_WRITE_APPROVAL_SECRET"],
  POSTGRES_WRITE_PREVIEW_TTL_MS: ["PG_WRITE_PREVIEW_TTL_MS"],
  POSTGRES_WRITE_SAMPLE_LIMIT: ["PG_WRITE_SAMPLE_LIMIT"],
  POSTGRES_MIGRATION_ENABLED: ["PG_MIGRATION_ENABLED"],
  POSTGRES_MIGRATION_PREVIEW_TTL_MS: ["PG_MIGRATION_PREVIEW_TTL_MS"],
  POSTGRES_DOTNET_PROJECT: ["CH_DOTNET_PROJECT"],
  POSTGRES_DOTNET_STARTUP_PROJECT: ["CH_DOTNET_STARTUP_PROJECT"],
  POSTGRES_DOTNET_TIMEOUT_MS: ["PG_DOTNET_TIMEOUT_MS"]
};

/** canonical prefix → the former prefixes it replaced. */
export const ENV_PREFIX_ALIASES: Readonly<Record<string, readonly string[]>> = {
  POSTGRES_ENV_: ["PG_ENV_"]
};

const warned = new Set<string>();

function warnOnce(legacy: string, canonical: string): void {
  if (warned.has(legacy)) {
    return;
  }
  warned.add(legacy);
  // stderr, never stdout: on a stdio transport stdout is the protocol channel.
  process.stderr.write(
    `[postgres-mcp] ${legacy} is deprecated — use ${canonical}. The old name still works for now.\n`
  );
}

/**
 * Copy any legacy value onto its canonical name, so the rest of the server only ever reads the
 * canonical one.
 *
 * Idempotent, and deliberately a mutation of `process.env` rather than a returned snapshot: the
 * config modules read at call time (so an operator can change a value without a restart in the
 * cases that support it), and returning a frozen copy would quietly change that.
 *
 * @returns the legacy names that were actually used, for the caller to report.
 */
export function resolveAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  const used: string[] = [];

  for (const [canonical, legacyNames] of Object.entries(ENV_ALIASES)) {
    // Canonical wins. Note the test for "set" is non-empty, not merely defined: an agent config
    // that writes "" for every declared var is the common case, and treating "" as set would make
    // the canonical name shadow a legacy value that does hold a connection string.
    if (env[canonical] !== undefined && env[canonical] !== "") {
      continue;
    }
    for (const legacy of legacyNames) {
      const value = env[legacy];
      if (value !== undefined && value !== "") {
        env[canonical] = value;
        used.push(legacy);
        warnOnce(legacy, canonical);
        break;
      }
    }
  }

  for (const [canonicalPrefix, legacyPrefixes] of Object.entries(ENV_PREFIX_ALIASES)) {
    for (const legacyPrefix of legacyPrefixes) {
      for (const key of Object.keys(env)) {
        if (!key.startsWith(legacyPrefix)) {
          continue;
        }
        const canonical = `${canonicalPrefix}${key.slice(legacyPrefix.length)}`;
        if (env[canonical] !== undefined && env[canonical] !== "") {
          continue;
        }
        const value = env[key];
        if (value !== undefined && value !== "") {
          env[canonical] = value;
          used.push(key);
          warnOnce(key, canonical);
        }
      }
    }
  }

  return used;
}
