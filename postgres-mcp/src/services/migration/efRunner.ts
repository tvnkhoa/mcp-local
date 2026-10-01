import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PolicyViolationError } from "../../middleware/errors.js";

/**
 * Runs one `dotnet ef` invocation. `efArgs` is the subcommand part only, e.g.
 * `["migrations", "list", "--json"]`; the fixed `--project` / `--startup-project` / `--no-build`
 * template is added by {@link buildEfArgv} on the real path.
 */
export type EfRunner = (efArgs: string[], connectionString: string) => Promise<EfResult>;

export interface MigrationConfig {
  enabled: boolean;
  /** Project containing the DbContext + Migrations (e.g. src/Infrastructure). */
  project: string;
  /** Startup project (e.g. src/Web). */
  startupProject: string;
  timeoutMs: number;
  /**
   * `lock_timeout` for every `dotnet ef` session, in ms; 0 leaves the server default (no limit).
   * Passed through the connection string, because EF opens its own connection (B-15.1).
   */
  lockTimeoutMs: number;
  approvalSecret: string;
  previewTtlMs: number;
  /**
   * TEST SEAM, never configured from the environment: `index.ts` does not set it, and nothing in
   * `config/` reads it. When present it replaces the `dotnet` child process.
   *
   * It exists because `dotnet` cannot run in CI, which left preview, apply, dry run and the
   * contiguity logic with no test at all (B-15.3). A fake runner can answer `migrations list` and
   * `migrations script` from fixtures, and stand in for `database update` by running SQL against a
   * real throwaway Postgres. The handlers above it then run unmodified.
   *
   * A fake on PATH would not work: `spawn` with `shell: false` resolves only `.exe` on Windows.
   */
  run?: EfRunner;
}

export interface EfResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function assertMigrationEnabled(config: MigrationConfig): void {
  if (!config.enabled) {
    throw new PolicyViolationError(
      "MIGRATION_DISABLED",
      "Migration tools are disabled. Set POSTGRES_MIGRATION_ENABLED=true, POSTGRES_MIGRATION_DOTNET_PROJECT and POSTGRES_MIGRATION_DOTNET_STARTUP_PROJECT to enable."
    );
  }
  if (!config.project || !config.startupProject) {
    throw new PolicyViolationError(
      "MIGRATION_PROJECT_UNCONFIGURED",
      "POSTGRES_MIGRATION_DOTNET_PROJECT and POSTGRES_MIGRATION_DOTNET_STARTUP_PROJECT must be set for migration tools."
    );
  }
}

/** EF migration names: letters/digits/underscore only — prevents arg/shell injection. */
function sanitizeMigrationName(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new PolicyViolationError(
      "INVALID_MIGRATION_NAME",
      "Migration name must match ^[A-Za-z0-9_]+$ (letters, digits, underscore)."
    );
  }
  return name;
}

/**
 * Run `dotnet ef <subcommand...>` with a FIXED argument template. The only
 * variable inputs are (a) the sanitized migration name and (b) the target
 * connection string, injected via the `CH_DB_CONNECTION` env var that the project's
 * IDesignTimeDbContextFactory already reads. No user string is ever concatenated
 * into a shell command — spawn is called with an argv array and shell:false.
 *
 * `CH_DB_CONNECTION` here is deliberately NOT renamed by S-43. It is an *outbound* name — the one
 * the .NET project expects — not this server's own configuration. Every inbound `CH_*` var became
 * `POSTGRES_*`; this one cannot, because the reader lives in a codebase this workspace does not own.
 */
export interface LockTimeoutResult {
  connectionString: string;
  applied: boolean;
  /** Why not applied, or what was merged. */
  note?: string;
}

