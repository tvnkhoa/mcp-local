/**
 * Connection strings, parsed into parts — never manipulated as text.
 *
 * This is the module the audit that motivated this server pointed at directly. The application it
 * was audited against switches tenant catalog like this:
 *
 * ```csharp
 * var newConn = connString.Replace(conn.Database, dbName);   // wec.be
 * ```
 *
 * That is a substring replacement over the whole connection string. It corrupts the connection
 * whenever the catalog name also occurs in the password, the user id, or the host — and it fails
 * silently, as a login error against a database that looks right in the logs. Since switching
 * catalog per call is this server's central operation, the connection string is parsed into
 * {@link SqlConnectionSettings} once and every later change is a field assignment.
 */

import type { EnvReader } from "@mcp/core";

import { PolicyViolationError } from "../middleware/errors.js";

/** A connection string, taken apart. `database` is the only field this server ever rewrites. */
export interface SqlConnectionSettings {
  readonly server: string;
  readonly port?: number;
  readonly instanceName?: string;
  readonly database: string;
  readonly user?: string;
  readonly password?: string;
  /**
   * `undefined` when the connection string does not say — and that distinction is load-bearing.
   *
   * `mssql` merges `options` over its own default with
   * `Object.assign({ encrypt: … ?? true }, config.options)`, so passing an explicit `false` here
   * *overrides the driver's secure default*. Defaulting this field to `false` therefore turned off
   * TLS for every connection string that simply omits `Encrypt=` — which is the common case, since
   * `Microsoft.Data.SqlClient` has defaulted it to true since v4 and nobody writes it out. The
   * login and every result row would go over the wire in plaintext.
   */
  readonly encrypt?: boolean;
  readonly trustServerCertificate: boolean;
  readonly connectTimeoutMs?: number;
  readonly applicationName?: string;
}

export interface EnvironmentConfig {
  /** Canonical environment name, e.g. "dev" | "uat" | "prod" | "default". */
  readonly name: string;
  readonly settings: SqlConnectionSettings;
  /** Which variable this came from — shown by `list_environments`, never the value. */
  readonly sourceDetail: string;
}

export interface EnvironmentRegistry {
  readonly environments: ReadonlyMap<string, EnvironmentConfig>;
  readonly defaultEnvironment: string;
}

/** Map .NET-style environment names onto the short canonical ones. */
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
  if (lower === "test" || lower === "testing" || lower === "uat") {
    return "uat";
  }
  return lower;
}

/**
 * Split `a=1;b=2` into pairs, honouring the three ADO.NET quoting forms.
 *
 * A naive `split(";")` loses everything after the first semicolon in a password — and a password is
 * exactly the field most likely to contain one. `{…}` is the ADO.NET escape; single and double
 * quotes are accepted because both appear in hand-written configuration.
 */
function splitPairs(raw: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let index = 0;

  while (index < raw.length) {
    // Skip empty segments. ADO.NET tolerates `a=1;;b=2`, and a doubled semicolon is easy to produce
    // by concatenating config fragments. Without this the next key parses as ";b" and the pair is
    // lost — which for `Initial Catalog` means the whole environment is reported unusable.
    while (index < raw.length && (raw[index] === ";" || raw[index] === " ")) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }

    const equals = raw.indexOf("=", index);
    if (equals === -1) {
      break;
    }
    const key = raw.slice(index, equals).trim().toLowerCase();
    index = equals + 1;

    while (index < raw.length && raw[index] === " ") {
      index += 1;
    }

    let value: string;
    const opener = raw[index];

    if (opener === "{") {
      const close = raw.indexOf("}", index + 1);
      const end = close === -1 ? raw.length : close;
      value = raw.slice(index + 1, end);
      index = end + 1;
    } else if (opener === "'" || opener === '"') {
      const close = raw.indexOf(opener, index + 1);
      const end = close === -1 ? raw.length : close;
      value = raw.slice(index + 1, end);
      index = end + 1;
    } else {
      const semicolon = raw.indexOf(";", index);
      const end = semicolon === -1 ? raw.length : semicolon;
      value = raw.slice(index, end).trim();
      index = end;
    }

    // Skip to just past the next separator.
    const next = raw.indexOf(";", index);
    index = next === -1 ? raw.length : next + 1;

    if (key !== "") {
      pairs.push([key, value]);
    }
  }

  return pairs;
}

