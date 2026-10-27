import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findWorktreeOwner, resolveGitCommonDir, resolveHeadCommitSha } from "../services/git/gitHelpers.js";
import { assertPathAllowed } from "./indexGuardrails.js";

/**
 * MCP-ISSUE-102: a linked worktree beside its main checkout is refused by the prefix check. It is accepted
 * when the worktree is registered in a common dir that lies inside an allowed root — and never otherwise.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}

function fixture(run: (f: { sandbox: string; main: string; wt: string }) => void): void {
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "cim-worktree-")));
  try {
    const main = path.join(sandbox, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "trunk");
    writeFileSync(path.join(main, "a.txt"), "a\n");
    git(main, "add", "a.txt");
    git(main, "commit", "-q", "-m", "init");
    const wt = path.join(sandbox, "wt-feature");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "-m", "feature work");
    run({ sandbox, main, wt });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("a registered worktree beside the allowed main checkout is accepted and keeps its own HEAD", () => {
  fixture(({ main, wt }) => {
    assert.throws(() => assertPathAllowed(path.join(main, "..", "elsewhere"), [main]), /outside allowed roots/);
    assertPathAllowed(wt, [main]);
    const wtHead = git(wt, "rev-parse", "HEAD");
    assert.equal(resolveHeadCommitSha(wt), wtHead);
    assert.notEqual(wtHead, git(main, "rev-parse", "HEAD"), "precondition: the worktree's branch moved on");
  });
});

test("a sibling dir that is not a registered worktree is refused", () => {
  fixture(({ sandbox, main }) => {
    const plain = path.join(sandbox, "plain");
    mkdirSync(plain);
    assert.throws(() => assertPathAllowed(plain, [main]), /outside allowed roots/);
    const other = path.join(sandbox, "other-repo");
    mkdirSync(other);
    git(other, "init", "-q");
    assert.throws(() => assertPathAllowed(other, [main]), /outside allowed roots/);
  });
});

test("a forged .git file pointing into the allowed repo is refused (no back-link)", () => {
  fixture(({ sandbox, main, wt }) => {
    const entry = path.join(main, ".git", "worktrees", path.basename(wt));
    const forged = path.join(sandbox, "forged");
    mkdirSync(forged);
    // Points at a REAL worktree entry of the allowed repo, but that entry's gitdir names wt, not this dir.
    writeFileSync(path.join(forged, ".git"), `gitdir: ${entry}\n`);
    assert.throws(() => assertPathAllowed(forged, [main]), /outside allowed roots/);
    assert.equal(resolveGitCommonDir(forged), null);
    // Points straight at the main .git directory: not a worktree entry either.
    const forged2 = path.join(sandbox, "forged2");
    mkdirSync(forged2);
    writeFileSync(path.join(forged2, ".git"), `gitdir: ${path.join(main, ".git")}\n`);
    assert.throws(() => assertPathAllowed(forged2, [main]), /outside allowed roots/);
  });
});

test("a worktree of a repo that is NOT inside an allowed root is refused", () => {
  fixture(({ sandbox, wt }) => {
    const unrelated = path.join(sandbox, "unrelated-root");
    mkdirSync(unrelated);
    assert.throws(() => assertPathAllowed(wt, [unrelated]), /outside allowed roots/);
  });
});

test("worktreeOf names the registered main checkout, null for the main itself", () => {
  fixture(({ main, wt }) => {
    const all = [
      { repoId: "app", repoPath: main },
      { repoId: "app-feature", repoPath: wt }
    ];
    assert.equal(findWorktreeOwner(all[1], all), "app");
    assert.equal(findWorktreeOwner(all[0], all), null);
    assert.equal(findWorktreeOwner(all[1], [all[1]]), null, "no registered owner");
  });
});