/**
 * The connection string `dotnet ef` receives, with `lock_timeout` set through Npgsql's `Options`
 * keyword (Npgsql 5.0 or later).
 *
 * Before this, `database update` ran with no lock wait at all. A migration that needed a lock on
 * a busy table queued behind it until `POSTGRES_MIGRATION_DOTNET_TIMEOUT_MS` killed the process. While it
 * queued, it blocked every other session that needed the same table: an `ALTER TABLE` waiting for
 * ACCESS EXCLUSIVE stops reads too.
 *
 * Never silently not applied. The result says whether it took, and why not:
 *  - `0` disables it.
 *  - A connection string that already sets `lock_timeout` keeps its own value. The operator chose it.
 *  - A `postgres://` URI is left alone. Npgsql reads only `key=value;` strings, so there is no
 *    `Options` to add to.
 */
export function withLockTimeout(connectionString: string, lockTimeoutMs: number): LockTimeoutResult {
  if (lockTimeoutMs <= 0) {
    return { connectionString, applied: false, note: "disabled (POSTGRES_MIGRATION_LOCK_TIMEOUT_MS=0)" };
  }
  const trimmed = connectionString.trim();
  if (/^postgres(ql)?:\/\//i.test(trimmed)) {
    return {
      connectionString,
      applied: false,
      note: "the connection string is a postgres:// URI; Npgsql reads key=value strings, so lock_timeout cannot be added to it"
    };
  }
  const setting = `-c lock_timeout=${String(lockTimeoutMs)}`;
  const parts = splitConnectionString(trimmed);
  if (parts === null) {
    return { connectionString, applied: false, note: "the connection string has an unbalanced quote; left as is" };
  }
  const at = parts.findIndex((p) => /^\s*options\s*=/i.test(p));
  if (at >= 0) {
    const part = parts[at] as string;
    if (/lock_timeout/i.test(part)) {
      return { connectionString, applied: false, note: "the connection string already sets lock_timeout in Options; left as is" };
    }
    const eq = part.indexOf("=");
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1).trim();
    // A quoted value keeps its quotes: the setting goes INSIDE them. Appending after the closing
    // quote produced `Options='-c a=b' -c lock_timeout=N`, which Npgsql cannot parse, so every
    // dotnet ef call failed while the preview reported the timeout as applied. Found by review,
    // finding 4 of the 2026-10-01 pass.
    const quote = value[0] === "'" || value[0] === '"' ? value[0] : "";
    const merged = quote !== "" && value.endsWith(quote) && value.length >= 2 ? `${value.slice(0, -1)} ${setting}${quote}` : `${value} ${setting}`;
    parts[at] = `${key}=${merged}`;
    return { connectionString: `${parts.join(";")};`, applied: true, note: "merged into the existing Options" };
  }
  return { connectionString: `${[...parts, `Options=${setting}`].join(";")};`, applied: true };
}

/**
 * Split a `key=value;` connection string on the `;` that separate pairs, but not on a `;` inside a
 * quoted value (Npgsql quotes a value that contains one). Empty pairs are dropped. Returns null on
 * an unbalanced quote, rather than guessing where the value ends.
 */