/** `tcp:host\instance,1433` → host / instance / port. */
function parseServerToken(raw: string): Pick<SqlConnectionSettings, "server" | "port" | "instanceName"> {
  let text = raw.trim();
  if (/^(tcp|np|lpc):/i.test(text)) {
    text = text.slice(text.indexOf(":") + 1);
  }

  let port: number | undefined;
  const comma = text.lastIndexOf(",");
  if (comma !== -1) {
    const parsed = Number(text.slice(comma + 1).trim());
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
      port = parsed;
      text = text.slice(0, comma);
    }
  }

  let instanceName: string | undefined;
  const backslash = text.indexOf("\\");
  if (backslash !== -1) {
    instanceName = text.slice(backslash + 1).trim() || undefined;
    text = text.slice(0, backslash);
  }

  return { server: text.trim(), port, instanceName };
}

/** `undefined` in, `undefined` out — so "unset" stays distinguishable from "set to false". */
function parseOptionalBool(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const lower = value.trim().toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "1" || lower === "sspi") {
    return true;
  }
  if (lower === "false" || lower === "no" || lower === "0") {
    return false;
  }
  return undefined;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  return parseOptionalBool(value) ?? fallback;
}

/**
 * Parse an ADO.NET / Npgsql-shaped SQL Server connection string.
 *
 * Accepts the aliases that actually appear in .NET configuration rather than only the canonical
 * spellings, because the connection strings this server is pointed at are copied from
 * `appsettings.json`, not authored for it.
 */
export function parseConnectionString(raw: string): SqlConnectionSettings {
  const pairs = new Map(splitPairs(raw));
  const get = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = pairs.get(key);
      if (value !== undefined && value !== "") {
        return value;
      }
    }
    return undefined;
  };

  const serverToken = get("data source", "server", "address", "addr", "network address");
  if (serverToken === undefined) {
    throw new Error(
      "Connection string is missing a server (expected `Data Source=` or `Server=`)."
    );
  }

  const database = get("initial catalog", "database");
  if (database === undefined) {
    throw new Error(
      "Connection string is missing a database (expected `Initial Catalog=` or `Database=`)."
    );
  }

  // Windows/integrated auth is not reachable from this driver on a non-Windows host and needs a
  // different code path even on one. Refusing here beats a connect-time error that reads like bad
  // credentials.
  if (parseBool(get("integrated security", "trusted_connection"), false)) {
    throw new Error(
      "Integrated Security is not supported — supply a SQL login (`User ID=` / `Password=`)."
    );
  }

  const connectTimeoutSeconds = Number(get("connection timeout", "connect timeout") ?? Number.NaN);

  return {
    ...parseServerToken(serverToken),
    database,
    user: get("user id", "uid", "user", "username"),
    password: get("password", "pwd"),
    // Left undefined when unset, so the driver applies its own (secure) default.
    encrypt: parseOptionalBool(get("encrypt")),
    trustServerCertificate: parseBool(get("trustservercertificate", "trust server certificate"), false),
    connectTimeoutMs: Number.isFinite(connectTimeoutSeconds)
      ? Math.round(connectTimeoutSeconds * 1000)
      : undefined,
    applicationName: get("application name", "app")
  };
}

/**
 * The catalog switch — a field assignment, not a string edit. See the module docblock for why that
 * distinction is the reason this function exists at all.
 */
export function withDatabase(
  settings: SqlConnectionSettings,
  database: string
): SqlConnectionSettings {
  return { ...settings, database };
}

