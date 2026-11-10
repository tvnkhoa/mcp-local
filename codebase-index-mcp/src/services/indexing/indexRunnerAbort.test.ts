import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner, type RunExtras } from "./indexRunner.js";
import type { IndexMode, IndexRunSummary } from "../../types/index.js";

/**
 * MCP-ISSUE-123 (review #1): the refresh worker's `exit` retires the parse pool, so every parse after it answers
 * job-timeout. A run that went on from there committed batches of parse timeouts and could be recorded `ok` at HEAD —
 * after which the fast skip and the freshness gate trusted an index that is mostly missing. An aborted run must be
 * recorded `cancelled` with no commit, and the next run must not skip.
 */

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();

function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(path.join(tmpdir(), "cim-abort-"));
  for (let i = 0; i < 40; i++) {
    const rel = `src/m${String(i)}.ts`;
    const prev = i > 0 ? `import { f${String(i - 1)} } from './m${String(i - 1)}';\n` : "";
    const call = i > 0 ? `  return f${String(i - 1)}() + ${String(i)};\n` : "  return 0;\n";
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), `${prev}export function f${String(i)}(): number {\n${call}}\n`);
  }
  git(root, "init", "-q");
  git(root, "add", "--", "src");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

function runner(store: GraphStore) {
  return createIndexRunner({
    store,
    // batchSize 5 below: several batch boundaries, so a mid-run abort stops before the last one.
    limits: { subtxSize: 5, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
    resolvePerformanceProfileOverride: () => "standard"
  });
}

async function withRepo(fn: (store: GraphStore, repo: string, head: string) => Promise<void>): Promise<void> {
  const { root, head } = makeRepo();
  const work = mkdtempSync(path.join(tmpdir(), "cim-abort-db-"));
  const store = new GraphStore(path.join(work, "g.db"));
  try {
    await fn(store, root.replace(/\\/g, "/"), head);
  } finally {
    store.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

const run = (store: GraphStore, repo: string, mode: IndexMode, extras: RunExtras = {}): Promise<IndexRunSummary> =>
  runner(store)("r", repo, mode, true, 1000, 5, extras) as Promise<IndexRunSummary>;

test("MCP-ISSUE-123: a run aborted before it starts is recorded cancelled with no commit", async () => {
  await withRepo(async (store, repo) => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(store, repo, "full", { abortSignal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.commitSha, null);
    const recorded = store.getLatestRun("r");
    assert.equal(recorded?.status, "cancelled");
    assert.equal(recorded?.commitSha, null, "an aborted run never becomes the indexed commit");
  });
});

test("MCP-ISSUE-123: a run aborted mid-extraction stops, is recorded cancelled with no commit, and the next incremental does not skip", async () => {
  await withRepo(async (store, repo, head) => {
    const controller = new AbortController();
    const result = await run(store, repo, "full", {
      abortSignal: controller.signal,
      // The first progress tick of the extraction phase: what an `exit` arriving mid-run looks like.
      onProgress: (_p, _t, message) => {
        if (/index/i.test(message) && !controller.signal.aborted) controller.abort();
      }
    });
    assert.equal(controller.signal.aborted, true, "the fixture reached the extraction phase");
    assert.equal(result.status, "cancelled", "never ok");
    assert.equal(result.commitSha, null);
    assert.ok(result.filesIndexed < 40, `stopped before the last batch (filesIndexed=${String(result.filesIndexed)})`);
    assert.equal(store.getLatestRun("r")?.commitSha, null);

    const next = await run(store, repo, "incremental");
    assert.notEqual(next.status, "cancelled");
    assert.equal(next.commitSha, head, "the next complete run records the commit");
    assert.ok(!/skip/i.test(String((next as { skipReason?: string }).skipReason ?? "")), "the next run was not fast-skipped on the aborted run");
    assert.ok(store.listIndexedFiles("r").length === 40, "and indexed every file");
  });
});

/** The graph as rows a clean full run must reproduce: symbol ids, and edges as from|to|type, sorted. */
function graphOf(dbPath: string): { symbols: string[]; edges: string[]; edgeTypes: Record<string, number> } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const symbols = (db.prepare("select symbol_id as id from symbols where repo_id = 'r' order by symbol_id").all() as { id: string }[]).map((r) => r.id);
    const edgeRows = db.prepare("select from_id as f, to_id as t, type from edges where repo_id = 'r'").all() as { f: string; t: string; type: string }[];
    const edges = edgeRows.map((e) => `${e.f}|${e.t}|${e.type}`).sort();
    const edgeTypes: Record<string, number> = {};
    for (const e of edgeRows) edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1;
    return { symbols, edges, edgeTypes };
  } finally {
    db.close();
  }
}

/** A clean full run of `repo` at its current HEAD, on a fresh DB. */
async function cleanFullGraph(repo: string): Promise<ReturnType<typeof graphOf>> {
  const work = mkdtempSync(path.join(tmpdir(), "cim-abort-clean-"));
  const dbPath = path.join(work, "g.db");
  const store = new GraphStore(dbPath);
  try {
    assert.equal((await run(store, repo, "full")).status, "ok");
  } finally {
    store.close();
  }
  try {
    return graphOf(dbPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Abort `mode` right after its files were written and before the resolve passes (the `pruning` tick): the partial
 * state a terminate-free exit leaves — written rows, unresolved edges, dependents not queued.
 */
async function abortedRun(store: GraphStore, dbPath: string, repo: string, mode: IndexMode): Promise<IndexRunSummary> {
  const controller = new AbortController();
  const result = await run(store, repo, mode, {
    abortSignal: controller.signal,
    onProgress: (_p, _t, message) => {
      if (/pruning/i.test(message) && !controller.signal.aborted) controller.abort();
    }
  });
  assert.equal(controller.signal.aborted, true, "the fixture reached the post-phase");
  assert.equal(result.status, "cancelled");
  assert.ok(graphOf(dbPath).symbols.length > 0, "the aborted run left written rows behind");
  return result;
}

async function withRepoDb(fn: (store: GraphStore, dbPath: string, repo: string) => Promise<void>): Promise<void> {
  const { root } = makeRepo();
  const work = mkdtempSync(path.join(tmpdir(), "cim-abort-db-"));
  const dbPath = path.join(work, "g.db");
  const store = new GraphStore(dbPath);
  try {
    await fn(store, dbPath, root.replace(/\\/g, "/"));
  } finally {
    store.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("MCP-ISSUE-123 re-review A: after an aborted FIRST full run, the next incremental leaves the graph a clean full run builds", async () => {
  await withRepoDb(async (store, dbPath, repo) => {
    await abortedRun(store, dbPath, repo, "full");
    const next = await run(store, repo, "incremental");
    assert.equal(next.status, "ok");
    const got = graphOf(dbPath);
    const want = await cleanFullGraph(repo);
    assert.deepEqual(got.edgeTypes, want.edgeTypes, "edges per type");
    assert.deepEqual(got.symbols, want.symbols, "symbols");
    assert.deepEqual(got.edges, want.edges, "edges");
  });
});

test("MCP-ISSUE-123 re-review A: after an aborted incremental over a new commit, the next incremental leaves the graph a clean full run builds", async () => {
  await withRepoDb(async (store, dbPath, repo) => {
    assert.equal((await run(store, repo, "full")).status, "ok");
    // A new commit that changes every file: each now also calls the next one, so resolution depends on files the
    // aborted run never reached.
    for (let i = 0; i < 40; i++) {
      const rel = `src/m${String(i)}.ts`;
      const next = (i + 1) % 40;
      writeFileSync(
        path.join(repo, rel),
        `import { g${String(next)} } from './m${String(next)}';
export function g${String(i)}(): number {
  return ${String(i)};
}
export function h${String(i)}(): number {
  return g${String(next)}();
}
`
      );
    }
    git(repo, "add", "--", "src");
    git(repo, "commit", "-q", "-m", "rename and cross-call");
    await abortedRun(store, dbPath, repo, "incremental");
    const next = await run(store, repo, "incremental");
    assert.equal(next.status, "ok");
    const got = graphOf(dbPath);
    const want = await cleanFullGraph(repo);
    assert.deepEqual(got.edgeTypes, want.edgeTypes, "edges per type");
    assert.deepEqual(got.symbols, want.symbols, "symbols");
    assert.deepEqual(got.edges, want.edges, "edges");
  });
});

/** Count calls to `names` on `store`, letting each call through. */
function spy(store: GraphStore, names: string[]): Record<string, number> {
  const calls: Record<string, number> = {};
  const target = store as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of names) {
    calls[name] = 0;
    const original = target[name]!.bind(store);
    target[name] = (...a: unknown[]) => {
      calls[name]! += 1;
      return original(...a);
    };
  }
  return calls;
}

test("MCP-ISSUE-123 re-review B: a failed run records no commit, and the next incremental at the same HEAD neither skips nor scopes — it runs full", async () => {
  await withRepo(async (store, repo, head) => {
    assert.equal((await run(store, repo, "full")).status, "ok");
    // The second full run dies after its first batch was committed: a partial graph at HEAD.
    const target = store as unknown as { checkpoint: () => void };
    const checkpoint = target.checkpoint.bind(store);
    target.checkpoint = () => {
      throw new Error("disk I/O error (test)");
    };
    await assert.rejects(run(store, repo, "full"), /disk I\/O error/);
    target.checkpoint = checkpoint;
    const failed = store.getLatestRun("r");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.commitSha, null, "a failed run never becomes the indexed commit");

    const next = await run(store, repo, "incremental");
    const skipReason = (next as { skipReason?: string }).skipReason;
    assert.equal(skipReason, undefined, `not fast-skipped on the failed run (skipReason=${String(skipReason)})`);
    assert.equal(next.mode, "full", "escalated to full, as after an aborted run");
    assert.match(String(next.scope), /failed/);
    assert.equal(next.status, "ok");
    assert.equal(next.commitSha, head);
  });
});

test("MCP-ISSUE-123 re-review C: an abort after the files were written skips the vector index rebuild", async () => {
  await withRepoDb(async (store, dbPath, repo) => {
    Object.defineProperty(store, "isVectorEnabled", { get: () => true });
    const calls = spy(store, ["rebuildVectorIndex", "syncVectorsForFiles"]);
    const result = await abortedRun(store, dbPath, repo, "full");
    assert.equal(result.commitSha, null);
    assert.deepEqual(calls, { rebuildVectorIndex: 0, syncVectorsForFiles: 0 });
  });
});

test("MCP-ISSUE-123 re-review C: an abort during the resolve passes runs no further pass and records cancelled with no commit", async () => {
  await withRepoDb(async (store, _dbPath, repo) => {
    const calls = spy(store, ["resolveCallEdgesBatch", "resolveImportEdges", "resolveTypeRefEdges", "resolveImplementsEdges", "resolveMentions", "deduplicateResolvedEdges"]);
    const controller = new AbortController();
    let atAbort: Record<string, number> = {};
    const result = await run(store, repo, "full", {
      abortSignal: controller.signal,
      onProgress: (_p, _t, message) => {
        if (/resolving imports/i.test(message) && !controller.signal.aborted) {
          atAbort = { ...calls };
          controller.abort();
        }
      }
    });
    assert.equal(controller.signal.aborted, true, "the fixture reached the import pass");
    assert.ok(atAbort.resolveCallEdgesBatch! > 0, "the call pass ran before the abort");
    assert.deepEqual(calls, atAbort, "no resolve call after the abort");
    assert.equal(result.status, "cancelled");
    assert.equal(result.commitSha, null);
    assert.equal(store.getLatestRun("r")?.status, "cancelled");
  });
});

test("MCP-ISSUE-123 re-review B follow-up: a throw in the post-phase records the run failed with no commit, and the next incremental runs full", async () => {
  await withRepo(async (store, repo, head) => {
    assert.equal((await run(store, repo, "full")).status, "ok");
    // A post-phase call outside the per-pass try/catch: the full run's FTS marker read, after its files were written.
    const target = store as unknown as { getIndexMeta: (key: string) => string | null };
    const getIndexMeta = target.getIndexMeta.bind(store);
    target.getIndexMeta = () => {
      throw new Error("database is locked (test)");
    };
    await assert.rejects(run(store, repo, "full"), /database is locked/);
    target.getIndexMeta = getIndexMeta;
    const failed = store.getLatestRun("r");
    assert.equal(failed?.status, "failed", "the run is on record, not missing");
    assert.equal(failed?.commitSha, null);
    assert.match(String(failed?.scope), /post-phase/);

    const next = await run(store, repo, "incremental");
    const skipReason = (next as { skipReason?: string }).skipReason;
    assert.equal(skipReason, undefined, `not fast-skipped (skipReason=${String(skipReason)})`);
    assert.equal(next.mode, "full");
    assert.equal(next.status, "ok");
    assert.equal(next.commitSha, head);
  });
});

test("MCP-ISSUE-123 review: the index session ends on every failing path — a pipeline throw, and a post-phase throw whose failed record throws too", async () => {
  await withRepo(async (store, repo) => {
    const sessions = spy(store, ["beginIndexSession", "endIndexSession"]);
    const target = store as unknown as Record<string, (...a: unknown[]) => unknown>;

    // 1. The pipeline throws (after its first batch).
    const checkpoint = target.checkpoint!;
    target.checkpoint = () => {
      throw new Error("disk I/O error (test)");
    };
    await assert.rejects(run(store, repo, "full"), /disk I\/O error/);
    target.checkpoint = checkpoint;
    assert.deepEqual(sessions, { beginIndexSession: 1, endIndexSession: 1 }, "the pipeline's throw ends the session");

    // 2. The post-phase throws, and so does every record of the run.
    const getIndexMeta = target.getIndexMeta!;
    const recordRun = target.recordRun!;
    target.getIndexMeta = () => {
      throw new Error("database is locked (test)");
    };
    target.recordRun = () => {
      throw new Error("database is locked (record)");
    };
    await assert.rejects(run(store, repo, "full"), /database is locked \(test\)/, "the original error surfaces");
    target.getIndexMeta = getIndexMeta;
    target.recordRun = recordRun;
    assert.deepEqual(sessions, { beginIndexSession: 2, endIndexSession: 2 }, "and so does a post-phase throw whose record fails");
  });
});

test("MCP-ISSUE-123 review: an abort at a batch boundary inside the call pass ends the pass there", async () => {
  await withRepoDb(async (store, _dbPath, repo) => {
    const controller = new AbortController();
    const calls = spy(store, ["resolveCallEdgesBatch", "resolveImportEdges", "resolveMentions"]);
    // Abort inside the first batch of the call pass: the pass must not ask for a second batch.
    const target = store as unknown as Record<string, (...a: unknown[]) => unknown>;
    const batch = target.resolveCallEdgesBatch!;
    let firstResolved = 0;
    target.resolveCallEdgesBatch = (...a: unknown[]) => {
      const resolved = batch(...a);
      if (!controller.signal.aborted) firstResolved = resolved as number;
      controller.abort();
      return resolved;
    };
    const result = await run(store, repo, "full", { abortSignal: controller.signal });
    assert.ok(firstResolved > 0, "the first batch resolved rows, so only the abort ends the loop");
    assert.equal(calls.resolveCallEdgesBatch, 1, "one batch, then the pass stopped at its boundary");
    assert.equal(calls.resolveImportEdges, 0);
    assert.equal(calls.resolveMentions, 0);
    assert.equal(result.status, "cancelled");
    assert.equal(result.commitSha, null);
  });
});
