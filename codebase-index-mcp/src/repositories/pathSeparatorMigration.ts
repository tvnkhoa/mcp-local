/**
 * MCP-ISSUE-079: one spelling for every stored path — forward slashes.
 *
 * Until release F the pipeline stored `path.relative` output, which is backslash-separated on Windows,
 * while a few writers (dirty-mode deltas, the watcher) produced forward slashes, so one repo could hold
 * `packages\portal\…` and `packages/console/src/AskRow.vue` side by side. The pipeline now writes
 * forward slashes only (`fileScan.toPosixRelative`); this migration brings rows an older build wrote
 * into the same form, once per database.
 *
 * Why migrate rather than only let the next run prune: most ids hash the path, so a re-extracted file
 * gets new ids and the backslash rows are simply pruned as "not in this scan" — but the `.csproj` lane
 * keys its module id on a separator-canonical path (MCP-ISSUE-065), so the new row has the SAME id as
 * the old one, and writing it while the backslash row still exists is a primary-key collision that
 * fails the run. Rewriting the paths in place first makes every later write a plain replace.
 *
 * What it does, per repo, in one transaction:
 *  1. a backslash `files` row whose forward-slash twin already exists is a duplicate: its rows are
 *     deleted from every per-file table (the twin is the current one);
 *  2. every remaining backslash path is rewritten with forward slashes, and the migrated `files` rows
 *     get an empty `content_hash`, so the next run — incremental included — re-extracts them and mints
 *     their ids from the new spelling. Until then the old ids stay valid references.
 *
 * Keyed in `schema_migrations`, so it scans the tables once, not at every start-up.
 */

import type Database from "better-sqlite3";

export const PATH_SEPARATOR_MIGRATION_KEY = "mcp-issue-079-posix-paths";

/** Per-file tables and their path column. `files` is handled first and separately. */
const PATH_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["symbols", "file_path"],
  ["string_literals", "file_path"],
  ["citations", "file_path"],
  ["code_comments", "file_path"],
  ["docs", "file_path"],
  ["routes", "file_path"],
  ["pending_reindex_files", "file_path"]
];

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(table) !== undefined;
}

/** Returns the number of `files` rows rewritten (0 when already applied or nothing to do). */
export function migratePathSeparators(db: Database.Database): number {
  db.exec(`create table if not exists schema_migrations (key text primary key, applied_at text not null)`);
  if (db.prepare(`select 1 from schema_migrations where key = ?`).get(PATH_SEPARATOR_MIGRATION_KEY)) return 0;

  let rewritten = 0;
  db.transaction(() => {
    const tables = PATH_COLUMNS.filter(([table]) => tableExists(db, table));

    // 1. Duplicates: the backslash spelling of a file the forward-slash spelling already holds.
    const twins = db
      .prepare(
        `select b.repo_id as repoId, b.path as path from files b
         where instr(b.path, char(92)) > 0
           and exists (select 1 from files f where f.repo_id = b.repo_id and f.path = replace(b.path, char(92), '/'))`
      )
      .all() as { repoId: string; path: string }[];
    for (const twin of twins) {
      db.prepare(
        `delete from edges where repo_id = ? and from_id in (select symbol_id from symbols where repo_id = ? and file_path = ?)`
      ).run(twin.repoId, twin.repoId, twin.path);
      if (tableExists(db, "doc_mentions")) {
        db.prepare(
          `delete from doc_mentions where repo_id = ? and doc_id in (select doc_id from docs where repo_id = ? and file_path = ?)`
        ).run(twin.repoId, twin.repoId, twin.path);
      }
      for (const [table, column] of tables) {
        db.prepare(`delete from ${table} where repo_id = ? and ${column} = ?`).run(twin.repoId, twin.path);
      }
      db.prepare(`delete from files where repo_id = ? and path = ?`).run(twin.repoId, twin.path);
    }

    // 2. Rewrite what is left, and make the next run re-extract it.
    rewritten = db
      .prepare(`update files set path = replace(path, char(92), '/'), content_hash = '' where instr(path, char(92)) > 0`)
      .run().changes;
    for (const [table, column] of tables) {
      // `or ignore` + delete: a table keyed on the path (pending_reindex_files) may already hold the twin.
      db.prepare(`update or ignore ${table} set ${column} = replace(${column}, char(92), '/') where instr(${column}, char(92)) > 0`).run();
      db.prepare(`delete from ${table} where instr(${column}, char(92)) > 0`).run();
    }

    db.prepare(`insert into schema_migrations (key, applied_at) values (?, ?)`).run(PATH_SEPARATOR_MIGRATION_KEY, new Date().toISOString());
  })();
  return rewritten;
}
