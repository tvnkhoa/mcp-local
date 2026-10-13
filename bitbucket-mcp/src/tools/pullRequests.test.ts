/**
 * PR comments and merge through dispatch. The rules pinned here are the ones
 * nothing upstream enforces for these repositories: merge commit only, a merge
 * bound to the commit that was previewed, and every write behind its flag.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BitbucketConfig } from "../config/index.js";
import { CONFIG, bodyOf, recording } from "./harness.test.js";

const WRITE = { ...CONFIG, writeEnabled: true } as BitbucketConfig;
const MERGE = { ...CONFIG, mergeEnabled: true } as BitbucketConfig;
const OPEN_PR = {
  id: 7,
  title: "develop to master",
  state: "OPEN",
  source: { branch: { name: "develop" }, commit: { hash: "f02e5cfc8fb6" } },
  destination: { branch: { name: "master" } }
};

test("list_pull_request_comments normalizes inline position, replies and deleted flags", async () => {
  const { client, calls } = recording({
    listPullRequestComments: {
      values: [
        { id: 1, user: { display_name: "A" }, content: { raw: "general" } },
        { id: 2, content: { raw: "inline" }, inline: { path: "src/a.ts", to: 12, from: null }, parent: { id: 1 }, deleted: true }
      ]
    }
  });
  const { payload } = await bodyOf("list_pull_request_comments", { repoSlug: "r", id: 7 }, undefined, client);
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["r", 7]);
  assert.deepEqual(payload.comments[0], { id: 1, author: "A", body: "general" });
  assert.deepEqual(payload.comments[1], { id: 2, body: "inline", path: "src/a.ts", line: 12, parentId: 1, deleted: true });
});

test("add_pull_request_comment builds inline and reply bodies, previews without the flag, posts only with it", async () => {
  const { client, calls } = recording({ addPullRequestComment: { id: 9, content: { raw: "x" } } });
  const dry = await bodyOf("add_pull_request_comment", { repoSlug: "r", id: 7, body: "nit", path: "src/a.ts", line: 3, parentId: 1, dryRun: true }, undefined, client);
  assert.deepEqual(dry.payload.request.body, { content: { raw: "nit" }, inline: { path: "src/a.ts", to: 3 }, parent: { id: 1 } });

  const refused = await bodyOf("add_pull_request_comment", { repoSlug: "r", id: 7, body: "nit" }, undefined, client);
  assert.equal(refused.payload.code, "WRITE_DISABLED");
  assert.equal(calls.length, 0, "neither the preview nor the refusal posts");

  const posted = await bodyOf("add_pull_request_comment", { repoSlug: "r", id: 7, body: "nit", path: "old.ts", oldLine: 4 }, WRITE, client);
  assert.equal(posted.payload.created, true);
  assert.deepEqual(calls[0]?.args[2], { content: { raw: "nit" }, inline: { path: "old.ts", from: 4 } });
});

test("add_pull_request_comment refuses a half-specified inline position", async () => {
  const { client, calls } = recording({});
  for (const args of [{ path: "a.ts" }, { line: 3 }, { path: "../a.ts", line: 1 }]) {
    const { payload } = await bodyOf("add_pull_request_comment", { repoSlug: "r", id: 7, body: "x", ...args }, WRITE, client);
    assert.match(String(payload.code), /invalid_inline|invalid_path/, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

test("merge_pull_request previews by default, always as a merge commit, and never calls merge", async () => {
  const { client, calls } = recording({ getPullRequest: OPEN_PR });
  const { payload } = await bodyOf("merge_pull_request", { repoSlug: "r", id: 7 }, MERGE, client);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.strategy, "merge_commit");
  assert.deepEqual(payload.request.body, { type: "pullrequest", merge_strategy: "merge_commit" });
  assert.equal(payload.pullRequest.sourceCommit, "f02e5cfc8fb6");
  assert.equal(calls.some((c) => c.method === "mergePullRequest"), false);
});

test("merge_pull_request has no way to ask for another strategy", async () => {
  const { client } = recording({ getPullRequest: OPEN_PR });
  const { payload } = await bodyOf("merge_pull_request", { repoSlug: "r", id: 7, mergeStrategy: "squash" }, MERGE, client);
  assert.equal(payload.code, "validation_error");
});

test("merge_pull_request applies only with the flag, the previewed commit, and an open PR", async () => {
  const cases: [BitbucketConfig, Record<string, unknown>, Record<string, unknown>, string][] = [
    [CONFIG, OPEN_PR, { expectedSourceCommit: "f02e5cfc8fb6" }, "MERGE_DISABLED"],
    [MERGE, OPEN_PR, {}, "expected_source_commit_required"],
    [MERGE, OPEN_PR, { expectedSourceCommit: "adc051ab9934" }, "source_moved"],
    [MERGE, { ...OPEN_PR, state: "MERGED" }, { expectedSourceCommit: "f02e5cfc8fb6" }, "pr_not_open"]
  ];
  for (const [config, pr, extra, code] of cases) {
    const { client, calls } = recording({ getPullRequest: pr });
    const { payload } = await bodyOf("merge_pull_request", { repoSlug: "r", id: 7, dryRun: false, ...extra }, config, client);
    assert.equal(payload.code, code);
    assert.equal(calls.some((c) => c.method === "mergePullRequest"), false, code);
  }
});

test("merge_pull_request refuses a missing flag or expectedSourceCommit before any upstream call, whatever the PR state", async () => {
  const cases: [BitbucketConfig, Record<string, unknown>, string][] = [
    [CONFIG, { expectedSourceCommit: "f02e5cfc8fb6" }, "MERGE_DISABLED"],
    [MERGE, {}, "expected_source_commit_required"]
  ];
  for (const [config, extra, code] of cases) {
    // The PR is MERGED: had the PR been fetched first, this would read pr_not_open.
    const { client, calls } = recording({ getPullRequest: { ...OPEN_PR, state: "MERGED" } });
    const { payload } = await bodyOf("merge_pull_request", { repoSlug: "r", id: 7, dryRun: false, ...extra }, config, client);
    assert.equal(payload.code, code);
    assert.equal(calls.length, 0, `${code}: no upstream call`);
  }
});

test("merge_pull_request merges when everything matches, accepting a full SHA for a 12-char PR hash", async () => {
  const { client, calls } = recording({
    getPullRequest: OPEN_PR,
    mergePullRequest: { state: "MERGED", merge_commit: { hash: "abc123" } }
  });
  const { payload } = await bodyOf(
    "merge_pull_request",
    { repoSlug: "r", id: 7, dryRun: false, expectedSourceCommit: "f02e5cfc8fb6b4582036e3fc901cedd7c0660ae0", closeSourceBranch: false },
    MERGE,
    client
  );
  assert.equal(payload.merged, true);
  assert.equal(payload.mergeCommit, "abc123");
  assert.equal(payload.pullRequest.state, "MERGED", "not the pre-merge snapshot's OPEN");
  const merge = calls.find((c) => c.method === "mergePullRequest");
  assert.deepEqual(merge?.args[2], { type: "pullrequest", merge_strategy: "merge_commit", close_source_branch: false });
});
