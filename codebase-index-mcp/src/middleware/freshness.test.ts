import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import { applyFreshness, computeTreeKey, createFreshnessGate, liveRunMarkers, pathsChangedSince, readDirtyLedger, recordDirtyLedger, tryAcquireLock, UNREADABLE, watcherRunPlan, type RepoTreeState, type TreeKey } from "./freshness.js";
import { GraphStore } from "../repositories/graphStore.js";
import { createIndexRunner } from "../services/indexing/indexRunner.js";
import { readWorkingTreeState } from "../services/git/gitHelpers.js";
import type { IndexMode, IndexRunResult } from "../types/index.js";

/**
 * R1 — read tools answer from a current index, without a manual index_repository.
 *
 * wec.aria's index was 463 commits behind with no watcher, and every answer said `coverage: "high"`.
 * These pin the gate's contract with a fake git and a fake runner: refresh when the tree moved, never
 * abort a slow run (its result serves the next query), one run per repo however many callers, and an
 * honest `freshness` block whenever an answer comes from an older index.
 */

type Harness = {
  gate: ReturnType<typeof createFreshnessGate>;
  runs: { mode: IndexMode; dirtyPaths?: readonly string[] }[];
  setTree: (t: RepoTreeState) => void;
  setIndexed: (sha: string | null) => void;
  finishRun: () => void;
  triggered: string[];
  pending: string[][];
  lockDir: string;
  cleanup: () => void;
};

type HarnessOpts = {
  budgetMs: number;
  autoFinish?: boolean;
  refuse?: string;
  pending?: boolean;
  /** MCP-ISSUE-101: the index DB's `tree_key` column, shared by every gate (process) handed the same map. */
  keyStore?: Map<string, string>;
  /** Repo folder to share with another harness (another process on the same tree). */
  repoDir?: string;
  status?: () => IndexRunResult["status"];
};

function harness(opts: HarnessOpts): Harness {
  const lockDir = opts.repoDir ?? mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let tree: RepoTreeState = { head: "aaa111", dirty: [] };
  let indexed: string | null = "aaa111";
  const runs: { mode: IndexMode; dirtyPaths?: readonly string[] }[] = [];
  const triggered: string[] = [];
  const pending: string[][] = [];
  let release: (() => void) | null = null;
  const gate = createFreshnessGate({
    enabled: true,
    budgetMs: opts.budgetMs,
    lockDir,
    checkTtlMs: 0,
    getRepoPath: () => lockDir,
    getIndexedCommit: () => indexed,
    readTree: () => tree,
    markTriggered: (runId) => triggered.push(runId),
    ...(opts.pending && { markPendingReindex: (_repoId: string, paths: string[]) => pending.push(paths) }),
    ...(opts.refuse !== undefined && { refuseRefresh: () => opts.refuse ?? null }),
    ...(opts.keyStore && {
      getCoveredKey: (repoId: string) => opts.keyStore?.get(repoId) ?? null,
      recordCoveredKey: (repoId: string, _runId: string, key: string) => opts.keyStore?.set(repoId, key)
    }),
    run: async (_repoId, _repoPath, mode, dirtyPaths) => {
      runs.push({ mode, ...(dirtyPaths && { dirtyPaths: [...dirtyPaths] }) });
      if (!opts.autoFinish) await new Promise<void>((resolve) => (release = resolve));
      indexed = tree.head;
      return { runId: `run-${String(runs.length)}`, ...(opts.status && { status: opts.status() }) } as IndexRunResult;
    }
  });
  return {
    gate,
    runs,
    triggered,
    pending,
    lockDir,
    setTree: (t) => (tree = t),
    setIndexed: (sha) => (indexed = sha),
    finishRun: () => release?.(),
    cleanup: () => rmSync(lockDir, { recursive: true, force: true })
  };
}

test("an index at HEAD with a clean tree is fresh, and nothing runs", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
    assert.equal(h.runs.length, 0);
  } finally { h.cleanup(); }
});

