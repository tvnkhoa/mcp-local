/**
 * IX-9 U2 (MCP-ISSUE-119): seed a worktree's index by copying its parent's rows.
 *
 * Under the id namespace (U1) a worktree that shares its parent's namespace mints the parent's ids, so the
 * copy is a plain `INSERT … SELECT` per table with `repo_id` replaced — no id is re-minted. The FTS tables
 * are filled for the child's new rowids only (never an FTS `'rebuild'`, which re-reads every repo), the
 * vectors are recomputed for the child, cross_repo_deps is left to the next full run, and one synthetic
 * `seed` run row, copied from the parent's latest ok run, is the base the git-scoped incremental diffs from.
 * A parent whose rows mix INDEX_VERSIONs is refused (MCP-ISSUE-130 finding 2, `parentFullBaseVersion`); the job runs full.
 *
 * Interface contract: ~/.claude/handover/briefs/2026-11-04-mcp-local-ix9-parallel.md (changes only via the leader).
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { GraphStore } from "./graphStore.js";
import { getLatestFullRunVersion, listRecentWorkRuns } from "./runStore.js";
import { ftsForgetRepo } from "./scopedRunStore.js";
import { immediateTransaction } from "./sqliteTx.js";
import { rebuildVectorIndexForRepo } from "./vectorStore.js";

export interface SeedRequest { parentRepoId: string; childRepoId: string; childRepoPath: string }
export interface SeedResult { parentIndexedSha: string; tablesCopied: Record<string, number>; durationMs: number }

export type SeedErrorCode = "PARENT_NOT_INDEXED" | "PARENT_UNVOUCHED" | "PARENT_BUSY" | "SCHEMA_UNHANDLED" | "COPY_FAILED";

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

/**
 * IX-9 review H1/M1: what the parent's index holds, vouched for the way `planGitScopedIncremental` vouches for a scoped
 * run. Walk the parent's WORK runs (fast-skips left out), newest first in the planner's order, to the newest complete
 * one (full / incremental / seed) — the base. Every run on the way must have ended ok, and a dirty one must name its
 * paths (tree key): a failed or cancelled run may have committed batches of newer content, which a seed labelled with
 * the base's commit would carry into the child where the child's git-scoped run never re-reads them. The paths those
 * dirty runs wrote (working-tree content, not the base commit's) are carried into the seed row's tree key, so the
 * child's first scoped run re-reads them. A run that overlapped the base's window must be a keyed ok dirty run too.
 */
export type SeedBase =
  | { ok: true; run: Record<string, unknown>; commitSha: string; carried: Record<string, string> }
  | { ok: false; reason: string };

const WORK_RUN_LIMIT = 200;

function treeKeyFiles(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const key = JSON.parse(raw) as { files?: Record<string, string> };
    return key && typeof key === "object" ? (key.files ?? {}) : null;
  } catch {
    return null;
  }
}

export function seedBaseOf(db: Database.Database, parentRepoId: string): SeedBase {
  const runs = db
    .prepare(
      `select * from index_runs where repo_id = ? and skip_reason is null
       order by finished_at desc, started_at desc, rowid desc limit ?`
    )
    .all(parentRepoId, WORK_RUN_LIMIT) as Array<Record<string, unknown>>;
  const carried: Record<string, string> = {};
  const carry = (run: Record<string, unknown>): string | null => {
    if (run.status !== "ok") return `a ${String(run.mode)} run since the last complete one ended ${String(run.status)}`;
    const files = treeKeyFiles(run.tree_key);
    if (!files && (run.mode === "dirty" || run.tree_dirty === 1)) return `a ${String(run.mode)} run over a dirty tree recorded no tree key`;
    Object.assign(carried, files ?? {});
    return null;
  };
  let at = 0;
  let base: Record<string, unknown> | null = null;
  for (; at < runs.length; at++) {
    const run = runs[at]!;
    const refused = carry(run);
    if (refused) return { ok: false, reason: refused };
    if (run.mode === "full" || run.mode === "incremental" || run.mode === "seed") {
      base = run;
      break;
    }
  }
  if (!base) return { ok: false, reason: "no complete run on record" };
  if (!base.started_at) return { ok: false, reason: "the last complete run recorded no start time" };
  for (const run of runs.slice(at + 1)) {
    if (!run.finished_at || String(run.finished_at) <= String(base.started_at)) break;
    if (run.mode !== "dirty") return { ok: false, reason: `a ${String(run.mode)} run overlapped the last complete one` };
    const refused = carry(run);
    if (refused) return { ok: false, reason: refused };
  }
  if (!base.commit_sha) return { ok: false, reason: "the last complete run recorded no commit" };
  // MCP-ISSUE-130 finding 2: the base may be a newer-version incremental over an older full build (wec.aria run 339b6b3a).
  // Its version on the seed row hides the older rows from the child's escalation; the full build's version would hide the
  // newer rows from a newer-build refusal. A mixed parent is not vouched for, so the job indexes the child full.
  const builtBy = parentFullBaseVersion(db, parentRepoId);
  const baseVersion = typeof base.index_version === "string" ? base.index_version : null;
  if (builtBy !== baseVersion) {
    return {
      ok: false,
      reason: `its rows mix index versions (fully built by ${builtBy ?? "no full run on record"}, last complete run by ${baseVersion ?? "an unrecorded INDEX_VERSION"}); a seed would copy the mix`
    };
  }
  return { ok: true, run: base, commitSha: String(base.commit_sha), carried };
}

