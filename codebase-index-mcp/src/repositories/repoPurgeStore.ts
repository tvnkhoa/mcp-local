import type Database from "better-sqlite3";

import { rebuildCommentsFtsImpl } from "./annotationsStore.js";
import { rebuildDocsFtsImpl } from "./docsStore.js";
import { rebuildLiteralsFtsImpl } from "./literalsStore.js";
import { rebuildFtsImpl } from "../services/search/symbolSearchFts.js";
import { deleteVectorsByRepo } from "./vectorStore.js";

/**
 * MCP-ISSUE-105: drop one registered repo from the index.
 *
 * Every table with a repo-keyed column is named here, in exactly one of three places, and
 * `repoPurgeStore.test.ts` fails when the schema grows a repo-keyed table that is in none of them.
 * Tables with no repo column of their own (refactor hunks, changes, rollbacks) are reached through the
 * preview / apply they belong to.
 */

/** Tables deleted by a plain `repo_id = ?`. */
export const PURGED_BY_REPO_ID = [
  "edges",
  "symbols",
  "files",
  "index_runs",
  "docs",
  "doc_mentions",
  "routes",
  "string_literals",
  "citations",
  "code_comments",
  "pending_reindex_files",
  "refactor_previews",
  "refactor_applies",
  "vec_symbol_map",
  "repositories"
] as const;

/** `cross_repo_deps` is keyed on both ends; a link INTO the repo points at symbols that are gone too. */
export const PURGED_BY_CROSS_REPO_COLUMNS = { cross_repo_deps: ["from_repo_id", "to_repo_id"] } as const;

/**
 * Columns named `repo_id` that are deliberately not deleted from, with the reason. FTS5 tables are
 * external-content views over a table above; they are rebuilt after the delete, not edited row by row.
 */
export const PURGE_EXEMPT: Record<string, string> = {
  "symbols_fts.repo_id": "external-content FTS over symbols, rebuilt after the delete",
  "docs_fts.repo_id": "external-content FTS over docs, rebuilt after the delete",
  "literals_fts.repo_id": "external-content FTS over string_literals, rebuilt after the delete",
  "vec_symbols.repo_id": "sqlite-vec partition key, deleted by deleteVectorsByRepo"
};

/** Tables reached through a parent row, and the parent's key column. */
const CHILD_TABLES: ReadonlyArray<{ table: string; key: string; parent: string; parentKey: string }> = [
  { table: "refactor_preview_hunks", key: "preview_id", parent: "refactor_previews", parentKey: "preview_id" },
  { table: "refactor_apply_changes", key: "apply_id", parent: "refactor_applies", parentKey: "apply_id" },
  { table: "refactor_apply_hunks", key: "apply_id", parent: "refactor_applies", parentKey: "apply_id" },
  { table: "refactor_rollbacks", key: "apply_id", parent: "refactor_applies", parentKey: "apply_id" }
];

export type PurgeCounts = Record<string, number>;

/** Delete every row of `repoId` in one transaction, then rebuild the FTS tables that mirrored it. */
export function purgeRepositoryImpl(db: Database.Database, repoId: string): PurgeCounts {
  const counts: PurgeCounts = {};
  db.transaction(() => {
    // Children first: they are found through rows the parent delete removes.
    for (const c of CHILD_TABLES) {
      counts[c.table] = db
        .prepare(`delete from ${c.table} where ${c.key} in (select ${c.parentKey} from ${c.parent} where repo_id = ?)`)
        .run(repoId).changes;
    }
    for (const table of PURGED_BY_REPO_ID) {
      if (table === "vec_symbol_map") continue; // below, with the vectors it indexes
      counts[table] = db.prepare(`delete from ${table} where repo_id = ?`).run(repoId).changes;
    }
    for (const [table, cols] of Object.entries(PURGED_BY_CROSS_REPO_COLUMNS)) {
      counts[table] = db.prepare(`delete from ${table} where ${cols.map((c) => `${c} = ?`).join(" or ")}`).run(...cols.map(() => repoId)).changes;
    }
  })();
  const mapped = db.prepare(`select count(*) as n from vec_symbol_map where repo_id = ?`).get(repoId) as { n: number };
  deleteVectorsByRepo(db, repoId); // also clears vec_symbol_map
  counts.vec_symbol_map = mapped.n;
  rebuildFtsImpl(db);
  rebuildDocsFtsImpl(db);
  rebuildLiteralsFtsImpl(db);
  rebuildCommentsFtsImpl(db);
  return counts;
}