test("HEAD moved: an incremental refresh runs, and a query inside the budget answers refreshed", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    h.setTree({ head: "bbb222", dirty: [] });
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "refreshed");
    assert.equal(note.mode, "incremental");
    assert.deepEqual(h.runs.map((r) => r.mode), ["incremental"]);
    assert.deepEqual(h.triggered, ["run-1"], "the run is tagged as query-triggered");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "and the next query is fresh with no second run");
    assert.equal(h.runs.length, 1);
  } finally { h.cleanup(); }
});

test("a run that outlives the budget is not aborted: the answer says refreshing, the next query uses it", async () => {
  const h = harness({ budgetMs: 20 });
  try {
    h.setTree({ head: "ccc333", dirty: [] });
    const first = await h.gate.ensureFresh("r");
    assert.equal(first.state, "refreshing");
    assert.match(first.reason ?? "", /continues in the background/);

    // A call that joins a run already past its budget answers at once — measured live, each call
    // during a 20 s refresh used to wait another full budget.
    const t0 = Date.now();
    const second = await h.gate.ensureFresh("r");
    assert.equal(second.state, "refreshing");
    assert.ok(Date.now() - t0 < 15, `joining an overdue run must not wait (${String(Date.now() - t0)} ms)`);
    assert.equal(h.runs.length, 1, "one run, however many callers");

    h.finishRun();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "the finished run serves the next query");
    assert.equal(h.runs.length, 1);
  } finally { h.cleanup(); }
});

test("only the working tree changed: a dirty-mode refresh, and the same dirty tree is not refreshed twice", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "edited.ts"), "export const a = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["edited.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).mode, "dirty");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "unchanged dirty set: covered");
    fs.writeFileSync(path.join(h.lockDir, "edited.ts"), "export const a = 22;\n");
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(h.lockDir, "edited.ts"), t, t);
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed", "an edit to a dirty file refreshes again");
    assert.equal(h.runs.length, 2);
  } finally { h.cleanup(); }
});

test("another live process holding the repo's lock means: do not run, say the answer is not current", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    h.setTree({ head: "ddd444", dirty: [] });
    // The parent process is alive and is not us: a real foreign holder.
    fs.writeFileSync(path.join(h.lockDir, "refresh-r.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "refreshing");
    assert.match(note.reason ?? "", /another server process/);
    assert.equal(h.runs.length, 0);
  } finally { h.cleanup(); }
});

test("a lock left by a dead process or too old is broken", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-lock-"));
  try {
    const file = path.join(dir, "x.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, at: Date.now() }));
    assert.equal(tryAcquireLock(file, 60_000, Date.now()), true, "dead pid");
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, at: 0 }));
    assert.equal(tryAcquireLock(file, 60_000, Date.now()), true, "older than the stale limit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("serialize never lets two runs for one repo overlap", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    const order: string[] = [];
    const slow = h.gate.serialize("r", async () => { order.push("a:start"); await new Promise((r) => setTimeout(r, 30)); order.push("a:end"); });
    const fast = h.gate.serialize("r", async () => { order.push("b:start"); order.push("b:end"); });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  } finally { h.cleanup(); }
});

test("applyFreshness: a not-current answer never keeps coverage high, and says why", () => {
  const note = { state: "refreshing" as const, mode: "incremental" as const, reason: "still running" };
  const obj = applyFreshness({ coverage: { confidence: "high", knownGaps: [] } }, note) as { coverage: { confidence: string; knownGaps: string[] }; freshness: unknown };
  assert.equal(obj.coverage.confidence, "medium");
  assert.ok(obj.coverage.knownGaps.some((g) => g.includes("still running")));
  assert.deepEqual(obj.freshness, note);
  assert.equal((applyFreshness({ coverage: "high" }, note) as { coverage: string }).coverage, "medium", "nano's bare string too");
  assert.deepEqual(applyFreshness({ a: 1 }, { state: "fresh" }), { a: 1 }, "a fresh answer is untouched");
  const refreshed = applyFreshness({ coverage: "high" }, { state: "refreshed", runId: "x" }) as { coverage: string; freshness: unknown };
  assert.equal(refreshed.coverage, "high", "a refreshed answer is current: coverage stands");
});

