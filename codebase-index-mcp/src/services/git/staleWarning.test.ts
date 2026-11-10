import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { GraphStore } from "../../repositories/graphStore.js";
import { buildStaleWarning } from "./gitHelpers.js";

/** MCP-ISSUE-123: buildStaleWarning's git lookups run off the server thread, with the same output as before. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

function commit(dir: string, file: string, body: string): string {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", body);
  return git(dir, "rev-parse", "HEAD");
}

function fakeStore(repoPath: string | null, indexedSha: string | null | undefined): GraphStore {
  return {
    getRepository: () => (repoPath ? { repoId: "r", repoPath } : null),
    getLatestRun: () => (indexedSha === undefined ? null : { commitSha: indexedSha })
  } as unknown as GraphStore;
}

const HINT = "line numbers may be off";

test("MCP-ISSUE-123: buildStaleWarning yields the event loop and keeps its output", async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cim-stale-warn-"));
  try {
    const repo = path.join(root, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    const c1 = commit(repo, "a.txt", "one\n");
    commit(repo, "a.txt", "two\n");
    const c3 = commit(repo, "a.txt", "three\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n"); // modified
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n"); // untracked

    // Probe: count event-loop turns while the warning is being built. The synchronous version held the
    // thread for both git calls, so no turn ran before its value was ready.
    let turns = 0;
    let probing = true;
    const spin = (): void => { if (probing) { turns++; setImmediate(spin); } };
    setImmediate(spin);
    let warning: Awaited<ReturnType<typeof buildStaleWarning>>;
    try {
      const pending = buildStaleWarning("r", fakeStore(repo, c1), HINT);
      assert.ok(pending instanceof Promise, "buildStaleWarning returns a Promise");
      warning = await pending;
    } finally {
      probing = false;
    }
    assert.ok(turns > 0, `the event loop turned while git ran (turns=${turns})`);

    assert.deepEqual(warning, {
      note: "index is stale: index commit differs from repo HEAD",
      hint: HINT,
      lastIndexedCommit: c1.slice(0, 12),
      headCommit: c3.slice(0, 12),
      commitsBehind: 2,
      dirtyCount: 2
    });

    // Up to date, unknown repo, no run, non-git directory: no warning.
    assert.equal(await buildStaleWarning("r", fakeStore(repo, c3), HINT), null);
    assert.equal(await buildStaleWarning("r", fakeStore(null, c1), HINT), null);
    assert.equal(await buildStaleWarning("r", fakeStore(repo, undefined), HINT), null);
    const plain = fs.mkdtempSync(path.join(tmpdir(), "cim-stale-plain-"));
    try {
      assert.equal(await buildStaleWarning("r", fakeStore(plain, c1), HINT), null);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }

    // An indexed commit git does not have: still stale, commitsBehind unknown — as the sync version answered.
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const gone = await buildStaleWarning("r", fakeStore(repo, missing), HINT);
    assert.equal(gone?.commitsBehind, null);
    assert.equal(gone?.dirtyCount, 2);
    assert.equal(gone?.lastIndexedCommit, missing.slice(0, 12));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
