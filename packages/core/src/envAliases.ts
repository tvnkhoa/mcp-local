/**
 * Renamed environment variables, still honoured.
 *
 * A rename alone is a silent breaking change: every install carries the old names in its agent
 * config, and the failure an operator sees is a default quietly taking over, or "nothing configured",
 * which reads as a broken machine rather than a renamed variable. So each server keeps a table of
 * canonical name → former names and calls `resolveEnvAliases` before anything reads configuration.
 *
 * Rules:
 *   - the canonical name always wins when both are set;
 *   - "set" means non-empty: agent configs commonly write "" for every declared variable, and treating
 *     "" as set would let an empty canonical name shadow a legacy name that holds the real value;
 *   - falling back to a former name warns once, on stderr (never stdout: on a stdio transport that is
 *     the protocol channel), naming the replacement;
 *   - a variable FAMILY (`POSTGRES_ENV_*`) is aliased by its former prefix.
 *
 * It mutates the env it is given, deliberately, rather than returning a snapshot: config modules read
 * at call time, and a frozen copy would quietly change that. The legacy name is left in place.
 *
 * Each server's table duplicates its manifest's `deprecatedAliases`, because a server may not import
 * the workspace tooling packages (dependency rule 5). `scripts/lib/envAliases.test.mjs` compares
 * every server's copy with the manifest and fails on drift.
 */

export interface EnvAliasTable {
  /** Prefix for the deprecation warning, e.g. `postgres-mcp`. */
  readonly label: string;
  /** canonical name → the former names it replaced, in preference order. */
  readonly names: Readonly<Record<string, readonly string[]>>;
  /** canonical prefix → former prefixes, for variable families. */
  readonly prefixes?: Readonly<Record<string, readonly string[]>>;
}

const warned = new Set<string>();

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

function warnOnce(label: string, legacy: string, canonical: string): void {
  const key = `${label}:${legacy}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  process.stderr.write(`[${label}] ${legacy} is deprecated — use ${canonical}. The old name still works for now.\n`);
}

/**
 * Copy every legacy value onto its canonical name. Idempotent.
 *
 * @returns the legacy names that were actually used.
 */
export function resolveEnvAliases(table: EnvAliasTable, env: NodeJS.ProcessEnv = process.env): string[] {
  const used: string[] = [];

  for (const [canonical, legacyNames] of Object.entries(table.names)) {
    if (isSet(env[canonical])) {
      continue;
    }
    for (const legacy of legacyNames) {
      const value = env[legacy];
      if (isSet(value)) {
        env[canonical] = value;
        used.push(legacy);
        warnOnce(table.label, legacy, canonical);
        break;
      }
    }
  }

  for (const [canonicalPrefix, legacyPrefixes] of Object.entries(table.prefixes ?? {})) {
    for (const legacyPrefix of legacyPrefixes) {
      for (const key of Object.keys(env)) {
        if (!key.startsWith(legacyPrefix)) {
          continue;
        }
        const canonical = `${canonicalPrefix}${key.slice(legacyPrefix.length)}`;
        const value = env[key];
        if (isSet(env[canonical]) || !isSet(value)) {
          continue;
        }
        env[canonical] = value;
        used.push(key);
        warnOnce(table.label, key, canonical);
      }
    }
  }

  return used;
}
