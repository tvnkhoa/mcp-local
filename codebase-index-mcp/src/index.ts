/**
 * codebase-index-mcp entry point.
 *
 * Configuration, construction, and start-up — nothing else. The protocol wiring lives in
 * `server.ts` and the published `tools/list` table in `tools/` (one file per S-32 migration
 * batch).
 *
 * This file owns the env, and that is why the pieces below are injected rather than
 * imported by the modules that need them: `server.ts` must not reach back for the store or
 * the tuning constants.
 */

import process from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runServer } from "@mcp/sdk";

import { GraphStore } from "./repositories/graphStore.js";
import { assertPathAllowed, clamp } from "./middleware/indexGuardrails.js";
import { WatchManager } from "./services/watch/watchManager.js";
import type { IndexRunnerLimits, RunExtras, RunIndexAndResolve } from "./services/indexing/indexRunner.js";
import type { IndexMode, IndexRunResult } from "./types/index.js";
import { DEFAULT_MIN_FREE_RAM_MB, DEFAULT_RUN_TIMEOUT_MS, IndexJobQueue, MAX_WAIT_MS, queuedWithin, runWithSeed } from "./services/indexing/indexJobs.js";
import { RefreshWorkerClient } from "./services/indexing/refreshWorkerClient.js";
import { newerBuildRefusal } from "./services/indexing/runPolicy.js";
import { INDEX_VERSION } from "./services/indexing/indexPipeline.js";
import { armWatchInactivityTimer, startAutoWatchers } from "./services/watch/watchLifecycle.js";
import {
  allowedRootsFromEnv,
  autoWatchReposFromEnv,
  booleanFromEnv,
  numberFromEnv,
  ratioFromEnvName,
  stringFromEnv,
  transportFromEnv,
  refactorApprovalSecret,
  tsLanguageServiceConfigFromEnv,
  watchConfigFromEnv
} from "./config/envConfig.js";
import {
  type ResponseProfile,
  type ToolRequestContext,
  asText as asTextCore
} from "./middleware/responseFormatter.js";
import { resolveServerVersion } from "./config/serverVersion.js";
import { assertNoLlmRuntimePolicy, assertRefactorApprovalPolicy } from "./middleware/errors.js";
import type { HandlerContext } from "./tools/handlers/handlerContext.js";
import { createCodebaseIndexServer } from "./server.js";
import { buildTools } from "./tools/index.js";
import { DEFAULT_MAX_MARKDOWN_BYTES } from "./services/indexing/fileFilter.js";
import { applyFreshness, computeTreeKey, createFreshnessGate, freshnessStateDir, parseTreeKey, recordDirtyLedger, serializeTreeKey, watcherRunPlan, type TreeKey } from "./middleware/freshness.js";
import { checkSeedAncestry, readWorkingTreeStateAsync } from "./services/git/gitHelpers.js";

