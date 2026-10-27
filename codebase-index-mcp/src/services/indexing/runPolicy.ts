/**
 * The decisions an index run makes before it does any work: should this run be
 * skipped, which performance profile applies, and what a zero-work run reports.
 *
 * Separated from `indexRunner.ts` because nothing here writes: they read the store
 * and query git, then return a decision. That makes them the part of a run that can
 * be exercised without starting the parser pool or opening a write transaction.
 *
 * Moved out of `src/index.ts` in migration step S-26. The bodies are unchanged; what
 * differs is that `store` is now an explicit first parameter instead of a closed-over
 * module global, and `resolvePerformanceProfileDecision` receives the already-parsed
 * env override rather than reading `process.env` itself. Its caller resolves that
 * value per run, so the read happens exactly as late as it did before.
 */

import { randomUUID } from "node:crypto";

import { collectDirtyFiles, diffNameStatusSince, hasWorkingTreeChanges, resolveHeadCommitSha, runGit, type NameStatusEntry } from "../git/gitHelpers.js";
import { parseTreeKey } from "../../middleware/freshness.js";
import type { GraphStore } from "../../repositories/graphStore.js";
import { INDEX_VERSION, SCOPE_FORCES_FULL_RUN, currentAnnotationKey, type PerformanceProfile } from "./indexPipeline.js";
import type { WorkRunTrace } from "../../repositories/runStore.js";
import type { IndexMode, IndexRunResult, ResolutionStats } from "../../types/index.js";

export interface IncrementalSkipDecision {
  shouldSkip: boolean;
  reason: string;
  headCommitSha: string | null;
  indexVersion: string;
}

export interface PerformanceProfileDecision {
  profile: PerformanceProfile;
  source: "env" | "auto";
  reason: string;
  fileCount: number;
  symbolCount: number;
}

