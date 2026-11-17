import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { buildRepoResources } from "../../resources/resourceHandler.js";
import { ChangeAnalysisError, computeChangedFileImpacts, computeChangedFileImpactsAsync } from "../../services/impact/changeAnalysis.js";
import { getRepoStaleness, runGitLines } from "../../services/git/gitHelpers.js";
import type { HandlerContext } from "./handlerContext.js";
import { buildIndexMetaWithFreshness } from "./impactHandler.js";
import { handleChangeImpact, handleDetectChanges } from "./indexHandler.js";

/**
 * MCP-ISSUE-134 follow-up: find_impact_files' indexMeta, the context resource, detect_changes and change_impact read
 * HEAD, `git status`, `git diff` and `git rev-list` off the server thread. Same answers as the sync reads; a bad ref
 * still maps to InvalidParams.
 */

function gitIn(dir: string) {
  return (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function tempGitRepo(): { dir: string; git: (...args: string[]) => string; first: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-head-async-"));
  const git = gitIn(dir);
  git("init", "-q");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, "b.txt"), "two\n");
  git("add", ".");
  git("commit", "-qm", "first");
  return { dir, git, first: git("rev-parse", "HEAD") };
}

type Run = { branch: string | null; commitSha: string | null; finishedAt: string };

/** The store surface these reads touch: the repo row, its latest run, and the impact scoring calls. */
function stubStore(repoPath: string | null, run: Run | null) {
  return {
    getRepository: (id: string) => (repoPath && id === "r" ? { repoId: "r", repoPath } : null),
    listRepositories: () => (repoPath ? [{ repoId: "r", repoPath }] : []),
    getLatestRun: (id: string) => (id === "r" ? run : null),
    getImpactFiles: () => ({ impactedFiles: [], totalImpactedCount: 0, truncated: false, graphHealth: {}, reliabilitySummary: {} }),
    getFileHash: () => null,
    findImportersOfRemovedPath: () => []
  } as never;
}

const run = (commitSha: string | null): Run => ({ branch: "main", commitSha, finishedAt: "2026-11-17T00:00:00.000Z" });

// ── find_impact_files indexMeta ────────────────────────────────────────────────

