/**
 * MCP-ISSUE-135 — `query_graph`'s statement, run in a CHILD PROCESS that the server can kill.
 *
 * better-sqlite3 runs a statement synchronously and exposes neither `sqlite3_interrupt` nor a progress handler, so a
 * JS timer can never stop it: on 16 Nov a correlated-subquery SELECT on wec.be held the served process's main thread
 * at 100% of a core for 300 s+ and every session timed out. A worker thread does not help either — measured on
 * better-sqlite3 11.10, `Worker.terminate()` only takes effect when the thread returns to JS, so it never resolved while
 * the statement ran (the thread kept its core). Killing a process does stop SQLite at once, so the statement runs
 * here; `queryGraphRunnerClient.ts` kills this process when `timeoutMs` passes.
 *
 * The connection is read-only (WAL: a reader never waits on the writer). Every guard the server thread applied is
 * applied again by `runReadOnlyGraphQueryImpl` itself (scope CTEs, schema-qualifier refusal, EXPLAIN root-page check).
 */

import Database from "better-sqlite3";

import { QueryGraphScopeError } from "../middleware/sqliteGuardrails.js";
import { runReadOnlyGraphQueryImpl } from "../services/impact/impactRepoSummaries.js";

export type QueryGraphResult = ReturnType<typeof runReadOnlyGraphQueryImpl>;

export type QueryGraphRequest = {
  kind: "run";
  id: number;
  dbPath: string;
  sql: string;
  params: Record<string, string | number | boolean | null>;
  limit: number;
};

export type QueryGraphMessage =
  | { kind: "ready" }
  | { kind: "result"; id: number; result: QueryGraphResult }
  | { kind: "error"; id: number; scope: boolean; message: string };

/** The child's request handling, with the connection injectable for tests. */
export function createQueryGraphHandler(open: (dbPath: string) => Database.Database): {
  answer: (req: QueryGraphRequest) => QueryGraphMessage;
  close: () => void;
} {
  let db: Database.Database | null = null;
  let openPath = "";
  return {
    answer: (req) => {
      try {
        if (!db || openPath !== req.dbPath) {
          db?.close();
          db = open(req.dbPath);
          openPath = req.dbPath;
        }
        // timeoutMs is not passed: the client's kill is the timeout; this side only measures.
        return { kind: "result", id: req.id, result: runReadOnlyGraphQueryImpl(db, req.sql, req.params, req.limit) };
      } catch (e) {
        return { kind: "error", id: req.id, scope: e instanceof QueryGraphScopeError, message: e instanceof Error ? e.message : String(e) };
      }
    },
    close: () => {
      db?.close();
      db = null;
    }
  };
}

if (typeof process.send === "function") {
  const handler = createQueryGraphHandler((dbPath) => {
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    conn.pragma("busy_timeout = 5000");
    conn.pragma("mmap_size = 268435456");
    return conn;
  });
  process.on("message", (req: QueryGraphRequest) => {
    process.send?.(handler.answer(req));
  });
  // The server went away (its IPC channel closed): never outlive it.
  process.on("disconnect", () => {
    handler.close();
    process.exit(0);
  });
  process.send({ kind: "ready" } satisfies QueryGraphMessage);
}
