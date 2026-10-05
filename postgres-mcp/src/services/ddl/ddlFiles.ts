/**
 * Migration files on disk: naming, loading, checksums, and writing new ones.
 *
 * Layout, one flat directory:
 *
 *   V20261001093000__add_orders_note.up.sql
 *   V20261001093000__add_orders_note.down.sql   (optional)
 *
 * Versions are UTC timestamps, not counters. Two branches that each add "0042" collide at merge,
 * while two timestamps almost never do. They sort as strings in apply order, and they are the same
 * shape as EF Core's migration ids.
 *
 * With POSTGRES_DDL_EXTERNAL_LEDGER the directory is a repo's own, written for psql and applied
 * until now by that repo's runner, so the layout is that repo's instead (the `psql` format):
 *
 *   0021-tenant-location.sql
 *   0021-tenant-location.down.sql   (optional, as the repo's runner reads it)
 *
 * Applied in file-name order, and checksummed over the file's RAW bytes, exactly as `sha256sum`
 * does, because the ledger rows already there were written that way. A down is paired with the up
 * of the same prefix and slug. Its checksum is not in the ledger, which records what ran; it binds
 * the down to the approval digest, so what was previewed is what reverts.
 */

import { createHash } from "node:crypto";
import { open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { PolicyViolationError } from "../../middleware/errors.js";
import { MAX_DDL_SCRIPT_BYTES } from "../../middleware/ddlGuardrails.js";

export const MIGRATION_FILE = /^V(\d{14})__([a-z0-9_]{1,100})\.(up|down)\.sql$/;
export const MIGRATION_NAME = /^[a-z0-9_]{1,100}$/;
export const MIGRATION_VERSION = /^\d{14}$/;
/** The psql format: a 4–14 digit prefix, a dash, a lower-case slug. */
export const PSQL_MIGRATION_FILE = /^(\d{4,14})-([a-z0-9][a-z0-9-]{0,150})\.sql$/;
/** Its down: the same prefix and slug, then `.down.sql`. A slug has no dot, so the two never overlap. */
export const PSQL_DOWN_FILE = /^(\d{4,14})-([a-z0-9][a-z0-9-]{0,150})\.down\.sql$/;

export type MigrationFileFormat = "mcp" | "psql";

export interface MigrationScript {
  /** File name only, never a path: responses must not leak the server's directory layout. */
  file: string;
  /** BOM-stripped, LF-normalized text: what runs, and in the `mcp` format what is checksummed. */
  text: string;
  /** `mcp`: `checksumOf(text)`. `psql`: sha256 of the file's raw bytes. */
  checksum: string;
}

export interface MigrationFile {
  version: string;
  name: string;
  up: MigrationScript;
  down?: MigrationScript;
}

export interface LoadedMigrations {
  migrations: MigrationFile[];
  /** `*.sql` files whose names do not follow the convention. Reported, never run. */
  ignoredFiles: string[];
  warnings: string[];
}

/**
 * The text a checksum is taken over. A BOM and CRLF line endings are what an editor or
 * `core.autocrlf` adds on Windows. Without normalizing them, a checkout on another machine would
 * report every applied migration as edited.
 */
export function normalizeScript(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * sha256 over the normalized text with trailing whitespace dropped.
 *
 * Trailing whitespace is dropped because files get a final newline when written and inline SQL
 * usually has none. The adopt rule matches an inline apply to the file later created from the
 * same SQL by this checksum, so the two must agree.
 */
export function checksumOf(text: string): string {
  return createHash("sha256").update(normalizeScript(text).trimEnd(), "utf8").digest("hex");
}

function fileError(code: string, message: string): PolicyViolationError {
  return new PolicyViolationError(code, message);
}

/**
 * Every migration in `dir`, sorted by version.
 *
 * Only regular files directly in `dir` are read. Subdirectories are not scanned, and symlinks are
 * skipped, so nothing outside the directory can be pulled into a migration.
 */
export async function loadMigrations(dir: string, format: MigrationFileFormat = "mcp"): Promise<LoadedMigrations> {
  return format === "psql" ? loadPsqlMigrations(dir) : loadMcpMigrations(dir);
}

async function readEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw fileError(
      "DDL_MIGRATIONS_DIR_UNREADABLE",
      `POSTGRES_DDL_MIGRATIONS_DIR could not be read${code === undefined ? "" : ` (${code})`}. Check that it exists and is a directory.`
    );
  }
}

