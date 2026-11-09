import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";
import type { IndexMode, IndexRunResult, IndexRunSummary } from "../../types/index.js";

/**
 * MCP-ISSUE-122 (F-b): `index_runs.finished_at` was stamped when the pipeline's extract phase ended and never moved,
 * so finished − started was `extractPhaseMs` while `elapsedMs` covered the whole run (a 103 s run read as 54 s). The
 * run is now stamped when it is recorded, at the same instant as `elapsedMs`.
 */

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-finished-"));
  // Enough files and calls that the post-phase (resolve, FTS, dedup) takes measurable time.
  for (let i = 0; i < 40; i++) {
    const rel = `src/m${String(i)}.ts`;
    const prev = i > 0 ? `import { f${String(i - 1)} } from './m${String(i - 1)}';\n` : "";
    const call = i > 0 ? `  return f${String(i - 1)}() + ${String(i)};\n` : "  return 0;\n";
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), `${prev}export function f${String(i)}(): number {\n${call}}\n`);
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function index(store: GraphStore, repoPath: string, mode: IndexMode): Promise<IndexRunResult> {
  const run = createIndexRunner({
    store,
    limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
    resolvePerformanceProfileOverride: () => "standard"
  });
  return await run("r", repoPath.replace(/\\/g, "/"), mode, true, 1000, 50);
}

test("MCP-ISSUE-122: finished_at is stamped when the run is recorded — after the post-phase, consistent with elapsedMs", async () => {
  const repo = makeRepo();
  const work = mkdtempSync(path.join(tmpdir(), "cim-finished-db-"));
  const store = new GraphStore(path.join(work, "g.db"));
  try {
    const before = Date.now();
    const result = (await index(store, repo, "full")) as IndexRunSummary;
    const after = Date.now();
    assert.equal(result.status, "ok");
    const recorded = store.getLatestRun("r");
    assert.ok(recorded, "the run is recorded");
    assert.equal(recorded.finishedAt, result.finishedAt, "the recorded row and the returned summary agree");

    const started = Date.parse(result.startedAt);
    const finished = Date.parse(result.finishedAt);
    assert.ok(started >= before - 1 && finished <= after + 1, "both stamps lie inside the call");
    const extract = result.extractPhaseMs ?? 0;
    const resolve = result.resolvePhaseMs ?? 0;
    assert.ok(resolve >= 3, `the fixture needs a measurable post-phase to tell the two stamps apart (resolvePhaseMs=${String(resolve)})`);
    // The old stamp was taken at startedAt + extractPhaseMs exactly; the post-phase comes after it. ISO strings carry
    // milliseconds, so allow 2 ms of rounding.
    assert.ok(
      finished - started >= extract + resolve - 2,
      `finished − started (${String(finished - started)} ms) covers extract (${String(extract)}) + resolve (${String(resolve)})`
    );
    // elapsedMs runs from the runner's clock, which starts no later than the pipeline's startedAt.
    assert.ok(finished - started <= result.elapsedMs + 2, `finished − started (${String(finished - started)}) ≤ elapsedMs (${String(result.elapsedMs)})`);
  } finally {
    store.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
