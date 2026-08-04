import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getRepoStaleness, getRepoWorkingTreeState } from "../../services/git/gitHelpers.js";
import { assertPathAllowed, clamp } from "../../middleware/indexGuardrails.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { resolveDetectChangesPolicy } from "../../services/analysis/policyResolver.js";
import { computeChangedFileImpacts } from "../../services/impact/changeAnalysis.js";
import { buildCoverageBlock } from "../../middleware/coverage.js";
import { buildIndexMeta } from "./impactHandler.js";
import type { IndexMode } from "../../types/index.js";
import { activateWatchForRepo, clearWatchInactivityTimer } from "../../services/watch/watchLifecycle.js";
import type { HandlerContext } from "./handlerContext.js";

// ── health_check ─────────────────────────────────────────────────────────────

export function handleHealthCheck(
  args: { repoId?: string },
  ctx: HandlerContext
): CallToolResult {
  const { store, watchManager, activeWatchRef, constants } = ctx;
  const { repoId } = args;

  const latestRun = repoId ? store.getLatestRun(repoId) : null;
  const staleness = repoId ? getRepoStaleness(repoId, store) : null;
  const repo = repoId ? store.getRepository(repoId) : null;
  const watchStatuses = repoId ? watchManager.getStatus(repoId) : [];
  const watchRunning = watchStatuses.length > 0;
  const workingTree = repo ? getRepoWorkingTreeState(repo.repoPath) : null;
  const packageBridge = repoId ? store.getPackageBridgeStats(repoId) : null;
  const vectorStats = repoId ? store.getVectorStats(repoId) : null;
  const unresolvedStats = repoId ? store.getUnresolvedStats(repoId) : null;

  // MCP-ISSUE-042: the third staleness signal. The other two are git-based and a refactor rollback
  // defeats both — it restores the pre-apply bytes, so HEAD matches and the tree is clean, while the
  // graph still holds the applied names. Without this, `health_check` reported "ready" for a graph
  // containing a symbol that exists in no file on disk.
  const pendingReindex = repoId ? store.getPendingReindexFiles(repoId) : [];

  const reasons: string[] = [];
  if (repoId && !repo) reasons.push("repository not registered; run index_repository first");
  if (repoId && repo && !latestRun) reasons.push("repository has no indexed run yet");
  if (staleness?.isStale === true) reasons.push("indexed commit differs from HEAD");
  if (workingTree?.isDirty === true) reasons.push("working tree has uncommitted changes");
  if (pendingReindex.length > 0) {
    reasons.push(`${String(pendingReindex.length)} file(s) written by the refactor engine are not re-indexed`);
  }

  let codebaseStatus: "unknown" | "needs_index" | "stale" | "dirty" | "ready" = "unknown";
  if (!repoId || !repo) {
    codebaseStatus = "unknown";
  } else if (!latestRun) {
    codebaseStatus = "needs_index";
  } else if (staleness?.isStale === true) {
    codebaseStatus = "stale";
  } else if (pendingReindex.length > 0) {
    // Ranked above "dirty": a clean tree with a pending set is exactly the rollback case, and it is
    // the one where nothing else in this response would report a problem.
    codebaseStatus = "stale";
  } else if (workingTree?.isDirty === true) {
    codebaseStatus = "dirty";
  } else if (staleness?.isStale === false) {
    codebaseStatus = "ready";
  }

  const shouldReindex = codebaseStatus === "needs_index" || codebaseStatus === "stale" || codebaseStatus === "dirty";
  const shouldEnableWatch = Boolean(repoId && repo && workingTree?.isDirty === true && !watchRunning);
  const actionHints =
    repoId && repo
      ? [
          {
            action: "index_repository",
            recommended: shouldReindex,
            urgency:
              codebaseStatus === "stale" || codebaseStatus === "needs_index"
                ? "high"
                : codebaseStatus === "dirty"
                  ? "medium"
                  : "low",
            reason:
              codebaseStatus === "needs_index"
                ? "No successful index run exists for this repo."
                : pendingReindex.length > 0
                  ? "Files written by the refactor engine have not been re-indexed — the graph may hold names that exist in no file on disk."
                  : codebaseStatus === "stale"
                    ? "Indexed commit does not match HEAD."
                    : codebaseStatus === "dirty"
                      ? "Working tree changed after latest index run."
                      : "Index appears up-to-date.",
            // `dirty` is sufficient and far cheaper for the refactor case: the pending set is unioned
            // into the changed-file set, so those files are re-indexed even with a clean tree.
            arguments: {
              repoId,
              repoPath: repo.repoPath,
              mode: pendingReindex.length > 0 && staleness?.isStale !== true ? "dirty" : "incremental"
            }
          },
          {
            action: "watch_repo_start",
            recommended: shouldEnableWatch,
            urgency: shouldEnableWatch ? "medium" : "low",
            reason: shouldEnableWatch
              ? "Uncommitted edits detected and no active watcher for this repo."
              : watchRunning
                ? "Watcher is already active for this repo."
                : "Use watch only for active edit sessions that need continuous indexing.",
            arguments: { action: "start", repoId, repoPath: repo.repoPath }
          }
        ]
      : [];

  return ctx.asText({
    status: "ok",
    serverVersion: constants.SERVER_VERSION,
    dbPath: constants.dbPath,
    allowedRootCount: constants.allowedRoots.length,
    docsLane: {
      docsIndexingEnabled: constants.DOCS_INDEXING_ENABLED,
      docsToolsEnabled: constants.DOCS_TOOLS_ENABLED
    },
    latestRun,
    staleness,
    watch: {
      autoStartEnabled: constants.WATCH_AUTO_START,
      activeOnly: constants.WATCH_ACTIVE_ONLY,
      activeWatchRepoId: activeWatchRef.current,
      running: watchRunning,
      watcherCount: watchStatuses.length,
      watchers: watchStatuses
    },
    // MCP-ISSUE-049: without `repoId` this call measures nothing repo-scoped, and must not report a
    // number as if it had. `scope` says which question was answered; the same call WITH a repoId
    // returned 2664 / "ready" where this one said 0 / "unknown", and the 0 read as "the vector index
    // is empty" — which is exactly how the sweep that filed this issue started.
    scope: repoId ? "repo" : "server",
    ...(repoId ? {} : { note: "server-scoped answer: pass repoId for codebase state, vector index size and unresolved stats." }),
    codebaseState: {
      repoId: repoId ?? null,
      status: codebaseStatus,
      shouldReindex,
      shouldEnableWatch,
      workingTree,
      ...(pendingReindex.length > 0 && {
        pendingReindex: {
          fileCount: pendingReindex.length,
          files: pendingReindex.slice(0, 20).map((x) => ({ filePath: x.filePath, reason: x.reason }))
        }
      }),
      reasons
    },
    packageBridge,
    vectorIndex: {
      // `enabled` IS server-wide, so it is always honest. The two counters are per-repo: they are
      // omitted rather than zeroed when there is no repo to count, because compact strips nulls and
      // `symbolsIndexed: 0` is indistinguishable from a genuinely empty index.
      enabled: store.isVectorEnabled,
      ...(vectorStats
        ? { symbolsIndexed: vectorStats.symbolsIndexed, lastRebuildAt: vectorStats.lastRebuildAt ?? null }
        : { measured: false })
    },
    unresolvedStats: unresolvedStats
      ? {
          noCandidates: unresolvedStats.noCandidates,
          ambiguous: unresolvedStats.ambiguous,
          externalBoundary: unresolvedStats.externalBoundary,
          importsTotal: unresolvedStats.importsTotal,
          importsClassified: unresolvedStats.importsClassified,
          importClassificationRatio: unresolvedStats.importClassificationRatio,
          trulyUnresolved: unresolvedStats.trulyUnresolved,
        }
      : null,
    actionHints
  }, "compact");
}

