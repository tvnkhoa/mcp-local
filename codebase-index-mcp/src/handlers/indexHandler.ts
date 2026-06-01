import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveHeadCommitSha,
  getRepoStaleness,
  getRepoWorkingTreeState,
  runGitLines,
  collectGitChangedFiles
} from "../gitHelpers.js";
import { assertPathAllowed, clamp } from "../indexGuardrails.js";
import { resolveResponseProfile } from "../responseFormatter.js";
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

  const reasons: string[] = [];
  if (repoId && !repo) reasons.push("repository not registered; run index_repository first");
  if (repoId && repo && !latestRun) reasons.push("repository has no indexed run yet");
  if (staleness?.isStale === true) reasons.push("indexed commit differs from HEAD");
  if (workingTree?.isDirty === true) reasons.push("working tree has uncommitted changes");

  let codebaseStatus: "unknown" | "needs_index" | "stale" | "dirty" | "ready" = "unknown";
  if (!repoId || !repo) {
    codebaseStatus = "unknown";
  } else if (!latestRun) {
    codebaseStatus = "needs_index";
  } else if (staleness?.isStale === true) {
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
                : codebaseStatus === "stale"
                  ? "Indexed commit does not match HEAD."
                  : codebaseStatus === "dirty"
                    ? "Working tree changed after latest index run."
                    : "Index appears up-to-date.",
            arguments: { repoId, repoPath: repo.repoPath, mode: "incremental" }
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
    codebaseState: {
      repoId: repoId ?? null,
      status: codebaseStatus,
      shouldReindex,
      shouldEnableWatch,
      workingTree,
      reasons
    },
    packageBridge,
    vectorIndex: {
      enabled: store.isVectorEnabled,
      symbolsIndexed: vectorStats?.symbolsIndexed ?? 0,
      lastRebuildAt: vectorStats?.lastRebuildAt ?? null,
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
    mode: "full" | "incremental";
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
  const headRef = args.headRef;
  const baseRef = args.baseRef ?? indexedCommitSha;
  const policyDefaults = resolveDetectChangesPolicy(args.policy);
  const minRiskScore = args.minRiskScore ?? policyDefaults.minRiskScore;
  const riskLevels = args.riskLevels ?? policyDefaults.riskLevels;
  const maxResults = args.maxResults ?? policyDefaults.maxResults;
  const sortBy = args.sortBy ?? policyDefaults.sortBy;

  const headCommitSha = resolveHeadCommitSha(repo.repoPath);
  const isWorkingTreeMode = !baseRef || (headCommitSha != null && baseRef === headCommitSha);

  let trackedChanged: string[];
  let note: string;
  if (isWorkingTreeMode) {
    const unstaged = runGitLines(repo.repoPath, ["diff", "--name-only", "HEAD"]);
    const staged = runGitLines(repo.repoPath, ["diff", "--cached", "--name-only"]);
    trackedChanged = [...new Set([...unstaged, ...staged])];
    note = baseRef
      ? "using working-tree diff (no new commits since last index; showing staged + unstaged changes)"
      : "baseRef unavailable; using working-tree diff against HEAD";
  } else {
    trackedChanged = runGitLines(repo.repoPath, ["diff", "--name-only", `${baseRef}..${headRef}`]);
    note = "using git range diff";
  }

  const untracked = args.includeUntracked
    ? runGitLines(repo.repoPath, ["ls-files", "--others", "--exclude-standard"])
    : [];

  const changedFiles = [
    ...new Set(
      [...trackedChanged, ...untracked]
        .map((x) => x.replace(/\\/g, "/").trim())
        .filter((x) => x.length > 0)
    )
  ].slice(0, args.maxFiles);

  const impacts = changedFiles.map((filePath) => {
    const impact = store.getImpactFiles(args.repoId, filePath, args.impactLimit);
    const risk = scoreChangeRisk(impact.impactedFiles.length, impact.reliabilitySummary, args.impactLimit);
    return {
      filePath,
      impactedFilesCount: impact.impactedFiles.length,
      reliabilitySummary: impact.reliabilitySummary,
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      riskSignals: risk.signals,
      topImpactedFiles: impact.impactedFiles.slice(0, 5)
    };
  });

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

// ── local helpers (used only by this handler group) ──────────────────────────

export function resolveDocsMode(mode: "auto" | "on" | "off", docsEnabled: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return docsEnabled;
}

function scoreChangeRisk(
  impactedFilesCount: number,
  reliabilitySummary: { edgeCount: number; medianConfidence: number; lowConfidenceEdgeCount: number; unresolvedRatio: number },
  impactLimit: number
): { riskScore: number; riskLevel: "high" | "medium" | "low"; signals: { impactBreadth: number; unresolvedPenalty: number; confidencePenalty: number; lowConfidencePenalty: number } } {
  const clampRisk = (v: number) => Math.max(0, Math.min(1, v));
  const impactBreadth = clampRisk(impactedFilesCount / Math.max(1, impactLimit));
  const unresolvedPenalty = clampRisk(reliabilitySummary.unresolvedRatio);
  const confidencePenalty = clampRisk(1 - reliabilitySummary.medianConfidence);
  const lowConfidencePenalty = reliabilitySummary.edgeCount > 0 ? clampRisk(reliabilitySummary.lowConfidenceEdgeCount / reliabilitySummary.edgeCount) : 0;
  const score01 = impactBreadth * 0.5 + unresolvedPenalty * 0.25 + confidencePenalty * 0.2 + lowConfidencePenalty * 0.05;
  const riskScore = Math.round(score01 * 100);
  const riskLevel = riskScore >= 67 ? "high" : riskScore >= 34 ? "medium" : "low";
  return { riskScore, riskLevel, signals: { impactBreadth, unresolvedPenalty, confidencePenalty, lowConfidencePenalty } };
}

function resolveDetectChangesPolicy(policy: "quick-triage" | "strict-review" | "release-gate" | "custom"): { minRiskScore: number; riskLevels: ("high" | "medium" | "low")[]; maxResults: number; sortBy: "risk" | "impact" | "path" } {
  if (policy === "quick-triage") return { minRiskScore: 20, riskLevels: ["high", "medium"], maxResults: 20, sortBy: "risk" };
  if (policy === "strict-review") return { minRiskScore: 40, riskLevels: ["high", "medium"], maxResults: 50, sortBy: "impact" };
  if (policy === "release-gate") return { minRiskScore: 67, riskLevels: ["high"], maxResults: 100, sortBy: "risk" };
  return { minRiskScore: 0, riskLevels: ["high", "medium", "low"], maxResults: 100, sortBy: "risk" };
}

export async function activateWatchForRepo(
  repoId: string,
  repoPath: string,
  reason: string,
  ctx: HandlerContext
): Promise<{ started: boolean; message: string }> {
  const { watchManager, activeWatchRef, watchInactivityTimers, constants } = ctx;
  assertPathAllowed(repoPath, constants.allowedRoots);

  if (constants.WATCH_ACTIVE_ONLY && activeWatchRef.current && activeWatchRef.current !== repoId) {
    clearWatchInactivityTimer(activeWatchRef.current, watchInactivityTimers);
    await watchManager.stop(activeWatchRef.current);
  }

  const currentStatus = watchManager.getStatus(repoId);
  let result: { started: boolean; message: string };
  if (currentStatus.length === 0) {
    result = watchManager.start(repoId, repoPath);
  } else {
    result = { started: false, message: `watch already active for repoId '${repoId}'` };
  }

  activeWatchRef.current = repoId;
  armWatchInactivityTimer(repoId, ctx);
  if (result.started) {
    process.stderr.write(`[watch-activate] repoId=${repoId} reason=${reason}\n`);
  }
  return result;
}

export function armWatchInactivityTimer(repoId: string, ctx: HandlerContext): void {
  const { watchManager, activeWatchRef, watchInactivityTimers, constants } = ctx;
  clearWatchInactivityTimer(repoId, watchInactivityTimers);
  const timer = setTimeout(() => {
    if (constants.WATCH_ACTIVE_ONLY && activeWatchRef.current === repoId) {
      activeWatchRef.current = null;
    }
    void watchManager.stop(repoId);
    watchInactivityTimers.delete(repoId);
    process.stderr.write(`[watch-idle-stop] repoId=${repoId} ttlMs=${String(constants.WATCH_ACTIVE_TTL_MS)}\n`);
  }, constants.WATCH_ACTIVE_TTL_MS);
  watchInactivityTimers.set(repoId, timer);
}

export function clearWatchInactivityTimer(repoId: string, timers: Map<string, NodeJS.Timeout>): void {
  const timer = timers.get(repoId);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(repoId);
}

// re-export for use by index.ts maybeAutoActivateWatchFromArgs
export { activateWatchForRepo as _activateWatchForRepo };
