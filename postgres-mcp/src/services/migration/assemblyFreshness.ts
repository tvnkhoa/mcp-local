import fs from "node:fs";
import path from "node:path";

import { PolicyViolationError } from "../../middleware/errors.js";

/**
 * Is the assembly `dotnet ef --no-build` loads older than the migrations in the source tree?
 *
 * The EF lane never builds (it runs `--no-build`), so every migration_* call reads whatever the
 * startup project last built. On 16 Nov that was a UAT-branch build a week old while the checkout
 * (develop) had newer migrations: migration_status listed the UAT set as pending and an apply would
 * have applied nothing of what the source held. EF gives no sign of it, so the server checks:
 *
 *  1. A migration id in the source that the assembly does not list (decisive: the list IS the
 *     assembly's content under `--no-build`).
 *  2. A migration source file modified after the assembly was written.
 *
 * Where the assembly is comes from `dotnet ef --verbose --prefix-output` itself ("Using application
 * base" + "Using assembly"), so no output layout (bin/, artifacts/) is assumed. When it cannot be
 * found, check 2 is skipped and says so; check 1 still runs. A project with no Migrations folder
 * has nothing to compare and reports `no_source`.
 */

/** EF migration source file: `<14 digits>_<Name>.cs`. Excludes `*.Designer.cs` and the ModelSnapshot. */
const MIGRATION_SOURCE = /^(\d{14}_[A-Za-z0-9_]+)\.cs$/;

/** Bounds for the Migrations walk (EF allows subfolders via --output-dir). */
const MAX_DEPTH = 4;
const MAX_FILES = 20_000;

export interface PrefixedEfOutput {
  /** The `data:` lines with their prefix removed: the command's real output (JSON for --json). */
  data: string;
  /** The `verbose:` lines with their prefix removed. */
  verbose: string[];
}

/**
 * Split `--prefix-output` stdout into its data and verbose lines. Output with no prefixed line at
 * all (an older runner, a test fake) is returned whole as data, so parsing stays unchanged for it.
 */
export function splitPrefixedOutput(stdout: string): PrefixedEfOutput {
  const lines = stdout.split(/\r?\n/);
  const prefixed = lines.some((l) => /^(data|verbose|info|warn|error):/.test(l));
  if (!prefixed) {
    return { data: stdout, verbose: [] };
  }
  const data: string[] = [];
  const verbose: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data.push(line.replace(/^data: {0,4}/, ""));
    } else if (line.startsWith("verbose:")) {
      verbose.push(line.replace(/^verbose: ?/, ""));
    }
  }
  return { data: data.join("\n"), verbose };
}

/**
 * The full path of the migrations assembly `dotnet ef` loaded, from its verbose lines:
 * `Using application base '<dir>'.` + `Using assembly '<name>'.`, else the `--assembly <path>`
 * argument of the logged `dotnet exec` line. Undefined when neither is there.
 */
export function resolveBuiltAssembly(verbose: string[]): string | undefined {
  let appBase: string | undefined;
  let assemblyName: string | undefined;
  for (const line of verbose) {
    const base = /^Using application base '(.+)'\.?\s*$/.exec(line);
    if (base) appBase = base[1];
    const asm = /^Using assembly '(.+)'\.?\s*$/.exec(line);
    if (asm) assemblyName = asm[1];
  }
  if (appBase !== undefined && assemblyName !== undefined) {
    return path.join(appBase, assemblyName.toLowerCase().endsWith(".dll") ? assemblyName : `${assemblyName}.dll`);
  }
  for (const line of verbose) {
    const exec = /\s--assembly\s+("([^"]+)"|(\S+))/.exec(line);
    if (exec) return exec[2] ?? exec[3];
  }
  return undefined;
}

/** The project directory: `POSTGRES_MIGRATION_DOTNET_PROJECT` may name the .csproj or its folder. */
export function projectDir(project: string): string {
  return /\.(cs|fs|vb)proj$/i.test(project) ? path.dirname(project) : project;
}

export interface SourceMigration {
  id: string;
  file: string;
  modifiedMs: number;
}

/** Migration source files under `<projectDir>/Migrations`, or null when that folder does not exist. */
export function listSourceMigrations(project: string): SourceMigration[] | null {
  const root = path.join(projectDir(project), "Migrations");
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const found: SourceMigration[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      const match = MIGRATION_SOURCE.exec(entry.name);
      if (!match) continue;
      try {
        found.push({ id: match[1] as string, file: full, modifiedMs: fs.statSync(full).mtimeMs });
      } catch {
        // vanished between readdir and stat: skip it
      }
    }
  };
  walk(root, 0);
  return found;
}