/**
 * The psql format. The version is the numeric prefix, and it must be unique, so that `target` names
 * one file. Order is by file name, which is the order a shell glob hands the repo's runner.
 */
async function loadPsqlMigrations(dir: string): Promise<LoadedMigrations> {
  const entries = await readEntries(dir);
  const migrations: MigrationFile[] = [];
  const downs: Array<{ version: string; name: string; script: MigrationScript }> = [];
  const ignoredFiles: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const down = PSQL_DOWN_FILE.exec(entry.name);
    if (down !== null) {
      const bytes = await readFile(path.join(dir, entry.name));
      if (bytes.byteLength > MAX_DDL_SCRIPT_BYTES) {
        throw fileError("DDL_TOO_LARGE", `${entry.name} is over ${String(MAX_DDL_SCRIPT_BYTES)} bytes.`);
      }
      downs.push({
        version: down[1] as string,
        name: down[2] as string,
        script: { file: entry.name, text: normalizeScript(bytes.toString("utf8")), checksum: createHash("sha256").update(bytes).digest("hex") }
      });
      continue;
    }
    const match = PSQL_MIGRATION_FILE.exec(entry.name);
    if (match === null) {
      if (entry.name.toLowerCase().endsWith(".sql")) {
        ignoredFiles.push(entry.name);
      }
      continue;
    }
    const [, version, name] = match as unknown as [string, string, string];
    const bytes = await readFile(path.join(dir, entry.name));
    if (bytes.byteLength > MAX_DDL_SCRIPT_BYTES) {
      throw fileError("DDL_TOO_LARGE", `${entry.name} is over ${String(MAX_DDL_SCRIPT_BYTES)} bytes.`);
    }
    const clash = migrations.find((m) => m.version === version);
    if (clash !== undefined) {
      throw fileError("DDL_DUPLICATE_VERSION", `Prefix ${version} is used by both ${clash.up.file} and ${entry.name}. Each prefix must be unique.`);
    }
    if (bytes.includes("\r\n")) {
      warnings.push(`${entry.name} has CRLF line endings. Its checksum is over those bytes, as sha256sum takes it, so a ledger row written from an LF checkout will not match.`);
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    migrations.push({ version, name, up: { file: entry.name, text: normalizeScript(bytes.toString("utf8")), checksum } });
  }

  // A down pairs only with the up of the same prefix AND slug: a renamed up would otherwise get the
  // down of a different migration.
  for (const down of downs) {
    const up = migrations.find((m) => m.version === down.version);
    if (up === undefined || up.name !== down.name) {
      warnings.push(`${down.script.file} has no matching ${down.version}-${down.name}.sql and is ignored.`);
      continue;
    }
    up.down = down.script;
  }

  migrations.sort((a, b) => (a.up.file < b.up.file ? -1 : a.up.file > b.up.file ? 1 : 0));
  ignoredFiles.sort();
  return { migrations, ignoredFiles, warnings };
}

