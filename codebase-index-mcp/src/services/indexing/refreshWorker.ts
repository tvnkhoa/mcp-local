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
 * Protocol: a `run` request gets exactly one `result` or `error`; a `warm` request gets nothing.
 */

import { parentPort } from "node:worker_threads";

import { performanceProfileOverrideFromEnv } from "../../config/envConfig.js";
import { GraphStore } from "../../repositories/graphStore.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";
import { createIndexRunner, type IndexRunnerLimits, type RunIndexAndResolve } from "./indexRunner.js";

/** Release J: below this many files a refresh parses on this thread; above, the parse workers pay off. */
const REFRESH_INLINE_PARSE_MAX_FILES = 150;

export type RefreshWorkerRequest = {
  /** `warm`: open the connection and load the runner now, answer nothing (posted at server start). */
  kind: "run" | "warm";
  id: number;
  dbPath: string;
  limits: IndexRunnerLimits;
  repoId: string;
  repoPath: string;
  mode: IndexMode;
  docsEnabled: boolean;
  maxFiles: number;
  batchSize: number;
};

export type RefreshWorkerMessage =
  | { type: "result"; id: number; result: IndexRunResult }
  | { type: "error"; id: number; error: string };

if (parentPort) {
  const port = parentPort;
  /** One connection and one runner for the worker's life; the DB path and limits never change in a process. */
  let runner: { dbPath: string; run: RunIndexAndResolve } | null = null;
  const runnerFor = (request: RefreshWorkerRequest): RunIndexAndResolve => {
    if (runner && runner.dbPath === request.dbPath) return runner.run;
    const store = new GraphStore(request.dbPath);
    runner = {
      dbPath: request.dbPath,
      // Release J: off the server thread, a small refresh parses inline; the grammars stay loaded in
      // this long-lived worker, so only its first refresh pays for them.
      run: createIndexRunner({
        store,
        limits: { ...request.limits, inlineParseMaxFiles: REFRESH_INLINE_PARSE_MAX_FILES },
        resolvePerformanceProfileOverride: () => performanceProfileOverrideFromEnv()
      })
    };
    return runner.run;
  };
  port.on("message", (request: RefreshWorkerRequest) => {
    if (request.kind === "warm") {
      try {
        runnerFor(request);
      } catch {
        // The first run reports whatever failed here.
      }
      return;
    }
    void (async () => {
      try {
        const run = runnerFor(request);
        const result = await run(request.repoId, request.repoPath, request.mode, request.docsEnabled, request.maxFiles, request.batchSize);
        port.postMessage({ type: "result", id: request.id, result } satisfies RefreshWorkerMessage);
      } catch (error) {
        port.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies RefreshWorkerMessage);
      }
    })();
  });
}
