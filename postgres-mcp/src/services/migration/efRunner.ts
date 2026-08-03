import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PolicyViolationError } from "../../middleware/errors.js";

export interface MigrationConfig {
  enabled: boolean;
  /** Project containing the DbContext + Migrations (e.g. src/Infrastructure). */
  project: string;
  /** Startup project (e.g. src/Web). */
  startupProject: string;
  timeoutMs: number;
  approvalSecret: string;
  previewTtlMs: number;
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
      "Migration tools are disabled. Set POSTGRES_MIGRATION_ENABLED=true, POSTGRES_DOTNET_PROJECT and POSTGRES_DOTNET_STARTUP_PROJECT to enable."
    );
  }
  if (!config.project || !config.startupProject) {
    throw new PolicyViolationError(
      "MIGRATION_PROJECT_UNCONFIGURED",
      "POSTGRES_DOTNET_PROJECT and POSTGRES_DOTNET_STARTUP_PROJECT must be set for migration tools."
    );
  }
}

/** EF migration names: letters/digits/underscore only — prevents arg/shell injection. */
export function sanitizeMigrationName(name: string): string {
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
function runEf(config: MigrationConfig, efArgs: string[], connectionString: string): Promise<EfResult> {
  const args = [
    "ef",
    ...efArgs,
    "--project",
    config.project,
    "--startup-project",
    config.startupProject,
    "--no-build"
  ];

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

export function efMigrationsList(config: MigrationConfig, connectionString: string): Promise<EfResult> {
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
export function sanitizeMigrationId(id: string): string {
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
