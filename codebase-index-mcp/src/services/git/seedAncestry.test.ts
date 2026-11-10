import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkSeedAncestry, classifyGitKill, gitAsync } from "./gitHelpers.js";

/** IX-9: a worktree is seeded from its parent's index only when the parent's indexed commit is an ancestor of its base. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

function commit(dir: string, file: string, body: string): string {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", body);
  return git(dir, "rev-parse", "HEAD");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cim-seed-anc-"));
  const parent = path.join(root, "parent");
  git(root, "init", "-q", "-b", "main", parent);
  const c1 = commit(parent, "a.txt", "one\n");
  const c2 = commit(parent, "a.txt", "two\n");
  const wt = path.join(root, "wt");
  git(parent, "worktree", "add", "-q", "-b", "wt/x", wt, c2);
  const w1 = commit(wt, "b.txt", "wt-one\n");
  git(parent, "checkout", "-q", "main");
  const p3 = commit(parent, "a.txt", "three\n"); // diverges from wt/x
  return { root, parent, wt, c1, c2, w1, p3, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("checkSeedAncestry: each refusal names its reason, an ancestor passes", async () => {
  const f = fixture();
  try {
    // parent indexed at base (equal) or behind it: seed allowed
    assert.deepEqual(await checkSeedAncestry(f.wt, f.c2, f.c2), { ok: true, parentSha: f.c2, childSha: f.c2 });
    assert.deepEqual(await checkSeedAncestry(f.wt, f.c1), { ok: true, parentSha: f.c1, childSha: f.w1 });

    // parent indexed on a commit that diverged from the worktree base (MCP-ISSUE-123: named, not parent_not_ancestor)
    const div = await checkSeedAncestry(f.wt, f.p3);
    assert.equal(div.ok, false);
    assert.equal(!div.ok && div.fallbackReason, "diverged");

    // parent indexed ahead of the worktree base: the worktree is behind (the 9 Nov acceptance case)
    const ahead = await checkSeedAncestry(f.wt, f.w1, f.c2);
    assert.equal(!ahead.ok && ahead.fallbackReason, "child_behind_parent");
    const moved = await checkSeedAncestry(f.wt, f.p3, f.c2); // the parent moved on from the worktree's base
    assert.equal(!moved.ok && moved.fallbackReason, "child_behind_parent");

    assert.equal((await checkSeedAncestry(f.wt, null) as { fallbackReason: string }).fallbackReason, "parent_not_indexed");
    assert.equal((await checkSeedAncestry(f.wt, "  ") as { fallbackReason: string }).fallbackReason, "parent_not_indexed");
    assert.equal(
      (await checkSeedAncestry(f.wt, "0123456789abcdef0123456789abcdef01234567") as { fallbackReason: string }).fallbackReason,
      "parent_sha_missing"
    );

    // unrelated history: an orphan commit in the same object store
    git(f.parent, "checkout", "-q", "--orphan", "orphan");
    git(f.parent, "rm", "-rq", "--cached", ".");
    const orphan = commit(f.parent, "z.txt", "orphan\n");
    const unrel = await checkSeedAncestry(f.wt, orphan);
    assert.equal(!unrel.ok && unrel.fallbackReason, "unrelated_history");

    // not a git directory: the child base cannot be resolved
    const plain = path.join(f.root, "plain");
    fs.mkdirSync(plain);
    const noHead = await checkSeedAncestry(plain, f.c1);
    assert.equal(noHead.ok, false);
  } finally { f.cleanup(); }
});

test("MCP-ISSUE-123: a git call killed by its timeout is git_timeout, not git_error", async () => {
  const f = fixture();
  try {
    // 1 ms: execFile kills git before it can exit — what a starved server saw at 5 s on 9 Nov.
    const r = await checkSeedAncestry(f.wt, f.c1, undefined, 1);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.fallbackReason, "git_timeout");
    // The same call with the normal timeout answers on ancestry.
    assert.equal((await checkSeedAncestry(f.wt, f.c1)).ok, true);
  } finally { f.cleanup(); }
});

test("MCP-ISSUE-123 #6: a maxBuffer overflow and an outside kill are named, not read as a timeout", async () => {
  const f = fixture();
  try {
    // Real execFile errors: 4 bytes cannot hold a sha; 1 ms cannot hold a spawn.
    const overflow = await gitAsync(f.wt, ["rev-parse", "HEAD"], 5_000, 4);
    assert.deepEqual(overflow, { status: -1, stdout: "", kill: "max_buffer" });
    const slow = await gitAsync(f.wt, ["rev-parse", "HEAD"], 1);
    assert.equal(slow.kill, "timeout");
    const fine = await gitAsync(f.wt, ["rev-parse", "HEAD"]);
    assert.deepEqual(fine, { status: 0, stdout: f.w1, kill: null });
    const failed = await gitAsync(f.wt, ["cat-file", "-e", "0123456789abcdef0123456789abcdef01234567^{commit}"]);
    assert.equal(failed.kill, null);
    assert.notEqual(failed.status, 0);
  } finally { f.cleanup(); }

  // The error shapes execFile produces (node lib/child_process.js): killed is set only when execFile itself killed git.
  assert.equal(classifyGitKill({ code: null, killed: true, signal: "SIGTERM" }), "timeout");
  assert.equal(classifyGitKill({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" }), "max_buffer");
  assert.equal(classifyGitKill({ code: null, killed: false, signal: "SIGKILL" }), "killed");
  assert.equal(classifyGitKill({ code: 128, killed: false, signal: null }), null);
  assert.equal(classifyGitKill({ code: "ENOENT", killed: false, signal: null }), null);
  assert.equal(classifyGitKill(null), null);
});
