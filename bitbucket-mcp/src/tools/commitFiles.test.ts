/**
 * commit_files_preview → commit_files_apply. What is pinned: no force (the
 * parent must be the head, before and during the call), allowlisted branches
 * only, apply commits exactly the preview, single use, and a reconcile script
 * for shared branches that refuses before it changes anything.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError } from "../middleware/errors.js";
import { commitForm, patternMatches, reconcileScript } from "./commitPlan.js";
import { CONFIG, bodyOf, recording } from "./harness.test.js";

const PARENT = "a".repeat(40);
const NEW = "b".repeat(40);
const nf = new BitbucketHttpError(404, "nf");

const ENABLED = {
  ...CONFIG,
  commitEnabled: true,
  commitBranches: ["wec.knowledge-base:docs/*", "sandbox/*"],
  commitSharedBranches: ["wec.aria:develop"]
} as BitbucketConfig;

/** An upstream where `branch` is at `head` (null = absent) and `exists` paths exist at the parent. */
function upstream(head: string | null, exists: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
  return recording({
    getCommit: (_s: unknown, sha: string) => (sha === NEW ? { hash: NEW, parents: [{ hash: PARENT }] } : { hash: PARENT }),
    getBranch: head === null ? nf : { target: { hash: head } },
    getSrcMeta: (_s: unknown, _sha: unknown, p: string) => (p in exists ? { type: "commit_file", size: exists[p]?.length } : nf),
    getSrcBounded: (_s: unknown, _sha: unknown, p: string) => ({ text: exists[p] ?? "", truncated: false, bytesRead: 0 }),
    createCommit: { status: 201, body: "", contentRange: null, location: `https://api.bitbucket.org/2.0/repositories/w/r/commit/${NEW}` },
    ...overrides
  });
}

const preview = (args: Record<string, unknown>, config: BitbucketConfig, client: ReturnType<typeof upstream>["client"]) =>
  bodyOf("commit_files_preview", { message: "m", parent: PARENT, ...args }, config, client);

test("allowlist patterns: repo:glob or a bare glob for every repo; * spans slashes", () => {
  assert.equal(patternMatches("wec.aria:develop", "wec.aria", "develop"), true);
  assert.equal(patternMatches("wec.aria:develop", "wec.aria", "develop2"), false);
  assert.equal(patternMatches("wec.knowledge-base:docs/*", "wec.knowledge-base", "docs/a/b"), true);
  assert.equal(patternMatches("sandbox/*", "any.repo", "sandbox/x"), true);
  assert.equal(patternMatches("w?c.aria:*", "wec.aria", "x"), true);
  assert.equal(patternMatches("wec.aria:dev.lop", "wec.aria", "devXlop"), false, "a dot is literal");
});

