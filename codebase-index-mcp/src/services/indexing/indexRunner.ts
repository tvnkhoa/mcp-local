/**
 * The index run orchestrator: scan/parse via the pipeline, then the post-phase that
 * resolves edges, rebuilds FTS, records the run, and reports progress.
 *
 * This lived in `src/index.ts` until migration step S-26. It was never entry-point
 * work — it sat there only because both `WatchManager` and `HandlerContext` need it,
 * and the entry point was the one place that already had `store` in scope. The body
 * below is unchanged; what moved is where its dependencies come from:
 *
 *   - `store` and the six tuning limits are now constructor arguments
 *   - the progress sink arrives through `resolveProgressNotifier`, so this module
 *     never sees `AsyncLocalStorage` or the MCP request context
 *
 * The decision functions it calls (skip? which profile?) live in `runPolicy.ts`.
 */

import { createIndexProgress, indexLog, type ProgressNotifier } from "./indexProgress.js";
import { resolvePostPhasePolicy } from "../../config/performanceConfig.js";
import { collectDirtyFiles, resolveCurrentBranch, resolveHeadCommitSha } from "../git/gitHelpers.js";
import type { GraphStore } from "../../repositories/graphStore.js";
import { runIndexPipeline, INDEX_VERSION, type PerformanceProfile } from "./indexPipeline.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";
import {
  buildSkippedRunSummary,
  evaluateIncrementalSkip,
  resolvePerformanceProfileDecision,
  safeCrossRepoResolve
} from "./runPolicy.js";

/** Tuning knobs the pipeline needs, all sourced from env at start-up. */
export interface IndexRunnerLimits {
  /** Files per sub-transaction inside a batch. */
  readonly subtxSize: number;
  /** Run a WAL checkpoint after every N completed batches. */
  readonly checkpointEveryNBatches: number;
  /** Files at or above this size go to the worker pool. */
  readonly largeFileThresholdBytes: number;
  /** Hard cap on file size; larger files are skipped. */
  readonly maxFileSizeBytes: number;
  readonly parseWorkers: number;
  readonly parseJobTimeoutMs: number;
}

export interface IndexRunnerOptions {
  readonly store: GraphStore;
  readonly limits: IndexRunnerLimits;
  /**
   * Called once per run to pick up the caller's progress sink, if the host supplied
   * a progressToken. A callback rather than a value because the sink is per-request
   * and this runner is built once at start-up — resolving it eagerly would capture
   * whatever request happened to be in flight then, which is to say none.
   */
  readonly resolveProgressNotifier?: () => ProgressNotifier | undefined;
  /**
   * The parsed `CODEBASE_INDEX_LARGE_REPO_PROFILE` override, or `"auto"` to let the
   * repo's own scale decide. A callback for the same reason as above and one more:
   * it used to be read from `process.env` on every run, and a callback keeps that
   * timing rather than freezing the value at start-up.
   */
  readonly resolvePerformanceProfileOverride: () => PerformanceProfile | "auto";
}

export type RunIndexAndResolve = (
  repoId: string,
  repoPath: string,
  mode: IndexMode,
  docsEnabled: boolean,
  maxFiles: number,
  batchSize: number
) => Promise<IndexRunResult>;