const dbPath = stringFromEnv("CODEBASE_INDEX_DB_PATH", "./codebase-index.db");
const allowedRoots = allowedRootsFromEnv();
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES_PER_RUN = numberFromEnv("CODEBASE_INDEX_MAX_FILES_PER_RUN", 20_000);
const MAX_RESULT_LIMIT = numberFromEnv("CODEBASE_INDEX_MAX_LIMIT", 500);
const MAX_DEPTH = numberFromEnv("CODEBASE_INDEX_MAX_DEPTH", 5);
/** Files per sub-transaction inside a batch. Lower = shorter lock windows; higher = fewer transactions. Default 20. */
const SUBTX_SIZE = numberFromEnv("CODEBASE_INDEX_SUBTRANSACTION_FILES", 20);
/** Run WAL checkpoint after every N completed batches. Default 1 = every batch. Increase for very large repos. */
const CHECKPOINT_EVERY_N_BATCHES = numberFromEnv("CODEBASE_INDEX_CHECKPOINT_EVERY_N_BATCHES", 1);
// Route ALL non-markdown files to the worker pool (threshold=0).
// The old default of 512KB exceeded the 500KB fileFilter cap, meaning workers were never used.
const LARGE_FILE_THRESHOLD_BYTES = numberFromEnv("CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES", 0);
/** Hard cap on file size. Default 500KB. Raise (e.g. 2_000_000) for repos with large generated files worth indexing. */
const MAX_FILE_SIZE_BYTES = numberFromEnv("CODEBASE_INDEX_MAX_FILE_SIZE_BYTES", 500_000);
/** Markdown has its own cap: the docs lane splits it by section, and a repo's decision log is often its largest file. */
const MAX_MARKDOWN_BYTES = numberFromEnv("CODEBASE_INDEX_MAX_MARKDOWN_BYTES", DEFAULT_MAX_MARKDOWN_BYTES);
const DEFAULT_PARSE_WORKERS = Math.max(1, Math.floor(os.cpus().length / 2));
const PARSE_WORKERS = numberFromEnv("CODEBASE_INDEX_PARSE_WORKERS", DEFAULT_PARSE_WORKERS);
const PARSE_JOB_TIMEOUT_MS = numberFromEnv("CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS", 20_000);
const WATCH_AUTO_START = booleanFromEnv("CODEBASE_INDEX_WATCH_AUTO_START_ENABLED", false);
const WATCH_ACTIVE_ONLY = booleanFromEnv("CODEBASE_INDEX_WATCH_ACTIVE_ONLY", true);
const WATCH_ACTIVE_TTL_MS = clamp(numberFromEnv("CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS", 15 * 60 * 1000), 5_000, 24 * 60 * 60 * 1000);
const AUTO_WATCH_REPOS = autoWatchReposFromEnv();
const watchConfig = watchConfigFromEnv();
const TELEMETRY_ENABLED = booleanFromEnv("CODEBASE_INDEX_TELEMETRY_ENABLED", false);
const TELEMETRY_SAMPLE_RATE = ratioFromEnvName("CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE", 1);
// MCP-ISSUE-061(i): both defaulted false, so a fresh clone had no docs lane and `query_docs` refused.
const DOCS_INDEXING_ENABLED = booleanFromEnv("CODEBASE_INDEX_DOCS_INDEXING_ENABLED", true);
const DOCS_TOOLS_ENABLED = booleanFromEnv("CODEBASE_INDEX_DOCS_TOOLS_ENABLED", true);
const LLM_ENABLED = booleanFromEnv("CODEBASE_INDEX_LLM_ENABLED", false);
const REFACTOR_STRICT_APPROVAL = booleanFromEnv("CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL_ENABLED", false);
const REFACTOR_APPROVAL_SECRET_ENV = stringFromEnv("CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET", "");
const REFACTOR_PREVIEW_TTL_MS = numberFromEnv("CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS", 30 * 60 * 1000);
const REFACTOR_LOW_CONFIDENCE_THRESHOLD = 0.8;
/** R1: read tools refresh a stale index before answering, within this budget (the run is never aborted). */
const QUERY_REFRESH_ENABLED = booleanFromEnv("CODEBASE_INDEX_QUERY_REFRESH_ENABLED", true);
/** Index only what git shows (tracked + untracked-not-ignored). false = the plain directory walk. */
const RESPECT_GITIGNORE = booleanFromEnv("CODEBASE_INDEX_RESPECT_GITIGNORE", true);
/** MCP-ISSUE-112: an index job does not START while free RAM is below this many MB (0 disables the floor). */
const MIN_FREE_RAM_MB = Math.max(0, numberFromEnv("CODEBASE_INDEX_MIN_FREE_RAM_MB", DEFAULT_MIN_FREE_RAM_MB));
/** MCP-ISSUE-112 follow-up: an index job's run still going after this many ms is stopped and fails (0 = no limit). */
const RUN_TIMEOUT_MS = Math.max(0, numberFromEnv("CODEBASE_INDEX_RUN_TIMEOUT_MS", DEFAULT_RUN_TIMEOUT_MS));
const QUERY_REFRESH_BUDGET_MS = clamp(numberFromEnv("CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS", 5_000), 1, 120_000);
/**
 * R3 exact: the TypeScript LanguageService lane of find_field_accesses (lazy; TS/JS fields only).
 * Release I1: answered in a worker thread; one call waits for it at most the R1 query budget.
 */
const SERVER_VERSION = resolveServerVersion(MODULE_DIR);

const toolContextStorage = new AsyncLocalStorage<ToolRequestContext>();
// One budget per call: the worker waits for what the freshness gate left, never a second full budget.
const TS_LS = {
  ...tsLanguageServiceConfigFromEnv(),
  waitMs: QUERY_REFRESH_BUDGET_MS,
  remainingWaitMs: (): number => {
    const started = toolContextStorage.getStore()?.startedAt;
    return Math.max(250, QUERY_REFRESH_BUDGET_MS - (started === undefined ? 0 : Date.now() - started));
  }
};

