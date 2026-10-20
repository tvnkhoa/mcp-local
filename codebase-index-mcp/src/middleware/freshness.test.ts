import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyFreshness, createFreshnessGate, tryAcquireLock, type RepoTreeState } from "./freshness.js";
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
  runs: { mode: IndexMode }[];
  setTree: (t: RepoTreeState) => void;
  setIndexed: (sha: string | null) => void;
  finishRun: () => void;
  triggered: string[];
  lockDir: string;
  cleanup: () => void;
};

function harness(opts: { budgetMs: number; autoFinish?: boolean }): Harness {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let tree: RepoTreeState = { head: "aaa111", dirty: [] };
  let indexed: string | null = "aaa111";
  const runs: { mode: IndexMode }[] = [];
  const triggered: string[] = [];
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
    run: async (_repoId, _repoPath, mode) => {
      runs.push({ mode });
      if (!opts.autoFinish) await new Promise<void>((resolve) => (release = resolve));
      indexed = tree.head;
      return { runId: `run-${String(runs.length)}` } as IndexRunResult;
    }
  });
  return {
    gate,
    runs,
    triggered,
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

    const second = h.gate.ensureFresh("r"); // joins the in-flight run, does not start another
    h.finishRun();
    assert.equal((await second).state, "refreshed");
    assert.equal(h.runs.length, 1, "one run, however many callers");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
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