export function createIndexRunner(options: IndexRunnerOptions): RunIndexAndResolve {
  const { store, limits, resolveProgressNotifier, resolvePerformanceProfileOverride } = options;

  return async function runIndexAndResolve(
    repoId: string,
    repoPath: string,
    mode: IndexMode,
    docsEnabled: boolean,
    maxFiles: number,
    batchSize: number
  ): Promise<IndexRunResult> {
  const yieldToEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  /**
   * Run a synchronous resolve function in batches to avoid blocking the event loop.
   * Each batch processes BATCH_SIZE rows, then yields before the next batch.
   * If maxRows=0 (unlimited), uses BATCH_SIZE per iteration until no more rows resolved.
   */
  const resolveInBatches = async (
    _repoId: string,
    label: string,
    resolveFn: (batchSize: number) => number,
    maxRows: number
  ): Promise<number> => {
    const BATCH_SIZE = 5_000;
    let totalResolved = 0;
    let remaining = maxRows > 0 ? maxRows : Infinity;
    let iteration = 0;
    const maxIterations = 200; // safety cap: 200 * 5000 = 1M rows max

    while (remaining > 0 && iteration < maxIterations) {
      const batchLimit = Math.min(BATCH_SIZE, remaining === Infinity ? BATCH_SIZE : remaining);
      const resolved = resolveFn(batchLimit);
      totalResolved += resolved;
      iteration += 1;

      indexLog(
        `[index-post-batch] repoId=${_repoId} type=${label} batch=${String(iteration)} resolved=${String(resolved)} total=${String(totalResolved)}`
      );

      // If nothing resolved in this batch, we're done
      if (resolved === 0) break;

      if (maxRows > 0) {
        remaining -= batchLimit;
      }

      await yieldToEventLoop();
    }

    return totalResolved;
  };

  // Dirty mode (ENH-A): re-index only the git working-tree delta (unstaged + staged +
  // untracked). Sub-second refresh for "what I just edited" without a full/incremental scan.
  let dirtyFileSet: Set<string> | undefined;
  if (mode === "dirty") {
    dirtyFileSet = collectDirtyFiles(repoPath);
    if (dirtyFileSet.size === 0) {
      const noOp = buildSkippedRunSummary({
        repoId,
        mode,
        commitSha: resolveHeadCommitSha(repoPath),
        branch: resolveCurrentBranch(repoPath),
        indexVersion: INDEX_VERSION,
        skipReason: "no dirty files"
      });
      store.recordRun(noOp);
      indexLog(`[index-dirty] repoId=${repoId} no working-tree changes — nothing to re-index`);
      return noOp;
    }
    indexLog(`[index-dirty] repoId=${repoId} re-indexing ${String(dirtyFileSet.size)} working-tree-changed file(s)`);
  }

  if (mode === "incremental") {
    const skipDecision = evaluateIncrementalSkip(store, repoId, repoPath);
    if (skipDecision.shouldSkip) {
      const skippedSummary = buildSkippedRunSummary({
        repoId,
        mode,
        commitSha: skipDecision.headCommitSha,
        branch: resolveCurrentBranch(repoPath),
        indexVersion: skipDecision.indexVersion,
        skipReason: skipDecision.reason
      });
      store.recordRun(skippedSummary);
      indexLog(`[index-skip] repoId=${repoId} reason=${skipDecision.reason}`);
      return skippedSummary;
    }
  }

  const profileDecision = resolvePerformanceProfileDecision(
    store,
    resolvePerformanceProfileOverride(),
    repoId,
    mode,
    maxFiles
  );
  const performanceProfile = profileDecision.profile;
  const postPolicy = resolvePostPhasePolicy(performanceProfile);
  // Resolve implements in post-phase for ALL modes (full + incremental).
  // Previous condition `mode !== "full"` was a bug — full index rebuilds all edges from scratch
  // so implements edges also need post-phase resolution.
  const effectiveResolveImplementsInPost = postPolicy.resolveImplementsInPost;
  indexLog(
    `[index-policy] repoId=${repoId} profile=${performanceProfile} source=${profileDecision.source} reason=${profileDecision.reason} fileCount=${String(profileDecision.fileCount)} symbolCount=${String(profileDecision.symbolCount)} maxUnresolvedRows=${String(postPolicy.maxUnresolvedRows)} resolveTypeRefs=${String(postPolicy.resolveTypeRefs)} resolvePropertyRefs=${String(postPolicy.resolvePropertyRefs)} resolveImplementsInPost=${String(postPolicy.resolveImplementsInPost)} effectiveResolveImplementsInPost=${String(effectiveResolveImplementsInPost)}`
  );

  // One progress reporter drives the whole run: the pipeline advances it through
  // scan → index, then we keep it going across the edge-resolution post-phase below
  // and stop() it with a summary. When the host supplied a progressToken, its
  // update()s stream `notifications/progress` so Claude Code shows live % + phase.
  const progress = createIndexProgress(repoId, resolveProgressNotifier?.());
  const runStartedMs = Date.now();

  // Disable WAL auto-checkpoint during indexing to prevent lock contention
  // with concurrent readers. Will be re-enabled in endIndexSession().
  store.beginIndexSession();

  // On throw the pipeline stops the reporter itself (failure line) before rethrowing.
  const summary = await runIndexPipeline(store, {
    repoId,
    repoPath,
    mode,
    performanceProfile,
    includeDocs: docsEnabled,
    maxFiles,
    batchSize,
    subtxSize: limits.subtxSize,
    checkpointEveryNBatches: limits.checkpointEveryNBatches,
    largeFileThresholdBytes: limits.largeFileThresholdBytes,
    maxFileSizeBytes: limits.maxFileSizeBytes,
    parseWorkers: limits.parseWorkers,
    parseJobTimeoutMs: limits.parseJobTimeoutMs,
    onlyRelativePaths: dirtyFileSet,
    progress
  });
  const resolvePhaseStart = Date.now();
  let ftsRebuildMs = 0;
  let buildContextMs = 0;
  let callEdgesAttempted = 0;
  let callResolveMs = 0;
  let importResolveMs = 0;
  let typeResolveMs = 0;
  let propertyResolveMs = 0;
  let implementsResolveMs = 0;

  progress.phase("finalizing");
  indexLog(`[index-post] repoId=${repoId} rebuilding FTS indexes...`);
  const ftsStart = Date.now();
  try { store.rebuildFts(); } catch { /* non-fatal */ }
  await yieldToEventLoop();
  try { store.rebuildLiteralsFts(); } catch { /* non-fatal */ }
  await yieldToEventLoop();
  if (docsEnabled) {
    indexLog(`[index-post] repoId=${repoId} rebuilding docs FTS...`);
    try { store.rebuildDocsFts(); } catch { /* non-fatal */ }
    await yieldToEventLoop();
  }
  ftsRebuildMs = Date.now() - ftsStart;

  indexLog(`[index-post] repoId=${repoId} resolving cross-repo links...`);
  const crossStats = safeCrossRepoResolve(store, repoId);
  await yieldToEventLoop();

  progress.phase("resolving calls");
  indexLog(`[index-post] repoId=${repoId} resolving call edges...`);
  const callEdgesResolved = await (async () => {
    const callStart = Date.now();
    try {
      // Build lookup maps ONCE, then process in batches to avoid blocking event loop
      indexLog(`[index-post] repoId=${repoId} building call resolution context...`);
      const ctxStart = Date.now();
      const ctx = store.buildCallResolutionContext(repoId);
      buildContextMs = Date.now() - ctxStart;
      callEdgesAttempted = ctx.unresolvedRows.length;
      indexLog(`[index-post] repoId=${repoId} pre-fetched ${String(ctx.unresolvedRows.length)} unresolved call edges`);
      if (ctx.unresolvedRows.length === 0) return 0;

      // Optimization: drop secondary edge indexes before bulk resolve to speed up UPDATEs.
      // Each UPDATE otherwise must maintain 4 secondary indexes on the edges table.
      indexLog(`[index-post] repoId=${repoId} dropping edge indexes for bulk resolve...`);
      store.dropEdgeIndexesForBulkWrite();

      const BATCH_SIZE = 5_000;
      let total = 0;
      let iteration = 0;
      const maxIterations = 1000;
      while (iteration < maxIterations) {
        const resolved = store.resolveCallEdgesBatch(repoId, ctx, BATCH_SIZE);
        total += resolved;
        iteration += 1;
        // Heartbeat only — keep the real symbol count in the message rather than
        // overwriting it with the resolved-call-edge total.
        progress.update({});
        indexLog(
          `[index-post-batch] repoId=${repoId} type=call batch=${String(iteration)} resolved=${String(resolved)} total=${String(total)}`
        );
        if (resolved === 0) break;
        await yieldToEventLoop();
      }
      return total;
    } catch { return 0; }
    finally {
      // Always rebuild indexes after resolve, even on error
      indexLog(`[index-post] repoId=${repoId} rebuilding edge indexes after resolve...`);
      try { store.rebuildEdgeIndexes(); } catch { /* non-fatal */ }
      callResolveMs = Date.now() - callStart;
    }
  })();
  await yieldToEventLoop();

  progress.phase("resolving imports");
  indexLog(`[index-post] repoId=${repoId} resolving import edges...`);
  const importStart = Date.now();
  const importEdgesResolved = await resolveInBatches(
    repoId,
    "import",
    (batchSize) => { try { return store.resolveImportEdges(repoId, batchSize); } catch { return 0; } },
    postPolicy.maxUnresolvedRows
  );
  importResolveMs = Date.now() - importStart;
  await yieldToEventLoop();

  if (postPolicy.resolveTypeRefs) {
    progress.phase("resolving types");
    indexLog(`[index-post] repoId=${repoId} resolving type references...`);
    const typeStart = Date.now();
    // MCP-ISSUE-038: on very-large repos keep every TYPE_REF token but skip the cross-repo and vector
    // fallbacks. `dead_code_scan` matches unresolved tokens by name, so the capability survives; what is
    // dropped is 105s of linking framework type names that have no in-repo target.
    (() => { try { store.resolveTypeRefEdges(repoId, postPolicy.maxUnresolvedRows, performanceProfile === "very-large"); } catch { /* non-fatal */ } })();
    typeResolveMs = Date.now() - typeStart;
  } else {
    indexLog(`[index-post-skip] repoId=${repoId} skipping type reference resolution by policy`);
  }
  await yieldToEventLoop();

  if (postPolicy.resolvePropertyRefs) {
    indexLog(`[index-post] repoId=${repoId} resolving property references...`);
    const propertyStart = Date.now();
    (() => { try { store.resolvePropertyEdges(repoId, postPolicy.maxUnresolvedRows); } catch { /* non-fatal */ } })();
    propertyResolveMs = Date.now() - propertyStart;
  } else {
    indexLog(`[index-post-skip] repoId=${repoId} skipping property reference resolution by policy`);
  }
  await yieldToEventLoop();

  const shouldResolveImplementsInPost = effectiveResolveImplementsInPost;
  if (shouldResolveImplementsInPost) {
    indexLog(`[index-post] repoId=${repoId} resolving interface implementations...`);
    const implementsStart = Date.now();
    try { store.resolveImplementsEdges(repoId); } catch { /* non-fatal */ }
    try { store.resolveExtendsEdges(repoId); } catch { /* non-fatal */ }
    // MCP-ISSUE-037: must come AFTER call resolution above, because it reads final CALLS edges. The base
    // of a template-method class calls its own abstract member in the same file, so extraction already
    // resolved that edge and it never passes through the unresolved-token lane.
    try { store.resolveBaseClassDispatch(repoId); } catch { /* non-fatal */ }
    // ISSUE-020: match message-bus PUBLISHES/CONSUMES tokens (depends on consumer IMPLEMENTS being resolved).
    try { store.resolvePublishesConsumesEdges(repoId); } catch { /* non-fatal */ }
    implementsResolveMs = Date.now() - implementsStart;
  } else {
    indexLog(`[index-post-skip] repoId=${repoId} skipping interface implementation resolution in post-phase`);
  }
  await yieldToEventLoop();

  // Post-resolve dedup: remove duplicate resolved edges that arise when both simple and
  // qualified edges resolve to the same symbolId (e.g. callee:Save + callee:IRepo.Save → same target).
  indexLog(`[index-post] repoId=${repoId} deduplicating resolved edges...`);
  const dedupCount = (() => { try { return store.deduplicateResolvedEdges(repoId); } catch { return 0; } })();
  indexLog(`[index-post] repoId=${repoId} removed ${dedupCount} duplicate resolved edges`);
  await yieldToEventLoop();

  const mentionsStart = Date.now();
  indexLog(`[index-post] repoId=${repoId} resolving mentions...`);
  const mentionsResolved = docsEnabled
    ? (() => { try { return store.resolveMentions(repoId); } catch { return 0; } })()
    : 0;
  const mentionsElapsed = Date.now() - mentionsStart;
  indexLog(`[index-post] repoId=${repoId} resolved ${mentionsResolved} mentions in ${mentionsElapsed}ms`);

  const recordStart = Date.now();
  indexLog(`[index-post] repoId=${repoId} recording run metadata...`);

  const fullSummary = {
    ...summary,
    crossRepoLinked: crossStats.resolved,
    callEdgesResolved,
    importEdgesResolved,
    mentionsResolved,
    crossRepoAttempts: crossStats.attempts,
    crossRepoResolved: crossStats.resolved,
    unresolvedNoCandidate: crossStats.unresolvedByReason.no_candidate,
    unresolvedAmbiguous: crossStats.unresolvedByReason.ambiguous_candidates,
    unresolvedBoundaryBlocked: crossStats.unresolvedByReason.boundary_blocked,
    unresolvedLowConfidence: crossStats.unresolvedByReason.low_confidence,
    resolvePhaseMs: Date.now() - resolvePhaseStart,
    buildContextMs,
    callResolveMs,
    importResolveMs,
    typeResolveMs,
    propertyResolveMs,
    implementsResolveMs,
    ftsRebuildMs,
    // ISSUE-025: self-describing call-resolution counters. `unresolvedCallsTotal` is a
    // deprecated alias of `callEdgesAttempted` (the pre-resolve unresolved-edge count).
    callEdgesAttempted,
    callEdgesUnresolved: Math.max(0, callEdgesAttempted - callEdgesResolved),
    unresolvedCallsTotal: callEdgesAttempted,
    unresolvedImportsCappedByPolicy: postPolicy.maxUnresolvedRows > 0,
    resolveCallsCoverage: callEdgesAttempted > 0 ? callEdgesResolved / callEdgesAttempted : 1,
    performanceProfile
  };
  store.recordRun(fullSummary);
  const recordElapsed = Date.now() - recordStart;
  indexLog(`[index-post] repoId=${repoId} recorded run metadata in ${recordElapsed}ms`);

  // Re-enable WAL auto-checkpoint and force a full checkpoint to shrink WAL file
  store.endIndexSession();

  indexLog(`[index-post-done] repoId=${repoId} crossRepo=${String(crossStats.resolved)} calls=${String(callEdgesResolved)} imports=${String(importEdgesResolved)} mentions=${String(mentionsResolved)}`);

  // Finish the reporter with one concise summary line (the only stderr line the
  // host sees for the whole run when logs are quiet).
  const totalSec = ((Date.now() - runStartedMs) / 1000).toFixed(1);
  progress.stop(
    `✓ index ${repoId} · ${String(fullSummary.filesIndexed)} files · ${String(fullSummary.symbolsUpserted)} symbols · ${String(callEdgesResolved)} calls · ${totalSec}s`
  );

  return fullSummary;
  };
}
