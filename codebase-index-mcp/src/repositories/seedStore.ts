/**
 * IX-9 U2 (MCP-ISSUE-119): seed a worktree's index by copying its parent's rows.
 *
 * Under the id namespace (U1) a worktree that shares its parent's namespace mints the parent's ids, so the
 * copy is a plain `INSERT … SELECT` per table with `repo_id` replaced — no id is re-minted. The FTS tables
 * are filled for the child's new rowids only (never an FTS `'rebuild'`, which re-reads every repo), the
 * vectors are recomputed for the child, cross_repo_deps is left to the next full run, and one synthetic
 * `seed` run row, copied from the parent's latest ok run, is the base the git-scoped incremental diffs from.
 *
 * Interface contract: ~/.claude/handover/briefs/2026-11-04-mcp-local-ix9-parallel.md (changes only via the leader).
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { GraphStore } from "./graphStore.js";
import { ftsForgetRepo } from "./scopedRunStore.js";
import { immediateTransaction } from "./sqliteTx.js";
import { rebuildVectorIndexForRepo } from "./vectorStore.js";

export interface SeedRequest { parentRepoId: string; childRepoId: string; childRepoPath: string }
export interface SeedResult { parentIndexedSha: string; tablesCopied: Record<string, number>; durationMs: number }

export type SeedErrorCode = "PARENT_NOT_INDEXED" | "SCHEMA_UNHANDLED" | "COPY_FAILED";

export class SeedError extends Error {
  readonly code: SeedErrorCode;
  constructor(code: SeedErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SeedError";
    this.code = code;
  }
}

/**
 * What the seed does with every table of the graph DB. A table missing here makes `seedFromParent` throw
 * `SCHEMA_UNHANDLED` before it copies anything, and `seedStore.test.ts` fails on a fresh schema — so a new
 * repo-keyed table cannot be silently left behind in a seeded worktree.
 */
export const SEED_TABLES: Readonly<Record<string, { action: "copy" | "recompute" | "special" | "skip"; reason: string }>> = {
  files: { action: "copy", reason: "hashes let a later hash walk re-extract only differing files" },
  symbols: { action: "copy", reason: "ids equal under a shared namespace" },
  edges: { action: "copy", reason: "resolved ids and unresolved tokens alike" },
  routes: { action: "copy", reason: "keyed by repo + file" },
  string_literals: { action: "copy", reason: "literal_id equal under a shared namespace" },
  docs: { action: "copy", reason: "doc_id hashes the file path only" },
  doc_mentions: { action: "copy", reason: "keyed by repo + doc" },
  citations: { action: "copy", reason: "annotation key copied with them" },
  code_comments: { action: "copy", reason: "annotation key copied with them" },
  pending_reindex_files: { action: "copy", reason: "paths stale in the parent are stale in the copy too" },
  symbols_fts: { action: "recompute", reason: "external-content FTS: inserted for the child's new rowids" },
  docs_fts: { action: "recompute", reason: "external-content FTS: inserted for the child's new rowids" },
  literals_fts: { action: "recompute", reason: "external-content FTS: inserted for the child's new rowids" },
  comments_fts: { action: "recompute", reason: "external-content FTS: inserted for the child's new rowids" },
  vec_symbol_map: { action: "recompute", reason: "rebuildVectorIndexForRepo after the copy commits" },
  vec_symbols: { action: "recompute", reason: "vec0 partition, filled by rebuildVectorIndexForRepo" },
  repositories: { action: "special", reason: "child row registered; parent's annotation_key and id namespace carried" },
  index_runs: { action: "special", reason: "one synthetic seed row from the parent's latest ok run, never its history" },
  cross_repo_deps: { action: "skip", reason: "full-run-only; the next full run builds it" },
  index_meta: { action: "skip", reason: "DB-wide facts, belong to no repo" },
  schema_migrations: { action: "skip", reason: "DB-wide migration ledger" },
  refactor_previews: { action: "skip", reason: "the parent session's refactor artifacts" },
  refactor_preview_hunks: { action: "skip", reason: "the parent session's refactor artifacts" },
  refactor_applies: { action: "skip", reason: "the parent session's refactor artifacts" },
  refactor_apply_changes: { action: "skip", reason: "the parent session's refactor artifacts" },
  refactor_apply_hunks: { action: "skip", reason: "the parent session's refactor artifacts" },
  refactor_rollbacks: { action: "skip", reason: "the parent session's refactor artifacts" }
};

const FTS_FILL = [
  { fts: "symbols_fts", table: "symbols", cols: "name, signature, symbol_id, repo_id" },
  { fts: "literals_fts", table: "string_literals", cols: "value, literal_id, repo_id" },
  { fts: "comments_fts", table: "code_comments", cols: "text" },
  { fts: "docs_fts", table: "docs", cols: "text, doc_id, repo_id" }
] as const;

const COPY_ORDER = Object.entries(SEED_TABLES).filter(([, v]) => v.action === "copy").map(([k]) => k);

/**
 * The graph DB's own tables (FTS5 and vec0 shadow tables excluded) that `SEED_TABLES` does not name.
 * Empty on a schema the seed fully handles.
 */
