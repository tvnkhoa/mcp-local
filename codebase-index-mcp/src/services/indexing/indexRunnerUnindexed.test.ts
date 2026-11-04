import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner, isUnindexed } from "./indexRunner.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";

/**
 * MCP-ISSUE-113 (IX-3a): a repoId with no index goes straight to a full run. Before, the default incremental run
 * extracted every file as new, met tsconfig.json / package.json / citations.json among them and escalated to full:
 * the repo was indexed twice (98 s for a wec.aria worktree).
 */

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-unidx-"));
  const files: Record<string, string> = {
    "package.json": '{ "name": "fixture", "version": "1.0.0" }\n',
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    ".codebase-index/citations.json": '{ "patterns": [] }\n',
    "src/a.ts": "export function unindexedAlpha(): number {\n  return 1;\n}\n",
    "src/b.ts": "import { unindexedAlpha } from './a';\nexport const b = unindexedAlpha();\n"
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

async function index(dbPath: string, repoPath: string, mode: IndexMode, runId?: string): Promise<IndexRunResult> {
  const store = new GraphStore(dbPath);
  try {
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    return await run("r", repoPath.replace(/\\/g, "/"), mode, true, 1000, 50, runId ? { runId } : {});
  } finally {
    store.close();
  }
}

test("MCP-ISSUE-113: an incremental or dirty run of a repoId with no index is ONE full run, recorded under the given runId", async () => {
  for (const mode of ["incremental", "dirty"] as const) {
    const repo = makeRepo();
    const work = mkdtempSync(path.join(tmpdir(), "cim-unidx-db-"));
    const dbPath = path.join(work, "index.db");
    try {
      if (mode === "dirty") writeFileSync(path.join(repo, "src/a.ts"), "export function unindexedAlpha(): number {\n  return 2;\n}\n");
      const result = await index(dbPath, repo, mode, `run-${mode}`);
      assert.equal(result.mode, "full", `${mode}: ran full`);
      assert.match(result.scope ?? "", /^full \(no index yet for this repoId; /, `${mode}: says why`);
      assert.doesNotMatch(result.scope ?? "", /escalated/, `${mode}: no escalation`);
      assert.equal(result.runId, `run-${mode}`);
      const db = new Database(dbPath, { readonly: true });
      try {
        const runs = db.prepare("select run_id, mode from index_runs where repo_id = 'r'").all() as { run_id: string; mode: string }[];
        assert.deepEqual(runs, [{ run_id: `run-${mode}`, mode: "full" }], `${mode}: one run recorded, not a thrown-away scoped pass and a full one`);
        assert.ok((db.prepare("select count(*) as n from symbols where repo_id = 'r' and name = 'unindexedAlpha'").get() as { n: number }).n === 1);
      } finally {
        db.close();
      }
      // Once indexed, a later incremental run is scoped (or skipped) as before.
      const next = await index(dbPath, repo, "incremental");
      assert.equal(next.mode, "incremental", `${mode}: the next run keeps its mode`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("MCP-ISSUE-113: isUnindexed needs both no run and no file", () => {
  assert.equal(isUnindexed({ getLatestRun: () => null, listIndexedFiles: () => [] }, "r"), true);
  assert.equal(isUnindexed({ getLatestRun: () => null, listIndexedFiles: () => [{ path: "a.ts", language: "typescript" }] }, "r"), false);
  assert.equal(isUnindexed({ getLatestRun: () => ({ runId: "x" }) as never, listIndexedFiles: () => [] }, "r"), false);
});