export interface AssemblyFreshness {
  /**
   * - `stale`: the migration ids differ (a source id the assembly lacks, or an assembly id with no
   *   source file). Exact, so preview / dry run / apply refuse.
   * - `possibly_stale`: the ids match but a migration source file is newer than the assembly. A
   *   branch switch rewrites mtimes with identical content, so this only warns.
   * - `no_source`: no Migrations folder (or no migration file in it): nothing to compare.
   */
  status: "fresh" | "stale" | "possibly_stale" | "no_source";
  /** The assembly `dotnet ef` loaded, when its verbose output named it. */
  assemblyPath?: string;
  assemblyBuiltAt?: string;
  newestSource?: { id: string; file: string; modifiedAt: string };
  /** Source migration ids the built assembly does not contain. */
  missingFromAssembly: string[];
  /** Assembly migration ids with no source file in the checkout. */
  missingFromSource: string[];
  /** Why (possibly) stale, one line each; empty when fresh. */
  reasons: string[];
  /** Set when the timestamp check could not run. */
  note?: string;
  remedy?: string;
}

const REMEDY =
  "Build the EF startup project (POSTGRES_MIGRATION_DOTNET_STARTUP_PROJECT) from the current checkout, e.g. `dotnet build <startup project>`, then call migration_status again. This server runs dotnet ef with --no-build and never builds.";

function idList(ids: string[]): string {
  return `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
}

/** Compare the source Migrations folder with the assembly `dotnet ef` reported loading. */
export function checkAssemblyFreshness(project: string, listedIds: readonly string[], verbose: string[]): AssemblyFreshness {
  const sources = listSourceMigrations(project);
  if (sources === null || sources.length === 0) {
    return { status: "no_source", missingFromAssembly: [], missingFromSource: [], reasons: [] };
  }
  const listed = new Set(listedIds);
  const sourceIds = new Set(sources.map((s) => s.id));
  const missingFromAssembly = [...sourceIds].filter((id) => !listed.has(id)).sort();
  const missingFromSource = [...listed].filter((id) => !sourceIds.has(id)).sort();
  // Newest by file time; equal times (a checkout writes many at once) go to the later id.
  const newest = sources.reduce((a, b) => (b.modifiedMs > a.modifiedMs || (b.modifiedMs === a.modifiedMs && b.id > a.id) ? b : a));
  const result: AssemblyFreshness = {
    status: "fresh",
    missingFromAssembly,
    missingFromSource,
    reasons: [],
    newestSource: { id: newest.id, file: newest.file, modifiedAt: new Date(newest.modifiedMs).toISOString() }
  };

  if (missingFromAssembly.length > 0) {
    result.reasons.push(`${missingFromAssembly.length} migration(s) in the source are not in the built assembly: ${idList(missingFromAssembly)}.`);
  }
  if (missingFromSource.length > 0) {
    result.reasons.push(`${missingFromSource.length} migration(s) in the built assembly have no source file in the checkout: ${idList(missingFromSource)}.`);
  }
  const idsDiffer = result.reasons.length > 0;

  const assemblyPath = resolveBuiltAssembly(verbose);
  if (assemblyPath === undefined) {
    result.note = "dotnet ef did not report the assembly path, so only the migration ids were compared.";
  } else {
    result.assemblyPath = assemblyPath;
    let builtMs: number | undefined;
    try {
      builtMs = fs.statSync(assemblyPath).mtimeMs;
    } catch {
      result.note = "The reported assembly could not be read, so only the migration ids were compared.";
    }
    if (builtMs !== undefined) {
      result.assemblyBuiltAt = new Date(builtMs).toISOString();
      if (newest.modifiedMs > builtMs) {
        result.reasons.push(
          `Migration source ${path.basename(newest.file)} (${result.newestSource?.modifiedAt}) is newer than the built assembly (${result.assemblyBuiltAt}).` +
            (idsDiffer ? "" : " The ids match, so this may only be a branch switch rewriting file times; rebuild to be sure.")
        );
      }
    }
  }
  if (idsDiffer) {
    result.status = "stale";
  } else if (result.reasons.length > 0) {
    result.status = "possibly_stale";
  }
  if (result.status !== "fresh") {
    result.remedy = REMEDY;
  }
  return result;
}

/**
 * Preview, dry run and apply refuse on the exact signal only (the ids differ): what they would run
 * is not the source. A newer file time alone (`possibly_stale`) is a warning, never a refusal.
 */
export function assertAssemblyFresh(freshness: AssemblyFreshness): void {
  if (freshness.status !== "stale") return;
  throw new PolicyViolationError(
    "MIGRATION_ASSEMBLY_STALE",
    `The assembly dotnet ef loads (--no-build) does not match the migration source. ${freshness.reasons.join(" ")} ${REMEDY}`
  );
}

/** The response field for a non-fresh assembly; undefined (dropped from the payload) when fresh. */
export function freshnessWarning(freshness: AssemblyFreshness): (AssemblyFreshness & { warning: string }) | undefined {
  if (freshness.status !== "stale" && freshness.status !== "possibly_stale") return undefined;
  const warning =
    freshness.status === "stale"
      ? "STALE BUILD: the assembly dotnet ef reads does not hold the checkout's migrations, so applied/pending below describe the old build. migration_preview, migration_dry_run and migration_apply refuse until it is rebuilt."
      : "POSSIBLY STALE BUILD: a migration source file is newer than the assembly dotnet ef reads, though the migration ids match.";
  return { warning, ...freshness };
}