/** Credentials removed. Safe for `list_environments`, health payloads and stderr. */
export function maskConnection(settings: SqlConnectionSettings): Record<string, unknown> {
  return {
    server: settings.server,
    port: settings.port,
    instanceName: settings.instanceName,
    database: settings.database,
    user: settings.user === undefined ? undefined : "***",
    hasPassword: settings.password !== undefined && settings.password !== "",
    // "(driver default)" rather than a guess: the driver decides when the string does not say, and
    // reporting `false` here would misdescribe an encrypted connection.
    encrypt: settings.encrypt ?? "(driver default)",
    trustServerCertificate: settings.trustServerCertificate
  };
}

/**
 * Build the environment registry from `SQLSERVER_CONNECTION` and the `SQLSERVER_ENV_*` family.
 *
 * A connection string that fails to parse is recorded as an unusable environment rather than
 * thrown: with several environments configured, one bad string must not stop the server from
 * serving the others. The failure surfaces on use, and in `list_environments`.
 */
export function buildEnvironmentRegistry(env: EnvReader): {
  registry: EnvironmentRegistry;
  invalid: ReadonlyArray<{ name: string; sourceDetail: string; reason: string }>;
} {
  const environments = new Map<string, EnvironmentConfig>();
  const invalid: Array<{ name: string; sourceDetail: string; reason: string }> = [];

  const add = (name: string, sourceDetail: string, raw: string): void => {
    const clash = environments.get(name);
    if (clash !== undefined) {
      // `canonicalEnvName` folds TEST/TESTING/UAT onto one name, so two variables can land on the
      // same key. Silently keeping one would leave the other's credentials unreachable with nothing
      // saying so — including in `list_environments`. Report it instead.
      invalid.push({
        name,
        sourceDetail,
        reason: `collides with ${clash.sourceDetail}: both resolve to environment "${name}". Rename one.`
      });
      return;
    }
    try {
      environments.set(name, { name, settings: parseConnectionString(raw), sourceDetail });
    } catch (cause) {
      invalid.push({
        name,
        sourceDetail,
        reason: cause instanceof Error ? cause.message : String(cause)
      });
    }
  };

  for (const key of env.presentKeys("SQLSERVER_ENV_")) {
    const suffix = key.slice("SQLSERVER_ENV_".length);
    if (suffix === "") {
      continue;
    }
    add(canonicalEnvName(suffix), key, env.string(key, ""));
  }

  const flat = env.optionalString("SQLSERVER_CONNECTION");
  if (flat !== undefined) {
    // Named `default` rather than folded into `dev`: an operator who sets both the flat variable
    // and `SQLSERVER_ENV_DEV` means two different things by them, and silently letting one win
    // would make the other's credentials unreachable with no message saying so.
    add("default", "SQLSERVER_CONNECTION", flat);
  }

  const requested = canonicalEnvName(env.string("SQLSERVER_DEFAULT_ENVIRONMENT", ""));
  const defaultEnvironment =
    requested !== "" && environments.has(requested)
      ? requested
      : environments.has("default")
        ? "default"
        : ([...environments.keys()][0] ?? "default");

  return { registry: { environments, defaultEnvironment }, invalid };
}

/**
 * Resolve an environment name to its configuration, honouring the allowlist.
 *
 * `allowed` empty means "no restriction" rather than "nothing allowed" — an allowlist that
 * defaults to blocking everything is a server that does not start for the operator who never set
 * it, which is not the failure mode worth having here.
 */
export function assertEnvironment(
  registry: EnvironmentRegistry,
  allowed: readonly string[],
  name: string
): EnvironmentConfig {
  const config = registry.environments.get(name);
  if (config === undefined) {
    const known = [...registry.environments.keys()].sort().join(", ") || "(none configured)";
    throw new PolicyViolationError(
      "unknown_environment",
      `Unknown environment "${name}". Configured: ${known}.`
    );
  }
  if (allowed.length > 0 && !allowed.some((entry) => canonicalEnvName(entry) === name)) {
    throw new PolicyViolationError(
      "environment_not_allowed",
      `Environment "${name}" is not in SQLSERVER_ALLOWED_ENVIRONMENTS.`
    );
  }
  return config;
}