export function unhandledSeedTables(db: Database.Database): string[] {
  const names = (db.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);
  const virtuals = new Set(
    (db.prepare(`select name from sqlite_master where type = 'table' and sql like 'create virtual table%' collate nocase`).all() as { name: string }[]).map((r) => r.name)
  );
  const isShadow = (n: string): boolean => [...virtuals].some((v) => n.startsWith(`${v}_`));
  return names.filter((n) => !(n in SEED_TABLES) && !isShadow(n)).sort();
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`select name from pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(table) !== undefined;
}

/** Forget the child's FTS rows, then delete its rows, so a re-seed starts from nothing. */
function clearChild(db: Database.Database, childRepoId: string): void {
  ftsForgetRepo(db, childRepoId);
  for (const table of COPY_ORDER) db.prepare(`delete from "${table}" where repo_id = ?`).run(childRepoId);
  db.prepare(`delete from index_runs where repo_id = ?`).run(childRepoId);
}

/** The parent run a seed copies: its newest ok run with a commit. The ancestry check reads the same row. */
function seedBaseRun(db: Database.Database, parentRepoId: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `select * from index_runs where repo_id = ? and status = 'ok' and mode in ('full', 'incremental', 'dirty', 'seed') and commit_sha is not null
       order by started_at desc limit 1`
    )
    .get(parentRepoId) as Record<string, unknown> | undefined;
}

/** The commit `seedFromParentDb` would seed from (the job's ancestry check), or null when the parent has no such run. */
export function seedBaseRunSha(db: Database.Database, parentRepoId: string): string | null {
  const run = seedBaseRun(db, parentRepoId);
  return run ? String(run.commit_sha) : null;
}

export function seedFromParentDb(db: Database.Database, req: SeedRequest): SeedResult {
  const started = Date.now();
  const { parentRepoId, childRepoId, childRepoPath } = req;
  if (parentRepoId === childRepoId) throw new SeedError("COPY_FAILED", `cannot seed ${childRepoId} from itself`);

  const unhandled = unhandledSeedTables(db);
  if (unhandled.length > 0) throw new SeedError("SCHEMA_UNHANDLED", `seed does not handle table(s): ${unhandled.join(", ")}`);

  const parent = db
    .prepare(`select annotation_key as annotationKey, coalesce(id_namespace, repo_id) as ns from repositories where repo_id = ?`)
    .get(parentRepoId) as { annotationKey: string | null; ns: string } | undefined;
  const baseRun = parent ? seedBaseRun(db, parentRepoId) : undefined;
  if (!parent || !baseRun) throw new SeedError("PARENT_NOT_INDEXED", `parent ${parentRepoId} has no ok index run with a commit`);
  const parentIndexedSha = String(baseRun.commit_sha);

  const tablesCopied: Record<string, number> = {};
  try {
    immediateTransaction(db, () => {
      db.prepare(
        `insert into repositories (repo_id, repo_path, updated_at, annotation_key, id_namespace) values (?, ?, ?, ?, ?)
         on conflict(repo_id) do update set repo_path = excluded.repo_path, updated_at = excluded.updated_at,
           annotation_key = excluded.annotation_key, id_namespace = excluded.id_namespace`
      ).run(childRepoId, childRepoPath, new Date().toISOString(), parent.annotationKey, parent.ns === childRepoId ? null : parent.ns);

      clearChild(db, childRepoId);

      for (const table of COPY_ORDER) {
        if (!tableExists(db, table)) continue;
        const cols = columnsOf(db, table);
        const list = cols.map((c) => `"${c}"`).join(", ");
        const select = cols.map((c) => (c === "repo_id" ? "?" : `"${c}"`)).join(", ");
        // In the parent's rowid order: rowid is the tie-break of equal-ranked answers, and a scan by the repo_id index
        // would hand the rows over in index order (measured: a probe's 5th hit differed from a full run).
        tablesCopied[table] = db.prepare(`insert into "${table}" (${list}) select ${select} from "${table}" where repo_id = ? order by rowid`).run(childRepoId, parentRepoId).changes;
      }

      for (const t of FTS_FILL) {
        tablesCopied[t.fts] = db.prepare(`insert into ${t.fts}(rowid, ${t.cols}) select rowid, ${t.cols} from ${t.table} where repo_id = ?`).run(childRepoId).changes;
      }

      const runCols = columnsOf(db, "index_runs");
      const values = runCols.map((c) => (c === "run_id" ? randomUUID() : c === "repo_id" ? childRepoId : c === "mode" ? "seed" : baseRun[c]));
      db.prepare(`insert into index_runs (${runCols.map((c) => `"${c}"`).join(", ")}) values (${runCols.map(() => "?").join(", ")})`).run(...(values as unknown[]));
      tablesCopied.index_runs = 1;
    })();
  } catch (err) {
    throw new SeedError("COPY_FAILED", `seed copy ${parentRepoId} -> ${childRepoId} rolled back: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  try {
    tablesCopied.vec_symbol_map = rebuildVectorIndexForRepo(db, childRepoId);
  } catch (err) {
    throw new SeedError("COPY_FAILED", `seed vectors for ${childRepoId} failed after the copy: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  return { parentIndexedSha, tablesCopied, durationMs: Date.now() - started };
}

/** Runs on the caller's connection, which must be the single writer's (the index job executor). */
export function seedFromParent(store: GraphStore, req: SeedRequest): SeedResult {
  return store.seedFromParent(req);
}
