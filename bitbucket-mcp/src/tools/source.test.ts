/**
 * The source tools through dispatch, against a recording client: directory vs
 * file vs binary, truncation, path errors, and code search's query building.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BitbucketHttpError } from "../middleware/errors.js";
import { CONFIG, bodyOf, recording } from "./harness.test.js";
import type { BitbucketConfig } from "../config/index.js";

const SHA = "a".repeat(40);

test("get_file_at_ref lists a directory, resolving the ref first and encoding the path per segment", async () => {
  const { client, calls } = recording({
    getBranch: { target: { hash: SHA } },
    getSrcMeta: { type: "commit_directory" },
    listSrcDir: { values: [{ path: "my docs/a.md", type: "commit_file", size: 3 }, { path: "my docs/sub", type: "commit_directory" }], next: "https://x/?page=E8Ux" }
  });
  const { payload } = await bodyOf("get_file_at_ref", { repoSlug: "r", ref: "feature/x", path: "my docs/" }, undefined, client);
  const meta = calls.find((c) => c.method === "getSrcMeta");
  assert.deepEqual(meta?.args, ["r", SHA, "my%20docs"]);
  assert.equal(payload.kind, "directory");
  assert.equal(payload.resolvedSha, SHA);
  assert.deepEqual(payload.entries[1], { path: "my docs/sub", type: "directory" });
  assert.equal(payload.nextCursor, "page=E8Ux");
});

test("get_file_at_ref returns text with truncation, and no content for binary files", async () => {
  {
    const { client } = recording({
      getBranch: { target: { hash: SHA } },
      getSrcMeta: { type: "commit_file", size: 9, attributes: [] },
      getSrcBounded: { text: "abcd", truncated: true, bytesRead: 4 }
    });
    const { payload } = await bodyOf("get_file_at_ref", { repoSlug: "r", ref: "develop", path: "a.txt", maxBytes: 4 }, undefined, client);
    assert.equal(payload.content, "abcd");
    assert.equal(payload.truncated, true);
    assert.equal(payload.returnedBytes, 4);
  }
  {
    const { client, calls } = recording({ getBranch: { target: { hash: SHA } }, getSrcMeta: { type: "commit_file", attributes: ["binary"] } });
    const { payload } = await bodyOf("get_file_at_ref", { repoSlug: "r", ref: "develop", path: "a.png" }, undefined, client);
    assert.equal(payload.binary, true);
    // `content: null` is dropped by the response normalizer; absent means none.
    assert.equal(payload.content, undefined);
    assert.equal(calls.some((c) => c.method === "getSrcBounded"), false, "a binary file is never downloaded");
  }
  {
    // Metadata that does not say binary, but the bytes do.
    const { client } = recording({
      getBranch: { target: { hash: SHA } },
      getSrcMeta: { type: "commit_file", attributes: [] },
      getSrcBounded: { text: "PK\u0003\u0004\u0000\u0000", truncated: false, bytesRead: 6 }
    });
    const { payload } = await bodyOf("get_file_at_ref", { repoSlug: "r", ref: "develop", path: "a.bin" }, undefined, client);
    assert.equal(payload.binary, true);
    assert.equal(payload.content, undefined);
  }
});

test("a missing path is path_not_found; a missing ref is ref_not_found", async () => {
  const nf = new BitbucketHttpError(404, "nf");
  {
    const { client } = recording({ getBranch: { target: { hash: SHA } }, getSrcMeta: nf, listFileHistory: nf });
    assert.equal((await bodyOf("get_file_at_ref", { repoSlug: "r", ref: "d", path: "x.md" }, undefined, client)).payload.code, "path_not_found");
    assert.equal((await bodyOf("get_file_history", { repoSlug: "r", ref: "d", path: "x.md" }, undefined, client)).payload.code, "path_not_found");
  }
  {
    const { client } = recording({ getBranch: nf, getTag: nf });
    assert.equal((await bodyOf("get_file_at_ref", { repoSlug: "r", ref: "gone", path: "x" }, undefined, client)).payload.code, "ref_not_found");
  }
});

test("get_file_history asks for the commit fields and refuses the repo root", async () => {
  const { client, calls } = recording({
    getBranch: { target: { hash: SHA } },
    listFileHistory: { values: [{ path: "a.ts", size: 5, commit: { hash: SHA, date: "d", message: "subj\nbody", author: { raw: "A <a@x>" } } }] }
  });
  const { payload } = await bodyOf("get_file_history", { repoSlug: "r", ref: "develop", path: "a.ts" }, undefined, client);
  const params = calls.find((c) => c.method === "listFileHistory")?.args[3] as { fields: string };
  assert.match(params.fields, /values\.commit\.message/);
  assert.deepEqual(payload.history[0], { sha: SHA, date: "d", author: "A <a@x>", subject: "subj", pathAtCommit: "a.ts", size: 5 });

  const root = await bodyOf("get_file_history", { repoSlug: "r", path: "/" }, undefined, client);
  assert.equal(root.payload.code, "invalid_path");
});

test("search_code scopes with repo:, ignores the default repo, keeps only matched lines", async () => {
  const hit = {
    content_match_count: 1,
    file: { path: "docs/a.md", links: { self: { href: "https://api.bitbucket.org/2.0/repositories/ws/wec.aria/src/abc123/docs/a.md" } } },
    content_matches: [{ lines: [{ line: 1, segments: [{ text: "context" }] }, { line: 2, segments: [{ text: "run " }, { text: "pnpm", match: true }] }] }]
  };
  const withDefault = { ...CONFIG, defaultRepo: "other" } as BitbucketConfig;
  const { client, calls } = recording({ searchCode: { values: [hit], size: 1 } });

  await bodyOf("search_code", { query: "pnpm" }, withDefault, client);
  assert.equal(calls[0]?.args[0], "pnpm", "no repoSlug means the whole workspace, default repo or not");

  const { payload } = await bodyOf("search_code", { query: "pnpm", repoSlug: "wec.aria" }, withDefault, client);
  assert.equal(calls[1]?.args[0], "repo:wec.aria pnpm");
  assert.deepEqual(payload.results[0], { repo: "wec.aria", path: "docs/a.md", indexedAt: "abc123", matchCount: 1, lines: [{ line: 2, text: "run pnpm" }] });

  assert.deepEqual(payload.indexedAt, ["wec.aria@abc123"], "the indexed commit is echoed at the top level");

  const bad = await bodyOf("search_code", { query: "x", repoSlug: "a b" }, undefined, client);
  assert.equal(bad.payload.code, "invalid_repo_slug");
  assert.equal(calls.length, 2);
});

test("search_code turns 404/403 into code_search_unavailable", async () => {
  for (const status of [404, 403]) {
    const { client } = recording({ searchCode: new BitbucketHttpError(status, "x") });
    const { payload } = await bodyOf("search_code", { query: "x" }, undefined, client);
    assert.equal(payload.code, "code_search_unavailable", String(status));
  }
});