assertNoLlmRuntimePolicy(LLM_ENABLED);
assertRefactorApprovalPolicy(REFACTOR_STRICT_APPROVAL, REFACTOR_APPROVAL_SECRET_ENV);
// MCP-ISSUE-104: never a constant. HTTP without one refuses to start; stdio gets a per-process random secret.
const REFACTOR_APPROVAL_SECRET = refactorApprovalSecret(REFACTOR_APPROVAL_SECRET_ENV, transportFromEnv().kind).secret;

const store = new GraphStore(dbPath);

/**
 * The index run's tuning limits. The run itself (`indexing/indexRunner.ts`) executes in the refresh worker
 * (MCP-ISSUE-112): this thread never runs one.
 */
const RUNNER_LIMITS: IndexRunnerLimits = {
  subtxSize: SUBTX_SIZE,
  checkpointEveryNBatches: CHECKPOINT_EVERY_N_BATCHES,
  largeFileThresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
  maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  maxMarkdownBytes: MAX_MARKDOWN_BYTES,
  respectGitignore: RESPECT_GITIGNORE,
  parseWorkers: PARSE_WORKERS,
  parseJobTimeoutMs: PARSE_JOB_TIMEOUT_MS
};

/**
 * R1 freshness gate. It owns the per-repo run queue, so every index run in this process —
 * index_repository, the watcher, and the gate's own refreshes — goes through `serialize` and two
 * never write one repo at once. The gate itself is handed an UNSERIALIZED runner (since release I1b,
 * the refresh worker's): it serializes internally, and passing the wrapped one would make a refresh
 * wait on itself.
 */
/**
 * R1 shared state (refresh locks, dirty-run ledgers) lives in a folder beside the index DB, not loose in
 * the DB's directory: the workspace keeps its DB at the repo root, where a bare `dirty-<repo>.json`
 * showed up as an untracked file.
 */
const FRESHNESS_LOCK_DIR = freshnessStateDir(dbPath);
/**
 * Release I1b: the gate's refresh runs execute in a worker thread on their own connection to the same
 * DB, so a 25 s dirty run never holds this thread's event loop (see refreshWorkerClient.ts). The run
 * is the same `createIndexRunner` run, newer-build guard included. MCP-ISSUE-112: index_repository (as a job) and the
 * watcher run there too, so every write of this process is the worker's and this thread only reads.
 */
const refreshWorker = new RefreshWorkerClient({
  dbPath,
  limits: RUNNER_LIMITS,
  onRunLanded: () => store.invalidateProcessCaches(),
  onPurged: () => store.invalidateProcessCaches()
});
// Release J: with the refresh worker writing the index, this thread's small commits must never run a
// WAL checkpoint the worker's PASSIVE checkpoint left behind (a measured 473 ms stall at landing).
store.setAutoCheckpointPages(0);
const freshnessGate = createFreshnessGate({
  enabled: QUERY_REFRESH_ENABLED,
  budgetMs: QUERY_REFRESH_BUDGET_MS,
  lockDir: FRESHNESS_LOCK_DIR,
  getRepoPath: (repoId) => store.getRepository(repoId)?.repoPath ?? null,
  getIndexedCommit: (repoId) => store.getLatestRun(repoId)?.commitSha ?? null,
  readTree: (repoPath) => readWorkingTreeStateAsync(repoPath),
  // MCP-ISSUE-111: the worker (the writer) makes the gate's bookkeeping writes; this thread makes none on a read.
  run: (repoId, repoPath, mode, dirtyPaths, bookkeeping) =>
    refreshWorker.run(repoId, repoPath, mode, DOCS_INDEXING_ENABLED, MAX_FILES_PER_RUN, 200, {
      ...(dirtyPaths && { knownDirtyPaths: dirtyPaths }),
      ...(bookkeeping && { bookkeeping })
    }),
  runBookkeeping: true,
  refuseRefresh: (repoId) => newerBuildRefusal(store.getLatestRun(repoId)?.indexVersion),
  getCoveredKey: (repoId) => store.getLatestRunTreeKey(repoId),
  hashMaxBytes: MAX_FILE_SIZE_BYTES,
  // MCP-ISSUE-101 part 5: an index fully built by another INDEX_VERSION is not current.
  getFullRunVersion: (repoId) => store.getLatestFullRunVersion(repoId),
  buildVersion: INDEX_VERSION
});

