/**
 * create_branch / delete_branch. Pinned: the protected names and the main
 * branch are refused whatever the allowlist, preview is the default, a delete
 * is bound to the previewed head and refused while an open PR uses the branch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError } from "../middleware/errors.js";
import { CONFIG, bodyOf, recording } from "./harness.test.js";

const HEAD = "a".repeat(40);
const nf = new BitbucketHttpError(404, "nf");
// Deliberately over-broad: the hard refusals must hold even against `*`.
const ALLOW = { ...CONFIG, commitBranches: ["*"], commitSharedBranches: ["wec.aria:release/*"] } as BitbucketConfig;
const ON = { ...ALLOW, branchEnabled: true } as BitbucketConfig;

function upstream(branchHead: string | null, openPrs: unknown[] = [], main = "trunk") {
  return recording({
    getRepository: { mainbranch: { name: main } },
    getBranch: (_s: unknown, name: string) => (name === "develop" ? { target: { hash: HEAD } } : branchHead === null ? nf : { target: { hash: branchHead } }),
    getTag: nf,
    listPullRequests: { values: openPrs },
    createBranch: { name: "sandbox/x", target: { hash: HEAD } },
    deleteBranch: undefined
  });
}

test("protected names, the main branch and shared branches are refused even with a * allowlist", async () => {
  for (const [name, code] of [
    ["master", "branch_protected"],
    ["develop", "branch_protected"],
    ["main", "branch_protected"],
    ["trunk", "branch_protected"],
    ["release/x", "branch_not_allowed"]
  ] as const) {
    for (const [tool, extra] of [
      ["create_branch", { fromRef: "develop" }],
      ["delete_branch", { expectedHead: HEAD }]
    ] as const) {
      const { client, calls } = upstream(HEAD);
      const { payload } = await bodyOf(tool, { repoSlug: "wec.aria", name, dryRun: false, ...extra }, ON, client);
      assert.equal(payload.code, code, `${tool} ${name}`);
      assert.equal(calls.some((c) => c.method === "createBranch" || c.method === "deleteBranch"), false);
    }
  }
});

test("a name on no allowlist is refused", async () => {
  const { client } = upstream(null);
  const { payload } = await bodyOf("create_branch", { repoSlug: "r", name: "sandbox/x", fromRef: "develop" }, CONFIG, client);
  assert.equal(payload.code, "branch_not_allowed");
});

test("create_branch previews by default, creates only when enabled, and refuses an existing name", async () => {
  {
    const { client, calls } = upstream(null);
    const { payload } = await bodyOf("create_branch", { repoSlug: "r", name: "sandbox/x", fromRef: "develop" }, ALLOW, client);
    assert.equal(payload.dryRun, true);
    assert.deepEqual(payload.request.body, { name: "sandbox/x", target: { hash: HEAD } });
    assert.equal(calls.some((c) => c.method === "createBranch"), false);
  }
  {
    const { client } = upstream(null);
    const { payload } = await bodyOf("create_branch", { repoSlug: "r", name: "sandbox/x", fromRef: "develop", dryRun: false }, ALLOW, client);
    assert.equal(payload.code, "BRANCH_DISABLED");
  }
  {
    const { client, calls } = upstream(null);
    const { payload } = await bodyOf("create_branch", { repoSlug: "r", name: "sandbox/x", fromRef: "develop", dryRun: false }, ON, client);
    assert.equal(payload.created, true);
    assert.deepEqual(calls.find((c) => c.method === "createBranch")?.args, ["r", "sandbox/x", HEAD]);
  }
  {
    const { client } = upstream(HEAD);
    const { payload } = await bodyOf("create_branch", { repoSlug: "r", name: "sandbox/x", fromRef: "develop" }, ALLOW, client);
    assert.equal(payload.code, "branch_exists");
  }
});

test("delete_branch previews the head, then deletes only that head, only when enabled", async () => {
  const { client, calls } = upstream(HEAD);
  const preview = await bodyOf("delete_branch", { repoSlug: "r", name: "sandbox/x" }, ON, client);
  assert.equal(preview.payload.dryRun, true);
  assert.equal(preview.payload.head, HEAD);

  const cases: [BitbucketConfig, Record<string, unknown>, string][] = [
    [ALLOW, { expectedHead: HEAD }, "BRANCH_DISABLED"],
    [ON, {}, "expected_head_required"],
    [ON, { expectedHead: "b".repeat(12) }, "head_moved"]
  ];
  for (const [config, extra, code] of cases) {
    const { payload } = await bodyOf("delete_branch", { repoSlug: "r", name: "sandbox/x", dryRun: false, ...extra }, config, client);
    assert.equal(payload.code, code);
  }
  assert.equal(calls.some((c) => c.method === "deleteBranch"), false);

  const done = await bodyOf("delete_branch", { repoSlug: "r", name: "sandbox/x", dryRun: false, expectedHead: HEAD.slice(0, 12) }, ON, client);
  assert.equal(done.payload.deleted, true);
  assert.deepEqual(calls.find((c) => c.method === "deleteBranch")?.args, ["r", "sandbox/x"]);
});

test("delete_branch refuses while an open PR uses the branch, from either side", async () => {
  for (const pr of [
    { id: 4, source: { branch: { name: "sandbox/x" } }, destination: { branch: { name: "develop" } } },
    { id: 5, source: { branch: { name: "sandbox/y" } }, destination: { branch: { name: "sandbox/x" } } }
  ]) {
    const { client, calls } = upstream(HEAD, [pr]);
    const { payload } = await bodyOf("delete_branch", { repoSlug: "r", name: "sandbox/x", dryRun: false, expectedHead: HEAD }, ON, client);
    assert.equal(payload.code, "branch_has_open_pr");
    assert.match(payload.message, new RegExp(`#${String(pr.id)}`));
    assert.equal(calls.some((c) => c.method === "deleteBranch"), false);
  }
  // A PR on another branch that a loose filter returned does not block.
  const { client } = upstream(HEAD, [{ id: 6, source: { branch: { name: "sandbox/xy" } }, destination: { branch: { name: "develop" } } }]);
  const { payload } = await bodyOf("delete_branch", { repoSlug: "r", name: "sandbox/x" }, ON, client);
  assert.equal(payload.dryRun, true);
});
