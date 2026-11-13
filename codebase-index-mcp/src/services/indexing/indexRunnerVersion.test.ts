import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";
import { INDEX_VERSION } from "./indexPipeline.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";

/**
 * MCP-ISSUE-130: after an INDEX_VERSION change, a scoped run (incremental, dirty, or one the freshness gate starts)
 * skipped every file whose content hash was unchanged, so those files kept the older build's extraction (wec.aria run
 * 339b6b3a, v15 → v16, ran incremental in ~35 s). The runner now escalates it to ONE full run, says why in the run's
 * scope, and the next run is scoped again.
 */

const OLD_VERSION = "v15-tiebreak-path";

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-ver-"));
  const files: Record<string, string> = {
    "src/a.ts": "export function versionAlpha(): number {\n  return 1;\n}\n",
    "src/b.ts": "import { versionAlpha } from './a';\nexport const b = versionAlpha();\n"
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function index(dbPath: string, repoPath: string, mode: IndexMode): Promise<IndexRunResult> {
  const store = new GraphStore(dbPath);
  try {
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    return await run("r", repoPath.replace(/\\/g, "/"), mode, true, 1000, 50);
  } finally {
    store.close();
  }
}

/** Rewrite the recorded runs as an older build would have left them. */
function ageRuns(dbPath: string, sql: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(sql).run();
  } finally {
    db.close();
  }
}

function withRepo(fn: (repo: string, dbPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const repo = makeRepo();
    const work = mkdtempSync(path.join(tmpdir(), "cim-ver-db-"));
    try {
      await fn(repo, path.join(work, "index.db"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  };
}

for (const mode of ["incremental", "dirty"] as const) {
  test(
    `MCP-ISSUE-130: an index last fully built by an older INDEX_VERSION turns a ${mode} run into ONE full run with the reason; the next run keeps its mode`,
    withRepo(async (repo, dbPath) => {
      assert.equal((await index(dbPath, repo, "full")).mode, "full");
      ageRuns(dbPath, `update index_runs set index_version = '${OLD_VERSION}' where repo_id = 'r'`);
      // A dirty run needs a dirty file to have work; an incremental one has none (same HEAD, clean tree) and would skip.
      if (mode === "dirty") writeFileSync(path.join(repo, "src/a.ts"), "export function versionAlpha(): number {\n  return 2;\n}\n");

      const escalated = await index(dbPath, repo, mode);
      assert.equal(escalated.mode, "full", `${mode}: ran full`);
      assert.equal(escalated.indexVersion, INDEX_VERSION);
      assert.match(escalated.scope ?? "", new RegExp(`^full \\(the index was last fully built by ${OLD_VERSION}; this server runs ${INDEX_VERSION}.*; ${mode} requested\\)$`));
      assert.equal(escalated.filesIndexed, 2, `${mode}: unchanged files re-extracted too`);

      const next = await index(dbPath, repo, mode);
      assert.equal(next.mode, mode, `${mode}: the next run is scoped again`);
    })
  );
}

test(
  "MCP-ISSUE-130: a v16 scoped run on top of a v15 full run does not hide the mismatch (wec.aria 339b6b3a)",
  withRepo(async (repo, dbPath) => {
    await index(dbPath, repo, "full");
    ageRuns(dbPath, `update index_runs set index_version = '${OLD_VERSION}' where repo_id = 'r'`);
    // The latest run carries this build's version, as the defective incremental run recorded.
    ageRuns(
      dbPath,
      `insert into index_runs (run_id, repo_id, mode, status, started_at, finished_at, files_scanned, files_indexed, files_skipped,
         symbols_upserted, edges_upserted, parse_failures, elapsed_ms, index_version, commit_sha)
       select 'scoped-v16', repo_id, 'incremental', 'ok', '2999-01-01T00:00:00Z', '2999-01-01T00:00:01Z', 0, 0, 0, 0, 0, 0, 0, '${INDEX_VERSION}', commit_sha
       from index_runs where repo_id = 'r' limit 1`
    );
    const run = await index(dbPath, repo, "incremental");
    assert.equal(run.mode, "full");
    assert.match(run.scope ?? "", /last fully built by v15-tiebreak-path/);
  })
);

test(
  "MCP-ISSUE-130: a repo with runs but no full run on record escalates once, not on every run",
  withRepo(async (repo, dbPath) => {
    await index(dbPath, repo, "full");
    ageRuns(dbPath, `update index_runs set mode = 'incremental' where repo_id = 'r'`);
    const first = await index(dbPath, repo, "incremental");
    assert.equal(first.mode, "full");
    assert.match(first.scope ?? "", /^full \(no full run of this repo is on record; /);
    const second = await index(dbPath, repo, "incremental");
    assert.equal(second.mode, "incremental", "the full run it became is the base now");
  })
);

test(
  "MCP-ISSUE-130: same INDEX_VERSION — an incremental run is unchanged (no escalation)",
  withRepo(async (repo, dbPath) => {
    await index(dbPath, repo, "full");
    writeFileSync(path.join(repo, "src/c.ts"), "export const c = 3;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "c");
    const run = await index(dbPath, repo, "incremental");
    assert.equal(run.mode, "incremental");
    assert.doesNotMatch(run.scope ?? "", /^full \(/);
  })
);