/** The generation number of an INDEX_VERSION (v7-text-json-html-svg is 7), or null for a foreign shape. */
export function indexGeneration(version: string | null | undefined): number | null {
  const m = /^v(\d+)\b/.exec(version ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Release F: several server processes share one index DB, and each refreshes on query (R1). A
 * process still running an older build re-indexed wec.aria in its own older format over a newer
 * build's run — backslash paths and a missing lane came back. A server must never write over an
 * index a NEWER build wrote; it says so, and the fix is restarting that server.
 * Returns the refusal reason, or null when this build may write.
 */
export function newerBuildRefusal(latestRunVersion: string | null | undefined, own: string = INDEX_VERSION): string | null {
  const theirs = indexGeneration(latestRunVersion);
  const ours = indexGeneration(own);
  if (theirs === null || ours === null || theirs <= ours) return null;
  return `this repo's index was written by a newer codebase-index build (${String(latestRunVersion)}); this server runs ${own} and will not write over it. Restart this MCP server to load the newer build.`;
}

/** Unresolved call rows from which a non-full run still drops the edge indexes for its resolve. */
export const BULK_RESOLVE_INDEX_DROP_MIN_ROWS = 50_000;

/**
 * Whether the call-resolve pass drops the four secondary `edges` indexes first (release I1b).
 * A full run does, as before; a dirty or incremental run only when it resolves a bulk population.
 * The indexes are DB-wide, so a drop slows every concurrent reader in every server process, and
 * rebuilding them over the whole table outweighs maintaining them through a few thousand UPDATEs.
 */
export function shouldDropEdgeIndexesForResolve(mode: IndexMode, unresolvedRows: number): boolean {
  return mode === "full" || unresolvedRows >= BULK_RESOLVE_INDEX_DROP_MIN_ROWS;
}

/**
 * Zero-metric IndexRunSummary for a run that did no work (dirty mode with a clean tree,
 * or an incremental run that skipped). Shared so the two skip paths can't drift as the
 * summary schema evolves.
 */
export function buildSkippedRunSummary(opts: {
  repoId: string;
  mode: IndexMode;
  commitSha: string | null;
  branch: string | null;
  indexVersion: string;
  skipReason: string;
}): IndexRunResult {
  const now = new Date().toISOString();
  return {
    runId: randomUUID(),
    repoId: opts.repoId,
    commitSha: opts.commitSha,
    branch: opts.branch,
    indexVersion: opts.indexVersion,
    mode: opts.mode,
    status: "ok",
    startedAt: now,
    finishedAt: now,
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    symbolsUpserted: 0,
    edgesUpserted: 0,
    docsUpserted: 0,
    mentionsUpserted: 0,
    parseFailures: 0,
    parseTimeouts: 0,
    elapsedMs: 0,
    crossRepoLinked: 0,
    callEdgesResolved: 0,
    callEdgesAttempted: 0,
    callEdgesUnresolved: 0,
    unresolvedCallsTotal: 0,
    resolveCallsCoverage: 1,
    importEdgesResolved: 0,
    mentionsResolved: 0,
    crossRepoAttempts: 0,
    crossRepoResolved: 0,
    unresolvedNoCandidate: 0,
    unresolvedAmbiguous: 0,
    unresolvedBoundaryBlocked: 0,
    unresolvedLowConfidence: 0,
    skipReason: opts.skipReason
  };
}

export function evaluateIncrementalSkip(
  store: GraphStore,
  repoId: string,
  repoPath: string
): IncrementalSkipDecision {
  const latestRun = store.getLatestRun(repoId);
  if (!latestRun?.commitSha) {
    return {
      shouldSkip: false,
      reason: "no previous indexed commit",
      headCommitSha: null,
      indexVersion: latestRun?.indexVersion ?? INDEX_VERSION
    };
  }

  // ISSUE-023: schema/lane version bump (vd. v1 → v2-string-literals) phải vô hiệu skip,
  // nếu không repo đã index sẽ không bao giờ populate lane mới dù HEAD không đổi.
  if (latestRun.indexVersion !== INDEX_VERSION) {
    return {
      shouldSkip: false,
      reason: `index version changed (${latestRun.indexVersion} → ${INDEX_VERSION})`,
      headCommitSha: resolveHeadCommitSha(repoPath),
      indexVersion: INDEX_VERSION
    };
  }

  // A clean tree at the indexed commit proves nothing when the last run that did work was `dirty`:
  // the index then holds working-tree content, and a file indexed while dirty and since deleted or
  // reverted is still in the graph. Skipping here is how wec.aria's release-B acceptance found a
  // deleted probe file still answering with coverage "high".
  // Release L (MCP-ISSUE-095): the same holds after a full or incremental run that indexed a dirty tree.
  if (store.getLatestWorkRunMode(repoId) === "dirty" || store.getLatestWorkRunTreeDirty(repoId)) {
    return {
      shouldSkip: false,
      reason: "the index holds working-tree content from a dirty run",
      headCommitSha: resolveHeadCommitSha(repoPath),
      indexVersion: latestRun.indexVersion ?? INDEX_VERSION
    };
  }

  // Release C: a new annotation scanner or an edited citations.json must reach unchanged files, which
  // only a run that is not skipped can do.
  if (store.getAnnotationKey(repoId) !== currentAnnotationKey(repoPath)) {
    return {
      shouldSkip: false,
      reason: "citation patterns or the annotation scanner changed since the last full scan",
      headCommitSha: resolveHeadCommitSha(repoPath),
      indexVersion: latestRun.indexVersion ?? INDEX_VERSION
    };
  }

  const headCommitSha = resolveHeadCommitSha(repoPath);
  if (!headCommitSha) {
    return {
      shouldSkip: false,
      reason: "unable to resolve HEAD",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  if (latestRun.commitSha !== headCommitSha) {
    return {
      shouldSkip: false,
      reason: "index commit differs from HEAD",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  const dirtyState = hasWorkingTreeChanges(repoPath);
  if (dirtyState === true) {
    return {
      shouldSkip: false,
      reason: "working tree has uncommitted changes",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  if (dirtyState === null) {
    return {
      shouldSkip: false,
      reason: "unable to resolve working tree state",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  return {
    shouldSkip: true,
    reason: "head unchanged and working tree clean",
    headCommitSha,
    indexVersion: latestRun.indexVersion
  };
}

/**
 * `configured` is the already-parsed `CODEBASE_INDEX_LARGE_REPO_PROFILE` value.
 * It arrives as an argument rather than being read from `process.env` here so that
 * env access stays in the entry point — the runner resolves it per run, so the
 * read is still as late as it was when this function owned it.
 */
export function resolvePerformanceProfileDecision(
  store: GraphStore,
  configured: PerformanceProfile | "auto",
  repoId: string,
  mode: IndexMode,
  maxFiles: number
): PerformanceProfileDecision {
  if (configured !== "auto") {
    const snap = store.getRepoSchemaSnapshot(repoId);
    return {
      profile: configured,
      source: "env",
      reason: "explicit override",
      fileCount: snap.fileCount,
      symbolCount: snap.symbolCount
    };
  }

  const snapshot = store.getRepoSchemaSnapshot(repoId);
  const estimatedFileCount = snapshot.fileCount;
  const estimatedSymbolCount = snapshot.symbolCount;

  if (estimatedFileCount === 0 && estimatedSymbolCount === 0) {
    if (mode === "full" && maxFiles >= 8000) {
      return {
        profile: "large",
        source: "auto",
        reason: "cold-start full index with high maxFiles",
        fileCount: estimatedFileCount,
        symbolCount: estimatedSymbolCount
      };
    }
    return {
      profile: "standard",
      source: "auto",
      reason: "cold-start fallback",
      fileCount: estimatedFileCount,
      symbolCount: estimatedSymbolCount
    };
  }

  if (estimatedFileCount >= 8000 || estimatedSymbolCount >= 60000) {
    return {
      profile: "very-large",
      source: "auto",
      reason: "snapshot scale threshold",
      fileCount: estimatedFileCount,
      symbolCount: estimatedSymbolCount
    };
  }
  if (estimatedFileCount >= 3000 || estimatedSymbolCount >= 20000) {
    return {
      profile: "large",
      source: "auto",
      reason: "snapshot scale threshold",
      fileCount: estimatedFileCount,
      symbolCount: estimatedSymbolCount
    };
  }
  return {
    profile: "standard",
    source: "auto",
    reason: "snapshot scale threshold",
    fileCount: estimatedFileCount,
    symbolCount: estimatedSymbolCount
  };
}

export function safeCrossRepoResolve(store: GraphStore, repoId: string): ResolutionStats {
  try {
    return store.resolveUnlinkedEdges(repoId);
  } catch {
    return {
      attempts: 0,
      resolved: 0,
      unresolvedByReason: {
        no_candidate: 0,
        ambiguous_candidates: 0,
        boundary_blocked: 0,
        low_confidence: 0
      }
    };
  }
}

/**
 * MCP-ISSUE-106: above this many paths a git-scoped incremental run walks the whole tree instead. The scoped run
 * re-extracts each path plus its dependents (escalating past `SCOPE_DEPENDENTS_CAP`); a diff this large is a branch
 * switch, where the hash walk is the cheaper way to find what really differs.
 */
export const GIT_SCOPE_MAX_PATHS = 500;

/** How far back `planGitScopedIncremental` looks for the run it diffs against. */
export const GIT_SCOPE_RUN_LOOKBACK = 50;

/**
 * Paths whose change alters WHICH files are indexed (git's ignore rules, the index's own config) or how every file
 * resolves (`SCOPE_FORCES_FULL_RUN`): a diff cannot name the files such a change affects.
 */
const GIT_SCOPE_FORCES_WALK = /(^|\/)(\.gitignore|\.gitattributes)$|(^|\/)\.codebase-index\//;

export type GitScopeInputs = {
  /** Work runs, newest first (`listRecentWorkRuns`). */
  runs: readonly WorkRunTrace[];
  /** `git diff --name-status <base> HEAD` for the base this function picks; called at most once. Null: git cannot diff. */
  diffSince: (sha: string) => NameStatusEntry[] | null;
  /** The working tree's dirty set now: staged, unstaged, untracked (both sides of a rename). */
  dirtyNow: readonly string[];
  /** Files the refactor engine wrote (MCP-ISSUE-042), re-read whatever git says. */
  pending: readonly string[];
  /** False when the scan does not take its file list from git (`respectGitignore: false`). */
  gitScan: boolean;
  /** The repo root is above repoPath: git prints root-relative paths, the index stores repoPath-relative ones. */
  subdirectory: boolean;
  annotationKeyCurrent: boolean;
  indexVersion?: string;
  maxPaths?: number;
};

export type GitScopePlan =
  | { kind: "scoped"; baseSha: string; paths: Set<string>; diffPaths: number; carriedDirty: number }
  | { kind: "walk"; reason: string };

/**
 * MCP-ISSUE-106: the files an incremental run must re-read, from git instead of hashing every file.
 *
 * The base is the newest ok `full`/`incremental` run. After it the index holds its commit's content for every file
 * but the ones it found dirty (its tree key), which it read from the working tree. Every later run must be an ok
 * `dirty` run, which wrote only the paths in its own tree key. So the files whose indexed content can differ from
 * disk are: what changed between the base commit and HEAD, what is dirty now, and every path any of those runs
 * indexed while dirty — a file dirty then and since reverted is in neither of the first two. A scoped incremental
 * run is itself a base: it re-read that whole union, so the induction holds back to the last full walk.
 *
 * Anything this cannot vouch for walks the tree: a non-ok or unkeyed run since the base (a cancelled run wrote an
 * unknown subset), a base at another INDEX_VERSION, a commit git no longer has, an ignore-rule or config change, or
 * more than `maxPaths` paths.
 */
export function planGitScopedIncremental(i: GitScopeInputs): GitScopePlan {
  if (!i.gitScan) return { kind: "walk", reason: "the scan does not take its file list from git" };
  if (i.subdirectory) return { kind: "walk", reason: "repoPath is a subdirectory of its git repo" };
  if (!i.annotationKeyCurrent) return { kind: "walk", reason: "the annotation key changed: unchanged files must be re-scanned" };
  const carried = new Set<string>();
  let base: WorkRunTrace | null = null;
  for (const run of i.runs) {
    if (run.status !== "ok") return { kind: "walk", reason: `a ${run.mode} run since the last complete one ended ${run.status}` };
    const key = parseTreeKey(run.treeKey);
    if (!key && (run.mode === "dirty" || run.treeDirty)) return { kind: "walk", reason: `a ${run.mode} run over a dirty tree recorded no tree key` };
    for (const p of Object.keys(key?.files ?? {})) carried.add(p);
    if (run.mode === "full" || run.mode === "incremental") {
      base = run;
      break;
    }
  }
  if (!base) return { kind: "walk", reason: "no complete run on record to diff against" };
  if (!base.commitSha) return { kind: "walk", reason: "the last complete run recorded no commit" };
  if (base.indexVersion !== (i.indexVersion ?? INDEX_VERSION)) return { kind: "walk", reason: `index version changed (${base.indexVersion ?? "none"})` };
  const diff = i.diffSince(base.commitSha);
  if (!diff) return { kind: "walk", reason: `git cannot diff ${base.commitSha.slice(0, 12)}..HEAD (gc'd, shallow, or unborn HEAD)` };
  const paths = new Set<string>();
  for (const e of diff) {
    paths.add(e.path);
    if (e.origPath) paths.add(e.origPath);
  }
  const diffPaths = paths.size;
  for (const p of carried) paths.add(p);
  for (const p of i.dirtyNow) paths.add(p);
  for (const p of i.pending) paths.add(p);
  for (const p of paths) {
    if (GIT_SCOPE_FORCES_WALK.test(p) || SCOPE_FORCES_FULL_RUN.test(p)) {
      return { kind: "walk", reason: `${p} changed: it can change which files are indexed or how they resolve` };
    }
  }
  const cap = i.maxPaths ?? GIT_SCOPE_MAX_PATHS;
  if (paths.size > cap) return { kind: "walk", reason: `${String(paths.size)} paths changed (cap ${String(cap)})` };
  return { kind: "scoped", baseSha: base.commitSha, paths, diffPaths, carriedDirty: carried.size };
}

/** {@link planGitScopedIncremental} over the store and git. */
export function planGitScopedIncrementalFor(
  store: GraphStore,
  repoId: string,
  repoPath: string,
  opts: { respectGitignore?: boolean } = {}
): GitScopePlan {
  let prefix: string;
  try {
    prefix = runGit(repoPath, ["rev-parse", "--show-prefix"]);
  } catch {
    return { kind: "walk", reason: "not a git repository" };
  }
  return planGitScopedIncremental({
    runs: store.listRecentWorkRuns(repoId, GIT_SCOPE_RUN_LOOKBACK),
    diffSince: (sha) => diffNameStatusSince(repoPath, sha),
    dirtyNow: [...collectDirtyFiles(repoPath)],
    pending: store.getPendingReindexFiles(repoId).map((e) => e.filePath),
    gitScan: opts.respectGitignore !== false,
    subdirectory: prefix !== "",
    annotationKeyCurrent: store.getAnnotationKey(repoId) === currentAnnotationKey(repoPath)
  });
}
