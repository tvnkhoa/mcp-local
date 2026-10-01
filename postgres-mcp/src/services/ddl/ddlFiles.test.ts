/**
 * Tests for migration files on disk, against a real temporary directory.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checksumOf, loadMigrations, nextVersion, normalizeScript, writeMigrationFiles } from "./ddlFiles.js";

const dirs: string[] = [];
async function tempDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ddl-files-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(dir, name), text, "utf8");
  }
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("files load by version, with down scripts paired and strangers reported", async () => {
  const dir = await tempDir({
    "V20261001000002__second.up.sql": "create table b (a int);",
    "V20261001000001__first.up.sql": "create table a (a int);",
    "V20261001000001__first.down.sql": "drop table a;",
    "notes.sql": "-- not a migration",
    "README.md": "ignored silently"
  });
  await mkdir(path.join(dir, "V20261001000003__nested.up.sql"));

  const loaded = await loadMigrations(dir);
  assert.deepEqual(loaded.migrations.map((m) => `${m.version}:${m.name}:${m.down === undefined ? "up" : "up+down"}`), [
    "20261001000001:first:up+down",
    "20261001000002:second:up"
  ]);
  assert.deepEqual(loaded.ignoredFiles, ["notes.sql"]);
  assert.equal(loaded.migrations[0]?.up.file, "V20261001000001__first.up.sql");
});

test("a down file without an up file is a warning, not a migration", async () => {
  const loaded = await loadMigrations(await tempDir({ "V20261001000001__orphan.down.sql": "drop table x;" }));
  assert.deepEqual(loaded.migrations, []);
  assert.equal(loaded.warnings.length, 1);
});

test("two files claiming one version are refused", async () => {
  const dir = await tempDir({
    "V20261001000001__one.up.sql": "create table a (a int);",
    "V20261001000001__two.up.sql": "create table b (a int);"
  });
  assert.equal(await codeOf(loadMigrations(dir)), "DDL_DUPLICATE_VERSION");
});

test("an oversized file and an unreadable directory are refused with stable codes", async () => {
  const big = await tempDir({ "V20261001000001__big.up.sql": `-- ${"x".repeat(262_145)}` });
  assert.equal(await codeOf(loadMigrations(big)), "DDL_TOO_LARGE");
  assert.equal(await codeOf(loadMigrations(path.join(os.tmpdir(), "ddl-files-does-not-exist-9f3c"))), "DDL_MIGRATIONS_DIR_UNREADABLE");
});

test("the checksum ignores a BOM, CRLF line endings and trailing whitespace — and nothing else", () => {
  const base = "create table t (a int);\nalter table t add column b int;";
  assert.equal(checksumOf(`﻿${base.replace(/\n/g, "\r\n")}\r\n\r\n`), checksumOf(base));
  assert.notEqual(checksumOf(base.replace("int;", "bigint;")), checksumOf(base));
  assert.notEqual(checksumOf(`  ${base}`), checksumOf(base), "leading whitespace is content");
  assert.equal(normalizeScript("﻿a\r\nb"), "a\nb");
});

test("nextVersion is now, unless the newest existing version is not behind the clock", () => {
  const now = new Date("2026-10-01T09:30:00Z");
  assert.equal(nextVersion(now, []), "20261001093000");
  assert.equal(nextVersion(now, ["20261001093000"]), "20261001093001");
  assert.equal(nextVersion(now, ["20261231235959"]), "20270101000000", "carries across a year boundary");
  assert.equal(nextVersion(now, ["20250101000000"]), "20261001093000");
});

test("writing creates LF files, never overwrites, and rolls back a half-written migration", async () => {
  const dir = await tempDir();
  const written = await writeMigrationFiles(dir, { version: "20261001000001", name: "add_t", up: "create table t (a int);\r\n", down: "drop table t;" }, []);
  const upText = await readFile(path.join(dir, "V20261001000001__add_t.up.sql"), "utf8");
  assert.equal(upText, "create table t (a int);\n");
  assert.equal(written.up.checksum, checksumOf("create table t (a int);"));
  assert.ok(written.down !== undefined);

  assert.equal(
    await codeOf(writeMigrationFiles(dir, { version: "20261001000001", name: "add_t", up: "x" }, ["20261001000001"])),
    "DDL_VERSION_EXISTS"
  );

  // A down file already in the way: the up file written just before it must be removed again.
  await writeFile(path.join(dir, "V20261001000002__clash.down.sql"), "pre-existing", "utf8");
  assert.equal(
    await codeOf(writeMigrationFiles(dir, { version: "20261001000002", name: "clash", up: "create table c (a int);", down: "drop table c;" }, [])),
    "DDL_VERSION_EXISTS"
  );
  assert.deepEqual((await readdir(dir)).filter((f) => f.includes("clash")), ["V20261001000002__clash.down.sql"]);

  assert.equal(
    await codeOf(writeMigrationFiles(dir, { version: "2026", name: "../escape", up: "x" }, [])),
    "DDL_INVALID_ARGS"
  );
});
