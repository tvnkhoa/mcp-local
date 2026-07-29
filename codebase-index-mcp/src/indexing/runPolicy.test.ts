import assert from "node:assert/strict";
import test from "node:test";

import type { GraphStore } from "../graphStore.js";
import { evaluateIncrementalSkip, resolvePerformanceProfileDecision } from "./runPolicy.js";

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
}): GraphStore {
  return {
    getLatestRun: () => parts.latestRun ?? null,
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