test("applyFreshness: an exact TypeScript answer scopes the note to its index-derived part", () => {
  const note = { state: "stale" as const, mode: "incremental" as const, reason: "the refresh run failed; this answer comes from the previous index." };
  const typed = { engine: "typescript-language-service", coverage: { confidence: "exact", engine: "typescript-language-service", knownGaps: [], gaps: [] } };
  const out = applyFreshness(typed, note) as { coverage: { confidence: string; knownGaps: string[] }; freshness: { reason: string; appliesTo: string } };
  assert.equal(out.coverage.confidence, "exact");
  assert.deepEqual(out.coverage.knownGaps, [], "coverage carries no 'previous index' line");
  assert.ok(!/previous index/i.test(JSON.stringify(out)), JSON.stringify(out));
  assert.equal(out.freshness.reason, "the refresh run failed");
  assert.ok(out.freshness.appliesTo.startsWith("index-derived parts only"));
  const nano = applyFreshness({ engine: "typescript-language-service", coverage: "exact" }, note) as { coverage: string };
  assert.equal(nano.coverage, "exact", "nano's bare word too");
});

test("release F: a process told it must not write over a newer build answers stale and runs nothing", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, refuse: "written by a newer build (v7-x)." });
  try {
    h.setTree({ head: "bbb222", dirty: [] });
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "stale");
    assert.match(note.reason ?? "", /newer build/);
    assert.equal(h.runs.length, 0);
  } finally { h.cleanup(); }
});

test("release I1b: an async tree read; two calls racing through it start one run, not two", async () => {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  const runs: IndexMode[] = [];
  let release: (() => void) | null = null;
  try {
    const gate = createFreshnessGate({
      enabled: true,
      budgetMs: 30,
      lockDir,
      getRepoPath: () => lockDir,
      getIndexedCommit: () => "aaa111",
      // Resolves on a later tick, as the server's execFile-based read does.
      readTree: () => new Promise<RepoTreeState>((resolve) => setTimeout(() => resolve({ head: "bbb222", dirty: [] }), 5)),
      run: async (_repoId, _repoPath, mode) => {
        runs.push(mode);
        await new Promise<void>((resolve) => (release = resolve));
        return { runId: "run-1" } as IndexRunResult;
      }
    });
    const [a, b] = await Promise.all([gate.ensureFresh("r"), gate.ensureFresh("r")]);
    assert.deepEqual(runs, ["incremental"], "one run for both callers");
    assert.equal(a.state, "refreshing");
    assert.equal(b.state, "refreshing");
    assert.doesNotMatch(b.reason ?? "", /another server process/, "the second caller joined this process's run");
    (release as (() => void) | null)?.();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("release I1b: a refresh run that fails (the worker crashed) answers stale and releases the lock", async () => {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let fail = true;
  const runs: IndexMode[] = [];
  try {
    const gate = createFreshnessGate({
      enabled: true,
      budgetMs: 1000,
      lockDir,
      getRepoPath: () => lockDir,
      getIndexedCommit: () => (fail ? "aaa111" : "bbb222"),
      readTree: () => ({ head: "bbb222", dirty: [] }),
      run: async (_repoId, _repoPath, mode) => {
        runs.push(mode);
        if (fail) throw new Error("the refresh worker crashed: boom");
        return { runId: "run-2" } as IndexRunResult;
      }
    });
    const note = await gate.ensureFresh("r");
    assert.equal(note.state, "stale");
    assert.match(note.reason ?? "", /refresh run failed/);
    assert.equal(fs.existsSync(path.join(lockDir, "refresh-r.lock")), false, "the lock is released");
    // The next query retries (here the index caught up meanwhile, so it is simply fresh).
    fail = false;
    assert.equal((await gate.ensureFresh("r")).state, "fresh");
    assert.equal(runs.length, 1);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("a file indexed while dirty, then deleted: a dirty run over that path cleans it, not a whole-repo incremental", async () => {
  // Release J, wec.aria's live check: removing one untracked probe ran `incremental` (re-hash every
  // file), 3.2 s warm and 6.5 s cold, against 0.4 s for the dirty run that added it.
  const h = harness({ budgetMs: 1000, autoFinish: true, pending: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "probe.ts"), "export const p = 1;\n");
    fs.writeFileSync(path.join(h.lockDir, "kept.ts"), "export const k = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["kept.ts", "probe.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).mode, "dirty");

    h.setTree({ head: "aaa111", dirty: ["kept.ts"] }); // probe.ts deleted
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "refreshed");
    assert.equal(note.mode, "dirty", "the cleanup is a dirty run");
    assert.deepEqual(h.pending, [["probe.ts"]], "the vanished path is handed to that run");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "and the ledger lets go of it: no run loop");
    assert.deepEqual(h.runs.map((r) => r.mode), ["dirty", "dirty"]);
  } finally { h.cleanup(); }
});

test("without a pending-reindex hook, a vanished path still falls back to an incremental run", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "probe.ts"), "export const p = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["probe.ts"] });
    await h.gate.ensureFresh("r");
    h.setTree({ head: "aaa111", dirty: [] });
    assert.equal((await h.gate.ensureFresh("r")).mode, "incremental");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
  } finally { h.cleanup(); }
});