test("indexMeta: clean tree at the indexed commit carries no freshness fields", async () => {
  const { dir, first } = tempGitRepo();
  try {
    assert.deepEqual(await buildIndexMetaWithFreshness(stubStore(dir, run(first)), "r"), { branch: "main", commitSha: first, indexedAt: run(first).finishedAt });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexMeta: a commit past the index and a dirty file give indexLag + dirtyFiles, in the sync field order", async () => {
  const { dir, git, first } = tempGitRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    git("commit", "-qam", "second");
    writeFileSync(path.join(dir, "c.txt"), "new\n");
    const meta = await buildIndexMetaWithFreshness(stubStore(dir, run(first)), "r");
    assert.deepEqual(meta, { branch: "main", commitSha: first, indexedAt: run(first).finishedAt, dirtyFiles: ["c.txt"], indexLag: { dirtyCount: 1, commitsBehind: 1 } });
    assert.deepEqual(Object.keys(meta ?? {}), ["branch", "commitSha", "indexedAt", "dirtyFiles", "indexLag"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexMeta: a non-git directory and a missing repo row answer like the sync reader (no lag, no error)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-notgit-"));
  try {
    assert.deepEqual(await buildIndexMetaWithFreshness(stubStore(dir, run("0".repeat(40))), "r"), { branch: "main", commitSha: "0".repeat(40), indexedAt: run("").finishedAt });
    assert.equal(await buildIndexMetaWithFreshness(stubStore(dir, null), "r"), null);
    assert.deepEqual(await buildIndexMetaWithFreshness(stubStore(null, run("x")), "r"), { branch: "main", commitSha: "x", indexedAt: run("").finishedAt });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── repo://r/context ───────────────────────────────────────────────────────────

test("context resource: staleness equals the sync getRepoStaleness, stale and fresh", async () => {
  const { dir, git, first } = tempGitRepo();
  try {
    const read = async (store: never) => JSON.parse((await buildRepoResources(store, 100).read("repo://r/context"))?.[0]?.text as string) as { staleness: unknown };
    const fresh = stubStore(dir, run(first));
    assert.deepEqual((await read(fresh)).staleness, getRepoStaleness("r", fresh));
    git("commit", "-q", "--allow-empty", "-m", "second");
    const stale = stubStore(dir, run(first));
    const staleness = (await read(stale)).staleness as { isStale: boolean };
    assert.equal(staleness.isStale, true);
    assert.deepEqual(staleness, JSON.parse(JSON.stringify(getRepoStaleness("r", stale))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk resource: the changed files are runGitLines' (diff vs HEAD), and none outside git", async () => {
  const { dir, first } = tempGitRepo();
  const notGit = mkdtempSync(path.join(tmpdir(), "cim-notgit-"));
  try {
    writeFileSync(path.join(dir, "a.txt"), "edited\n");
    writeFileSync(path.join(dir, "b.txt"), "edited\n");
    const risk = async (store: never) => JSON.parse((await buildRepoResources(store, 100).read("repo://r/risk"))?.[0]?.text as string) as { changedFileCount: number };
    assert.equal((await risk(stubStore(dir, run(first)))).changedFileCount, runGitLines(dir, ["diff", "--name-only", "HEAD"]).length);
    assert.equal((await risk(stubStore(dir, run(first)))).changedFileCount, 2);
    assert.equal((await risk(stubStore(notGit, run(first)))).changedFileCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(notGit, { recursive: true, force: true });
  }
});

// ── detect_changes / change_impact core ────────────────────────────────────────

const coreArgs = (repoPath: string, over: Partial<Parameters<typeof computeChangedFileImpacts>[1]> = {}) => ({
  repoId: "r",
  repoPath,
  headRef: "HEAD",
  includeUntracked: true,
  maxFiles: 100,
  impactLimit: 20,
  indexedCommitSha: null,
  ...over
});

test("change set: working tree, range diff with a rename and untracked files, non-git dir — async equals sync", async () => {
  const { dir, git, first } = tempGitRepo();
  const notGit = mkdtempSync(path.join(tmpdir(), "cim-notgit-"));
  try {
    const store = stubStore(dir, run(first));
    const both = async (args: ReturnType<typeof coreArgs>) => {
      const a = await computeChangedFileImpactsAsync(store, args);
      assert.deepEqual(a, computeChangedFileImpacts(store, args));
      return a;
    };
    // working tree (baseRef = HEAD): staged + unstaged + untracked
    writeFileSync(path.join(dir, "a.txt"), "edited\n");
    writeFileSync(path.join(dir, "u.txt"), "untracked\n");
    const wt = await both(coreArgs(dir, { indexedCommitSha: first }));
    assert.deepEqual(wt.changedFiles.sort(), ["a.txt", "u.txt"]);
    // range diff: a rename committed, an untracked file beside it
    git("checkout", "-q", "--", "a.txt");
    git("mv", "b.txt", "b2.txt");
    git("commit", "-qm", "rename");
    const range = await both(coreArgs(dir, { indexedCommitSha: first }));
    assert.equal(range.note, "using git range diff");
    assert.deepEqual(range.changedFiles.sort(), ["b.txt", "b2.txt", "u.txt"]);
    await both(coreArgs(dir, { baseRef: first, includeUntracked: false }));
    // non-git: working-tree mode reads [] as nothing changed
    assert.deepEqual((await both(coreArgs(notGit))).changedFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(notGit, { recursive: true, force: true });
  }
});

test("change set: an unresolvable baseRef rejects with the same ChangeAnalysisError", async () => {
  const { dir, first } = tempGitRepo();
  try {
    const args = coreArgs(dir, { baseRef: "definitely-not-a-ref-xyz", indexedCommitSha: first });
    let syncMessage = "";
    try {
      computeChangedFileImpacts(stubStore(dir, run(first)), args);
    } catch (e) {
      syncMessage = (e as Error).message;
    }
    await assert.rejects(computeChangedFileImpactsAsync(stubStore(dir, run(first)), args), (e: unknown) => {
      assert.ok(e instanceof ChangeAnalysisError);
      assert.equal(e.code, "UNRESOLVED_REF");
      assert.equal(e.message, syncMessage);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detect_changes and change_impact still map a bad ref to InvalidParams", async () => {
  const { dir, first } = tempGitRepo();
  try {
    const ctx = { store: stubStore(dir, run(first)), asText: (p: unknown) => p } as unknown as HandlerContext;
    const isBadRef = (e: unknown): boolean => e instanceof McpError && e.code === ErrorCode.InvalidParams && /definitely-not-a-ref-xyz/.test(e.message);
    const common = { repoId: "r", baseRef: "definitely-not-a-ref-xyz", headRef: "HEAD", includeUntracked: false, maxFiles: 100, impactLimit: 20, profile: "compact" };
    await assert.rejects(handleDetectChanges({ ...common, policy: "custom", groupBy: "file" }, ctx), isBadRef);
    await assert.rejects(handleChangeImpact({ ...common, testLinkMinScore: 0.7, testLinkMaxCandidates: 5, maxTestsToRun: 20 }, ctx), isBadRef);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the point of the change: nothing sync on the server thread ─────────────────

/**
 * Records every sync fs / child-process call made while `run` is in flight. Patches the CommonJS builtins and
 * re-syncs their ESM named exports, so `import fs from "node:fs"` and `import { execFileSync }` both see the spy.
 */
async function syncCallsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const require = createRequire(import.meta.url);
  const targets: Array<[Record<string, unknown>, string, string]> = [
    [require("node:fs") as Record<string, unknown>, "fs", "readFileSync"],
    [require("node:fs") as Record<string, unknown>, "fs", "readdirSync"],
    [require("node:fs") as Record<string, unknown>, "fs", "statSync"],
    [require("node:fs") as Record<string, unknown>, "fs", "existsSync"],
    [require("node:child_process") as Record<string, unknown>, "child_process", "execFileSync"],
    [require("node:child_process") as Record<string, unknown>, "child_process", "spawnSync"]
  ];
  const calls: string[] = [];
  const originals = targets.map(([mod, , name]) => mod[name]);
  targets.forEach(([mod, label, name], i) => {
    const orig = originals[i] as (...a: unknown[]) => unknown;
    mod[name] = (...a: unknown[]) => {
      calls.push(`${label}.${name}(${String(a[0])}${name.includes("exec") || name.includes("spawn") ? ` ${JSON.stringify(a[1])}` : ""})`);
      return orig(...a);
    };
  });
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    targets.forEach(([mod, , name], i) => {
      mod[name] = originals[i];
    });
    syncBuiltinESMExports();
  }
  return calls;
}

test("no sync fs read or git spawn while indexMeta, the context resource or the change set is read", async () => {
  const { dir, git, first } = tempGitRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    git("commit", "-qam", "second");
    writeFileSync(path.join(dir, "c.txt"), "new\n");
    const store = stubStore(dir, run(first));
    const head = git("rev-parse", "HEAD");
    const calls = await syncCallsDuring(async () => {
      await buildIndexMetaWithFreshness(store, "r");
      await buildRepoResources(store, 100).read("repo://r/context");
      await buildRepoResources(store, 100).read("repo://r/risk");
      await computeChangedFileImpactsAsync(store, coreArgs(dir, { indexedCommitSha: first }));
      await computeChangedFileImpactsAsync(store, coreArgs(dir, { indexedCommitSha: head }));
    });
    assert.deepEqual(calls, []);
    // The spy is live: the sync reader is caught by it.
    const syncCalls = await syncCallsDuring(async () => computeChangedFileImpacts(store, coreArgs(dir, { indexedCommitSha: first })));
    assert.ok(syncCalls.length > 0, "the spy sees the sync reader's calls");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
