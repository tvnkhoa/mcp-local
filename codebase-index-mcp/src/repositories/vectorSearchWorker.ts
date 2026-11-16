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
  | { kind: "search"; id: number; dbPath: string; repoId: string; text: string; k: number }
  | { kind: "invalidate"; id: number }
  | { kind: "exit"; id: number };

export type VectorSearchMessage =
  | { kind: "result"; id: number; rows: { symbolId: string; distance: number }[]; ms: number }
  | { kind: "error"; id: number; message: string };

let db: Database.Database | null = null;
let openPath = "";

function connection(dbPath: string): Database.Database {
  if (db && openPath === dbPath) return db;
  db?.close();
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("mmap_size = 268435456");
  openPath = dbPath;
  initVectorStore(db, createRequire(import.meta.url));
  return db;
}

parentPort?.on("message", (req: VectorSearchRequest) => {
  if (req.kind === "exit") {
    db?.close();
    db = null;
    process.exit(0);
  }
  if (req.kind === "invalidate") {
    // The KNN memo lives in this thread's copy of vectorStore.ts; a run that landed through another connection
    // (the refresh worker) leaves it stale. The server thread posts this from `onRunLanded` / `onPurged`.
    invalidateVectorSearchCache();
    return;
  }
  const t0 = performance.now();
  try {
    const rows = vectorSearchSymbols(connection(req.dbPath), req.repoId, req.text, req.k);
    const msg: VectorSearchMessage = { kind: "result", id: req.id, rows, ms: Math.round(performance.now() - t0) };
    parentPort?.postMessage(msg);
  } catch (e) {
    const msg: VectorSearchMessage = { kind: "error", id: req.id, message: e instanceof Error ? e.message : String(e) };
    parentPort?.postMessage(msg);
  }
});
