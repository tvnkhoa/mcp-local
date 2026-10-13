/**
 * The commit and compare tools through dispatch, against a recording client:
 * argument translation, client-side filtering and its cursor, the caps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Call } from "./harness.test.js";
import { bodyOf, recording } from "./harness.test.js";
import { AHEAD_BEHIND_CAP } from "./compare.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NEXT = "https://api.bitbucket.org/2.0/repositories/w/r/commits?ctx=c1&page=2";

function commit(n: number, date: string, author = "Dev <dev@x>"): Record<string, unknown> {
  return { hash: n.toString(16).padStart(40, "0"), date, message: `subject ${String(n)}\n\nbody`, author: { raw: author }, parents: [] };
}

const argsOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

test("list_commits passes include/exclude/path through and returns one upstream page when nothing filters client-side", async () => {
  const { client, calls } = recording({ listCommits: { values: [commit(1, "2026-10-01T00:00:00Z")], next: NEXT } });
  const { payload } = await bodyOf("list_commits", { repoSlug: "r", include: ["develop"], exclude: ["master", "v1"], path: "src/a.ts" }, undefined, client);
  const [, params] = argsOf(calls, "listCommits")[0] as [string, Record<string, unknown>];
  assert.deepEqual(params.include, ["develop"]);
  assert.deepEqual(params.exclude, ["master", "v1"]);
  assert.equal(params.path, "src/a.ts");
  assert.equal(params.pagelen, 30);
  assert.equal(payload.commits[0].subject, "subject 1");
  assert.equal(payload.nextCursor, "page=2&ctx=c1");
});

test("list_commits with a filter returns exactly pagelen and resumes mid-page with skip", async () => {
  const page = [1, 2, 3, 4, 5].map((n) => commit(n, "2026-10-05T00:00:00Z", n % 2 ? "Koi <k@x>" : "Other <o@x>"));
  const { client, calls } = recording({
    listCommits: (_s: unknown, p: { cursor?: { page: string } }) =>
      (p.cursor?.page ?? "1") === "1" ? { values: page, next: NEXT } : { values: [] }
  });
  const first = await bodyOf("list_commits", { repoSlug: "r", author: "koi", pagelen: 2 }, undefined, client);
  assert.deepEqual(first.payload.commits.map((c: { subject: string }) => c.subject), ["subject 1", "subject 3"]);
  // Stopped at index 2, so the next call starts at index 3 of the same page.
  assert.equal(first.payload.nextCursor, "page=1&skip=3");
  assert.equal(argsOf(calls, "listCommits")[0]?.[1] && (argsOf(calls, "listCommits")[0]?.[1] as Record<string, unknown>).pagelen, 100);

  const second = await bodyOf("list_commits", { repoSlug: "r", author: "koi", pagelen: 2, cursor: "page=1&skip=3" }, undefined, client);
  assert.deepEqual(second.payload.commits.map((c: { subject: string }) => c.subject), ["subject 5"]);
});

test("list_commits since stops on a page entirely older than since, not on the first older commit", async () => {
  const pages: Record<string, unknown> = {
    "1": { values: [commit(1, "2026-10-09T00:00:00Z"), commit(2, "2026-09-01T00:00:00Z"), commit(3, "2026-10-08T00:00:00Z")], next: NEXT },
    "2": { values: [commit(4, "2026-09-02T00:00:00Z")], next: "https://api.bitbucket.org/2.0/x?page=3" }
  };
  const { client, calls } = recording({
    listCommits: (_slug: unknown, p: { cursor?: { page: string } }) => pages[p.cursor?.page ?? "1"]
  });
  const { payload } = await bodyOf("list_commits", { repoSlug: "r", since: "2026-10-01" }, undefined, client);
  assert.deepEqual(payload.commits.map((c: { subject: string }) => c.subject), ["subject 1", "subject 3"]);
  assert.equal(argsOf(calls, "listCommits").length, 2);
  // null is dropped by the response normalizer: no cursor means no more pages.
  assert.equal(payload.nextCursor, undefined);
  assert.equal(payload.scanCapReached, false);
});

test("list_commits reports the scan cap and a cursor to continue", async () => {
  const page = Array.from({ length: 100 }, (_, i) => commit(i, "2026-10-05T00:00:00Z"));
  const { client, calls } = recording({ listCommits: { values: page, next: NEXT } });
  const { payload } = await bodyOf("list_commits", { repoSlug: "r", author: "nobody" }, undefined, client);
  assert.equal(argsOf(calls, "listCommits").length, 10);
  assert.equal(payload.scanned, 1000);
  assert.equal(payload.scanCapReached, true);
  assert.equal(payload.nextCursor, "page=2&ctx=c1");
});

test("invalid commit-tool input is refused before any upstream call", async () => {
  const { client, calls } = recording({});
  const cases: [string, Record<string, unknown>, string][] = [
    ["list_commits", { repoSlug: "r", include: ["a..b"] }, "invalid_ref"],
    ["list_commits", { repoSlug: "r", since: "last tuesday" }, "invalid_since"],
    ["list_commits", { repoSlug: "r", cursor: "page=2&host=x" }, "invalid_cursor"],
    ["list_commits", { repoSlug: "r", path: "../x" }, "invalid_path"],
    ["get_commit", { repoSlug: "r", sha: "not-a-sha" }, "invalid_sha"],
    ["get_commit_statuses", { repoSlug: "r", sha: "zzzzzzz" }, "invalid_sha"],
    ["compare_refs", { repoSlug: "r", base: "master", head: "x..y" }, "invalid_ref"]
  ];
  for (const [tool, args, code] of cases) {
    const { isError, payload } = await bodyOf(tool, args, undefined, client);
    assert.equal(isError, true, tool);
    assert.equal(payload.code, code, `${tool} ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, 0);
});

test("get_commit pages the diffstat up to maxFiles and reports the cut", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ status: "modified", lines_added: 1, lines_removed: 2, new: { path: `f${String(i)}` }, old: { path: `f${String(i)}` } }));
  const { client, calls } = recording({
    getCommit: { hash: SHA_A, message: "full\n\nmessage", parents: [{ hash: SHA_B }] },
    getDiffstat: (_s: unknown, _spec: unknown, p: { page: number }) => ({ size: 250, values: rows(100), next: p.page < 3 ? "x" : undefined })
  });
  const { payload } = await bodyOf("get_commit", { repoSlug: "r", sha: "AAAAAAA", maxFiles: 150 }, undefined, client);
  assert.equal(argsOf(calls, "getCommit")[0]?.[1], "aaaaaaa");
  assert.equal(argsOf(calls, "getDiffstat").length, 2);
  assert.equal(payload.files.length, 150);
  assert.equal(payload.filesTotal, 250);
  assert.equal(payload.filesTruncated, true);
  assert.deepEqual(payload.totals, { files: 150, linesAdded: 150, linesRemoved: 300 });
  assert.equal(payload.commit.message, "full\n\nmessage");
  assert.equal(payload.files[0].oldPath, undefined);
});

test("compare_refs resolves names to SHAs, builds the spec head-first, and caps ahead/behind", async () => {
  const full = { values: Array.from({ length: 100 }, () => ({})), next: NEXT };
  const { client, calls } = recording({
    getBranch: (_s: unknown, name: string) => ({ target: { hash: name === "develop" ? SHA_A : SHA_B } }),
    getMergeBase: { hash: "c".repeat(40) },
    getDiffstat: { size: 0, values: [] },
    // ahead (include develop) never ends; behind (include master) is one commit.
    listCommits: (_s: unknown, p: { include: string[] }) => (p.include[0] === SHA_A ? full : { values: [{}] })
  });
  const { payload } = await bodyOf("compare_refs", { repoSlug: "r", base: "master", head: "develop" }, undefined, client);
  assert.equal(argsOf(calls, "getMergeBase")[0]?.[1], `${SHA_A}..${SHA_B}`);
  assert.equal(argsOf(calls, "getDiffstat")[0]?.[1], `${SHA_A}..${SHA_B}`);
  assert.deepEqual(payload.ahead, { count: AHEAD_BEHIND_CAP, capped: true, display: `≥${String(AHEAD_BEHIND_CAP)}` });
  assert.deepEqual(payload.behind, { count: 1, capped: false, display: "1" });
  assert.equal(payload.diff, undefined, "statOnly defaults to true: no diff call");
  assert.equal(argsOf(calls, "getDiffBounded").length, 0);
});

test("compare_refs statOnly:false returns the bounded diff; an oversized maxDiffBytes is rejected", async () => {
  const { client, calls } = recording({
    getBranch: { target: { hash: SHA_A } },
    getMergeBase: { hash: SHA_A },
    getDiffstat: { size: 0, values: [] },
    listCommits: { values: [] },
    getDiffBounded: { text: "diff --git", truncated: true, bytesRead: 10 }
  });
  const { payload } = await bodyOf("compare_refs", { repoSlug: "r", base: "a", head: "b", statOnly: false, maxDiffBytes: 10 }, undefined, client);
  assert.equal(argsOf(calls, "getDiffBounded")[0]?.[2], 10);
  assert.equal(payload.diffTruncated, true);

  const big = await bodyOf("compare_refs", { repoSlug: "r", base: "a", head: "b", maxDiffBytes: 2_000_000 }, undefined, client);
  assert.equal(big.payload.code, "validation_error");
});
