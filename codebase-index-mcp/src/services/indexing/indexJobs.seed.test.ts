import assert from "node:assert/strict";
import test from "node:test";

import { runWithSeed, type IndexJobProgress, type IndexJobRequest, type SeedStepDeps } from "./indexJobs.js";
import { SeedError } from "../../repositories/seedStore.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";

/**
 * IX-9 (U3): register_worktree's job seeds from the parent's index only when the parent's indexed commit is an
 * ancestor of the worktree's HEAD; every refusal or failure runs full in the same job with a named fallbackReason.
 * `seed` is a stub with the seedStore contract's signature; SeedError is the store's own.
 */

const request = (seedFrom?: string): IndexJobRequest => ({
  repoId: "wt", repoPath: "/r/wt", mode: "incremental", docsEnabled: true, maxFiles: 100, batchSize: 50, source: "register_worktree",
  ...(seedFrom && { seedFrom })
});


function harness(over: Partial<SeedStepDeps> & { runStatus?: (mode: IndexMode, n: number) => string } = {}) {
  const runs: IndexMode[] = [];
  const progress: IndexJobProgress[] = [];
  const seeds: unknown[] = [];
  const purged: string[] = [];
  const deps: SeedStepDeps = {
    parentIndexedSha: () => "p".repeat(40),
    childHasIndex: () => false,
    ancestry: (_path, sha) => ({ ok: true, parentSha: sha ?? "", childSha: "c".repeat(40) }),
    seed: (req) => { seeds.push(req); return { parentIndexedSha: "p".repeat(40), tablesCopied: { symbols: 3 }, durationMs: 1 }; },
    run: async (mode) => {
      runs.push(mode);
      return { status: over.runStatus?.(mode, runs.length) ?? "ok", mode } as unknown as IndexRunResult;
    },
    purgeChild: (id) => { purged.push(id); },
    onProgress: (p) => progress.push(p),
    ...over
  };
  return { deps, runs, progress, seeds, purged };
}

test("IX-9: no seedFrom → the plain run in the requested mode", async () => {
  const h = harness();
  const out = await runWithSeed(request(), h.deps);
  assert.deepEqual(h.runs, ["incremental"]);
  assert.equal(out.seeded, false);
  assert.equal(out.fallbackReason, undefined);
  assert.equal(h.seeds.length, 0);
});

test("IX-9: an already indexed child runs its normal incremental, no seed, no fallback", async () => {
  const h = harness({ childHasIndex: () => true });
  const out = await runWithSeed(request("parent"), h.deps);
  assert.deepEqual(h.runs, ["incremental"]);
  assert.equal(out.fallbackReason, undefined);
  assert.equal(h.seeds.length, 0);
});

test("IX-9: ancestor ok → phase seed, seedFromParent with the contract's request, then incremental", async () => {
  const h = harness();
  const out = await runWithSeed(request("parent"), h.deps);
  assert.deepEqual(h.seeds, [{ parentRepoId: "parent", childRepoId: "wt", childRepoPath: "/r/wt" }]);
  assert.deepEqual(h.runs, ["incremental"]);
  assert.equal(out.seeded, true);
  assert.equal(out.fallbackReason, undefined);
  assert.deepEqual(h.progress.map((p) => p.phase), ["seed", "incremental (after seed)"]);
});

test("IX-9: ancestry refused → full, fallbackReason reported, no seed attempted", async () => {
  const h = harness({ ancestry: () => ({ ok: false, fallbackReason: "parent_not_ancestor", parentSha: "p", childSha: "c" }) });
  const out = await runWithSeed(request("parent"), h.deps);
  assert.deepEqual(h.runs, ["full"]);
  assert.equal(out.fallbackReason, "parent_not_ancestor");
  assert.equal(h.progress[0]?.fallbackReason, "parent_not_ancestor");
  assert.equal(h.seeds.length, 0);
});

test("IX-9: the parent's indexed sha reaches the ancestry check", async () => {
  let seen: string | null = "unset";
  const h = harness({
    parentIndexedSha: () => null,
    ancestry: (_p, sha) => { seen = sha; return { ok: false, fallbackReason: "parent_not_indexed", parentSha: null, childSha: null }; }
  });
  const out = await runWithSeed(request("parent"), h.deps);
  assert.equal(seen, null);
  assert.equal(out.fallbackReason, "parent_not_indexed");
});

test("IX-9: SeedError{code} → full with seed_<code>", async () => {
  for (const code of ["PARENT_NOT_INDEXED", "SCHEMA_UNHANDLED", "COPY_FAILED"] as const) {
    const h = harness({ seed: () => { throw new SeedError(code, code); } });
    const out = await runWithSeed(request("parent"), h.deps);
    assert.deepEqual(h.runs, ["full"]);
    assert.equal(out.fallbackReason, `seed_${code.toLowerCase()}`);
    assert.deepEqual(h.purged, ["wt"], "a seed error clears the child: the vector step runs after the copy commits");
  }
  const h = harness({ seed: () => { throw new Error("boom"); } });
  assert.equal((await runWithSeed(request("parent"), h.deps)).fallbackReason, "seed_failed");
});

test("IX-9: incremental after the seed fails (status or throw) → purge the child, then full", async () => {
  const failing = harness({ runStatus: (mode) => (mode === "incremental" ? "failed" : "ok") });
  const out = await runWithSeed(request("parent"), failing.deps);
  assert.deepEqual(failing.runs, ["incremental", "full"]);
  assert.deepEqual(failing.purged, ["wt"]);
  assert.equal(out.fallbackReason, "incremental_after_seed_failed");
  assert.equal(out.seeded, false);
  assert.ok(out.seed, "the seed result is still reported");

  const runs: IndexMode[] = [];
  const throwing = harness({
    run: async (mode) => { runs.push(mode); if (mode === "incremental") throw new Error("worker died"); return { status: "ok" } as unknown as IndexRunResult; }
  });
  const out2 = await runWithSeed(request("parent"), throwing.deps);
  assert.deepEqual(runs, ["incremental", "full"]);
  assert.equal(out2.fallbackReason, "incremental_after_seed_failed");
});