// MCP-ISSUE-101: on wec.aria every query on a dirty tree paid a ~7.4 s dirty run — the covered key was size+mtime,
// in memory, so a touch re-ran it and no other server process could reuse it.

test("MCP-ISSUE-101: an unchanged dirty tree is fresh with no run; a touch alone runs nothing; a content change runs once", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore: new Map() });
  try {
    const file = path.join(h.lockDir, "edited.ts");
    fs.writeFileSync(file, "export const a = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["edited.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "second check on the same tree");
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(file, t, t);
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "touched, same bytes: still covered");
    assert.equal(h.runs.length, 1);
    fs.writeFileSync(file, "export const a = 2;\n"); // same size, new content
    fs.utimesSync(file, t, t); // and the same mtime: only the content says it changed
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed", "a content change refreshes");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
    assert.equal(h.runs.length, 2, "exactly one more run");
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: the covered key is shared — a second gate (another process) on the same DB answers fresh without a run", async () => {
  const keyStore = new Map<string, string>();
  const a = harness({ budgetMs: 1000, autoFinish: true, keyStore });
  const b = harness({ budgetMs: 1000, autoFinish: true, keyStore, repoDir: a.lockDir });
  try {
    fs.writeFileSync(path.join(a.lockDir, "x.ts"), "export const x = 1;\n");
    a.setTree({ head: "aaa111", dirty: ["x.ts"] });
    b.setTree({ head: "aaa111", dirty: ["x.ts"] });
    assert.equal((await a.gate.ensureFresh("r")).state, "refreshed");
    assert.deepEqual(await b.gate.ensureFresh("r"), { state: "fresh" }, "process B reuses process A's key");
    assert.equal(b.runs.length, 0);
  } finally { a.cleanup(); }
});

test("MCP-ISSUE-101: a dirty run re-indexes only the files the covered key does not vouch for", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore: new Map() });
  try {
    for (const n of ["p", "q", "r"]) fs.writeFileSync(path.join(h.lockDir, `${n}.ts`), `export const ${n} = 1;\n`);
    h.setTree({ head: "aaa111", dirty: ["p.ts", "q.ts", "r.ts"] });
    await h.gate.ensureFresh("r");
    assert.deepEqual(h.runs[0]?.dirtyPaths, ["p.ts", "q.ts", "r.ts"], "no key yet: every dirty file");
    fs.writeFileSync(path.join(h.lockDir, "q.ts"), "export const q = 2;\n");
    fs.writeFileSync(path.join(h.lockDir, "s.ts"), "export const s = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["p.ts", "q.ts", "r.ts", "s.ts"] });
    await h.gate.ensureFresh("r");
    assert.deepEqual(h.runs[1]?.dirtyPaths, ["q.ts", "s.ts"], "only the changed and the new file");
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: a run that ends failed or cancelled answers stale and records no key; the next query runs again", async () => {
  let status: IndexRunResult["status"] = "cancelled";
  const keyStore = new Map<string, string>();
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore, status: () => status });
  try {
    fs.writeFileSync(path.join(h.lockDir, "f.ts"), "export const f = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["f.ts"] });
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "stale");
    assert.match(note.reason ?? "", /ended cancelled/);
    assert.equal(keyStore.size, 0, "no key for a run that covered nothing");
    status = "ok";
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed");
    assert.equal(h.runs.length, 2);
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: pathsChangedSince — another HEAD vouches for nothing; reverted files are named", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-key-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "a");
    fs.writeFileSync(path.join(dir, "b.ts"), "b");
    const before = await computeTreeKey(dir, { head: "h1", dirty: ["b.ts", "a.ts", "gone.ts"] });
    assert.deepEqual(Object.keys(before.files), ["a.ts", "b.ts", "gone.ts"]);
    assert.equal(before.files["gone.ts"], "deleted");
    const now = await computeTreeKey(dir, { head: "h1", dirty: ["a.ts"] });
    assert.deepEqual(pathsChangedSince(before, now), ["b.ts", "gone.ts"], "no longer dirty: re-index from disk");
    assert.equal(pathsChangedSince(before, { ...now, head: "h2" }), null);
    assert.equal(pathsChangedSince(null, now), null);
    const big = await computeTreeKey(dir, { head: "h1", dirty: ["a.ts"] }, 0);
    assert.equal(big.files["a.ts"], "size:1", "above the hash cap: keyed by size");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101: an unreadable dirty file is never vouched for, whatever was recorded", () => {
  const covered: TreeKey = { head: "h1", files: { "a.ts": UNREADABLE, "b.ts": "x" } };
  assert.deepEqual(pathsChangedSince(covered, { head: "h1", files: { "a.ts": UNREADABLE, "b.ts": "x" } }), ["a.ts"]);
});