/** The commit `seedFromParentDb` would seed from (the job's ancestry check), or null when the parent cannot be vouched for. */
export function seedBaseRunSha(db: Database.Database, parentRepoId: string): string | null {
  const base = seedBaseOf(db, parentRepoId);
  return base.ok ? base.commitSha : null;
}

/**
 * `GIT_SCOPE_RUN_LOOKBACK` in `services/indexing/runPolicy.ts`, mirrored so this repository module does not import the
 * indexing pipeline; `seedStore.test.ts` asserts the two agree.
 */
export const FULL_BASE_LOOKBACK = 50;

/**
 * MCP-ISSUE-130 open item (2): the INDEX_VERSION that built the parent's rows, by the rule `versionEscalationFor`
 * applies — the newest ok `full` or `seed` run among the recent work runs, else the latest ok full run. The seed is
 * refused when it differs from the base run's version: the base may be an incremental run stamped with a newer version
 * over an older full build (wec.aria run 339b6b3a). Null when the parent has no full build on record.
 */
export function parentFullBaseVersion(db: Database.Database, parentRepoId: string): string | null {
  const recent = listRecentWorkRuns(db, parentRepoId, FULL_BASE_LOOKBACK);
  const newest = recent.find((r) => r.status === "ok" && (r.mode === "full" || r.mode === "seed"));
  return newest ? newest.indexVersion : getLatestFullRunVersion(db, parentRepoId);
}

/** The seed row's tree key: the base's own key with the carried dirty paths as its files (null when neither exists). */
function seedTreeKey(base: Record<string, unknown>, carried: Record<string, string>): { key: string | null; dirty: number } {
  let key: Record<string, unknown> | null = null;
  if (typeof base.tree_key === "string" && base.tree_key) {
    try {
      key = JSON.parse(base.tree_key) as Record<string, unknown>;
    } catch {
      key = null;
    }
  }
  const dirty = Object.keys(carried).length > 0;
  if (!key && !dirty) return { key: null, dirty: Number(base.tree_dirty ?? 0) };
  return { key: JSON.stringify({ ...(key ?? { head: base.commit_sha }), files: carried }), dirty: dirty ? 1 : 0 };
}

/**
 * `guard` (review (b)) runs first inside the IMMEDIATE transaction: a reason to refuse that only the caller can see
 * (the parent's run markers / repair flag, shared by every process on the DB). Checked under the write lock, no batch of
 * another process's parent run can commit between it and the copy.
 */
export function seedFromParentDb(db: Database.Database, req: SeedRequest, guard?: () => string | null): SeedResult {
  const started = Date.now();
  const { parentRepoId, childRepoId, childRepoPath } = req;
  if (parentRepoId === childRepoId) throw new SeedError("COPY_FAILED", `cannot seed ${childRepoId} from itself`);

  const unhandled = unhandledSeedTables(db);
  if (unhandled.length > 0) throw new SeedError("SCHEMA_UNHANDLED", `seed does not handle table(s): ${unhandled.join(", ")}`);

  const parent = db
    .prepare(`select annotation_key as annotationKey, coalesce(id_namespace, repo_id) as ns from repositories where repo_id = ?`)
    .get(parentRepoId) as { annotationKey: string | null; ns: string } | undefined;
  if (!parent || !db.prepare(`select 1 from index_runs where repo_id = ? limit 1`).get(parentRepoId)) {
    throw new SeedError("PARENT_NOT_INDEXED", `parent ${parentRepoId} has no index run`);
  }
  let parentIndexedSha = "";

  const tablesCopied: Record<string, number> = {};
  try {
    immediateTransaction(db, () => {
      const busy = guard?.() ?? null;
      if (busy) throw new SeedError("PARENT_BUSY", `parent ${parentRepoId} cannot be seeded from now: ${busy}`);
      // Review H1: vouched inside the write transaction, so no run of this DB can land between the check and the copy.
      const vouched = seedBaseOf(db, parentRepoId);
      if (!vouched.ok) throw new SeedError("PARENT_UNVOUCHED", `parent ${parentRepoId} cannot be vouched for: ${vouched.reason}`);
      const baseRun = vouched.run;
      parentIndexedSha = vouched.commitSha;
      const treeKey = seedTreeKey(baseRun, vouched.carried);
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
      const values = runCols.map((c) =>
        c === "run_id" ? randomUUID() : c === "repo_id" ? childRepoId : c === "mode" ? "seed" : c === "tree_key" ? treeKey.key : c === "tree_dirty" ? treeKey.dirty : baseRun[c]
      );
      db.prepare(`insert into index_runs (${runCols.map((c) => `"${c}"`).join(", ")}) values (${runCols.map(() => "?").join(", ")})`).run(...(values as unknown[]));
      tablesCopied.index_runs = 1;
    })();
  } catch (err) {
    if (err instanceof SeedError) throw err;
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