// ── index_repository ──────────────────────────────────────────────────────────

export async function handleIndexRepository(
  args: {
    repoId: string;
    repoPath: string;
    mode: IndexMode;
    docsMode: "auto" | "on" | "off";
    maxFiles: number;
    batchSize: number;
  },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, constants } = ctx;
  assertPathAllowed(args.repoPath, constants.allowedRoots);
  const docsEnabled = resolveDocsMode(args.docsMode, constants.DOCS_INDEXING_ENABLED);
  store.ensureRepository(args.repoId, args.repoPath);
  const summary = await ctx.runIndexAndResolve(
    args.repoId,
    args.repoPath,
    args.mode,
    docsEnabled,
    clamp(args.maxFiles, 1, constants.MAX_FILES_PER_RUN),
    clamp(args.batchSize, 1, 2_000)
  );
  return ctx.asText(summary);
}

// ── watch_repo ────────────────────────────────────────────────────────────────

export async function handleWatchRepo(
  args: { action: "start" | "stop" | "status"; repoId?: string; repoPath?: string },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, watchManager, activeWatchRef, watchInactivityTimers, constants } = ctx;

  if (args.action === "start") {
    if (!args.repoId) throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoId is required for action=start");
    if (!args.repoPath) throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoPath is required for action=start");
    assertPathAllowed(args.repoPath, constants.allowedRoots);
    store.ensureRepository(args.repoId, args.repoPath);
    const startResult = await activateWatchForRepo(args.repoId, args.repoPath, "watch_repo:start", ctx);
    return ctx.asText(startResult);
  }

  if (args.action === "stop") {
    if (!args.repoId) throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoId is required for action=stop");
    if (activeWatchRef.current === args.repoId) activeWatchRef.current = null;
    clearWatchInactivityTimer(args.repoId, watchInactivityTimers);
    return ctx.asText(await watchManager.stop(args.repoId));
  }

  return ctx.asText({
    autoStartEnabled: constants.WATCH_AUTO_START,
    manualWatchSupported: true,
    activeOnly: constants.WATCH_ACTIVE_ONLY,
    activeWatchRepoId: activeWatchRef.current,
    watchActiveTtlMs: constants.WATCH_ACTIVE_TTL_MS,
    recommendation: "Use watch_repo start only for short debug sessions; stop after diagnostics.",
    watchers: watchManager.getStatus(args.repoId)
  });
}