test("MCP-ISSUE-101: watcherRunPlan — dirty over batch + unvouched at the indexed HEAD; incremental when HEAD moved", () => {
  const key: TreeKey = { head: "c2", files: { "y.ts": "h-y", "z.ts": "h-z" } };
  const batch = { changed: ["y.ts"], deleted: ["gone.ts"], overflowed: false };
  assert.deepEqual(watcherRunPlan(batch, key, { head: "c2", files: { "z.ts": "h-z" } }, "c2"), { mode: "dirty", paths: ["gone.ts", "y.ts"] });
  assert.deepEqual(watcherRunPlan(batch, key, null, "c2"), { mode: "dirty", paths: ["gone.ts", "y.ts", "z.ts"] }, "no key: every dirty file");
  assert.deepEqual(watcherRunPlan(batch, key, null, "c1"), { mode: "incremental" }, "HEAD moved since the indexed commit");
  assert.deepEqual(watcherRunPlan(batch, key, { head: "c1", files: {} }, "c2"), { mode: "incremental" }, "the key is at another HEAD");
  assert.deepEqual(watcherRunPlan({ ...batch, overflowed: true }, key, null, "c2"), { mode: "incremental" });
  assert.deepEqual(watcherRunPlan(batch, null, null, "c2"), { mode: "incremental" }, "outside git");
});