test("preview refuses a branch on neither allowlist, before any upstream call", async () => {
  const { client, calls } = upstream(PARENT);
  const { payload } = await preview({ repoSlug: "wec.aria", branch: "master", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
  assert.equal(payload.code, "branch_not_allowed");
  assert.equal(calls.length, 0);
});

test("preview refuses when the parent is not the branch head — commit_files never forces", async () => {
  const { client } = upstream("c".repeat(40));
  const { payload } = await preview({ repoSlug: "wec.aria", branch: "develop", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
  assert.equal(payload.code, "parent_not_head");
  assert.match(payload.message, /never forces/);
});

test("preview validates files: text only, one of content/delete, no duplicates, delete must exist", async () => {
  const { client } = upstream(PARENT, { "old.md": "x" });
  const base = { repoSlug: "wec.aria", branch: "develop" };
  const cases: [unknown[], string][] = [
    [[{ path: "a.bin", content: "a\u0000b" }], "binary_content"],
    [[{ path: "a.md" }], "invalid_file"],
    [[{ path: "a.md", content: "x", delete: true }], "invalid_file"],
    [[{ path: "a.md", content: "x" }, { path: "a.md/", content: "y" }], "invalid_path"],
    [[{ path: "../a.md", content: "x" }], "invalid_path"],
    [[{ path: "gone.md", delete: true }], "delete_missing"],
    [[{ path: "big.md", content: "x".repeat(524_289) }], "content_too_large"]
  ];
  for (const [files, code] of cases) {
    const { payload } = await preview({ ...base, files }, ENABLED, client);
    assert.equal(payload.code, code, JSON.stringify(files).slice(0, 80));
  }
});

test("preview describes each change and refuses a commit that changes nothing", async () => {
  const { client } = upstream(PARENT, { "same.md": "keep", "old.md": "x" });
  const { payload } = await preview(
    { repoSlug: "wec.aria", branch: "develop", files: [{ path: "new.md", content: "n" }, { path: "same.md", content: "keep" }, { path: "old.md", delete: true }] },
    ENABLED,
    client
  );
  assert.deepEqual(payload.changes.map((c: { path: string; action: string }) => `${c.path}:${c.action}`), ["new.md:add", "same.md:unchanged", "old.md:delete"]);
  assert.equal(payload.branchKind, "shared");
  assert.ok(payload.previewId && payload.approvalToken);

  const none = await preview({ repoSlug: "wec.aria", branch: "develop", files: [{ path: "same.md", content: "keep" }] }, ENABLED, client);
  assert.equal(none.payload.code, "no_changes");
});

test("a shared branch is never created; an isolated one may be", async () => {
  {
    const { client } = upstream(null);
    const { payload } = await preview({ repoSlug: "wec.aria", branch: "develop", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
    assert.equal(payload.code, "branch_not_found");
  }
  {
    const { client } = upstream(null);
    const { payload } = await preview({ repoSlug: "wec.knowledge-base", branch: "docs/new", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
    assert.equal(payload.newBranch, true);
    assert.equal(payload.branchKind, "isolated");
  }
});

test("apply is off unless enabled, and needs this process's token for that preview", async () => {
  const { client } = upstream(PARENT);
  const { payload: p } = await preview({ repoSlug: "s", branch: "sandbox/x", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);

  const off = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, CONFIG, client);
  assert.equal(off.payload.code, "COMMIT_DISABLED");
  const forged = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: `${String(p.approvalToken)}x` }, ENABLED, client);
  assert.equal(forged.payload.code, "INVALID_APPROVAL_TOKEN");
  const unknown = await bodyOf("commit_files_apply", { previewId: "nope", approvalToken: p.approvalToken }, ENABLED, client);
  assert.equal(unknown.payload.code, "preview_not_found");
});

test("apply posts exactly the previewed files with the parent asserted, verifies the new commit, and is single-use", async () => {
  const { client, calls } = upstream(PARENT, { "old.md": "x" });
  const { payload: p } = await preview(
    { repoSlug: "s", branch: "sandbox/x", files: [{ path: "dir/a b.md", content: "hi\n" }, { path: "old.md", delete: true }] },
    ENABLED,
    client
  );
  const { payload } = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, ENABLED, client);
  assert.equal(payload.committed, true);
  assert.equal(payload.newSha, NEW);
  assert.equal(payload.parentVerified, true);
  assert.equal(payload.reconcile, undefined, "an isolated branch needs no reconcile");

  const form = calls.find((c) => c.method === "createCommit")?.args[1] as URLSearchParams;
  assert.equal(form.get("parents"), PARENT);
  assert.equal(form.get("branch"), "sandbox/x");
  assert.equal(form.get("/dir/a b.md"), "hi\n");
  assert.deepEqual(form.getAll("files"), ["/old.md"]);

  const again = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, ENABLED, client);
  assert.equal(again.payload.code, "preview_not_found");
});

test("apply refuses if the branch moved since the preview, and maps Bitbucket's own refusal the same way", async () => {
  {
    const { client } = upstream(PARENT);
    const { payload: p } = await preview({ repoSlug: "s", branch: "sandbox/x", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
    const moved = upstream("c".repeat(40));
    const { payload } = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, ENABLED, moved.client);
    assert.equal(payload.code, "parent_not_head");
    assert.equal(moved.calls.some((c) => c.method === "createCommit"), false);
  }
  // Documented: 409. Observed live on 2026-10-13: 400 with this exact message.
  const refusals: [BitbucketHttpError, RegExp][] = [
    [new BitbucketHttpError(409, "conflict"), /409/],
    [
      new BitbucketHttpError(
        400,
        "Bitbucket returned 400 Bad Request.",
        '{"type":"error","error":{"message":"The parent commit specified (4f2d33c7) is not the head of branch sandbox/x."}}'
      ),
      /400/
    ]
  ];
  for (const [refusal, status] of refusals) {
    const { client, calls } = upstream(PARENT, {}, { createCommit: refusal });
    const { payload: p } = await preview({ repoSlug: "s", branch: "sandbox/x", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
    const { payload } = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, ENABLED, client);
    assert.equal(payload.code, "parent_not_head");
    assert.match(payload.message, status);
    assert.equal(calls.filter((c) => c.method === "createCommit").length, 1);
  }
  {
    // Any other 400 is not a parent refusal and must not be reported as one.
    const { client } = upstream(PARENT, {}, { createCommit: new BitbucketHttpError(400, "bad", '{"error":{"message":"something else"}}') });
    const { payload: p } = await preview({ repoSlug: "s", branch: "sandbox/x", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
    const { payload } = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, ENABLED, client);
    assert.equal(payload.code, "bitbucket_http_error");
  }
});

test("apply on a shared branch returns the reconcile script", async () => {
  const { client } = upstream(PARENT);
  const { payload: p } = await preview({ repoSlug: "wec.aria", branch: "develop", files: [{ path: "a.md", content: "x" }] }, ENABLED, client);
  const { payload } = await bodyOf("commit_files_apply", { previewId: p.previewId, approvalToken: p.approvalToken }, ENABLED, client);
  assert.match(payload.reconcile.script, /git update-ref 'refs\/heads\/develop' b{40} a{40}/);
  assert.match(payload.reconcile.script, /git reset -q b{40} -- 'a\.md'/);
});

test("commitForm: leading-slash field per written file, deletions listed in files", () => {
  const form = commitForm({ branch: "b", parent: PARENT, message: "m", author: "A <a@x>", files: [{ path: "x.md", content: "1" }, { path: "y.md", delete: true }] });
  assert.equal(form.get("/x.md"), "1");
  assert.deepEqual(form.getAll("files"), ["/y.md"]);
  assert.equal(form.get("author"), "A <a@x>");
});

// --- the reconcile script, run against a real git repository ---------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();
}

/**
 * Simulates the shared worktree: origin gets the server-side commit of one
 * path; locally that path is already edited to the same content, and a peer
 * has a different file staged. The script must move the branch, clean only
 * the committed path, and leave the peer's staged file staged.
 */
function sharedWorktree(): { dir: string; parent: string; newSha: string } {
  const origin = mkdtempSync(join(tmpdir(), "cf-origin-"));
  git(origin, "init", "-q", "-b", "develop");
  git(origin, "config", "core.autocrlf", "false");
  writeFileSync(join(origin, "a.md"), "old\n");
  writeFileSync(join(origin, "peer.md"), "p0\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const parent = git(origin, "rev-parse", "HEAD");

  const dir = mkdtempSync(join(tmpdir(), "cf-local-"));
  git(dir, "clone", "-q", origin, ".");
  git(dir, "config", "core.autocrlf", "false");

  // The "server-side" commit, made directly in origin.
  writeFileSync(join(origin, "a.md"), "new\n");
  git(origin, "commit", "-q", "-am", "server-side");
  const newSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "--detach");

  // Local state: our path already has the committed content (unstaged), a peer staged peer.md.
  writeFileSync(join(dir, "a.md"), "new\n");
  writeFileSync(join(dir, "peer.md"), "p1\n");
  git(dir, "add", "peer.md");
  return { dir, parent, newSha };
}

const bash = (cwd: string, script: string): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync("bash", ["-c", script], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, out: String((error as { stdout?: string }).stdout ?? "") };
  }
};

test("reconcile script: moves the branch, cleans only the committed path, keeps a peer's staged file", () => {
  const { dir, parent, newSha } = sharedWorktree();
  const { script } = reconcileScript({ branch: "develop", parent, message: "m", files: [{ path: "a.md", content: "new\n" }] }, newSha) as { script: string };
  const run = bash(dir, script);
  assert.equal(run.ok, true, run.out);
  assert.equal(git(dir, "rev-parse", "HEAD"), newSha);
  assert.equal(git(dir, "status", "--porcelain"), "M  peer.md", "a.md is clean; peer.md is still staged");
});

test("reconcile script: refuses without changing anything when the local content differs", () => {
  const { dir, parent, newSha } = sharedWorktree();
  writeFileSync(join(dir, "a.md"), "something else\n");
  const { script } = reconcileScript({ branch: "develop", parent, message: "m", files: [{ path: "a.md", content: "new\n" }] }, newSha) as { script: string };
  const run = bash(dir, script);
  assert.equal(run.ok, false);
  assert.match(run.out, /a\.md differs from the commit/);
  assert.equal(git(dir, "rev-parse", "HEAD"), parent, "the branch did not move");
});
