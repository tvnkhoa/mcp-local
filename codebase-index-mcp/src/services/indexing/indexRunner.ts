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
import type { ExtractionWorkerPool } from "../extractors/extractionWorkerPool.js";
import { runIndexPipeline, INDEX_VERSION, SCOPE_FORCES_FULL_RUN, type PerformanceProfile } from "./indexPipeline.js";
import { mentionNameForms, pathKeysFor, tokenParts } from "../../repositories/scopedRunStore.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";
import {
  buildSkippedRunSummary,
  evaluateIncrementalSkip,
  newerBuildRefusal,
  resolvePerformanceProfileDecision,
  safeCrossRepoResolve,
  shouldDropEdgeIndexesForResolve
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
  /** Cap for markdown files; omitted means the `fileFilter` default. */
  readonly maxMarkdownBytes?: number;
  /** Skip files .gitignore excludes; omitted means true. */
  readonly respectGitignore?: boolean;
  readonly parseWorkers: number;
  readonly parseJobTimeoutMs: number;
  /**
   * Release J: a non-full run with at most this many files to extract parses them on this thread instead
   * of starting the parse workers, whose start-up (each loads the extractor modules) cost ~3 s of a
   * 5-file wec.aria refresh. Set by the refresh worker only — it is off the server thread — so absent
   * means never inline.
   */
  readonly inlineParseMaxFiles?: number;
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
  /**
   * Release J: parse workers that outlive one run (the refresh worker keeps them warm). Without it each
   * run starts its own, and their start-up — each loads the extractor modules — was ~3 s of a refresh.
   */
  readonly sharedParsePool?: () => ExtractionWorkerPool;
  /**
   * Release K3 (P2): leave the end-of-session checkpoint to the caller. The refresh worker posts the
   * result first and checkpoints after, so the answer never waits on it (it was ~280 ms of a refresh).
   */
  readonly deferSessionEnd?: boolean;
}

/** Per-run extras, internal to the runner and its refresh worker. */
export type RunExtras = {
  /** Release J: set on the full run a scoped run escalated to; recorded as that run's `scope`. */
  escalatedBecause?: string;
  /**
   * Release K3 (P1): the dirty set the freshness gate already read (`readWorkingTreeStateAsync`, the
   * same porcelain-v2 read as `collectDirtyFiles`), so a dirty run does not run `git status` again.
   */
  knownDirtyPaths?: readonly string[];
};

export type RunIndexAndResolve = (
  repoId: string,
  repoPath: string,
  mode: IndexMode,
  docsEnabled: boolean,
  maxFiles: number,
  batchSize: number,
  extras?: RunExtras
) => Promise<IndexRunResult>;

