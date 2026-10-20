import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "./schema.js";
import { migratePathSeparators, PATH_SEPARATOR_MIGRATION_KEY } from "./pathSeparatorMigration.js";

/**
 * MCP-ISSUE-079: rows an older build wrote on Windows (`packages\portal\x.ts`) are rewritten to forward
 * slashes once, duplicates of an already forward-slash file are dropped, and the rewritten files are
 * marked for re-extraction. The `.csproj` case is the one that made this a migration instead of a
 * prune: its module id is separator-canonical, so a new write would collide with the old row.
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  initGraphSchema(db);
  runGraphMigrations(db, false); // applies the (empty) migration and records its key
  db.prepare(`delete from schema_migrations where key = ?`).run(PATH_SEPARATOR_MIGRATION_KEY);
  return db;
}

function seed(db: Database.Database): void {
  const file = db.prepare(`insert into files (repo_id, path, content_hash, language, updated_at) values ('r', ?, 'h', ?, 't')`);
  const symbol = db.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values ('r', ?, ?, ?, 'module', 1)`);
  file.run("Api\\Api.csproj", "csproj");
  symbol.run("canonical-csproj-id", "Api\\Api.csproj", "Api");
  file.run("packages\\portal\\a.ts", "typescript");
  symbol.run("old-a", "packages\\portal\\a.ts", "a.ts");
  db.prepare(`insert into string_literals (repo_id, literal_id, file_path, line, value, kind) values ('r', 'lit-a', 'packages\\portal\\a.ts', 1, 'hello-world', 'string')`).run();
  // Mixed state: one file stored under both spellings.
  file.run("packages/console/src/AskRow.vue", "vue");
  symbol.run("new-askrow", "packages/console/src/AskRow.vue", "AskRow.vue");
  file.run("packages\\console\\src\\AskRow.vue", "vue");
  symbol.run("old-askrow", "packages\\console\\src\\AskRow.vue", "AskRow.vue");
  db.prepare(`insert into edges (repo_id, from_id, to_id, type) values ('r', 'old-askrow', 'old-a', 'IMPORTS')`).run();
}

test("backslash paths are rewritten, twins dropped, and rewritten files queued for re-extraction", () => {
  const db = freshDb();
  seed(db);

  assert.equal(migratePathSeparators(db), 2, "the csproj and a.ts rows are rewritten; the AskRow twin is dropped");

  const files = db.prepare(`select path, content_hash as hash from files order by path`).all() as { path: string; hash: string }[];
  assert.deepEqual(files, [
    { path: "Api/Api.csproj", hash: "" },
    { path: "packages/console/src/AskRow.vue", hash: "h" },
    { path: "packages/portal/a.ts", hash: "" }
  ]);
  const symbols = db.prepare(`select symbol_id as id, file_path as path from symbols order by id`).all();
  assert.deepEqual(symbols, [
    { id: "canonical-csproj-id", path: "Api/Api.csproj" },
    { id: "new-askrow", path: "packages/console/src/AskRow.vue" },
    { id: "old-a", path: "packages/portal/a.ts" }
  ]);
  assert.equal((db.prepare(`select file_path as p from string_literals`).get() as { p: string }).p, "packages/portal/a.ts");
  assert.equal((db.prepare(`select count(*) as n from edges where from_id = 'old-askrow'`).get() as { n: number }).n, 0, "the twin's edges go with it");
});

test("the migration runs once per database", () => {
  const db = freshDb();
  seed(db);
  migratePathSeparators(db);
  db.prepare(`insert into files (repo_id, path, content_hash, language, updated_at) values ('r', 'late\\x.ts', 'h', 'typescript', 't')`).run();
  assert.equal(migratePathSeparators(db), 0, "keyed: a second call does nothing");
  assert.equal((db.prepare(`select count(*) as n from files where instr(path, char(92)) > 0`).get() as { n: number }).n, 1);
});
