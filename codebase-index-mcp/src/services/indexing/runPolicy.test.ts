import assert from "node:assert/strict";
import test from "node:test";

import type { GraphStore } from "../../repositories/graphStore.js";
import type { WorkRunTrace } from "../../repositories/runStore.js";
import type { NameStatusEntry } from "../git/gitHelpers.js";
import {
  BULK_RESOLVE_INDEX_DROP_MIN_EDGE_SHARE,
  BULK_RESOLVE_INDEX_DROP_MIN_ROWS,
  evaluateIncrementalSkip,
  indexGeneration,
  newerBuildRefusal,
  planGitScopedIncremental,
  resolvePerformanceProfileDecision,
  shouldDropEdgeIndexesForResolve,
  type GitScopeInputs
} from "./runPolicy.js";
import { currentAnnotationKey, INDEX_VERSION } from "./indexPipeline.js";
import { repoEdgeShare } from "./indexRunner.js";

/**
 * The decisions a run makes before doing any work.
 *
 * Worth unit-testing precisely because they are cheap to get wrong and expensive to notice: a
 * skip that fires when it should not leaves a stale graph that every later answer is derived
 * from, and the wrong performance profile silently changes which edges get resolved.
 *
 * S-26 made `store` an explicit parameter instead of a module global, which is what allows a stub
 * here — no SQLite file, no parser pool.
 */

/** Only the two reads these functions perform. Cast because the real store is far larger. */
function stubStore(parts: {
  latestRun?: { commitSha?: string | null; indexVersion?: string } | null;
  snapshot?: { fileCount: number; symbolCount: number };
  latestWorkMode?: string | null;
  latestWorkTreeDirty?: boolean;
  annotationKey?: string | null;
}): GraphStore {
  return {
    getLatestRun: () => parts.latestRun ?? null,
    getLatestWorkRunMode: () => parts.latestWorkMode ?? null,
    getLatestWorkRunTreeDirty: () => parts.latestWorkTreeDirty ?? false,
    // An annotation key that matches a repo with no citations.json, so these tests reach the git checks.
    getAnnotationKey: () => parts.annotationKey === undefined ? currentAnnotationKey("/nowhere") : parts.annotationKey,
    getRepoSchemaSnapshot: () => parts.snapshot ?? { fileCount: 0, symbolCount: 0 }
  } as unknown as GraphStore;
}

// --- evaluateIncrementalSkip -------------------------------------------------
// Only the branches that need no git are asserted here; the git-dependent ones belong to the
// integration harnesses, which have a real repository to point at.

test("never skips when there is no previously indexed commit", () => {
  const decision = evaluateIncrementalSkip(stubStore({ latestRun: null }), "repo", "/nowhere");
  assert.equal(decision.shouldSkip, false);
  assert.equal(decision.reason, "no previous indexed commit");
});

test("never skips when the last run recorded no commit sha", () => {
  const store = stubStore({ latestRun: { commitSha: null, indexVersion: "v1" } });
  assert.equal(evaluateIncrementalSkip(store, "repo", "/nowhere").shouldSkip, false);
});

test("an index-version change defeats the skip even when HEAD is unchanged", () => {
  // ISSUE-023: without this, a repo indexed under an older schema would never populate a new lane
  // — the skip would fire forever because the commit really has not moved.
  const store = stubStore({ latestRun: { commitSha: "abc123", indexVersion: "v0-ancient" } });
  const decision = evaluateIncrementalSkip(store, "repo", "/nowhere");
  assert.equal(decision.shouldSkip, false);
  assert.match(decision.reason, /index version changed/);
});

test("cannot skip when HEAD is unresolvable", () => {
  // A path that is not a git repository: the decision must fail safe toward doing the work.
  const store = stubStore({ latestRun: { commitSha: "abc123" } });
  const decision = evaluateIncrementalSkip(store, "repo", "/definitely/not/a/repo");
  assert.equal(decision.shouldSkip, false);
});

// --- resolvePerformanceProfileDecision --------------------------------------

test("an explicit profile overrides everything and is reported as env-sourced", () => {
  const store = stubStore({ snapshot: { fileCount: 99_999, symbolCount: 99_999 } });
  const decision = resolvePerformanceProfileDecision(store, "standard", "repo", "full", 20_000);
  assert.equal(decision.profile, "standard");
  assert.equal(decision.source, "env");
  assert.equal(decision.reason, "explicit override");
});

test("cold start: a full run with high maxFiles starts large, otherwise standard", () => {
  const cold = stubStore({ snapshot: { fileCount: 0, symbolCount: 0 } });
  assert.deepEqual(
    { ...resolvePerformanceProfileDecision(cold, "auto", "repo", "full", 8_000) },
    { profile: "large", source: "auto", reason: "cold-start full index with high maxFiles", fileCount: 0, symbolCount: 0 }
  );
  assert.equal(resolvePerformanceProfileDecision(cold, "auto", "repo", "full", 7_999).profile, "standard");
  assert.equal(resolvePerformanceProfileDecision(cold, "auto", "repo", "incremental", 20_000).profile, "standard");
});