test("MCP-ISSUE-101: HEAD moved with no watcher running, then a watcher batch names only Y — X is re-indexed all the same", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-watchhead-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  };
  const dbPath = path.join(dir, ".index", "i.db");
  fs.mkdirSync(path.dirname(dbPath));
  fs.writeFileSync(path.join(dir, ".gitignore"), ".index/\n");
  fs.writeFileSync(path.join(dir, "x.ts"), "export function xOld(): number {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(dir, "y.ts"), "export function yOne(): number {\n  return 1;\n}\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "c1");
  const repoPath = dir.replace(/\\/g, "/");
  const store = new GraphStore(dbPath);
  try {
    store.ensureRepository("w", repoPath);
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    await run("w", repoPath, "full", false, 1000, 50);
    // A pull the watcher never saw: X changes in a new commit.
    fs.writeFileSync(path.join(dir, "x.ts"), "export function xNew(): number {\n  return 2;\n}\n");
    git("commit", "-q", "-am", "c2");
    // Then the watcher sees one edit, to Y.
    fs.writeFileSync(path.join(dir, "y.ts"), "export function yTwo(): number {\n  return 2;\n}\n");
    const key = await computeTreeKey(repoPath, readWorkingTreeState(repoPath));
    const plan = watcherRunPlan({ changed: ["y.ts"], deleted: [], overflowed: false }, key, null, store.getLatestRun("w")?.commitSha ?? null);
    assert.deepEqual(plan, { mode: "incremental" });
    await run("w", repoPath, plan.mode, false, 1000, 50);
    const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => { name: string }[] } } }).db;
    const xs = db.prepare(`select name from symbols where repo_id = ? and file_path = 'x.ts' and kind = 'function'`).all("w").map((r) => r.name);
    assert.deepEqual(xs, ["xNew"], "the commit's change to X is in the index");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101: a dirty run handed its paths takes the re-read ones out of the ledger", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-ledger-"));
  try {
    recordDirtyLedger(dir, "r", "dirty", { head: "h1", dirty: ["a.ts", "b.ts"] });
    // b.ts was reverted and a watcher dirty run re-read it; a.ts is still dirty.
    recordDirtyLedger(dir, "r", "dirty", { head: "h1", dirty: ["a.ts"] }, ["a.ts", "b.ts"]);
    assert.deepEqual(readDirtyLedger(dir, "r")?.paths, ["a.ts"]);
    recordDirtyLedger(dir, "r", "dirty", { head: "h1", dirty: ["c.ts"] }, ["c.ts"]);
    assert.deepEqual(readDirtyLedger(dir, "r")?.paths, ["a.ts", "c.ts"], "a path the run did not re-read stays");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── MCP-ISSUE-101 part 5: no "fresh" while any process is running an index of the repo ────────────────────

/**
 * A second PROCESS on the same DB and state dir runs a real full index through its own gate's `serialize`
 * (as index_repository and the watcher do). It prints `midrun` from the pipeline's first progress tick, when
 * the first batch is committed and nothing is resolved yet, and `done` when the run ends.
 */
const CHILD = `
import { GraphStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/repositories/graphStore.ts")).href)};
import { createFreshnessGate } from ${JSON.stringify(pathToFileURL(path.resolve("src/middleware/freshness.ts")).href)};
import { runIndexPipeline } from ${JSON.stringify(pathToFileURL(path.resolve("src/services/indexing/indexPipeline.ts")).href)};
const [dbPath, lockDir, repoPath] = process.argv.slice(2);
const store = new GraphStore(dbPath);
store.ensureRepository("r", repoPath);
const gate = createFreshnessGate({ enabled: true, budgetMs: 0, lockDir, getRepoPath: () => repoPath, getIndexedCommit: () => null, readTree: () => ({ head: null, dirty: [] }), run: async () => { throw new Error("unused"); } });
let told = false;
await gate.serialize("r", () => runIndexPipeline(store, {
  repoId: "r", repoPath, mode: "full", maxFiles: 5000, batchSize: 10, subtxSize: 5, parseWorkers: 0,
  onProgress: () => { if (!told) { told = true; process.stdout.write("midrun\\n"); } }
}));
store.close();
process.stdout.write("done\\n");
`;

function startChild(lockDir: string, repoDir: string): { child: ChildProcess; lines: string[]; waitFor: (line: string) => Promise<void> } {
  const script = path.join(lockDir, "child.mts");
  fs.writeFileSync(script, CHILD);
  const child = spawn(process.execPath, ["--import", "tsx", script, path.join(lockDir, "x.db"), lockDir, repoDir.replace(/\\/g, "/")], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines: string[] = [];
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  child.stdout!.on("data", (b: Buffer) => {
    for (const l of b.toString().split(/\r?\n/).filter(Boolean)) {
      lines.push(l);
      for (const w of waiters.filter((x) => x.line === l)) w.resolve();
    }
  });
  const waitFor = (line: string): Promise<void> =>
    lines.includes(line)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          waiters.push({ line, resolve });
          child.once("exit", (code) => (lines.includes(line) ? resolve() : reject(new Error(`child exited ${String(code)} before "${line}"`))));
        });
  return { child, lines, waitFor };
}

function bigRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-fresh-repo-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/util.ts"), "export function helper(): number {\n  return 1;\n}\n");
  for (let i = 0; i < 400; i++) {
    fs.writeFileSync(path.join(dir, `src/c${String(i)}.ts`), `import { helper } from "./util";\n\nexport function main${String(i)}(): number {\n  return helper();\n}\n`);
  }
  return dir;
}

