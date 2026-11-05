import type Database from "better-sqlite3";

import { rebuildCommentsFtsImpl } from "./annotationsStore.js";
import { rebuildDocsFtsImpl } from "./docsStore.js";
import { rebuildLiteralsFtsImpl } from "./literalsStore.js";
import { rebuildFtsImpl } from "../services/search/symbolSearchFts.js";
import { deleteVectorsByRepo } from "./vectorStore.js";
import { immediateTransaction } from "./sqliteTx.js";
import { ftsForgetRepo } from "./scopedRunStore.js";
import { FTS_PER_FILE_META_KEY, getIndexMeta } from "./runStore.js";

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
 * external-content views over a table above; the repo's rows are forgotten before the delete (MCP-ISSUE-111).
 */
export const PURGE_EXEMPT: Record<string, string> = {
  "symbols_fts.repo_id": "external-content FTS over symbols, the repo's rows forgotten before the delete",
  "docs_fts.repo_id": "external-content FTS over docs, the repo's rows forgotten before the delete",
  "literals_fts.repo_id": "external-content FTS over string_literals, the repo's rows forgotten before the delete",
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

/**
 * Delete every row of `repoId`, then rebuild the FTS tables that mirrored it. The `repositories` row goes LAST,
 * after the vectors and the FTS rebuilds succeeded: while it exists the repo is still known, so a failure part-way
 * leaves a repo `remove_repository` can be retried on, never orphan rows no retry can reach.
 */
export function purgeRepositoryImpl(db: Database.Database, repoId: string): PurgeCounts {
  const counts: PurgeCounts = {};
  // MCP-ISSUE-111 follow-up: on a DB whose FTS is kept per file (index_meta.fts_per_file), forget only this repo's FTS
  // rows, in the delete's transaction. The all-repo rebuild held the write lock for seconds on the shared DB; it stays
  // only for a DB an older build may have left inconsistent.
  const perFile = getIndexMeta(db, FTS_PER_FILE_META_KEY) !== null;
  immediateTransaction(db, () => {
    if (perFile) ftsForgetRepo(db, repoId);
    // Children first: they are found through rows the parent delete removes.
    for (const c of CHILD_TABLES) {
      counts[c.table] = db
        .prepare(`delete from ${c.table} where ${c.key} in (select ${c.parentKey} from ${c.parent} where repo_id = ?)`)
        .run(repoId).changes;
    }
    for (const table of PURGED_BY_REPO_ID) {
      if (table === "vec_symbol_map" || table === "repositories") continue; // below: after the vectors they index / last
      counts[table] = db.prepare(`delete from ${table} where repo_id = ?`).run(repoId).changes;
    }
    for (const [table, cols] of Object.entries(PURGED_BY_CROSS_REPO_COLUMNS)) {
      counts[table] = db.prepare(`delete from ${table} where ${cols.map((c) => `${c} = ?`).join(" or ")}`).run(...cols.map(() => repoId)).changes;
    }
  })();
  const mapped = db.prepare(`select count(*) as n from vec_symbol_map where repo_id = ?`).get(repoId) as { n: number };
  deleteVectorsByRepo(db, repoId); // also clears vec_symbol_map
  counts.vec_symbol_map = mapped.n;
  if (!perFile) {
    rebuildFtsImpl(db);
    rebuildDocsFtsImpl(db);
    rebuildLiteralsFtsImpl(db);
    rebuildCommentsFtsImpl(db);
  }
  counts.repositories = db.prepare(`delete from repositories where repo_id = ?`).run(repoId).changes;
  return counts;
}

/**
 * IX-9 (MCP-ISSUE-119): drop a repo's INDEX but keep its registration — the seeded child's rows before the full run
 * that replaces a failed seed. Unlike {@link purgeRepositoryImpl} it never rebuilds an FTS table across every repo
 * (the IX-1 lock cause): the child's FTS rows were inserted per row by the seed or the run, so forgetting them per repo
 * is always consistent. The `repositories` row (path, parent link, id namespace, annotation key) stays.
 */
export function clearRepositoryIndexImpl(db: Database.Database, repoId: string): PurgeCounts {
  const counts: PurgeCounts = {};
  immediateTransaction(db, () => {
    ftsForgetRepo(db, repoId);
    for (const c of CHILD_TABLES) {
      counts[c.table] = db
        .prepare(`delete from ${c.table} where ${c.key} in (select ${c.parentKey} from ${c.parent} where repo_id = ?)`)
        .run(repoId).changes;
    }
    for (const table of PURGED_BY_REPO_ID) {
      if (table === "vec_symbol_map" || table === "repositories") continue;
      counts[table] = db.prepare(`delete from ${table} where repo_id = ?`).run(repoId).changes;
    }
    for (const [table, cols] of Object.entries(PURGED_BY_CROSS_REPO_COLUMNS)) {
      counts[table] = db.prepare(`delete from ${table} where ${cols.map((c) => `${c} = ?`).join(" or ")}`).run(...cols.map(() => repoId)).changes;
    }
  })();
  const mapped = db.prepare(`select count(*) as n from vec_symbol_map where repo_id = ?`).get(repoId) as { n: number };
  deleteVectorsByRepo(db, repoId);
  counts.vec_symbol_map = mapped.n;
  return counts;
}
