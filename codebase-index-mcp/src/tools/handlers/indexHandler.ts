import { existsSync, statSync } from "node:fs";
import { transportFromEnv } from "../../config/envConfig.js";
import { runningEntryPath } from "../../config/serverVersion.js";
import { loadCitationConfig } from "../../services/docs/citationConfig.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";
import { DEFAULT_STALE_RUN_MS, freshnessStateDir, liveRunMarkers, lockFileFor, readDirtyLedger, releaseLock, removeRepoStateFiles, tryAcquireLock, vanishedDirtyPaths } from "../../middleware/freshness.js";
import { readStatusEntriesAsync, stillDirty, summarizeWorkingTree, type StatusEntry } from "../../services/git/gitHelpers.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { findWorktreeOwner, getRepoStaleness } from "../../services/git/gitHelpers.js";
import { assertPathAllowed, clamp } from "../../middleware/indexGuardrails.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { resolveDetectChangesPolicy } from "../../services/analysis/policyResolver.js";
import { computeChangedFileImpacts } from "../../services/impact/changeAnalysis.js";
import { buildCoverageBlock } from "../../middleware/coverage.js";
import { buildIndexMeta } from "./impactHandler.js";
import type { IndexMode } from "../../types/index.js";
import { activateWatchForRepo, clearWatchInactivityTimer } from "../../services/watch/watchLifecycle.js";
import type { HandlerContext } from "./handlerContext.js";
import { MAX_WAIT_MS, sameRepoPath, type IndexJob } from "../../services/indexing/indexJobs.js";

/**
 * Changed files that cannot have a linked test, by nature (MCP-ISSUE-058(e)).
 *
 * `change_impact` on a docs-only diff put 10 `SKILL.md`, 3 `docs/*.md` and a `Dockerfile` into
 * `residualRisk.untestedChangedFiles` with "run the broader suite for these" — advice that is not
 * merely useless but actively misleading about what the change did.
 */
const NON_TESTABLE_CHANGE_PATH =
  /(\.(md|markdown|mdx|txt|rst|adoc|ya?ml|json|toml|ini|cfg|conf|lock|svg|png|jpe?g|gif|ico|csv)$)|(^|\/)(Dockerfile|\.dockerignore|\.gitignore|\.editorconfig|LICENSE)$/i;

function isNonTestableChangePath(filePath: string): boolean {
  return NON_TESTABLE_CHANGE_PATH.test(filePath.replace(/\\/g, "/"));
}

/**
 * MCP-ISSUE-060: a ref the caller chose that git cannot resolve is invalid INPUT, not a server fault.
 * Left unmapped it falls through `mapError`'s final branch and reports `INTERNAL_ERROR`, telling the
 * caller to file a bug about their own typo.
 *
 * Matched by `name`, not `instanceof`: ADR 0001 records that identity checks across package
 * boundaries are unreliable in this workspace, and this guard is cheap enough to be robust anyway.
 */
function asInvalidParamsOnBadRef<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && error.name === "ChangeAnalysisError") {
      throw new McpError(ErrorCode.InvalidParams, error.message);
    }
    throw error;
  }
}

// ── health_check ─────────────────────────────────────────────────────────────

// Module-level on purpose: this module loads at start-up, so the timestamp is the process's own
// start without an OS call. Compared with the served process, `pid` / `buildAt` expose a session
// still talking to an old stdio child after a `/mcp` transport switch or an upgrade.
const PROCESS_STARTED_AT = new Date().toISOString();

/**
 * ISO mtime of the running entry — `dist/index.js` two levels up from this file, or `dist/bundle/index.js`
 * itself when bundled (MCP-ISSUE-124); null if unreadable.
 */