test("MCP-ISSUE-101 part 5: a query from another process while a full index runs answers refreshing, then fresh", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const repo = bigRepo();
  try {
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "clean tree at HEAD, nothing running");
    const c = startChild(h.lockDir, repo);
    await c.waitFor("midrun");
    const mid = await h.gate.ensureFresh("r");
    const finished = c.lines.includes("done");
    assert.ok(!finished, "the child's run is still going when the query is answered");
    assert.equal(mid.state, "refreshing", JSON.stringify(mid));
    assert.match(mid.reason ?? "", /index run of this repo is in progress \(pid \d+/);
    assert.match(mid.reason ?? "", /partly re-written index/);
    assert.equal(h.runs.length, 0, "the gate does not start a run of its own over the other process's");
    await c.waitFor("done");
    await new Promise((resolve) => c.child.once("exit", resolve));
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "the marker is gone with the run");
  } finally {
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: a marker left by a killed process is not a run in progress", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const repo = bigRepo();
  try {
    const c = startChild(h.lockDir, repo);
    await c.waitFor("midrun");
    c.child.kill("SIGKILL");
    await new Promise((resolve) => c.child.once("exit", resolve));
    assert.ok(fs.readdirSync(h.lockDir).some((n) => n.startsWith("running-r-")), "the killed run left its marker");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
    assert.ok(!fs.readdirSync(h.lockDir).some((n) => n.startsWith("running-r-")), "the dead pid's marker is removed");
  } finally {
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: a marker older than staleRunMs is ignored even if its pid is alive (pid reuse)", async () => {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  try {
    fs.writeFileSync(path.join(lockDir, "running-r-1-1.json"), JSON.stringify({ pid: process.pid, at: 1_000 }));
    assert.deepEqual(liveRunMarkers(lockDir, "r", 60_000, 2_000), [{ pid: process.pid, at: 1_000 }]);
    assert.deepEqual(liveRunMarkers(lockDir, "r", 60_000, 100_000), []);
    assert.deepEqual(fs.readdirSync(lockDir), []);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: a run in this process (index_repository through serialize) is in progress for its queries too", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    let release!: () => void;
    const run = h.gate.serialize("r", () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshing");
    release();
    await run;
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
  } finally {
    h.cleanup();
  }
});