test("auto thresholds are exact, and either file or symbol count can trip them", () => {
  const at = (fileCount: number, symbolCount: number) =>
    resolvePerformanceProfileDecision(
      stubStore({ snapshot: { fileCount, symbolCount } }),
      "auto",
      "repo",
      "full",
      20_000
    ).profile;

  // Boundaries pinned on both sides: an off-by-one here changes which edges get resolved.
  assert.equal(at(8_000, 1), "very-large");
  assert.equal(at(1, 60_000), "very-large");
  assert.equal(at(7_999, 59_999), "large");
  assert.equal(at(3_000, 1), "large");
  assert.equal(at(1, 20_000), "large");
  assert.equal(at(2_999, 19_999), "standard");
  assert.equal(at(1, 1), "standard");
});

test("never skips after a dirty run: the index holds working-tree content a clean tree no longer has", async () => {
  // wec.aria, release-B acceptance: an untracked file indexed by a dirty run, then deleted, left a
  // clean tree at the indexed commit — and the fast skip kept the phantom symbol forever.
  const { INDEX_VERSION } = await import("./indexPipeline.js");
  const store = stubStore({ latestRun: { commitSha: "abc", indexVersion: INDEX_VERSION }, latestWorkMode: "dirty" });
  const decision = evaluateIncrementalSkip(store, "repo", "/nowhere");
  assert.equal(decision.shouldSkip, false);
  assert.match(decision.reason, /working-tree content/);
});

test("release L: never skips after a full or incremental run that indexed a dirty tree", async () => {
  // MCP-ISSUE-095, wec.aria conformance `sql-supersede`: an incremental run indexed an untracked migration; once it
  // was deleted the tree was clean at the indexed commit, and the next incremental run fast-skipped over it.
  const { INDEX_VERSION } = await import("./indexPipeline.js");
  const store = stubStore({ latestRun: { commitSha: "abc", indexVersion: INDEX_VERSION }, latestWorkMode: "incremental", latestWorkTreeDirty: true });
  const decision = evaluateIncrementalSkip(store, "repo", "/nowhere");
  assert.equal(decision.shouldSkip, false);
  assert.match(decision.reason, /working-tree content/);
});

test("never skips when the stored annotation scan differs from the current one", async () => {
  const { INDEX_VERSION } = await import("./indexPipeline.js");
  const store = stubStore({ latestRun: { commitSha: "abc", indexVersion: INDEX_VERSION }, annotationKey: null });
  const decision = evaluateIncrementalSkip(store, "repo", "/nowhere");
  assert.equal(decision.shouldSkip, false);
  assert.match(decision.reason, /citation patterns or the annotation scanner/);
});

test("release F: an older build refuses to write over a newer build, never the other way", () => {
  assert.equal(indexGeneration("v7-text-json-html-svg"), 7);
  assert.equal(indexGeneration("weird"), null);
  const refusal = newerBuildRefusal("v7-text-json-html-svg", "v6-vue-components") ?? "";
  assert.ok(refusal.includes("newer codebase-index build (v7-text-json-html-svg); this server runs v6-vue-components"), refusal);
  assert.equal(newerBuildRefusal("v6-vue-components", "v7-text-json-html-svg"), null, "a newer build upgrades an older index");
  assert.equal(newerBuildRefusal("v7-a", "v7-b"), null, "same generation");
  assert.equal(newerBuildRefusal(null, "v7-a"), null, "no run yet");
  // Release G (R9, MCP-ISSUE-081) was generation 8; release H (MCP-ISSUE-082, the SQL lane) 9; release
  // I (I6b one literal cap, I3/I4 one current SQL definition + imported query consts) is 10; release J
  // (no vector fallback, canonical mention and SQL order, MCP-ISSUE-084/085) was 11; release K (ambiguous
  // doc mentions keep no pick, MCP-ISSUE-089) was 12; release L (superseded SQL mention candidates, the EF
  // snapshot lane, MCP-ISSUE-090/092) was 13; release M (sql_drop sites, the EF migration Sql lane, enriched index
  // signatures) was 14; MCP-ISSUE-101 part 4 (ties break on the file path) was 15; the tree-sitter Python
  // lane (PY-1..PY-4) is 16.
  assert.equal(indexGeneration(INDEX_VERSION), 16);
  assert.equal(newerBuildRefusal("v15-tiebreak-path", INDEX_VERSION), null, "v16 upgrades a v15 index");
  assert.ok((newerBuildRefusal(INDEX_VERSION, "v15-tiebreak-path") ?? "").includes(INDEX_VERSION), "a v15 build refuses to write over a v16 index");
});

test("release I1b: only a full run or a bulk resolve drops the DB-wide edge indexes", () => {
  assert.equal(shouldDropEdgeIndexesForResolve("full", 0), true, "full runs keep the bulk-write optimisation");
  // A wec.aria dirty run resolves ~6 000 call rows; dropping the indexes made every concurrent reader
  // full-scan `edges` and cost more to rebuild than it saved.
  assert.equal(shouldDropEdgeIndexesForResolve("dirty", 6_000), false);
  assert.equal(shouldDropEdgeIndexesForResolve("incremental", BULK_RESOLVE_INDEX_DROP_MIN_ROWS - 1), false);
  assert.equal(shouldDropEdgeIndexesForResolve("incremental", BULK_RESOLVE_INDEX_DROP_MIN_ROWS), true);
});