function entryBuildAt(): string | null {
  try {
    return statSync(runningEntryPath(import.meta.url, "indexHandler", "../../index.js")).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Which process answered. Small enough for every response profile. */
export function buildServerInfo(
  transport: "stdio" | "http" = transportFromEnv().kind,
  buildAt: string | null = entryBuildAt()
): { pid: number; startedAt: string; transport: "stdio" | "http"; buildAt: string | null } {
  return { pid: process.pid, startedAt: PROCESS_STARTED_AT, transport, buildAt };
}

export async function handleHealthCheck(
  args: { repoId?: string },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, watchManager, activeWatchRef, constants } = ctx;
  const { repoId } = args;

  const repo = repoId ? store.getRepository(repoId) : null;
  // MCP-ISSUE-086 (release K1): ONE git read, async. It used to be two synchronous `git status` runs
  // (porcelain v1 for the working-tree block, v2 for the dirty ledger) that held the server thread
  // ~570 ms on wec.be and ~300 ms on wec.aria — every other call in flight waited. HEAD comes from the
  // same read. `null`: not a git repo, or git failed — the same answers the sync reads gave then.
  let status: { head: string | null; entries: StatusEntry[] } | null = null;
  if (repo) {
    try {
      status = await readStatusEntriesAsync(repo.repoPath);
    } catch {
      status = null;
    }
  }
  const latestRun = repoId ? store.getLatestRun(repoId) : null;
  const staleness = repoId ? getRepoStaleness(repoId, store, repo ? (status?.head ?? null) : undefined) : null;
  const watchStatuses = repoId ? watchManager.getStatus(repoId) : [];
  const watchRunning = watchStatuses.length > 0;
  const workingTree = repo ? summarizeWorkingTree(status?.entries ?? null) : null;
  const packageBridge = repoId ? store.getPackageBridgeStats(repoId) : null;
  const vectorStats = repoId ? store.getVectorStats(repoId) : null;
  const unresolvedStats = repoId ? store.getUnresolvedStats(repoId, latestRun?.runId) : null;

  // MCP-ISSUE-042: the third staleness signal. The other two are git-based and a refactor rollback
  // defeats both — it restores the pre-apply bytes, so HEAD matches and the tree is clean, while the
  // graph still holds the applied names. Without this, `health_check` reported "ready" for a graph
  // containing a symbol that exists in no file on disk.
  const pendingReindex = repoId ? store.getPendingReindexFiles(repoId) : [];

  // R1 (release B.1): the fourth signal. Files a dirty run indexed from the working tree, since
  // deleted or reverted, leave a clean tree at the indexed HEAD — and their symbols in the graph.
  // wec.aria's acceptance found health_check saying "up-to-date" in exactly that state.
  let indexedFromOldTree: string[] = [];
  if (repo && status?.head) {
    const ledger = readDirtyLedger(freshnessStateDir(constants.dbPath), repoId!);
    indexedFromOldTree = vanishedDirtyPaths(ledger, status.head, stillDirty(status.entries, ledger?.paths ?? []));
  }

  const reasons: string[] = [];
  if (repoId && !repo) reasons.push("repository not registered; run index_repository first");
  if (repoId && repo && !latestRun) reasons.push("repository has no indexed run yet");
  if (staleness?.isStale === true) reasons.push("indexed commit differs from HEAD");
  if (workingTree?.isDirty === true) reasons.push("working tree has uncommitted changes");
  if (pendingReindex.length > 0) {
    reasons.push(`${String(pendingReindex.length)} file(s) written by the refactor engine are not re-indexed`);
  }
  if (indexedFromOldTree.length > 0) {
    reasons.push(`${String(indexedFromOldTree.length)} file(s) were indexed from a working tree that has since changed (deleted or reverted): ${indexedFromOldTree.slice(0, 5).join(", ")}`);
  }

  let codebaseStatus: "unknown" | "needs_index" | "stale" | "dirty" | "ready" = "unknown";
  if (!repoId || !repo) {
    codebaseStatus = "unknown";
  } else if (!latestRun) {
    codebaseStatus = "needs_index";
  } else if (staleness?.isStale === true) {
    codebaseStatus = "stale";
  } else if (pendingReindex.length > 0 || indexedFromOldTree.length > 0) {
    // Ranked above "dirty": a clean tree with a pending set is exactly the rollback case, and it is
    // the one where nothing else in this response would report a problem.
    codebaseStatus = "stale";
  } else if (workingTree?.isDirty === true) {
    codebaseStatus = "dirty";
  } else if (staleness?.isStale === false) {
    codebaseStatus = "ready";
  }

  // R1: with the freshness gate on, a stale or dirty index is refreshed by the next read query, so a
  // manual index_repository is optional. Saying "high" here sent callers to re-index by hand (seen live
  // right after release B: the hint said high while the gate was already refreshing).
  const selfRefreshing = constants.QUERY_REFRESH_ENABLED === true && (codebaseStatus === "stale" || codebaseStatus === "dirty");
  const shouldReindex = !selfRefreshing && (codebaseStatus === "needs_index" || codebaseStatus === "stale" || codebaseStatus === "dirty");
  const shouldEnableWatch = Boolean(repoId && repo && workingTree?.isDirty === true && !watchRunning);
  const actionHints =
    repoId && repo
      ? [
          {
            action: "index_repository",
            recommended: shouldReindex,
            urgency: selfRefreshing
              ? "low"
              : codebaseStatus === "stale" || codebaseStatus === "needs_index"
                ? "high"
                : codebaseStatus === "dirty"
                  ? "medium"
                  : "low",
            reason:
              codebaseStatus === "needs_index"
                ? "No successful index run exists for this repo."
                : pendingReindex.length > 0
                  ? "Files written by the refactor engine have not been re-indexed — the graph may hold names that exist in no file on disk."
                  : indexedFromOldTree.length > 0 && staleness?.isStale !== true
                    ? `${String(indexedFromOldTree.length)} file(s) were indexed from a working tree that has since changed (deleted or reverted); the next incremental run clears them.`
                  : codebaseStatus === "stale"
                    ? "Indexed commit does not match HEAD."
                    : codebaseStatus === "dirty"
                      ? "Working tree changed after latest index run."
                      : "Index appears up-to-date.",
            ...(selfRefreshing && {
              note: "Read tools refresh this index automatically on the next query (CODEBASE_INDEX_QUERY_REFRESH_ENABLED). Call index_repository only to force it now."
            }),
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
    server: buildServerInfo(),
    dbPath: constants.dbPath,
    allowedRootCount: constants.allowedRoots.length,
    docsLane: {
      docsIndexingEnabled: constants.DOCS_INDEXING_ENABLED,
      docsToolsEnabled: constants.DOCS_TOOLS_ENABLED
    },
    latestRun,
    staleness,
    ...(repo && { worktreeOf: findWorktreeOwner({ repoId: repoId!, repoPath: repo.repoPath }, store.listRepositories()) }),
    ...(repo && { citations: citationStatus(store, repoId!, repo.repoPath) }),
    // MCP-ISSUE-082: the SQL lane's named gaps — a statement no reader recognised is listed, never dropped.
    ...(repo && (() => {
      const sqlLane = store.getSqlLaneStats(repoId!);
      return sqlLane ? { sqlLane } : {};
    })()),
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

// ── remove_repository ─────────────────────────────────────────────────────────

/** A refresh lock older than this is broken by the next taker (the gate's own default). */
const REMOVE_LOCK_STALE_MS = 15 * 60_000;

/**
 * MCP-ISSUE-105: drop a registered repo's rows and state files; refuses the cases listed in the tool description.
 *
 * The repo's refresh lock is taken FIRST and held to the end: a gate takes that lock before it writes its run marker,
 * so with the lock ours no gate of any process can start a run between the marker check and the purge. (An
 * index_repository or watcher run of another process takes no lock, only a marker; the marker check covers it unless
 * it starts in the instant between the check and the purge.) A watcher of ANOTHER process leaves no signal at all
 * until it runs, so it is not refused here — see the tool description.
 */
export function handleRemoveRepository(args: { repoId: string; force: boolean }, ctx: HandlerContext): CallToolResult | Promise<CallToolResult> {
  const { store, activeWatchRef, constants } = ctx;
  const repo = store.getRepository(args.repoId);
  if (!repo) throw new McpError(ErrorCode.InvalidParams, `remove_repository: unknown repoId '${args.repoId}'; list_repositories names the registered ones.`);
  if (activeWatchRef.current === args.repoId) {
    throw new McpError(ErrorCode.InvalidRequest, `remove_repository: a watcher is running for '${args.repoId}'; stop it with watch_repo(action:'stop') first.`);
  }
  if (!args.force && existsSync(repo.repoPath)) {
    throw new McpError(ErrorCode.InvalidRequest, `remove_repository: repoPath '${repo.repoPath}' still exists on disk; pass force:true to drop the index of a live checkout.`);
  }
  const stateDir = freshnessStateDir(constants.dbPath);
  const lockFile = lockFileFor(stateDir, args.repoId);
  if (!tryAcquireLock(lockFile, REMOVE_LOCK_STALE_MS, Date.now())) {
    throw new McpError(ErrorCode.InvalidRequest, `remove_repository: a refresh of '${args.repoId}' holds its lock (this or another server process); retry when it ends.`);
  }
  let async = false;
  try {
    const runs = liveRunMarkers(stateDir, args.repoId, DEFAULT_STALE_RUN_MS, Date.now());
    if (runs.length > 0) {
      throw new McpError(ErrorCode.InvalidRequest, `remove_repository: an index run of '${args.repoId}' is in progress (pid ${runs.map((r) => String(r.pid)).join(", ")}); retry when it ends.`);
    }
    const done = (rowsRemoved: Record<string, number>): CallToolResult => {
      const stateFilesRemoved = removeRepoStateFiles(stateDir, args.repoId);
      return ctx.asText({ repoId: args.repoId, repoPath: repo.repoPath, removed: true, rowsRemoved, stateFilesRemoved }, "compact");
    };
    // Review 3-rest: in the server the delete goes to the writer (the refresh worker, in the DB-wide queue).
    if (ctx.purgeRepository) {
      async = true;
      return ctx.purgeRepository(args.repoId).then(done).finally(() => releaseLock(lockFile));
    }
    return done(store.purgeRepository(args.repoId));
  } finally {
    if (!async) releaseLock(lockFile);
  }
}

// ── index_repository ──────────────────────────────────────────────────────────

/**
 * MCP-ISSUE-112: what index_repository and index_status answer about a job. A job that ended ok answers its run
 * summary (the shape index_repository always returned) plus `runId` and `state`; any other answers the job's state
 * and what to do next.
 */
export function jobView(job: IndexJob, pending: IndexJob[] = []): Record<string, unknown> {
  if (job.state === "ok" && job.result) {
    return { ...job.result, runId: job.runId, state: job.state, source: job.source, ...(job.fallbackReason && { fallbackReason: job.fallbackReason }) };
  }
  const ahead =
    job.state === "queued"
      ? pending.filter((j) => j.runId !== job.runId && j.queuedAt <= job.queuedAt).map((j) => ({ runId: j.runId, repoId: j.repoId, state: j.state }))
      : [];
  return {
    runId: job.runId,
    state: job.state,
    repoId: job.repoId,
    mode: job.mode,
    source: job.source,
    queuedAt: job.queuedAt,
    ...(job.startedAt && { startedAt: job.startedAt }),
    ...(job.finishedAt && { finishedAt: job.finishedAt }),
    ...(job.waitingFor && { waitingFor: job.waitingFor }),
    ...(ahead.length > 0 && { ahead }),
    ...(job.phase && { phase: job.phase }),
    ...(job.progress !== undefined && { progress: job.progress }),
    ...(job.total !== undefined && { total: job.total }),
    ...(job.error && { error: job.error }),
    ...(job.fallbackReason && { fallbackReason: job.fallbackReason }),
    ...(job.result && { result: job.result }),
    ...(job.state === "queued" || job.state === "running"
      ? { next: `poll index_status({ runId: "${job.runId}" }) until state is ok or failed` }
      : {})
  };
}

function requireJobs(ctx: HandlerContext): NonNullable<HandlerContext["indexJobs"]> {
  if (!ctx.indexJobs) throw new McpError(ErrorCode.InternalError, "index jobs are not available in this server context");
  return ctx.indexJobs;
}

export async function handleIndexRepository(
  args: {
    repoId: string;
    repoPath: string;
    mode: IndexMode;
    docsMode: "auto" | "on" | "off";
    maxFiles: number;
    batchSize: number;
    wait?: boolean;
  },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { constants } = ctx;
  const jobs = requireJobs(ctx);
  assertPathAllowed(args.repoPath, constants.allowedRoots);
  const docsEnabled = resolveDocsMode(args.docsMode, constants.DOCS_INDEXING_ENABLED);
  // Follow-up 3: no write on the server thread — the run registers the repo, on the worker's connection
  // (runIndexPipeline → ensureRepository). An IMMEDIATE write here waited out busy_timeout behind the worker.
  const job = jobs.enqueue({
    repoId: args.repoId,
    repoPath: args.repoPath,
    mode: args.mode,
    docsEnabled,
    maxFiles: clamp(args.maxFiles, 1, constants.MAX_FILES_PER_RUN),
    batchSize: clamp(args.batchSize, 1, 2_000),
    source: "index_repository"
  });
  if (args.wait !== true) return ctx.asText(jobView(job, jobs.pending()));
  // A waiting caller with a progress token gets the run's notifications/progress, as before jobs.
  const notify = ctx.progressNotifier;
  let tick = 0;
  const unsubscribe = notify
    ? jobs.subscribe(job.runId, (p) => {
        tick = Math.max(tick + 1, p.progress ?? 0);
        notify(tick, p.total, `${args.repoId}: ${p.phase}`);
      })
    : undefined;
  try {
    return ctx.asText(jobView((await jobs.wait(job.runId, MAX_WAIT_MS)) ?? job, jobs.pending()));
  } finally {
    unsubscribe?.();
  }
}

// ── register_worktree ─────────────────────────────────────────────────────────

/**
 * MCP-ISSUE-114 (IX-4): one call for a new git worktree of an indexed repo — validate it, register it, queue its index
 * job (a new repoId runs full once, MCP-ISSUE-113) and start its watcher; answer the runId at once. Calling it again
 * for the same repoId and path re-queues a run and keeps the watcher.
 */
export async function handleRegisterWorktree(
  args: { parentRepoId: string; repoPath: string; repoId: string },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, constants } = ctx;
  const jobs = requireJobs(ctx);
  assertPathAllowed(args.repoPath, constants.allowedRoots);
  if (args.repoId === args.parentRepoId) {
    throw new McpError(ErrorCode.InvalidParams, `register_worktree: repoId must differ from parentRepoId ('${args.repoId}').`);
  }
  const parent = store.getRepository(args.parentRepoId);
  if (!parent) {
    throw new McpError(ErrorCode.InvalidParams, `register_worktree: unknown parentRepoId '${args.parentRepoId}'. Run list_repositories to see the indexed repos.`);
  }
  if (!existsSync(args.repoPath)) {
    throw new McpError(ErrorCode.InvalidParams, `register_worktree: repoPath does not exist: ${args.repoPath}`);
  }
  // A worktree of the parent shares its git common dir; anything else is the wrong parent (or not a worktree).
  if (findWorktreeOwner({ repoId: args.repoId, repoPath: args.repoPath }, [parent]) !== parent.repoId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `register_worktree: ${args.repoPath} is not a git worktree of '${parent.repoId}' (${parent.repoPath}): their git common dirs differ. Use index_repository for a repo that is not a worktree.`
    );
  }
  if (sameRepoPath(args.repoPath, parent.repoPath)) {
    throw new McpError(ErrorCode.InvalidParams, `register_worktree: repoPath is the parent's own checkout (${parent.repoPath}), not a worktree of it.`);
  }
  const existing = store.getRepository(args.repoId);
  if (existing && !sameRepoPath(existing.repoPath, args.repoPath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `register_worktree: repoId '${args.repoId}' is already registered at ${existing.repoPath}. Pick another repoId, or remove_repository it first.`
    );
  }
  // Review follow-up B: the run registers the repo, so a job not yet run is a registration too.
  const pendingJobs = jobs.pending();
  const pendingSameId = pendingJobs.find((j) => j.repoId === args.repoId && !sameRepoPath(j.repoPath, args.repoPath));
  if (pendingSameId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `register_worktree: repoId '${args.repoId}' has an index job queued for ${pendingSameId.repoPath} (runId ${pendingSameId.runId}). Pick another repoId.`
    );
  }
  const other =
    store.listRepositories().find((r) => r.repoId !== args.repoId && sameRepoPath(r.repoPath, args.repoPath)) ??
    pendingJobs.find((j) => j.repoId !== args.repoId && sameRepoPath(j.repoPath, args.repoPath));
  if (other) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `register_worktree: ${args.repoPath} is already registered as '${other.repoId}'. Use that repoId, or remove_repository it first.`
    );
  }
  // Follow-up 3: the run registers the repo on the worker's connection; this thread does not write.
  const job = jobs.enqueue({
    repoId: args.repoId,
    repoPath: args.repoPath,
    mode: "incremental",
    docsEnabled: constants.DOCS_INDEXING_ENABLED,
    maxFiles: constants.MAX_FILES_PER_RUN,
    batchSize: 200,
    source: "register_worktree",
    // IX-9: the executor seeds from the parent's index when the parent's indexed commit is an ancestor of this
    // worktree's HEAD; otherwise it runs full and reports fallbackReason in index_status.
    seedFrom: parent.repoId
  });
  const watch = await activateWatchForRepo(args.repoId, args.repoPath, "register_worktree", ctx);
  return ctx.asText({
    repoId: args.repoId,
    parentRepoId: parent.repoId,
    repoPath: args.repoPath,
    registered: existing ? "already" : "new",
    runId: job.runId,
    state: job.state,
    ...(job.waitingFor && { waitingFor: job.waitingFor }),
    watch: { ...watch, activeOnly: constants.WATCH_ACTIVE_ONLY },
    next: `poll index_status({ runId: "${job.runId}" }) until state is ok or failed`
  });
}