export function createIndexRunner(options: IndexRunnerOptions): RunIndexAndResolve {
  const { store, limits, resolveProgressNotifier, resolvePerformanceProfileOverride, sharedParsePool, deferSessionEnd } = options;

  return async function runIndexAndResolve(
    repoId: string,
    repoPath: string,
    mode: IndexMode,
    docsEnabled: boolean,
    maxFiles: number,
    batchSize: number,
    extras: RunExtras = {}
  ): Promise<IndexRunResult> {
  const { escalatedBecause } = extras;
  // Never write over an index a newer build wrote (several server processes share one DB).
  const refusal = newerBuildRefusal(store.getLatestRun(repoId)?.indexVersion);
  if (refusal) throw new Error(`index_repository refused: ${refusal}`);

  const yieldToEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  /** Release J: redo a scoped run as a full one, and say why on the full run's record. */
  const escalateToFull = (reason: string): Promise<IndexRunResult> => {
    indexLog(`[index-scope] repoId=${repoId} ${mode} run escalated to full: ${reason}`);
    return runIndexAndResolve(repoId, repoPath, "full", docsEnabled, maxFiles, batchSize, { escalatedBecause: `full (escalated from ${mode}: ${reason})` });
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
    dirtyFileSet = extras.knownDirtyPaths ? new Set(extras.knownDirtyPaths) : collectDirtyFiles(repoPath);
    // MCP-ISSUE-042: union in files the refactor engine wrote. After a rollback the tree is clean
    // again, so git contributes nothing and this set is the only reason `mode:"dirty"` has work to do.
    const pending = store.getPendingReindexFiles(repoId);
    for (const entry of pending) {
      dirtyFileSet.add(entry.filePath);
    }
    if (pending.length > 0) {
      indexLog(`[index-dirty] repoId=${repoId} +${String(pending.length)} file(s) from the pending re-index set`);
    }
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
    // Release J: a config edit can change how every file resolves; known now, so go straight to full.
    const config = [...dirtyFileSet].find((p) => SCOPE_FORCES_FULL_RUN.test(p));
    if (config) return escalateToFull(`${config} changed: it can change how every file resolves`);
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
    ...(limits.maxMarkdownBytes !== undefined && { maxMarkdownBytes: limits.maxMarkdownBytes }),
    ...(limits.respectGitignore !== undefined && { respectGitignore: limits.respectGitignore }),
    parseWorkers: limits.parseWorkers,
    parseJobTimeoutMs: limits.parseJobTimeoutMs,
    ...(limits.inlineParseMaxFiles !== undefined && { inlineParseMaxFiles: limits.inlineParseMaxFiles }),
    ...(sharedParsePool && { sharedWorkerPool: sharedParsePool() }),
    onlyRelativePaths: dirtyFileSet,
    progress
  });
  // Release J: the pipeline found a scoped run cannot be exact (a config file, or too many dependents)
  // after writing the changed files; a full run over the same tree is.
  if (summary.scopeEscalation) {
    progress.stop(`↻ index ${repoId} · ${mode} run escalated to full · ${summary.scopeEscalation}`);
    return escalateToFull(summary.scopeEscalation);
  }
  // Release K3: present on a scoped (non-escalated) run; absent means "run every pass repo-wide".
  const scopeInputs = mode !== "full" ? summary.scopeInputs : undefined;
  // Release K3: a scoped run that wrote and removed nothing left the graph as the last run left it, and
  // every pass below but cross-repo (which re-links against the other repos' current state) is a pure
  // function of it — re-running them reproduces what is stored. The refresh after a server restart, or
  // after a peer touched a file without changing it, is such a run.
  const unchanged = scopeInputs !== undefined && scopeInputs.reextracted.length === 0 && scopeInputs.removed.length === 0;
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
  // Release J: a scoped run kept the FTS tables in step per file as it wrote (scopedRunStore.ts); the
  // rebuild re-reads every repo in the shared DB, so only a full run pays for it.
  if (mode === "full") {
    indexLog(`[index-post] repoId=${repoId} rebuilding FTS indexes...`);
    const ftsStart = Date.now();
    try { store.rebuildFts(); } catch { /* non-fatal */ }
    await yieldToEventLoop();
    try { store.rebuildLiteralsFts(); } catch { /* non-fatal */ }
    await yieldToEventLoop();
    try { store.rebuildCommentsFts(); } catch { /* non-fatal */ }
    await yieldToEventLoop();
    if (docsEnabled) {
      indexLog(`[index-post] repoId=${repoId} rebuilding docs FTS...`);
      try { store.rebuildDocsFts(); } catch { /* non-fatal */ }
      await yieldToEventLoop();
    }
    ftsRebuildMs = Date.now() - ftsStart;
  }

  progress.phase("resolving calls");
  indexLog(`[index-post] repoId=${repoId} resolving call edges...`);
  // Populations that are not resolutions of the attempted set — see resolveCallEdgesBatch.
  const callResolveStats = { rowsUpdated: 0, dispatchInserted: 0 };
  const callEdgesResolved = await (async () => {
    const callStart = Date.now();
    if (unchanged) return 0;
    try {
      // Build lookup maps ONCE, then process in batches to avoid blocking event loop
      indexLog(`[index-post] repoId=${repoId} building call resolution context...`);
      const ctxStart = Date.now();
      const ctx = store.buildCallResolutionContext(repoId);
      buildContextMs = Date.now() - ctxStart;
      // Release K3 (P3a): a scoped run re-resolves only the rows whose answer can have changed — rows of
      // re-extracted files (the changed ones and their dependents, all fresh tokens), and rows whose
      // callee names a symbol in K. Any other unresolved row has the same candidates as last run.
      if (scopeInputs) {
        const files = new Set(scopeInputs.reextracted);
        const names = new Set(scopeInputs.names);
        ctx.unresolvedRows = ctx.unresolvedRows.filter((r) => files.has(r.fromFile) || tokenParts(r.toId).some((p) => names.has(p)));
      }
      callEdgesAttempted = ctx.unresolvedRows.length;
      indexLog(`[index-post] repoId=${repoId} pre-fetched ${String(ctx.unresolvedRows.length)} unresolved call edges`);
      if (ctx.unresolvedRows.length === 0) return 0;

      // Optimization: drop secondary edge indexes before bulk resolve to speed up UPDATEs.
      // Each UPDATE otherwise must maintain 4 secondary indexes on the edges table.
      // Release I1b: only for a bulk resolve. The indexes are DB-wide (every repo, every server
      // process), so dropping them for a dirty run's few thousand rows made every concurrent reader
      // full-scan `edges` — a get_file_summary on the server thread took 104 s during a wec.aria
      // dirty refresh — and rebuilding them over the whole table cost more than the UPDATEs saved.
      if (shouldDropEdgeIndexesForResolve(mode, ctx.unresolvedRows.length)) {
        indexLog(`[index-post] repoId=${repoId} dropping edge indexes for bulk resolve...`);
        store.dropEdgeIndexesForBulkWrite();
      }

      const BATCH_SIZE = 5_000;
      let total = 0;
      let iteration = 0;
      const maxIterations = 1000;
      while (iteration < maxIterations) {
        const resolved = store.resolveCallEdgesBatch(repoId, ctx, BATCH_SIZE, callResolveStats);
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
      // Always rebuild indexes after resolve, even on error (`create if not exists`: a no-op when kept).
      indexLog(`[index-post] repoId=${repoId} rebuilding edge indexes after resolve...`);
      try { store.rebuildEdgeIndexes(); } catch { /* non-fatal */ }
      callResolveMs = Date.now() - callStart;
    }
  })();
  await yieldToEventLoop();

  progress.phase("resolving imports");
  indexLog(`[index-post] repoId=${repoId} resolving import edges...`);
  const importStart = Date.now();
  const importEdgesResolved = unchanged ? 0 : await resolveInBatches(
    repoId,
    "import",
    (batchSize) => { try { return store.resolveImportEdges(repoId, batchSize); } catch { return 0; } },
    postPolicy.maxUnresolvedRows
  );
  // MCP-ISSUE-074: Vue template tokens go through the same module resolver as imports. Not budgeted by
  // maxUnresolvedRows — one row per rendered tag or bound prop, bounded by the template text itself.
  const componentEdgesResolved = unchanged ? 0 : (() => { try { return store.resolveComponentEdges(repoId); } catch { return 0; } })();
  if (componentEdgesResolved > 0) {
    indexLog(`[index-post] repoId=${repoId} resolved ${String(componentEdgesResolved)} vue component edge(s)`);
  }
  importResolveMs = Date.now() - importStart;
  await yieldToEventLoop();

  // MCP-ISSUE-075: CSS variable/class tokens. Unconditional and unbudgeted — CSS edges are few, the
  // pass is one indexed scan per edge type, and it also re-fans earlier resolutions so an incremental
  // run lands on the same graph as a full one. Non-fatal: a failure leaves labelled tokens behind.
  (() => {
    try {
      // Release K3 (P3c): the pass rebinds every CSS token by name; nothing it reads changed unless a
      // file this run wrote or removed had or has CSS rows.
      if (scopeInputs && !scopeInputs.lanes.css) return;
      const css = store.resolveCssEdges(repoId);
      if (css.tokensResolved + css.tokensUnresolved > 0) {
        indexLog(`[index-post] repoId=${repoId} css tokens resolved=${String(css.tokensResolved)} unresolved=${String(css.tokensUnresolved)} edges=${String(css.edgesWritten)}`);
      }
    } catch { /* non-fatal */ }
  })();

  // MCP-ISSUE-082: SQL tokens (migrations and TS query literals) bound by name, plus the migration
  // order. Unconditional and unbudgeted like CSS — it rebuilds the whole bound set from tokens each
  // run, which is what keeps an incremental run equal to a full one. Non-fatal.
  (() => {
    try {
      // Release K3 (P3c): likewise for SQL, plus the `sqlconst:` anchors, which bind through a module
      // (and one barrel hop) that may hold no SQL row of its own: a written or removed file whose path
      // keys, or a K name, meet an anchor's token parts.
      if (scopeInputs && !scopeInputs.lanes.sql) {
        const anchorParts = store.sqlAnchorTokenParts(repoId);
        const keys = [...scopeInputs.reextracted, ...scopeInputs.removed].flatMap(pathKeysFor).concat(scopeInputs.names);
        if (!keys.some((k) => anchorParts.has(k))) return;
      }
      const sql = store.resolveSqlEdges(repoId);
      if (sql.tokensResolved + sql.tokensUnresolved + sql.tokensAmbiguous + sql.migrationOrderEdges > 0) {
        indexLog(`[index-post] repoId=${repoId} sql tokens resolved=${String(sql.tokensResolved)} unresolved=${String(sql.tokensUnresolved)} ambiguous=${String(sql.tokensAmbiguous)} edges=${String(sql.edgesWritten)} migrationOrder=${String(sql.migrationOrderEdges)}`);
      }
    } catch { /* non-fatal */ }
  })();

  // MCP-ISSUE-076: package.json → package.json for dependencies on a package of this repo. Recomputed
  // whole every run (a pure function of the npm: tokens and the declared names); non-fatal.
  (() => {
    try {
      if (unchanged) return;
      const workspace = store.resolveWorkspacePackageEdges(repoId);
      if (workspace > 0) indexLog(`[index-post] repoId=${repoId} workspace package edges=${String(workspace)}`);
    } catch { /* non-fatal */ }
  })();

  if (postPolicy.resolveTypeRefs && !unchanged) {
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

  if (postPolicy.resolvePropertyRefs && !unchanged) {
    indexLog(`[index-post] repoId=${repoId} resolving property references...`);
    const propertyStart = Date.now();
    (() => { try { store.resolvePropertyEdges(repoId, postPolicy.maxUnresolvedRows); } catch { /* non-fatal */ } })();
    propertyResolveMs = Date.now() - propertyStart;
  } else {
    indexLog(`[index-post-skip] repoId=${repoId} skipping property reference resolution by policy`);
  }

  // MCP-ISSUE-055: bind routes whose handler lives in another part of the same partial class. Runs
  // unconditionally — it is one UPDATE over the (small) routes table, and it is not governed by the
  // unresolved-row budget the edge resolvers share. Non-fatal: a failure here costs handler
  // addressability, never the index run.
  (() => {
    try {
      if (unchanged) return;
      const rebound = store.resolveRouteHandlers(repoId);
      if (rebound > 0) indexLog(`[index-post] repoId=${repoId} rebound ${String(rebound)} route handler(s) across partial-class files`);
    } catch { /* non-fatal */ }
  })();

  await yieldToEventLoop();

  const shouldResolveImplementsInPost = effectiveResolveImplementsInPost && !unchanged;
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

  // MCP-ISSUE-048: cross-repo resolution runs LAST, not first.
  //
  // It used to run before the call/type/implements resolvers, so it saw a graph full of unresolved
  // placeholders and its 5000-row window was spent on tokens that resolve locally a moment later.
  // Running it here means the population is what genuinely could not be resolved inside this repo —
  // which is the only population where a cross-repo bridge is the right answer — and it makes the
  // count comparable between full and dirty runs instead of inverting between them.
  // MCP-ISSUE-045: a full run REBUILDS this repo's outbound cross-repo links rather than adding to
  // them. `cross_repo_deps` was append-only (`insert … on conflict do nothing`) and never cleared, so
  // links created by an earlier, wronger rule survived every subsequent run — the 408 bogus `Task`
  // rows this fix was meant to remove were still there after it shipped, because nothing deletes.
  // A resolution rule that cannot heal the rows it already wrote is not a fix.
  //
  // Scoped to `from_repo_id = this repo`: those are the links this run is responsible for. Rows where
  // another repo points INTO this one belong to that repo's run. Full runs only — a dirty/incremental
  // run re-extracts a subset, so clearing would drop links whose source files it never looked at.
  if (mode === "full") {
    try {
      const cleared = store.clearOutboundCrossRepoDeps(repoId);
      if (cleared > 0) {
        indexLog(`[index-post] repoId=${repoId} cleared ${String(cleared)} stale outbound cross-repo link(s) before re-resolving`);
      }
    } catch { /* non-fatal — a stale link is worse than a failed run, but not worth losing the run over */ }
  }
  indexLog(`[index-post] repoId=${repoId} resolving cross-repo links...`);
  const crossStats = safeCrossRepoResolve(store, repoId);
  await yieldToEventLoop();

  // Post-resolve dedup: remove duplicate resolved edges that arise when both simple and
  // qualified edges resolve to the same symbolId (e.g. callee:Save + callee:IRepo.Save → same target).
  indexLog(`[index-post] repoId=${repoId} deduplicating resolved edges...`);
  // Release K3 (d): repo-wide only when a repo-wide rebinding pass (CSS / SQL) ran; otherwise the only
  // rows written or rewritten are the re-extracted files', and a duplicate shares its from_id.
  const dedupCount = (() => {
    try {
      if (unchanged) return 0;
      if (scopeInputs && !scopeInputs.lanes.css && !scopeInputs.lanes.sql) return store.deduplicateResolvedEdgesForFiles(repoId, scopeInputs.reextracted);
      return store.deduplicateResolvedEdges(repoId);
    } catch {
      return 0;
    }
  })();
  indexLog(`[index-post] repoId=${repoId} removed ${dedupCount} duplicate resolved edges`);
  await yieldToEventLoop();

  const mentionsStart = Date.now();
  indexLog(`[index-post] repoId=${repoId} resolving mentions...`);
  // Release J: a resolved mention keeps its symbol_id and resolveMentions revisits only null rows, by
  // keys K cannot bound (prefix, suffix, file path) — so a scoped run re-resolves all of them, exactly
  // as a full run's freshly extracted (all-null) rows are.
  const mentionsResolved = docsEnabled
    ? (() => {
        try {
          // Release K3 (b): a scoped run unbinds only the bound mentions it can have changed (see
          // resetMentionsForScope); an escalated or otherwise unscoped non-full run still unbinds all.
          if (scopeInputs) {
            // Release K3: unbind only the bound rows the run can have changed, and re-decide only them,
            // the fresh rows of re-extracted docs, and unbound rows whose text meets a changed name.
            const resetKeys = store.resetMentionsForScope(repoId, scopeInputs);
            return store.resolveMentions(repoId, {
              forms: mentionNameForms(scopeInputs.names),
              pathKeys: new Set(scopeInputs.pathKeys.map((k) => k.toLowerCase())),
              docFiles: scopeInputs.reextracted,
              resetKeys
            });
          }
          if (mode !== "full") store.resetMentionResolution(repoId);
          return store.resolveMentions(repoId);
        } catch {
          return 0;
        }
      })()
    : 0;
  const mentionsElapsed = Date.now() - mentionsStart;
  indexLog(`[index-post] repoId=${repoId} resolved ${mentionsResolved} mentions in ${mentionsElapsed}ms`);

  // The actual remainder, after every resolver has run (MCP-ISSUE-048).
  const callEdgesRemaining = (() => {
    try {
      return store.countUnresolvedCallEdges(repoId);
    } catch {
      return Math.max(0, callEdgesAttempted - callEdgesResolved);
    }
  })();

  const recordStart = Date.now();
  indexLog(`[index-post] repoId=${repoId} recording run metadata...`);

  // MCP-ISSUE-048: the authoritative graph size, read back from the tables the run just wrote.
  // `symbolsUpserted`/`edgesUpserted` are counted at EXTRACTION time (array lengths handed to the
  // writer), so they can never equal the row counts once dedup and pruning have run. Both numbers are
  // legitimate — they answer different questions — but only one of them was reported, under a name
  // that reads like the other.
  const graphSnapshot = (() => {
    try {
      const snap = store.getRepoSchemaSnapshot(repoId);
      return { symbolsInGraph: snap.symbolCount, edgesInGraph: snap.edgeCount };
    } catch {
      return {};
    }
  })();

  const { scopeInputs: _scopeInputs, ...summaryToRecord } = summary;
  const fullSummary = {
    ...summaryToRecord,
    // Spans the whole run, including the post-phase below. The pipeline's own figure is preserved as
    // `extractPhaseMs`, so nothing is lost and no contained phase can exceed the total.
    elapsedMs: Date.now() - runStartedMs,
    ...graphSnapshot,
    edgesDeduplicated: dedupCount,
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
    // Still a partition of `callEdgesAttempted` — that invariant is load-bearing (the smoke test
    // asserts it). What MCP-ISSUE-048 actually broke was the NUMERATOR: `callEdgesResolved` counted
    // updated rows plus inserted dispatch edges, so it could exceed `attempted`, drive this
    // subtraction negative, and leave the clamp reporting 0. `resolveCallEdgesBatch` now returns
    // pairs, so the partition holds arithmetically instead of by clamping.
    callEdgesUnresolved: Math.max(0, callEdgesAttempted - callEdgesResolved),
    // The MEASURED remainder, and a different question: how many CALLS rows in the graph still point
    // at a `callee:` placeholder. Not a partition of `attempted` — most of these are external/BCL
    // targets that were never candidates for resolution — which is why it gets its own name rather
    // than redefining the field above.
    callEdgesUnresolvedInGraph: callEdgesRemaining,
    callRowsUpdated: callResolveStats.rowsUpdated,
    dispatchEdgesInserted: callResolveStats.dispatchInserted,
    unresolvedCallsTotal: callEdgesAttempted,
    unresolvedImportsCappedByPolicy: postPolicy.maxUnresolvedRows > 0,
    // Clamped as a backstop; with a pair-level numerator it should no longer be reachable.
    resolveCallsCoverage:
      callEdgesAttempted > 0 ? Math.min(1, callEdgesResolved / callEdgesAttempted) : 1,
    performanceProfile,
    ...(escalatedBecause ? { scope: escalatedBecause } : {})
  };
  store.recordRun(fullSummary);
  // Whatever the refactor engine wrote has now been through the graph (MCP-ISSUE-042).
  store.clearPendingReindexFiles(repoId);
  const recordElapsed = Date.now() - recordStart;
  indexLog(`[index-post] repoId=${repoId} recorded run metadata in ${recordElapsed}ms`);

  // Re-enable WAL auto-checkpoint and force a full checkpoint to shrink WAL file
  if (!deferSessionEnd) store.endIndexSession(mode === "full");

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