test("MCP-ISSUE-122 (F-d): the edge indexes are dropped only when this repo holds most of the DB's edges", () => {
  const share = BULK_RESOLVE_INDEX_DROP_MIN_EDGE_SHARE;
  assert.equal(share, 0.5);
  // At the threshold: dropped as before (a fresh or single-repo DB is share 1).
  assert.equal(shouldDropEdgeIndexesForResolve("full", 0, share), true);
  assert.equal(shouldDropEdgeIndexesForResolve("full", 0, 1), true, "a single-repo DB keeps the bulk-write optimisation");
  assert.equal(shouldDropEdgeIndexesForResolve("incremental", BULK_RESOLVE_INDEX_DROP_MIN_ROWS, share), true);
  // Just below: kept, whatever the mode or row count — wec.aria on the live DB is 6%.
  assert.equal(shouldDropEdgeIndexesForResolve("full", 0, share - 0.001), false);
  assert.equal(shouldDropEdgeIndexesForResolve("full", 0, 0.064), false, "wec.aria on the 14-repo live DB");
  assert.equal(shouldDropEdgeIndexesForResolve("incremental", BULK_RESOLVE_INDEX_DROP_MIN_ROWS, share - 0.001), false);
  // The share never turns a drop ON that the mode and row count did not call for.
  assert.equal(shouldDropEdgeIndexesForResolve("dirty", 6_000, 1), false);
});

test("MCP-ISSUE-122 (F-d): repoEdgeShare counts every repo's edges, answers 1 alone or on a failed read", () => {
  const edges: Record<string, number> = { a: 60, b: 30, c: 10 };
  const store = (ids: string[]) => ({
    listRepositories: () => ids.map((repoId) => ({ repoId })) as ReturnType<GraphStore["listRepositories"]>,
    getRepoSchemaSnapshot: (repoId: string) => ({ edgeCount: edges[repoId] ?? 0 }) as ReturnType<GraphStore["getRepoSchemaSnapshot"]>
  });
  assert.equal(repoEdgeShare(store(["a", "b", "c"]), "a"), 0.6);
  assert.equal(repoEdgeShare(store(["a", "b", "c"]), "c"), 0.1);
  assert.equal(repoEdgeShare(store(["b", "c"]), "a"), 0.6, "a repo not yet listed still counts its own edges");
  assert.equal(repoEdgeShare(store(["a"]), "a"), 1, "alone in the DB");
  assert.equal(repoEdgeShare(store([]), "a"), 1, "first run on a fresh DB");
  const failing = { listRepositories: () => { throw new Error("SQLITE_BUSY"); }, getRepoSchemaSnapshot: () => { throw new Error("x"); } };
  assert.equal(repoEdgeShare(failing, "a"), 1, "a failed read keeps the old behaviour");
});

// ── IX-9 (MCP-ISSUE-119): a seed row is a base for the git-scoped incremental ──

const seedRun = (over: Partial<WorkRunTrace> = {}): WorkRunTrace => ({
  mode: "seed",
  status: "ok",
  startedAt: "2026-11-05T00:00:00.000Z",
  finishedAt: "2026-11-05T00:00:00.000Z",
  commitSha: "a".repeat(40),
  indexVersion: INDEX_VERSION,
  treeKey: JSON.stringify({ head: "a".repeat(40), files: {} }),
  treeDirty: false,
  excludeRules: "{}",
  ...over
});

const seedInputs = (runs: WorkRunTrace[], diff: NameStatusEntry[] = []): GitScopeInputs => ({
  runs,
  headSha: "f".repeat(40),
  diffSince: () => diff,
  dirtyNow: [],
  pending: [],
  gitScan: true,
  excludeRulesNow: "{}",
  excludeRulesChangedSince: () => null,
  annotationKeyCurrent: true
});

test("IX-9: a seed run is the base — scoped over parent-commit..HEAD plus the parent's carried dirty paths", () => {
  const carried = JSON.stringify({ head: "a".repeat(40), files: { "src/parentDirty.ts": "h" } });
  const plan = planGitScopedIncremental(seedInputs([seedRun({ treeKey: carried, treeDirty: true })], [{ status: "M", path: "src/a.ts" }]));
  assert.equal(plan.kind, "scoped");
  if (plan.kind !== "scoped") return;
  assert.equal(plan.baseSha, "a".repeat(40));
  assert.deepEqual([...plan.paths].sort(), ["src/a.ts", "src/parentDirty.ts"]);
});

test("IX-9: a seed row at another INDEX_VERSION still walks", () => {
  const plan = planGitScopedIncremental(seedInputs([seedRun({ indexVersion: "v0-old" })]));
  assert.equal(plan.kind, "walk");
});
