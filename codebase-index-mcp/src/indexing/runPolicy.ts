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

import { hasWorkingTreeChanges, resolveHeadCommitSha } from "../gitHelpers.js";
import type { GraphStore } from "../graphStore.js";
import { INDEX_VERSION, type PerformanceProfile } from "../indexPipeline.js";
import type { IndexMode, IndexRunResult, ResolutionStats } from "../types.js";

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