/** MCP-ISSUE-101: the tree a run is about to index, keyed before it starts (a file edited mid-run then differs). */
async function treeKeyNow(repoPath: string): Promise<TreeKey | null> {
  try {
    const tree = await readWorkingTreeStateAsync(repoPath);
    return tree.head ? await computeTreeKey(repoPath, tree, MAX_FILE_SIZE_BYTES) : null;
  } catch {
    return null; // not a git repo
  }
}

/**
 * index_repository's and the watcher's run: in the DB-wide queue (MCP-ISSUE-111), executed by the refresh worker
 * (MCP-ISSUE-112), which also records the covered tree key on the run (the writer's connection, never this thread's).
 */
const runInWorker = async (
  repoId: string,
  repoPath: string,
  mode: IndexMode,
  docsEnabled: boolean,
  maxFiles: number,
  batchSize: number,
  extras: RunExtras = {},
  /** Review F3: called right before the run is posted to the worker (after the tree key is read); may throw to skip it. */
  beforeRun?: () => void
): Promise<IndexRunResult> => {
    const key = await treeKeyNow(repoPath);
    beforeRun?.();
    // MCP-ISSUE-101: index_repository and the watcher leave the index covering the whole tree, as a gate run does.
    const result = await refreshWorker.run(repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, {
      ...extras,
      ...(key && { bookkeeping: { ...extras.bookkeeping, coveredKey: serializeTreeKey(key) } })
    });
    // index_repository and the watcher keep the dirty-run ledger current too (see freshness.ts).
    try {
      // MCP-ISSUE-101: a dirty run handed its paths re-read them, so a reverted one leaves the ledger now.
      recordDirtyLedger(FRESHNESS_LOCK_DIR, repoId, mode, await readWorkingTreeStateAsync(repoPath), extras.knownDirtyPaths ?? false);
    } catch {
      // not a git repo
    }
    return result;
  };
const runIndexAndResolve: RunIndexAndResolve = (repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, extras = {}) =>
  freshnessGate.serialize(repoId, () => runInWorker(repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, extras), mode);

/**
 * MCP-ISSUE-112: index_repository's runs as server-side jobs — answered at once, one at a time, never started under
 * the free-RAM floor, and owned by the server, so a client that disconnects cancels nothing.
 */
const indexJobs = new IndexJobQueue({
  minFreeRamMb: MIN_FREE_RAM_MB,
  runTimeoutMs: RUN_TIMEOUT_MS,
  // Only this job's run is stopped (review follow-up C); terminating the worker rejects it, releasing the DB-wide queue.
  onRunTimeout: (job) => void refreshWorker.abortRun(job.runId, `index run ${job.runId} of ${job.repoId} stopped: CODEBASE_INDEX_RUN_TIMEOUT_MS=${String(RUN_TIMEOUT_MS)} ms`),
  // The clock starts when the run leaves the DB-wide queue for the worker, and a job failed meanwhile never runs.
  execute: (job, request, onProgress, control) => {
    // Review F3: the clock starts once nothing but worker work is left; a job failed by then never starts any.
    const begin = (): void => {
      if (control.cancelled()) throw new Error(`index job ${job.runId} had already failed; its run was not started`);
      control.started();
    };
    const run = (mode: IndexMode): Promise<IndexRunResult> =>
      runInWorker(
        request.repoId,
        request.repoPath,
        mode,
        request.docsEnabled,
        request.maxFiles,
        request.batchSize,
        {
          runId: job.runId,
          onProgress: (progress: number, total: number | undefined, message: string) =>
            onProgress({ phase: message.replace(/^[^:]*: /, ""), progress, ...(total !== undefined && { total }) })
        },
        begin
      );
    // IX-9 (MCP-ISSUE-119): register_worktree's job seeds from the parent when its indexed commit is an ancestor of
    // the worktree's HEAD, else runs full and says why (fallbackReason). Seed and clear run in the refresh worker —
    // the single writer — inside this job's turn of the DB-wide queue; this thread only reads.
    return freshnessGate.serialize(
      request.repoId,
      async () =>
        (
          await runWithSeed(request, {
            parentIndexedSha: (parentRepoId) => store.seedBaseSha(parentRepoId),
            childHasIndex: (childRepoId) => store.seedBaseSha(childRepoId) !== null,
            ancestry: (childRepoPath, parentSha) => checkSeedAncestry(childRepoPath, parentSha),
            seed: async (req) => {
              begin();
              const seeded = await refreshWorker.seed(req, job.runId);
              store.invalidateProcessCaches();
              return seeded;
            },
            purgeChild: async (childRepoId) => {
              await refreshWorker.clear(childRepoId);
            },
            run,
            onProgress
          })
        ).result,
      request.mode
    );
  }
});

