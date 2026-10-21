import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readHeadShaFromFiles, resolveHeadCommitSha } from "./gitHelpers.js";

/**
 * Release I1b — HEAD is read from the git directory's files instead of spawning `git rev-parse`
 * (a synchronous spawn held the server thread up to 1.9 s while the refresh worker loaded the CPU).
 * Every shape is checked against what git itself says.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

function repo(): { dir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cim-head-"));
  const dir = path.join(root, "repo");
  fs.mkdirSync(path.join(dir, "sub", "deeper"), { recursive: true });
  git(root, "init", "-q", dir);
  fs.writeFileSync(path.join(dir, "sub", "deeper", "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(dir, "sub", "deeper", "a.txt"), "two\n");
  git(dir, "commit", "-q", "-am", "two");
  return { dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a branch HEAD through a loose ref, also from a subdirectory", () => {
  const r = repo();
  try {
    const expected = git(r.dir, "rev-parse", "HEAD");
    assert.equal(readHeadShaFromFiles(r.dir), expected);
    assert.equal(readHeadShaFromFiles(path.join(r.dir, "sub", "deeper")), expected);
    assert.equal(resolveHeadCommitSha(r.dir), expected);
  } finally { r.cleanup(); }
});

test("a branch HEAD through packed-refs, and a detached HEAD", () => {
  const r = repo();
  try {
    git(r.dir, "pack-refs", "--all");
    const expected = git(r.dir, "rev-parse", "HEAD");
    assert.equal(readHeadShaFromFiles(r.dir), expected, "packed");
    const first = git(r.dir, "rev-parse", "HEAD~1");
    git(r.dir, "checkout", "-q", "--detach", first);
    assert.equal(readHeadShaFromFiles(r.dir), first, "detached");
  } finally { r.cleanup(); }
});

test("a linked worktree (.git file + commondir)", () => {
  const r = repo();
  try {
    const wt = path.join(path.dirname(r.dir), "wt");
    git(r.dir, "worktree", "add", "-q", "-b", "side", wt, "HEAD~1");
    assert.equal(readHeadShaFromFiles(wt), git(wt, "rev-parse", "HEAD"));
    // A commit on the worktree's branch is seen there and not in the main checkout.
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "side");
    assert.equal(readHeadShaFromFiles(wt), git(wt, "rev-parse", "HEAD"));
    assert.equal(readHeadShaFromFiles(r.dir), git(r.dir, "rev-parse", "HEAD"));
  } finally { r.cleanup(); }
});

test("unborn branch and non-git directory: null (the caller falls back to git, which also says null)", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cim-head-"));
  try {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    // tmpdir itself is not inside a git repo on any machine this runs on; if it were, the walk-up
    // would find that repo — which is also what git does.
    const outside = (() => { try { git(plain, "rev-parse", "--git-dir"); return false; } catch { return true; } })();
    if (outside) assert.equal(readHeadShaFromFiles(plain), null);
    const unborn = path.join(root, "unborn");
    git(root, "init", "-q", unborn);
    assert.equal(readHeadShaFromFiles(unborn), null);
    assert.equal(resolveHeadCommitSha(unborn), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