function splitConnectionString(value: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        if (value[i + 1] === quote) {
          // A doubled quote inside a quoted value is an escaped quote.
          current += quote;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if ((ch === "'" || ch === '"') && /=\s*$/.test(current)) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim() !== "") parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== null) {
    return null;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** The full argv for `dotnet`: the subcommand, then the fixed project template. */
export function buildEfArgv(config: Pick<MigrationConfig, "project" | "startupProject">, efArgs: string[]): string[] {
  return ["ef", ...efArgs, "--project", config.project, "--startup-project", config.startupProject, "--no-build"];
}

function runEf(config: MigrationConfig, efArgs: string[], rawConnectionString: string): Promise<EfResult> {
  // Every invocation, not only `database update`: `migrations list` reads the history table and
  // could queue behind a lock on it just the same.
  const connectionString = withLockTimeout(rawConnectionString, config.lockTimeoutMs).connectionString;
  if (config.run !== undefined) {
    return config.run(efArgs, connectionString);
  }
  const args = buildEfArgv(config, efArgs);

  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", args, {
      shell: false,
      env: { ...process.env, CH_DB_CONNECTION: connectionString },
      cwd: path.dirname(config.project)
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new PolicyViolationError("MIGRATION_TIMEOUT", `dotnet ef timed out after ${config.timeoutMs}ms.`));
    }, config.timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new PolicyViolationError("DOTNET_NOT_AVAILABLE", `Failed to launch dotnet: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function efMigrationsList(config: MigrationConfig, connectionString: string): Promise<EfResult> {
  return runEf(config, ["migrations", "list", "--no-connect"], connectionString);
}

/**
 * Connected variant — reports which migrations are applied vs pending on the target DB.
 * `--json` (available on `dotnet ef` since EF Core tools 3.0) returns structured
 * `{id, name, safeName, applied}` entries instead of human/locale-oriented text with an
 * `applied`/`(Pending)` marker — avoids scraping stdout with a regex that can misclassify
 * migrations under a non-English CLI locale or if the marker text/position ever changes.
 */
export function efMigrationsListConnected(config: MigrationConfig, connectionString: string): Promise<EfResult> {
  return runEf(config, ["migrations", "list", "--json"], connectionString);
}

export function efMigrationsAdd(config: MigrationConfig, name: string, connectionString: string): Promise<EfResult> {
  return runEf(config, ["migrations", "add", sanitizeMigrationName(name)], connectionString);
}

/** Idempotent script: safe to run against a DB at any migration point. */
export function efMigrationsScript(config: MigrationConfig, connectionString: string): Promise<EfResult> {
  return runEf(config, ["migrations", "script", "--idempotent"], connectionString);
}

/** EF migration ids look like `20240131120000_AddFoo` — validate before using as a CLI arg. */
function sanitizeMigrationId(id: string): string {
  if (!/^\d+_[A-Za-z0-9_]+$/.test(id)) {
    throw new PolicyViolationError(
      "INVALID_MIGRATION_ID",
      `Migration id '${id}' does not match ^\\d+_[A-Za-z0-9_]+$.`
    );
  }
  return id;
}

/**
 * Non-idempotent delta script: SQL for migrations AFTER `fromMigration` (the last one
 * already applied on the target DB) through latest — i.e. only the pending delta.
 * Omit `fromMigration` (fresh DB, nothing applied) to script from scratch. The positional
 * `<from>` lands before runEf's `--project/...` options, which is valid for `dotnet ef`.
 */
export function efMigrationsScriptDelta(
  config: MigrationConfig,
  connectionString: string,
  fromMigration?: string
): Promise<EfResult> {
  const efArgs = ["migrations", "script"];
  if (fromMigration) efArgs.push(sanitizeMigrationId(fromMigration));
  return runEf(config, efArgs, connectionString);
}

export function efDatabaseUpdate(config: MigrationConfig, connectionString: string): Promise<EfResult> {
  return runEf(config, ["database", "update"], connectionString);
}

/** A rollback target: a migration id, or `0` for "before the first migration" (EF's own spelling). */
function sanitizeTarget(target: string): string {
  return target === "0" ? target : sanitizeMigrationId(target);
}

/**
 * The SQL that takes the database from `from` to `to`. When `to` is earlier than `from`, EF
 * scripts the migrations' Down methods, newest first: that is the rollback script.
 */
export function efMigrationsScriptRange(config: MigrationConfig, connectionString: string, from: string, to: string): Promise<EfResult> {
  return runEf(config, ["migrations", "script", sanitizeMigrationId(from), sanitizeTarget(to)], connectionString);
}

/** `database update <target>`: reverts every migration applied after `target` (`0` = all of them). */
export function efDatabaseUpdateTo(config: MigrationConfig, connectionString: string, target: string): Promise<EfResult> {
  return runEf(config, ["database", "update", sanitizeTarget(target)], connectionString);
}

/** List migration files in the project's Migrations folder (newest first). */
export function listMigrationFiles(config: MigrationConfig, filterName?: string): string[] {
  const dir = path.join(config.project, "Migrations");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".cs") && (!filterName || f.includes(filterName)))
    .map((f) => path.join(dir, f))
    .sort()
    .reverse();
}