/** Moved to indexJobs.ts (the job queue compares paths too); re-exported for this module's callers and tests. */
export { sameRepoPath };

// ── index_status ──────────────────────────────────────────────────────────────

/**
 * MCP-ISSUE-112: a job this process holds, else the run as `index_runs` recorded it (a job from before a server
 * restart, or one trimmed from memory). A job whose server died before the run was recorded is unknown.
 */
export function handleIndexStatus(args: { runId: string }, ctx: HandlerContext): CallToolResult {
  const jobs = requireJobs(ctx);
  // IX-A (MCP-ISSUE-126): every answer lists the gate's and the watcher's refresh runs in flight in this process —
  // they hold the same DB-wide queue as jobs, and a hung one was invisible for 5 h.
  const refreshRuns = jobs.refreshes?.list() ?? [];
  const withRefreshes = (body: Record<string, unknown>): CallToolResult => ctx.asText({ ...body, refreshRuns });
  const job = jobs.get(args.runId);
  if (job) return withRefreshes(jobView(job, jobs.pending()));
  const refresh = jobs.refreshes?.get(args.runId);
  if (refresh) return withRefreshes({ ...refresh, next: `poll index_status({ runId: "${refresh.runId}" }) until it answers from index_runs` });
  const run = ctx.store.getRunById(args.runId);
  if (run) {
    const state = run.status === "failed" || run.status === "cancelled" ? "failed" : "ok";
    return withRefreshes({ ...run, state, source: "index_runs" });
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `index_status: unknown runId '${args.runId}'. It is neither a job of this server process nor a recorded run; a job queued before a server restart that had not finished is lost: call index_repository again.`
  );
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
    // MCP-ISSUE-121: no write on the server thread. `ensureRepository` here was an INSERT on this thread's connection,
    // which waits out busy_timeout (30 s) behind the worker's write lock. A repo already registered at this path
    // needs no write; otherwise an index job registers it (or re-points it) on the worker's connection, as
    // index_repository and register_worktree do.
    const existing = store.getRepository(args.repoId);
    const job =
      existing && sameRepoPath(existing.repoPath, args.repoPath)
        ? undefined
        : requireJobs(ctx).enqueue({
            repoId: args.repoId,
            repoPath: args.repoPath,
            mode: "incremental",
            docsEnabled: constants.DOCS_INDEXING_ENABLED,
            maxFiles: constants.MAX_FILES_PER_RUN,
            batchSize: 200,
            source: "watch_repo"
          });
    const startResult = await activateWatchForRepo(args.repoId, args.repoPath, "watch_repo:start", ctx);
    return ctx.asText(job ? { ...startResult, registeredBy: { runId: job.runId, state: job.state } } : startResult);
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

  const core = asInvalidParamsOnBadRef(() =>
    computeChangedFileImpacts(store, {
      repoId: args.repoId,
      repoPath: repo.repoPath,
      baseRef: args.baseRef,
      headRef: args.headRef,
      includeUntracked: args.includeUntracked,
      maxFiles: args.maxFiles,
      impactLimit: args.impactLimit,
      indexedCommitSha
    })
  );
  const { baseRef, headRef, changedFiles, totalChangedFileCount, note, impacts } = core;
  const changedFilesDroppedByLimit = Math.max(0, totalChangedFileCount - changedFiles.length);

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

  // MCP-ISSUE-054: say WHY the result is empty. `strict-review` sets minRiskScore 40; on a real
  // 83-file diff that filtered every row, and the response then read
  // `riskSummary:{highRiskCount:0,...,maxRiskScore:0}` — which a caller reasonably summarises as
  // "no risk in 83 changed files". `matchedCount: 0` was present but stated nothing about the cause.
  // The number quoted here must be the MAXIMUM score, and `sortedImpacts[0]` is only that under
  // `sortBy: "risk"`. `strict-review` — the policy this diagnostic exists for — defaults to
  // `sortBy: "impact"`, and `"path"` sorts alphabetically, so element 0 was routinely some other
  // file's score: a diagnostic added to prevent a false conclusion was stating a false number.
  const emptiedByFilter = filteredImpacts.length === 0 && sortedImpacts.length > 0;
  const maxRiskScoreBeforeFilter = sortedImpacts.reduce((max, x) => Math.max(max, x.riskScore), 0);
  const filterInfo = {
    policyUsed: args.policy,
    minRiskScore,
    riskLevels: Array.from(allowedRiskLevels),
    maxResults,
    sortBy,
    matchedCount: filteredImpacts.length,
    returnedCount: selectedImpacts.length,
    droppedByLimit: Math.max(0, filteredImpacts.length - selectedImpacts.length),
    ...(emptiedByFilter
      ? {
          emptyReason:
            `the filter removed all ${String(sortedImpacts.length)} scored file(s), the diff is not empty — ` +
            `highest score seen was ${String(maxRiskScoreBeforeFilter)} against minRiskScore ${String(minRiskScore)}` +
            (args.policy === "custom" ? "." : ` from policy '${args.policy}'.`),
          maxRiskScoreBeforeFilter
        }
      : {})
  };

  if (profile === "nano") {
    const topRiskChanges = selectedImpacts.slice(0, 5).map((x) => ({ filePath: x.filePath, riskScore: x.riskScore, riskLevel: x.riskLevel }));
    return ctx.asText({ repoId: args.repoId, baseRef, headRef, changedFileCount: totalChangedFileCount, changedFilesReturned: changedFiles.length, changedFilesDroppedByLimit, topChangedFiles: changedFiles.slice(0, 20), topRiskChanges, riskSummary, filter: filterInfo, impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, indexedCommitSha, baseRef, headRef, changedFileCount: totalChangedFileCount, changedFilesReturned: changedFiles.length, changedFilesDroppedByLimit, changedFiles, impacts: selectedImpacts, riskSummary, filter: filterInfo, impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note }, profile);
  }

  if (profile === "verbose") {
    return ctx.asText({
      repoId: args.repoId, indexedCommitSha, latestRun, baseRef, headRef, includeUntracked: args.includeUntracked,
      changedFileCount: totalChangedFileCount, changedFilesReturned: changedFiles.length, changedFilesDroppedByLimit, changedFiles, impacts: selectedImpacts, riskSummary, filter: filterInfo,
      impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note,
      summary: { filesCapped: changedFilesDroppedByLimit > 0, maxFiles: args.maxFiles, impactLimit: args.impactLimit, resultsLimited: filterInfo.droppedByLimit > 0 }
    }, profile);
  }

  return ctx.asText({ repoId: args.repoId, indexedCommitSha, baseRef, headRef, changedFileCount: totalChangedFileCount, changedFilesReturned: changedFiles.length, changedFilesDroppedByLimit, changedFiles, impacts: selectedImpacts, riskSummary, filter: filterInfo, impactedFileCount: impactedFileSet.size, ...(moduleGroups ? { moduleGroups } : {}), note }, profile);
}