// ── detect_changes ────────────────────────────────────────────────────────────

export function handleDetectChanges(
  args: {
    repoId: string;
    baseRef?: string;
    headRef: string;
    includeUntracked: boolean;
    maxFiles: number;
    impactLimit: number;
    policy: "quick-triage" | "strict-review" | "release-gate" | "custom";
    minRiskScore?: number;
    riskLevels?: ("high" | "medium" | "low")[];
    maxResults?: number;
    sortBy?: "risk" | "impact" | "path";
    groupBy: "file" | "module";
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `detect_changes: unknown repoId '${args.repoId}'. Run index_repository first.`);
  }

  const latestRun = store.getLatestRun(args.repoId);
  const indexedCommitSha = latestRun?.commitSha ?? null;
  const policyDefaults = resolveDetectChangesPolicy(args.policy);
  const minRiskScore = args.minRiskScore ?? policyDefaults.minRiskScore;
  const riskLevels = args.riskLevels ?? policyDefaults.riskLevels;
  const maxResults = args.maxResults ?? policyDefaults.maxResults;
  const sortBy = args.sortBy ?? policyDefaults.sortBy;

  const core = computeChangedFileImpacts(store, {
    repoId: args.repoId,
    repoPath: repo.repoPath,
    baseRef: args.baseRef,
    headRef: args.headRef,
    includeUntracked: args.includeUntracked,
    maxFiles: args.maxFiles,
    impactLimit: args.impactLimit,
    indexedCommitSha
  });
  const { baseRef, headRef, changedFiles, note, impacts } = core;

  const sortedImpacts = [...impacts].sort((a, b) => {
    if (sortBy === "impact") return b.impactedFilesCount - a.impactedFilesCount || b.riskScore - a.riskScore || a.filePath.localeCompare(b.filePath);
    if (sortBy === "path") return a.filePath.localeCompare(b.filePath);
    return b.riskScore - a.riskScore || b.impactedFilesCount - a.impactedFilesCount || a.filePath.localeCompare(b.filePath);
  });

  const allowedRiskLevels = new Set(riskLevels);
  const filteredImpacts = sortedImpacts.filter((x) => x.riskScore >= minRiskScore && allowedRiskLevels.has(x.riskLevel));
  const selectedImpacts = filteredImpacts.slice(0, maxResults);

  const riskSummary = {
    highRiskCount: selectedImpacts.filter((x) => x.riskLevel === "high").length,
    mediumRiskCount: selectedImpacts.filter((x) => x.riskLevel === "medium").length,
    lowRiskCount: selectedImpacts.filter((x) => x.riskLevel === "low").length,
    maxRiskScore: selectedImpacts[0]?.riskScore ?? 0,
    avgRiskScore:
      selectedImpacts.length > 0
        ? Math.round((selectedImpacts.reduce((sum, x) => sum + x.riskScore, 0) / selectedImpacts.length) * 100) / 100
        : 0
  };

  const impactedFileSet = new Set<string>();
  for (const row of selectedImpacts) {
    for (const impacted of row.topImpactedFiles) impactedFileSet.add(impacted.filePath);
  }

  const moduleGroups =
    args.groupBy === "module"
      ? (() => {
          const allImpactedFiles = selectedImpacts.flatMap((x) => x.topImpactedFiles.map((f) => f.filePath));
          const grouped = store.groupFilesByModule(allImpactedFiles);
          return Object.entries(grouped)
            .map(([module, files]) => ({ module, fileCount: files.length, topFiles: files.slice(0, 5) }))
            .sort((a, b) => b.fileCount - a.fileCount);
        })()
      : undefined;

  const filterInfo = {
    policyUsed: args.policy,
    minRiskScore,
    riskLevels: Array.from(allowedRiskLevels),
    maxResults,
    sortBy,
    matchedCount: filteredImpacts.length,
    returnedCount: selectedImpacts.length,
    droppedByLimit: Math.max(0, filteredImpacts.length - selectedImpacts.length)
  };

  if (profile === "nano") {
    const topRiskChanges = selectedImpacts.slice(0, 5).map((x) => ({ filePath: x.filePath, riskScore: x.riskScore, riskLevel: x.riskLevel }));
    return ctx.asText({ repoId: args.repoId, baseRef, headRef, changedFileCount: changedFiles.length, topChangedFiles: changedFiles.slice(0, 20), topRiskChanges, riskSummary, filter: filterInfo, impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, indexedCommitSha, baseRef, headRef, changedFileCount: changedFiles.length, changedFiles, impacts: selectedImpacts, riskSummary, filter: filterInfo, impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note }, profile);
  }

  if (profile === "verbose") {
    return ctx.asText({
      repoId: args.repoId, indexedCommitSha, latestRun, baseRef, headRef, includeUntracked: args.includeUntracked,
      changedFileCount: changedFiles.length, changedFiles, impacts: selectedImpacts, riskSummary, filter: filterInfo,
      impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note,
      summary: { filesCapped: changedFiles.length === args.maxFiles, maxFiles: args.maxFiles, impactLimit: args.impactLimit, resultsLimited: filterInfo.droppedByLimit > 0 }
    }, profile);
  }

  return ctx.asText({ repoId: args.repoId, indexedCommitSha, baseRef, headRef, changedFileCount: changedFiles.length, changedFiles, impacts: selectedImpacts, riskSummary, filter: filterInfo, impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note }, profile);
}

