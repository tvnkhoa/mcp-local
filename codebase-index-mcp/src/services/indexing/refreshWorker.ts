/**
 * R1, release I1b — the worker thread that executes the freshness gate's refresh runs.
 *
 * A query-triggered refresh is an ordinary index run (`createIndexRunner`), but on wec.aria a 4-file
 * dirty run took 27.7 s and held the server's event loop for up to 8 s at a stretch (the post-phase
 * resolvers and the FTS rebuild are synchronous SQLite work). Here it runs on its OWN `GraphStore` —
 * a second SQLite connection to the same WAL database — so the server thread keeps answering from
 * its read connection while the run writes. WAL readers never wait on the writer; the connection's
 * `busy_timeout` covers the brief checkpoint windows.
 *
 * The run goes through `createIndexRunner` unchanged, so the release F newer-build guard
 * (`newerBuildRefusal`, checked against THIS connection's latest run at run start) applies here before
 * anything is written: a worker never writes over an index a newer build wrote.
 *
 * `refreshWorkerClient.ts` spawns this file with `new URL("./refreshWorker.js", import.meta.url)`, so
 * the two must stay in the same folder (as `fieldWorker.ts` / `fieldWorkerClient.ts` do).
 *
 * Protocol: a `run` request gets exactly one `result` or `error`; `purge`/`clear` one `purged` or `error`; `seed` one
 * `seeded` or `error` (with the SeedError `code`); a `warm` request gets nothing.
 */

import { parentPort } from "node:worker_threads";

import { performanceProfileOverrideFromEnv } from "../../config/envConfig.js";
import { GraphStore } from "../../repositories/graphStore.js";
import { SeedError, type SeedResult } from "../../repositories/seedStore.js";
import { ExtractionWorkerPool } from "../extractors/extractionWorkerPool.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";
import type { RunBookkeeping } from "../../middleware/freshness.js";
import { createIndexRunner, type IndexRunnerLimits, type RunIndexAndResolve } from "./indexRunner.js";
import { parentRunRefusal } from "./indexJobs.js";

/**
 * Release J: a refresh of at most this many files parses on this thread; a larger one (its dependents
 * included) goes to the warm parse workers below.
 */
const REFRESH_INLINE_PARSE_MAX_FILES = 8;
/**
 * Release J: parse workers kept warm across refreshes, so a refresh never waits ~3 s for their start-up.
 * Fewer than a full run's `cpus/2` — every Claude session runs a server, and each keeps these resident —
 * and released after a quiet spell; the next refresh starts them again.
 */
const REFRESH_PARSE_WORKERS = 3;
const REFRESH_PARSE_POOL_IDLE_MS = 10 * 60_000;

export type RefreshWorkerRequest = {
  /** `warm`: open the connection and load the runner now, answer nothing (posted at server start). */
  /** `purge` (review 3-rest): `remove_repository`'s delete, on this worker's connection — the writer's. */
  /** `seed` / `clear` (IX-9, MCP-ISSUE-119): a worktree's seed from `seedFrom`, and the per-repo index clear before
   *  a seed's fallback full run — both on this connection, the single writer's. */
  kind: "run" | "warm" | "purge" | "seed" | "clear";
  id: number;
  dbPath: string;
  limits: IndexRunnerLimits;
  repoId: string;
  repoPath: string;
  mode: IndexMode;
  docsEnabled: boolean;
  maxFiles: number;
  batchSize: number;
  /** Release K3 (P1): the freshness gate's dirty set for a dirty run (see `RunExtras.knownDirtyPaths`). */
  dirtyPaths?: string[];
  /** MCP-ISSUE-111: the gate's bookkeeping, written on this worker's connection (see `RunExtras.bookkeeping`). */
  bookkeeping?: RunBookkeeping;
  /** MCP-ISSUE-112: the run id an index job handed out. */
  runId?: string;
  /** MCP-ISSUE-112: post `progress` messages for this run (an index job reports its phase). */
  reportProgress?: boolean;
  /** IX-9: the parent repoId of a `seed` request. */
  seedFrom?: string;
  /** IX-9 review (b): the run-state dir; the seed re-checks the parent's run markers inside its write transaction. */
  lockDir?: string;
};

export type RefreshWorkerMessage =
  | { type: "result"; id: number; result: IndexRunResult }
  | { type: "progress"; id: number; progress: number; total: number | undefined; message: string }
  | { type: "purged"; id: number; counts: Record<string, number> }
  | { type: "seeded"; id: number; seed: SeedResult }
  | { type: "error"; id: number; error: string; code?: string };

/** `endIndexSession`, best-effort: a checkpoint that cannot run now runs on a later one. */
function endSession(store: GraphStore, truncate: boolean): void {
  try {
    store.endIndexSession(truncate);
  } catch {
    // Non-fatal: the WAL is checkpointed by the next run's session end.
  }
}

