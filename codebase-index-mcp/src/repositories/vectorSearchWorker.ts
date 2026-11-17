/**
 * MCP-ISSUE-132 — the vector near-neighbour search of `search_symbols`, off the server thread.
 *
 * A name query with fewer than three FTS hits is padded with sqlite-vec KNN neighbours (`nearby`). The KNN is a
 * brute-force scan of the repo's 512-dim partition — up to four of them per lookup (`knnDeterministic` widens on
 * ties) — and ran synchronously on the server thread: 0.3-0.7 s per scan locally, 2.9 s on the CI runner, while a
 * full run rewrote the repo (FTS then finds nothing, so every name lookup pads). Every other session of the HTTP
 * server waited behind it. The scan runs here instead, on its own read-only connection; the server thread waits
 * for the answer with a budget and never blocks on it (`vectorSearchWorkerClient.ts`).
 *
 * The connection is read-only and only ever reads (WAL: a reader never waits on the writer's lock).
 */

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

import { initVectorStore, invalidateVectorSearchCache, vectorSearchSymbols } from "./vectorStore.js";

export type VectorSearchRequest =
  /** `deadline` (epoch ms): the caller stops waiting then; a request still queued at that time is not scanned. */
  | { kind: "search"; id: number; dbPath: string; repoId: string; text: string; k: number; deadline?: number }
  | { kind: "invalidate"; id: number }
  | { kind: "exit"; id: number };

export type VectorSearchMessage =
  | { kind: "result"; id: number; rows: { symbolId: string; distance: number }[]; ms: number }
  | { kind: "error"; id: number; message: string }
  /** MCP-ISSUE-135: the request waited in this worker's queue past its deadline and was dropped unscanned. */
  | { kind: "expired"; id: number };

/**
 * The worker's request handling, with its two side effects injectable for tests. A connection whose sqlite-vec failed
 * to load is an ERROR for every search (review, 16 Nov): vectorStore.ts would fall back to its in-memory map, which is
 * empty in this thread, and answer `rows: []` as a success — the padding would vanish without a word.
 *
 * MCP-ISSUE-135: a request whose caller already gave up (its `deadline` passed while it queued behind another scan)
 * is answered `expired` without scanning. A scan in progress cannot be interrupted (better-sqlite3 has no interrupt and
 * the KNN is one synchronous statement per widening round); the client bounds that one by retiring the lane.
 */
export function createSearchHandler(deps: {
  open: (dbPath: string) => Database.Database;
  loadVec: (db: Database.Database) => boolean;
  now?: () => number;
}): { answer: (req: Extract<VectorSearchRequest, { kind: "search" }>) => VectorSearchMessage; close: () => void } {
  let db: Database.Database | null = null;
  let openPath = "";
  let vecLoaded = false;
  const connection = (dbPath: string): Database.Database => {
    if (db && openPath === dbPath) return db;
    db?.close();
    db = deps.open(dbPath);
    openPath = dbPath;
    vecLoaded = deps.loadVec(db);
    return db;
  };
  return {
    answer: (req) => {
      if (req.deadline !== undefined && (deps.now ?? Date.now)() >= req.deadline) return { kind: "expired", id: req.id };
      const t0 = performance.now();
      try {
        const conn = connection(req.dbPath);
        if (!vecLoaded) return { kind: "error", id: req.id, message: "sqlite-vec did not load in the vector-search worker" };
        const rows = vectorSearchSymbols(conn, req.repoId, req.text, req.k);
        return { kind: "result", id: req.id, rows, ms: Math.round(performance.now() - t0) };
      } catch (e) {
        return { kind: "error", id: req.id, message: e instanceof Error ? e.message : String(e) };
      }
    },
    close: () => {
      db?.close();
      db = null;
    }
  };
}

const handler = createSearchHandler({
  open: (dbPath) => {
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    conn.pragma("busy_timeout = 5000");
    conn.pragma("mmap_size = 268435456");
    return conn;
  },
  loadVec: (conn) => initVectorStore(conn, createRequire(import.meta.url))
});

parentPort?.on("message", (req: VectorSearchRequest) => {
  if (req.kind === "exit") {
    handler.close();
    process.exit(0);
  }
  if (req.kind === "invalidate") {
    // The KNN memo lives in this thread's copy of vectorStore.ts; a run that landed through another connection
    // (the refresh worker) leaves it stale. The server thread posts this from `onRunLanded` / `onPurged`.
    invalidateVectorSearchCache();
    return;
  }
  parentPort?.postMessage(handler.answer(req));
});