// ── change_impact (ENH-E) ──────────────────────────────────────────────────────
// One intent — "what did my change affect and which tests cover it" — fusing
// detect_changes (changed files + risk) → find_impact_files (dependents) →
// link_tests_to_source (covering tests) into a ranked "tests to run" list plus a
// residual-risk note. Lets the agent run a trusted targeted test subset instead of the
// whole suite after editing.

const CHANGE_IMPACT_SOURCE_PROBE_CAP = 100;

/**
 * Release C: whether the repo configures citation patterns, which entries were rejected and why, and
 * what the index holds — so a misspelt regex is a health finding, not a silent zero.
 */
function citationStatus(store: HandlerContext["store"], repoId: string, repoPath: string): unknown {
  const load = loadCitationConfig(repoPath);
  const counts = store.annotationCounts(repoId);
  return {
    configPresent: load.present,
    patterns: load.config?.citations.map((c) => c.id) ?? [],
    ...(load.errors.length > 0 && { configErrors: load.errors }),
    stored: counts.citationsByPattern,
    codeComments: counts.comments
  };
}

/** Citations listed per changed file in change_impact's `citationsTouched`. */
const CHANGE_IMPACT_CITATIONS_PER_FILE = 20;

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
  const core = asInvalidParamsOnBadRef(() => computeChangedFileImpacts(store, {
    repoId: args.repoId,
    repoPath: repo.repoPath,
    baseRef: args.baseRef,
    headRef: args.headRef,
    includeUntracked: args.includeUntracked,
    maxFiles: args.maxFiles,
    impactLimit: args.impactLimit,
    indexedCommitSha
  }));

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

  // `score` ranks (source risk × link score); `linkScore` is the link's own strength. Release G (R11,
  // wec.aria acceptance): a row reading `score: 0.076` was a 0.76 link on a 10%-risk file, and read as
  // a 0.076 link. Both are reported, and the floor applies to the link.
  const testMap = new Map<string, { testFile: string; coveredSources: Set<string>; score: number; linkScore: number; reasons: Set<string> }>();
  // A changed test file is itself a test to run, never "no linked test".
  for (const changed of core.changedFiles) {
    if (isTestPath(changed)) testMap.set(changed, { testFile: changed, coveredSources: new Set([changed]), score: 1, linkScore: 1, reasons: new Set(["changed itself"]) });
  }
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
        existing.linkScore = Math.max(existing.linkScore, link.score);
        for (const r of link.reasons ?? []) existing.reasons.add(r);
      } else {
        testMap.set(link.testFile, { testFile: link.testFile, coveredSources: new Set([link.sourceFile]), score: weighted, linkScore: link.score, reasons: new Set(link.reasons ?? []) });
      }
    }
  }
  for (const changed of core.changedFiles) if (testMap.get(changed)?.reasons.has("changed itself")) coveredSources.add(changed);

  const round3 = (n: number): number => Math.round(n * 1000) / 1000;
  const testsToRun = [...testMap.values()]
    .map((t) => ({ testFile: t.testFile, coveredSources: [...t.coveredSources], score: round3(t.score), linkScore: round3(t.linkScore), reasons: [...t.reasons] }))
    .sort((a, b) => b.score - a.score || b.coveredSources.length - a.coveredSources.length || a.testFile.localeCompare(b.testFile))
    .slice(0, args.maxTestsToRun);

  const untestedChangedFiles = core.changedFiles.filter((f) => !coveredSources.has(f));
  const dependentCount = dependentFiles.size;
  const covered = [...dependentFiles].filter((f) => coveredSources.has(f)).length;

  // MCP-ISSUE-058(e): a file scoring 0 is not "low risk", it is "no measurable risk". Bucketing 14
  // zero-scoring docs as `low: 14` reads as a finding; `none` reads as what it is.
  const riskSummary = {
    high: core.impacts.filter((x) => x.riskLevel === "high").length,
    medium: core.impacts.filter((x) => x.riskLevel === "medium").length,
    low: core.impacts.filter((x) => x.riskLevel === "low" && x.riskScore > 0).length,
    none: core.impacts.filter((x) => x.riskScore === 0).length,
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

  // MCP-ISSUE-058(e): a Markdown file or a Dockerfile has no linked test because it CANNOT have one.
  // Lumping all 14 files of a docs-only diff into "run the broader suite for these" turned a no-op
  // change into an alarm. Partitioned so the actionable half stands on its own.
  const untestedCode = untestedChangedFiles.filter((f) => !isNonTestableChangePath(f));
  const untestedNonCode = untestedChangedFiles.filter((f) => isNonTestableChangePath(f));
  const residualRisk = {
    untestedChangedFiles: untestedCode,
    ...(untestedNonCode.length > 0 ? { nonCodeChangedFiles: untestedNonCode } : {}),
    note:
      untestedCode.length > 0
        ? `${String(untestedCode.length)} changed CODE file(s) have no linked test — run the broader suite for these.` +
          (untestedNonCode.length > 0 ? ` ${String(untestedNonCode.length)} further changed file(s) are non-code (docs/config) and are not testable.` : "")
        : untestedNonCode.length > 0
          ? `no changed code file lacks a test; the remaining ${String(untestedNonCode.length)} changed file(s) are non-code (docs/config) and are not testable.`
          : "all changed files have at least one linked test."
  };
  const testCoverage = { dependentFiles: dependentCount, covered, uncovered: dependentCount - covered, ...(sourceProbeTruncated ? { probeTruncatedAt: CHANGE_IMPACT_SOURCE_PROBE_CAP } : {}) };

  // Release C (R6): what cites a changed file — an invariant marker naming its test file, a decision
  // row or a code comment pointing at it. "Which invariants does this diff touch" is this list
  // filtered to the invariant patterns.
  const citationsTouched: { changedFile: string; citedBy: { filePath: string; line: number; patternId: string; raw: string }[] }[] = [];
  for (const changed of core.changedFiles) {
    const { rows } = store.citationsTo(args.repoId, { filePath: changed }, CHANGE_IMPACT_CITATIONS_PER_FILE);
    if (rows.length > 0) {
      citationsTouched.push({ changedFile: changed, citedBy: rows.map((r) => ({ filePath: r.filePath, line: r.line, patternId: r.patternId, raw: r.raw })) });
    }
  }
  const citations = citationsTouched.length > 0 ? { citationsTouched } : {};

  if (profile === "nano") {
    return ctx.asText(
      {
        repoId: args.repoId,
        changedFileCount: core.totalChangedFileCount, changedFilesReturned: core.changedFiles.length, changedFilesDroppedByLimit: Math.max(0, core.totalChangedFileCount - core.changedFiles.length),
        topTestsToRun: testsToRun.slice(0, 10).map((t) => ({ testFile: t.testFile, score: t.score, linkScore: t.linkScore })),
        riskSummary,
        residualRisk: residualRisk.note,
        coverage: coverage.confidence,
        ...(citationsTouched.length > 0 && { citationsTouchedCount: citationsTouched.reduce((n, c) => n + c.citedBy.length, 0) }),
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
        changedFileCount: core.totalChangedFileCount, changedFilesReturned: core.changedFiles.length, changedFilesDroppedByLimit: Math.max(0, core.totalChangedFileCount - core.changedFiles.length),
        changedFiles: core.changedFiles,
        riskSummary,
        testsToRun: testsToRun.map((t) => ({ testFile: t.testFile, coveredSources: t.coveredSources, score: t.score, linkScore: t.linkScore, reasons: t.reasons })),
        testCoverage,
        residualRisk,
        coverage,
        ...citations,
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
      changedFileCount: core.totalChangedFileCount, changedFilesReturned: core.changedFiles.length, changedFilesDroppedByLimit: Math.max(0, core.totalChangedFileCount - core.changedFiles.length),
      changedFiles: core.changedFiles,
      impacts: core.impacts,
      riskSummary,
      testsToRun,
      ...citations,
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