if (parentPort) {
  const port = parentPort;
  /** One connection and one runner for the worker's life; the DB path and limits never change in a process. */
  let runner: { dbPath: string; run: RunIndexAndResolve; store: GraphStore } | null = null;
  let parsePool: ExtractionWorkerPool | null = null;
  let parsePoolIdle: NodeJS.Timeout | undefined;
  const warmParsePool = (limits: IndexRunnerLimits): ExtractionWorkerPool => {
    if (parsePoolIdle) clearTimeout(parsePoolIdle);
    parsePool ??= new ExtractionWorkerPool(Math.max(1, Math.min(REFRESH_PARSE_WORKERS, limits.parseWorkers)), limits.parseJobTimeoutMs);
    return parsePool;
  };
  const releaseParsePoolWhenIdle = (): void => {
    if (parsePoolIdle) clearTimeout(parsePoolIdle);
    parsePoolIdle = setTimeout(() => {
      const pool = parsePool;
      parsePool = null;
      void pool?.dispose();
    }, REFRESH_PARSE_POOL_IDLE_MS);
    parsePoolIdle.unref();
  };
  const runnerFor = (request: RefreshWorkerRequest): { run: RunIndexAndResolve; store: GraphStore } => {
    if (runner && runner.dbPath === request.dbPath) return runner;
    const store = new GraphStore(request.dbPath);
    runner = {
      dbPath: request.dbPath,
      store,
      // Release J: off the server thread, a small refresh parses inline; the grammars stay loaded in
      // this long-lived worker, so only its first refresh pays for them.
      run: createIndexRunner({
        store,
        limits: { ...request.limits, inlineParseMaxFiles: REFRESH_INLINE_PARSE_MAX_FILES },
        resolvePerformanceProfileOverride: () => performanceProfileOverrideFromEnv(),
        // Release K3 (P2): the checkpoint runs after the result is posted — see below.
        deferSessionEnd: true,
        ...(request.limits.parseWorkers > 0 && { sharedParsePool: () => warmParsePool(request.limits) })
      })
    };
    return runner;
  };
  port.on("message", (request: RefreshWorkerRequest) => {
    if (request.kind === "warm") {
      try {
        runnerFor(request);
        if (request.limits.parseWorkers > 0) {
          warmParsePool(request.limits);
          releaseParsePoolWhenIdle();
        }
      } catch {
        // The first run reports whatever failed here.
      }
      return;
    }
    if (request.kind === "seed") {
      try {
        if (!request.seedFrom) throw new SeedError("COPY_FAILED", "seed request without seedFrom");
        const lockDir = request.lockDir;
        const parentRepoId = request.seedFrom;
        const seed = runnerFor(request).store.seedFromParent(
          { parentRepoId, childRepoId: request.repoId, childRepoPath: request.repoPath },
          lockDir ? () => parentRunRefusal(lockDir, parentRepoId) : undefined
        );
        port.postMessage({ type: "seeded", id: request.id, seed } satisfies RefreshWorkerMessage);
      } catch (error) {
        port.postMessage({
          type: "error",
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof SeedError && { code: error.code })
        } satisfies RefreshWorkerMessage);
      }
      return;
    }
    if (request.kind === "purge" || request.kind === "clear") {
      try {
        const store = runnerFor(request).store;
        const counts = request.kind === "clear" ? store.clearRepositoryIndex(request.repoId) : store.purgeRepository(request.repoId);
        port.postMessage({ type: "purged", id: request.id, counts } satisfies RefreshWorkerMessage);
      } catch (error) {
        port.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies RefreshWorkerMessage);
      }
      return;
    }
    void (async () => {
      let active: { run: RunIndexAndResolve; store: GraphStore } | null = null;
      try {
        active = runnerFor(request);
        const result = await active.run(request.repoId, request.repoPath, request.mode, request.docsEnabled, request.maxFiles, request.batchSize, {
          ...(request.dirtyPaths && { knownDirtyPaths: request.dirtyPaths }),
          ...(request.bookkeeping && { bookkeeping: request.bookkeeping }),
          ...(request.runId && { runId: request.runId }),
          ...(request.reportProgress && {
            onProgress: (progress: number, total: number | undefined, message: string) =>
              port.postMessage({ type: "progress", id: request.id, progress, total, message } satisfies RefreshWorkerMessage)
          })
        });
        port.postMessage({ type: "result", id: request.id, result } satisfies RefreshWorkerMessage);
        // Release K3 (P2): the run is committed and the answer is on its way; NOW the end-of-session
        // checkpoint, ~280 ms that used to sit in front of every refreshed answer. It is synchronous, so
        // no other message this worker receives starts a run before it returns; the server thread's
        // connection never checkpoints (release J), so it is the only checkpointer of this run's WAL.
        endSession(active.store, result.mode === "full");
      } catch (error) {
        port.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies RefreshWorkerMessage);
        // A failed run still began a session: restore the connection's checkpoint threshold.
        if (active) endSession(active.store, false);
      } finally {
        if (parsePool) releaseParsePoolWhenIdle();
      }
    })();
  });
}