// ── change_impact (ENH-E) ──────────────────────────────────────────────────────
// One intent — "what did my change affect and which tests cover it" — fusing
// detect_changes (changed files + risk) → find_impact_files (dependents) →
// link_tests_to_source (covering tests) into a ranked "tests to run" list plus a
// residual-risk note. Lets the agent run a trusted targeted test subset instead of the
// whole suite after editing.

const CHANGE_IMPACT_SOURCE_PROBE_CAP = 100;

export function handleChangeImpact(
  args: {
    repoId: string;
    baseRef?: string;
    headRef: string;
    includeUntracked: boolean;
    maxFiles: number;
    impactLimit: number;
    testLinkMinScore: number;
    testLinkMaxCandidates: number;
    maxTestsToRun: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `change_impact: unknown repoId '${args.repoId}'. Run index_repository first.`);
  }

  const indexedCommitSha = store.getLatestRun(args.repoId)?.commitSha ?? null;
  const core = computeChangedFileImpacts(store, {
    repoId: args.repoId,
    repoPath: repo.repoPath,
    baseRef: args.baseRef,
    headRef: args.headRef,
    includeUntracked: args.includeUntracked,
    maxFiles: args.maxFiles,
    impactLimit: args.impactLimit,
    indexedCommitSha
  });

  // Dependent set = changed files ∪ their static dependents. Carry per-file risk for ranking.
  const riskByFile = new Map<string, number>();
  for (const imp of core.impacts) riskByFile.set(imp.filePath, imp.riskScore);
  const dependentFiles = new Set<string>(core.changedFiles);
  for (const imp of core.impacts) {
    for (const t of imp.topImpactedFiles) {
      dependentFiles.add(t.filePath);
      if (!riskByFile.has(t.filePath)) riskByFile.set(t.filePath, imp.riskScore); // inherit caller risk
    }
  }

  // Probe covering tests per dependent source file (capped), highest-risk files first.
  const probeOrder = [...dependentFiles].sort((a, b) => (riskByFile.get(b) ?? 0) - (riskByFile.get(a) ?? 0));
  const probed = probeOrder.slice(0, CHANGE_IMPACT_SOURCE_PROBE_CAP);
  const sourceProbeTruncated = probeOrder.length > probed.length;

  const testMap = new Map<string, { testFile: string; coveredSources: Set<string>; score: number; reasons: Set<string> }>();
  const coveredSources = new Set<string>();
  // Shared across every probe so each source file's distinctive tokens (name-affinity, ISSUE-017)
  // are computed at most once for the whole request, not re-tokenized over the full source set on
  // each of up to CHANGE_IMPACT_SOURCE_PROBE_CAP calls. (review)
  const sourceTokensCache = new Map<string, Set<string>>();
  for (const sourceFile of probed) {
    // `limit` (3rd arg) caps total links AND triggers an early loop break in linkTestsToSource,
    // so it must be the per-source budget (maxTestsToRun), NOT testLinkMaxCandidates (the
    // per-test candidate cap, 4th arg) — passing the small value there truncated each probe to ~3.
    const links = store.linkTestsToSource(args.repoId, sourceFile, args.maxTestsToRun, args.testLinkMaxCandidates, args.testLinkMinScore, sourceTokensCache);
    const srcRisk = (riskByFile.get(sourceFile) ?? 0) / 100; // 0..1
    for (const link of links) {
      coveredSources.add(link.sourceFile);
      const weighted = Math.max(srcRisk, 0.01) * link.score; // keep zero-risk-but-linked tests rankable
      const existing = testMap.get(link.testFile);
      if (existing) {
        existing.coveredSources.add(link.sourceFile);
        existing.score = Math.max(existing.score, weighted);
        for (const r of link.reasons ?? []) existing.reasons.add(r);
      } else {
        testMap.set(link.testFile, { testFile: link.testFile, coveredSources: new Set([link.sourceFile]), score: weighted, reasons: new Set(link.reasons ?? []) });
      }
    }
  }

  const testsToRun = [...testMap.values()]
    .map((t) => ({ testFile: t.testFile, coveredSources: [...t.coveredSources], score: Math.round(t.score * 1000) / 1000, reasons: [...t.reasons] }))
    .sort((a, b) => b.score - a.score || b.coveredSources.length - a.coveredSources.length || a.testFile.localeCompare(b.testFile))
    .slice(0, args.maxTestsToRun);

  const untestedChangedFiles = core.changedFiles.filter((f) => !coveredSources.has(f));
  const dependentCount = dependentFiles.size;
  const covered = [...dependentFiles].filter((f) => coveredSources.has(f)).length;

  const riskSummary = {
    high: core.impacts.filter((x) => x.riskLevel === "high").length,
    medium: core.impacts.filter((x) => x.riskLevel === "medium").length,
    low: core.impacts.filter((x) => x.riskLevel === "low").length,
    maxRiskScore: core.impacts.reduce((m, x) => Math.max(m, x.riskScore), 0)
  };

  const maxUnresolvedRatio = core.impacts.reduce((m, x) => Math.max(m, x.reliabilitySummary.unresolvedRatio), 0);
  const coverage = buildCoverageBlock({
    resultCount: testsToRun.length,
    // Tests are expected only when there ARE dependent files to cover; an empty result then
    // is a low-confidence "no tests found" signal (emits a fallback), not a clean bill.
    expectedNonZero: dependentCount > 0,
    truncated: sourceProbeTruncated,
    reliabilitySummary: { unresolvedRatio: maxUnresolvedRatio },
    kind: "change_impact"
  });

  const residualRisk = {
    untestedChangedFiles,
    note:
      untestedChangedFiles.length > 0
        ? `${String(untestedChangedFiles.length)} changed file(s) have no linked test — run the broader suite for these.`
        : "all changed files have at least one linked test."
  };
  const testCoverage = { dependentFiles: dependentCount, covered, uncovered: dependentCount - covered, ...(sourceProbeTruncated ? { probeTruncatedAt: CHANGE_IMPACT_SOURCE_PROBE_CAP } : {}) };

  if (profile === "nano") {
    return ctx.asText(
      {
        repoId: args.repoId,
        changedFileCount: core.changedFiles.length,
        topTestsToRun: testsToRun.slice(0, 10).map((t) => ({ testFile: t.testFile, score: t.score })),
        riskSummary,
        residualRisk: residualRisk.note,
        coverage: coverage.confidence,
        note: core.note
      },
      profile
    );
  }

  if (profile === "compact") {
    return ctx.asText(
      {
        repoId: args.repoId,
        baseRef: core.baseRef,
        headRef: core.headRef,
        changedFileCount: core.changedFiles.length,
        changedFiles: core.changedFiles,
        riskSummary,
        testsToRun: testsToRun.map((t) => ({ testFile: t.testFile, coveredSources: t.coveredSources, score: t.score })),
        testCoverage,
        residualRisk,
        coverage,
        indexMeta: buildIndexMeta(store, args.repoId),
        note: core.note
      },
      profile
    );
  }

  return ctx.asText(
    {
      repoId: args.repoId,
      indexedCommitSha,
      baseRef: core.baseRef,
      headRef: core.headRef,
      changedFileCount: core.changedFiles.length,
      changedFiles: core.changedFiles,
      impacts: core.impacts,
      riskSummary,
      testsToRun,
      testCoverage,
      residualRisk,
      coverage,
      indexMeta: buildIndexMeta(store, args.repoId),
      note: core.note
    },
    profile
  );
}

// ── local helpers (used only by this handler group) ──────────────────────────

function resolveDocsMode(mode: "auto" | "on" | "off", docsEnabled: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return docsEnabled;
}