test("MCP-ISSUE-101 part 5: an index last fully built by another INDEX_VERSION answers refreshing with the reason", async () => {
  let version: string | null = "v14-release-m";
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let tree: RepoTreeState = { head: "aaa111", dirty: [] };
  let indexed = "aaa111";
  const gate = createFreshnessGate({
    enabled: true,
    budgetMs: 1000,
    lockDir,
    getRepoPath: () => lockDir,
    getIndexedCommit: () => indexed,
    readTree: () => tree,
    getFullRunVersion: () => version,
    buildVersion: "v15-tiebreak-path",
    run: async () => {
      indexed = tree.head!;
      return { runId: "run-1" } as IndexRunResult;
    }
  });
  try {
    const clean = await gate.ensureFresh("r");
    assert.equal(clean.state, "refreshing");
    assert.match(clean.reason ?? "", /last fully built by v14-release-m; this server runs v15-tiebreak-path/);
    assert.match(clean.reason ?? "", /mode "full"/);
    // A scoped refresh does not make the index current: still flagged after it.
    tree = { head: "bbb222", dirty: [] };
    const after = await gate.ensureFresh("r");
    assert.equal(after.state, "refreshing", JSON.stringify(after));
    assert.equal(after.runId, "run-1");
    // A full run at this build's version clears it.
    version = "v15-tiebreak-path";
    assert.deepEqual(await gate.ensureFresh("r"), { state: "fresh" });
    // No full run on record (a new repo mid first run): nothing to compare.
    version = null;
    assert.deepEqual(await gate.ensureFresh("r"), { state: "fresh" });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: getLatestFullRunVersion reads the latest ok FULL run, not a later scoped one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-fresh-db-"));
  const store = new GraphStore(path.join(dir, "x.db"));
  try {
    const db = new Database(path.join(dir, "x.db"));
    const insert = db.prepare(
      `insert into index_runs (run_id, repo_id, mode, status, started_at, finished_at, files_scanned, files_indexed, files_skipped,
         symbols_upserted, edges_upserted, parse_failures, elapsed_ms, index_version) values (?, 'r', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?)`
    );
    insert.run("a", "full", "ok", "2026-10-27T01:00:00Z", "2026-10-27T01:01:00Z", "v14-release-m");
    insert.run("b", "full", "failed", "2026-10-27T02:00:00Z", "2026-10-27T02:01:00Z", "v15-tiebreak-path");
    insert.run("c", "dirty", "ok", "2026-10-27T03:00:00Z", "2026-10-27T03:01:00Z", "v15-tiebreak-path");
    db.close();
    assert.equal(store.getLatestFullRunVersion("r"), "v14-release-m");
    assert.equal(store.getLatestFullRunVersion("other"), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 F2: a dirty path that stays unreadable stops forcing runs after N checks, and the answer still reports it", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const bad = "bad\0name.ts"; // stat throws a non-ENOENT error: keyed UNREADABLE
  try {
    h.setTree({ head: "aaa111", dirty: [bad] });
    for (let i = 0; i < 3; i++) await h.gate.ensureFresh("r");
    const settled = h.runs.length;
    assert.ok(settled >= 1 && settled <= 3, `${String(settled)} runs while the path was being given up on`);
    for (let i = 0; i < 4; i++) {
      const note = await h.gate.ensureFresh("r");
      assert.equal(note.state, "fresh");
      assert.deepEqual(note.unreadable, [bad]);
    }
    assert.equal(h.runs.length, settled, "a capped path starts no further run");
    const answer = applyFreshness({ coverage: { confidence: "high", knownGaps: [] } }, await h.gate.ensureFresh("r")) as { coverage: { knownGaps: string[] }; freshness: { unreadable: string[] } };
    assert.match(answer.coverage.knownGaps[0] ?? "", /could not be read/);
    assert.deepEqual(answer.freshness.unreadable, [bad]);
    // another dirty file still triggers its run
    h.setTree({ head: "aaa111", dirty: [bad, "ok.ts"] });
    writeFileSync(path.join(h.lockDir, "ok.ts"), "x");
    await h.gate.ensureFresh("r");
    assert.equal(h.runs.length, settled + 1);
    assert.deepEqual(h.runs.at(-1)?.dirtyPaths, ["ok.ts"]);
  } finally { h.cleanup(); }
});

test("run markers are matched per exact repoId: `a` does not see the run of `a-b`, and an old-form marker still counts for its repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-markers-"));
  try {
    const live = { pid: process.pid, at: Date.now() };
    writeFileSync(path.join(dir, `running-a-b-${String(process.pid)}-1.json`), JSON.stringify({ ...live, repoId: "a-b" }));
    assert.deepEqual(liveRunMarkers(dir, "a", 60_000, Date.now()), []);
    assert.equal(liveRunMarkers(dir, "a-b", 60_000, Date.now()).length, 1);
    // written before markers named their repo: matched on the name alone
    writeFileSync(path.join(dir, `running-a-${String(process.pid)}-2.json`), JSON.stringify(live));
    assert.equal(liveRunMarkers(dir, "a", 60_000, Date.now()).length, 1);
    assert.equal(liveRunMarkers(dir, "a-b", 60_000, Date.now()).length, 1);
    // two ids that sanitize to one name: the marker's own repoId decides, and the other repo's file is left alone
    writeFileSync(path.join(dir, `running-x_y-${String(process.pid)}-3.json`), JSON.stringify({ ...live, repoId: "x/y" }));
    assert.deepEqual(liveRunMarkers(dir, "x y", 60_000, Date.now()), []);
    assert.equal(liveRunMarkers(dir, "x/y", 60_000, Date.now()).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a live run of `a-b` does not make the gate of `a` answer refreshing", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    writeFileSync(path.join(h.lockDir, `running-a-b-${String(process.pid)}-1.json`), JSON.stringify({ pid: process.pid, at: Date.now(), repoId: "a-b" }));
    assert.deepEqual(await h.gate.ensureFresh("a"), { state: "fresh" });
    assert.equal((await h.gate.ensureFresh("a-b")).state, "refreshing");
  } finally { h.cleanup(); }
});