async function loadMcpMigrations(dir: string): Promise<LoadedMigrations> {
  const entries = await readEntries(dir);

  const byVersion = new Map<string, { name: string; up?: MigrationScript; down?: MigrationScript }>();
  const ignoredFiles: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = MIGRATION_FILE.exec(entry.name);
    if (match === null) {
      if (entry.name.toLowerCase().endsWith(".sql")) {
        ignoredFiles.push(entry.name);
      }
      continue;
    }
    const [, version, name, direction] = match as unknown as [string, string, string, "up" | "down"];

    const raw = await readFile(path.join(dir, entry.name), "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_DDL_SCRIPT_BYTES) {
      throw fileError("DDL_TOO_LARGE", `${entry.name} is over ${String(MAX_DDL_SCRIPT_BYTES)} bytes.`);
    }
    const text = normalizeScript(raw);
    const script: MigrationScript = { file: entry.name, text, checksum: checksumOf(text) };

    const slot = byVersion.get(version) ?? { name };
    if (slot.name !== name || slot[direction] !== undefined) {
      throw fileError(
        "DDL_DUPLICATE_VERSION",
        `Version ${version} is used by more than one ${direction} file (${slot[direction]?.file ?? `V${version}__${slot.name}.*`} and ${entry.name}). Each version must be unique.`
      );
    }
    slot[direction] = script;
    byVersion.set(version, slot);
  }

  const migrations: MigrationFile[] = [];
  for (const [version, slot] of byVersion) {
    if (slot.up === undefined) {
      warnings.push(`${slot.down?.file ?? version} has no matching .up.sql and is ignored.`);
      continue;
    }
    migrations.push({ version, name: slot.name, up: slot.up, ...(slot.down === undefined ? {} : { down: slot.down }) });
  }
  migrations.sort((a, b) => a.version.localeCompare(b.version));
  ignoredFiles.sort();
  return { migrations, ignoredFiles, warnings };
}

/** `YYYYMMDDHHMMSS` in UTC. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** One second after a 14-digit version, carrying across minutes, days and years correctly. */
function nextSecond(version: string): string {
  const iso = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}Z`;
  return stamp(new Date(Date.parse(iso) + 1000));
}

/**
 * The version for a new migration: now, or one second past the newest existing version if the
 * clock is behind it. A new migration must sort after everything already there, or it would be
 * out of order the moment it was written.
 */
export function nextVersion(now: Date, existing: readonly string[]): string {
  const candidate = stamp(now);
  const newest = [...existing].sort().at(-1);
  return newest !== undefined && candidate <= newest ? nextSecond(newest) : candidate;
}

/**
 * Write a new migration's files. Both are created with the `wx` flag, so an existing file is
 * never overwritten. If the down file fails, the up file is removed again, so a migration is
 * never left half-written.
 *
 * Returns the written scripts. Callers validate `up` and `down` BEFORE calling this; nothing here
 * inspects SQL.
 */
export async function writeMigrationFiles(
  dir: string,
  migration: { version: string; name: string; up: string; down?: string },
  existingVersions: readonly string[]
): Promise<{ up: MigrationScript; down?: MigrationScript }> {
  if (!MIGRATION_VERSION.test(migration.version) || !MIGRATION_NAME.test(migration.name)) {
    throw fileError("DDL_INVALID_ARGS", "A migration version must be 14 digits and a name must match ^[a-z0-9_]{1,100}$.");
  }
  if (existingVersions.includes(migration.version)) {
    throw fileError("DDL_VERSION_EXISTS", `Version ${migration.version} already exists in the migrations directory.`);
  }

  const base = `V${migration.version}__${migration.name}`;
  const write = async (file: string, text: string): Promise<MigrationScript> => {
    const normalized = normalizeScript(text);
    let handle;
    try {
      handle = await open(path.join(dir, file), "wx");
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        throw fileError("DDL_VERSION_EXISTS", `${file} already exists.`);
      }
      throw error;
    }
    try {
      await handle.writeFile(normalized.endsWith("\n") ? normalized : `${normalized}\n`, "utf8");
    } finally {
      await handle.close();
    }
    const written = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    return { file, text: written, checksum: checksumOf(written) };
  };

  const up = await write(`${base}.up.sql`, migration.up);
  if (migration.down === undefined) {
    return { up };
  }
  try {
    const down = await write(`${base}.down.sql`, migration.down);
    return { up, down };
  } catch (error) {
    await unlink(path.join(dir, up.file)).catch(() => undefined);
    throw error;
  }
}
