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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { GraphStore } from "./graphStore.js";
import { assertPathAllowed, clamp } from "./guardrails/indexGuardrails.js";
import { WatchManager } from "./watchManager.js";
import { createIndexRunner } from "./indexing/indexRunner.js";
import { armWatchInactivityTimer, startAutoWatchers } from "./watch/watchLifecycle.js";
import {
  allowedRootsFromEnv,
  autoWatchReposFromEnv,
  booleanFromEnv,
  numberFromEnv,
  performanceProfileOverrideFromEnv,
  ratioFromEnvName,
  stringFromEnv,
  watchConfigFromEnv
} from "./config/envConfig.js";
import {
  type ResponseProfile,
  type ToolRequestContext,
  asText as asTextCore
} from "./response/responseFormatter.js";
import { resolveServerVersion } from "./serverUtils.js";
import { assertNoLlmRuntimePolicy, assertRefactorApprovalPolicy } from "./errorHandler.js";
import type { HandlerContext } from "./handlers/handlerContext.js";
import { createCodebaseIndexServer } from "./server.js";
import { buildTools } from "./tools/index.js";

const dbPath = stringFromEnv("CODEBASE_INDEX_DB_PATH", "./codebase-index.db");
const allowedRoots = allowedRootsFromEnv();
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES_PER_RUN = numberFromEnv("CODEBASE_INDEX_MAX_FILES_PER_RUN", 20_000);
const MAX_RESULT_LIMIT = numberFromEnv("CODEBASE_INDEX_MAX_RESULT_LIMIT", 500);
const MAX_DEPTH = numberFromEnv("CODEBASE_INDEX_MAX_DEPTH", 5);
/** Files per sub-transaction inside a batch. Lower = shorter lock windows; higher = fewer transactions. Default 20. */
const SUBTX_SIZE = numberFromEnv("CODEBASE_INDEX_SUBTX_SIZE", 20);
/** Run WAL checkpoint after every N completed batches. Default 1 = every batch. Increase for very large repos. */
const CHECKPOINT_EVERY_N_BATCHES = numberFromEnv("CODEBASE_INDEX_CHECKPOINT_EVERY_N_BATCHES", 1);
// Route ALL non-markdown files to the worker pool (threshold=0).
// The old default of 512KB exceeded the 500KB fileFilter cap, meaning workers were never used.
const LARGE_FILE_THRESHOLD_BYTES = numberFromEnv("CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES", 0);
/** Hard cap on file size. Default 500KB. Raise (e.g. 2_000_000) for repos with large generated files worth indexing. */
const MAX_FILE_SIZE_BYTES = numberFromEnv("CODEBASE_INDEX_MAX_FILE_SIZE_BYTES", 500_000);
const DEFAULT_PARSE_WORKERS = Math.max(1, Math.floor(os.cpus().length / 2));
const PARSE_WORKERS = numberFromEnv("CODEBASE_INDEX_PARSE_WORKERS", DEFAULT_PARSE_WORKERS);
const PARSE_JOB_TIMEOUT_MS = numberFromEnv("CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS", 20_000);
const WATCH_AUTO_START = booleanFromEnv("CODEBASE_INDEX_WATCH_AUTO_START", false);
const WATCH_ACTIVE_ONLY = booleanFromEnv("CODEBASE_INDEX_WATCH_ACTIVE_ONLY", true);
const WATCH_ACTIVE_TTL_MS = clamp(numberFromEnv("CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS", 15 * 60 * 1000), 5_000, 24 * 60 * 60 * 1000);
const AUTO_WATCH_REPOS = autoWatchReposFromEnv();
const watchConfig = watchConfigFromEnv();
const TELEMETRY_ENABLED = booleanFromEnv("CODEBASE_INDEX_TELEMETRY_ENABLED", false);
const TELEMETRY_SAMPLE_RATE = ratioFromEnvName("CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE", 1);
const DOCS_INDEXING_ENABLED = booleanFromEnv("CODEBASE_INDEX_DOCS_INDEXING_ENABLED", false);
const DOCS_TOOLS_ENABLED = booleanFromEnv("CODEBASE_INDEX_DOCS_TOOLS_ENABLED", false);
const LLM_ENABLED = booleanFromEnv("CODEBASE_INDEX_LLM_ENABLED", false);
const REFACTOR_STRICT_APPROVAL = booleanFromEnv("CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL", false);
const REFACTOR_APPROVAL_SECRET = stringFromEnv("CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET", "");
const REFACTOR_PREVIEW_TTL_MS = numberFromEnv("CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS", 30 * 60 * 1000);
const REFACTOR_LOW_CONFIDENCE_THRESHOLD = 0.8;
const SERVER_VERSION = resolveServerVersion(MODULE_DIR);

const toolContextStorage = new AsyncLocalStorage<ToolRequestContext>();

assertNoLlmRuntimePolicy(LLM_ENABLED);
assertRefactorApprovalPolicy(REFACTOR_STRICT_APPROVAL, REFACTOR_APPROVAL_SECRET);

const store = new GraphStore(dbPath);

/**
 * The index run orchestrator (S-26: extracted to `indexing/indexRunner.ts`).
 *
 * Built once here because it needs `store` and the env-derived tuning limits, both
 * of which only the entry point owns. The two callbacks stay lazy on purpose: the
 * progress sink is per-request, and the profile override was read from the env on
 * every run before the extraction. Resolving either eagerly would change behaviour.
 */
const runIndexAndResolve = createIndexRunner({
  store,
  limits: {
    subtxSize: SUBTX_SIZE,
    checkpointEveryNBatches: CHECKPOINT_EVERY_N_BATCHES,
    largeFileThresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    parseWorkers: PARSE_WORKERS,
    parseJobTimeoutMs: PARSE_JOB_TIMEOUT_MS
  },
  resolveProgressNotifier: () => toolContextStorage.getStore()?.progressNotifier,
  resolvePerformanceProfileOverride: () => performanceProfileOverrideFromEnv()
});

const watchManager = new WatchManager(
  watchConfig,
  async (repoId, repoPath, config) => {
    assertPathAllowed(repoPath, allowedRoots);
    await runIndexAndResolve(repoId, repoPath, "incremental", DOCS_INDEXING_ENABLED, config.maxFilesPerRun, config.batchSize);
  },
  (repoId, deletedRelativePaths) => store.pruneFiles(repoId, deletedRelativePaths),
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
  return asTextCore(payload, profile, toolContextStorage.getStore(), TELEMETRY_ENABLED, TELEMETRY_SAMPLE_RATE);
}

function buildHandlerContext(): HandlerContext {
  return {
    store,
    watchManager,
    activeWatchRef,
    watchInactivityTimers,
    runIndexAndResolve,
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
  tools: buildTools({ limits, buildContext: buildHandlerContext }),
  buildHandlerContext,
  toolContextStorage,
  renderResult: asText,
  telemetry: { enabled: TELEMETRY_ENABLED, sampleRate: TELEMETRY_SAMPLE_RATE }
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
  name: "watchers",
  run: async () => {
    for (const timer of watchInactivityTimers.values()) {
      clearTimeout(timer);
    }
    watchInactivityTimers.clear();
    await watchManager.stopAll();
  }
});

async function main(): Promise<void> {
  await handle.start();
  await startAutoWatchers(buildHandlerContext(), AUTO_WATCH_REPOS);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  void handle.stop("startup_failed").finally(() => process.exit(1));
});