/**
 * Review F1: remove_repository's delete through the writer, but never a long wait. With an index job running it is
 * refused at once (naming the run); otherwise it waits for its turn in the DB-wide queue at most MAX_WAIT_MS (a gate
 * refresh can be ahead of it), then refuses — retryable — instead of holding the call past the client's ceiling.
 */
async function purgeThroughWriter(repoId: string): Promise<Record<string, number>> {
  const busy = (): McpError => {
    const running = indexJobs.pending().filter((j) => j.state === "running");
    const which = running.map((j) => `${j.runId} (${j.repoId})`).join(", ");
    return new McpError(
      ErrorCode.InvalidRequest,
      `remove_repository: an index run is in progress${which ? `: ${which}` : ""}; retry when it ends (index_status shows it).`
    );
  };
  if (indexJobs.pending().some((j) => j.state === "running")) throw busy();
  return queuedWithin<Record<string, number>>(
    (fn) => freshnessGate.serialize(repoId, fn),
    () => refreshWorker.purge(repoId),
    MAX_WAIT_MS,
    busy
  );
}

async function ensureFresh(repoId: string): Promise<void> {
  const note = await freshnessGate.ensureFresh(repoId);
  const requestContext = toolContextStorage.getStore();
  if (requestContext) requestContext.freshness = note;
}

const watchManager = new WatchManager(
  watchConfig,
  async (repoId, repoPath, config, batch) => {
    assertPathAllowed(repoPath, allowedRoots);
    // MCP-ISSUE-101: a dirty run over the batch's paths plus the dirty files the covered key does not vouch for — not
    // a whole-repo incremental re-hash — unless HEAD moved or the batch dropped events (see watcherRunPlan).
    const plan = watcherRunPlan(batch, await treeKeyNow(repoPath), parseTreeKey(store.getLatestRunTreeKey(repoId)), store.getLatestRun(repoId)?.commitSha ?? null);
    if (plan.mode === "incremental") {
      // Follow-up 3: an overflowed batch's deletions are pruned by a dirty run over them — in the worker, in the DB-wide
      // queue — not by a write on this thread.
      if (batch.overflowed && batch.deleted.length > 0) {
        await runIndexAndResolve(repoId, repoPath, "dirty", DOCS_INDEXING_ENABLED, config.maxFilesPerRun, config.batchSize, { knownDirtyPaths: batch.deleted });
      }
      await runIndexAndResolve(repoId, repoPath, "incremental", DOCS_INDEXING_ENABLED, config.maxFilesPerRun, config.batchSize);
      return;
    }
    await runIndexAndResolve(repoId, repoPath, "dirty", DOCS_INDEXING_ENABLED, config.maxFilesPerRun, config.batchSize, { knownDirtyPaths: plan.paths });
  },
  // Follow-up 3: no prune on this thread (it waited on the worker's write lock); the runner above prunes in the worker.
  () => 0,
  ({ repoId }) => {
    if (WATCH_ACTIVE_ONLY && activeWatchRef.current === repoId) {
      armWatchInactivityTimer(repoId, buildHandlerContext());
    }
  }
);

const activeWatchRef = { current: null as string | null };
const watchInactivityTimers = new Map<string, NodeJS.Timeout>();

/**
 * Serialize a successful payload, and emit the telemetry line while doing it.
 *
 * Handed to the handlers as `ctx.asText` and to `server.ts` as its `renderResult`, so the
 * emit happens exactly once per response whichever side produced it.
 */
function asText(payload: unknown, profile: ResponseProfile = "standard"): CallToolResult {
  const requestContext = toolContextStorage.getStore();
  return asTextCore(applyFreshness(payload, requestContext?.freshness), profile, requestContext, TELEMETRY_ENABLED, TELEMETRY_SAMPLE_RATE);
}

function buildHandlerContext(): HandlerContext {
  const clientSessionId = toolContextStorage.getStore()?.clientSessionId;
  const clientIdentity = toolContextStorage.getStore()?.clientIdentity;
  const progressNotifier = toolContextStorage.getStore()?.progressNotifier;
  return {
    ...(progressNotifier === undefined ? {} : { progressNotifier }),
    ...(clientSessionId === undefined ? {} : { clientSessionId }),
    ...(clientIdentity === undefined ? {} : { clientIdentity }),
    store,
    watchManager,
    activeWatchRef,
    watchInactivityTimers,
    runIndexAndResolve,
    indexJobs,
    // Review 3-rest: remove_repository deletes through the writer, in the DB-wide queue.
    purgeRepository: purgeThroughWriter,
    asText,
    constants: {
      MAX_FILES_PER_RUN,
      MAX_RESULT_LIMIT,
      MAX_DEPTH,
      WATCH_AUTO_START,
      WATCH_ACTIVE_ONLY,
      WATCH_ACTIVE_TTL_MS,
      DOCS_INDEXING_ENABLED,
      DOCS_TOOLS_ENABLED,
      QUERY_REFRESH_ENABLED,
      TS_LS,
      LLM_ENABLED,
      REFACTOR_STRICT_APPROVAL,
      REFACTOR_APPROVAL_SECRET,
      REFACTOR_PREVIEW_TTL_MS,
      REFACTOR_LOW_CONFIDENCE_THRESHOLD,
      SERVER_VERSION,
      dbPath,
      allowedRoots
    }
  };
}

/** Advertised bounds. Env-derived, so two differently-configured deployments publish different schemas. */
const limits = { maxResultLimit: MAX_RESULT_LIMIT, maxDepth: MAX_DEPTH, maxFilesPerRun: MAX_FILES_PER_RUN };

const handle = createCodebaseIndexServer({
  // Not SERVER_VERSION: the version on the wire has been "0.1.0" since before the package
  // reached 0.3.0, and health_check reports the package one. Changing either is visible to
  // clients, so they stay as they are.
  version: "0.1.0",
  limits,
  store,
  tools: buildTools({ limits, buildContext: buildHandlerContext, ensureFresh }),
  buildHandlerContext,
  toolContextStorage,
  renderResult: asText,
  telemetry: { enabled: TELEMETRY_ENABLED, sampleRate: TELEMETRY_SAMPLE_RATE },
  // R4: one process, many clients — the store, watchers and refresh worker below are shared by all.
  // MCP-ISSUE-103: over HTTP, sessions survive a restart for the bearer that opened them (the store sits beside the DB).
  transport: ((t) => (t.kind === "http" ? { ...t, sessionStoreFile: path.join(FRESHNESS_LOCK_DIR, "http-sessions.json") } : t))(transportFromEnv())
});

// Registered before start(), and store-before-watchers on purpose: hooks run in reverse, so
// the order at shutdown is transport, then watchers, then the database. A watcher that fires
// after the store is closed would throw on a closed handle.
handle.lifecycle.onShutdown({
  name: "store",
  run: () => {
    store.close();
  }
});
handle.lifecycle.onShutdown({
  name: "index-jobs",
  run: () => {
    indexJobs.dispose();
  }
});
handle.lifecycle.onShutdown({
  name: "refresh-worker",
  run: async () => {
    await refreshWorker.dispose();
  }
});
handle.lifecycle.onShutdown({
  name: "watchers",
  run: async () => {
    for (const timer of watchInactivityTimers.values()) {
      clearTimeout(timer);
    }
    watchInactivityTimers.clear();
    await watchManager.stopAll();
  }
});

runServer(handle, {
  onStarted: () => {
    // Release I1b: the refresh worker opens its connection now, not inside the first query's budget.
    if (QUERY_REFRESH_ENABLED) refreshWorker.warm();
    return startAutoWatchers(buildHandlerContext(), AUTO_WATCH_REPOS);
  },
  // The store and the watchers are acquired above, before start() — so unlike the other
  // three servers this one must run its shutdown hooks on a failed start-up.
  stopOnCrash: true,
  // The raw stack, not an event line: this is the only diagnostic a start-up failure
  // leaves behind, and it goes to stderr because stdout is the transport.
  onCrash: (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
});
