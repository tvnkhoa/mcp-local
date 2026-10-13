/**
 * The pure helpers behind the commit/compare/source tools: validators, path
 * encoding, cursors, the compare spec, ref resolution, and the bounded body read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BitbucketHttpError } from "../middleware/errors.js";
import { readCapped } from "../services/boundedBody.js";
import {
  buildCompareSpec,
  cursorFromNext,
  encodeRepoPath,
  formatCursor,
  parseCursor,
  resolveToSha,
  validateRef,
  validateRepoPath,
  validateSha
} from "./refs.js";
import { recording } from "./harness.test.js";

const SHA = "b2dce2fd01b742570618a44c8249680dd35b4fe5";

test("validateSha accepts 7–40 hex, lowercased, and refuses anything else", () => {
  assert.equal(validateSha("B2DCE2F"), "b2dce2f");
  assert.equal(validateSha(SHA), SHA);
  for (const bad of ["b2dce2", "xyz1234", `${SHA}0`, "develop"]) {
    assert.throws(() => validateSha(bad), { code: "invalid_sha" }, bad);
  }
});

test("validateRef accepts branch names with slashes and refuses what would break a spec or path", () => {
  for (const ok of ["develop", "feature/JIRA-1_x", "v1.2.3", SHA]) {
    assert.equal(validateRef(ok), ok);
  }
  // `..` matters most: the compare spec is `x..y`, so a ref holding one would
  // smuggle a different comparison upstream.
  for (const bad of ["a..b", "a//b", "/a", "a/", "-a", "a.lock", "a.", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a@{1}", ""]) {
    assert.throws(() => validateRef(bad), { code: "invalid_ref" }, JSON.stringify(bad));
  }
});

test("validateRepoPath strips trailing slashes, allows the root, refuses traversal", () => {
  assert.equal(validateRepoPath("docs/adr/"), "docs/adr");
  assert.equal(validateRepoPath(""), "");
  for (const bad of ["/etc", "../x", "a/../b", "a/./b", "a//b", "a\\b", "a\u0000b"]) {
    assert.throws(() => validateRepoPath(bad), { code: "invalid_path" }, JSON.stringify(bad));
  }
});

test("encodeRepoPath encodes each segment and keeps the slashes", () => {
  assert.equal(encodeRepoPath("a b/c#d/e?.md"), "a%20b/c%23d/e%3F.md");
  assert.equal(encodeRepoPath(""), "");
});

test("cursors carry only page, ctx and skip — never the next URL's host or other params", () => {
  // The two shapes seen live on 2026-10-13: /commits pages with page+ctx, a
  // /src directory listing with an opaque page token.
  assert.equal(
    cursorFromNext("https://api.bitbucket.org/2.0/repositories/w/r/commits?pagelen=100&fields=x&ctx=abc123&page=2"),
    "page=2&ctx=abc123"
  );
  assert.equal(cursorFromNext("https://api.bitbucket.org/2.0/repositories/w/r/src/s/docs/?pagelen=2&page=E8Ux"), "page=E8Ux");
  assert.equal(cursorFromNext(undefined), null);
  assert.equal(cursorFromNext("https://x/?pagelen=2"), null);

  assert.deepEqual(parseCursor("page=2&ctx=abc123"), { page: "2", ctx: "abc123" });
  assert.deepEqual(parseCursor(formatCursor({ page: "1", skip: 7 })), { page: "1", skip: 7 });
  for (const bad of ["", "ctx=a", "page=2&host=evil", "page=1&skip=-1", "page=1&skip=101", "page=1&skip=x"]) {
    assert.throws(() => parseCursor(bad), { code: "invalid_cursor" }, bad);
  }
});

test("buildCompareSpec puts head first — Bitbucket's order, the reverse of git's", () => {
  // Pinned by the live check on 2026-10-13: diffstat/<develop>..<master> listed
  // develop's added files; the other order was empty.
  assert.equal(buildCompareSpec("head1", "base2"), "head1..base2");
});

test("resolveToSha: a full SHA is used as is, a name tries branch then tag, a short SHA is expanded", async () => {
  const notFound = new BitbucketHttpError(404, "nf");
  {
    const { client, calls } = recording({});
    assert.deepEqual(await resolveToSha(client, "r", SHA.toUpperCase()), { ref: SHA.toUpperCase(), sha: SHA, kind: "sha" });
    assert.equal(calls.length, 0);
  }
  {
    const { client } = recording({ getBranch: notFound, getTag: { target: { hash: SHA } } });
    assert.deepEqual(await resolveToSha(client, "r", "v1.0"), { ref: "v1.0", sha: SHA, kind: "tag" });
  }
  {
    const { client } = recording({ getBranch: notFound, getTag: notFound, getCommit: { hash: SHA } });
    assert.equal((await resolveToSha(client, "r", "b2dce2f")).sha, SHA);
  }
  {
    const { client } = recording({ getRepository: { mainbranch: { name: "master" } }, getBranch: { target: { hash: SHA } } });
    assert.deepEqual(await resolveToSha(client, "r", undefined), { ref: "master", sha: SHA, kind: "main" });
  }
  {
    const { client } = recording({ getBranch: notFound, getTag: notFound });
    await assert.rejects(resolveToSha(client, "r", "gone"), { code: "ref_not_found" });
  }
  {
    // Anything but a 404 is a real failure, not "try the next kind".
    const { client } = recording({ getBranch: new BitbucketHttpError(403, "no") });
    await assert.rejects(resolveToSha(client, "r", "develop"), { status: 403 });
  }
});

// --- readCapped ---------------------------------------------------------------

function streamed(...chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(enc.encode(c));
        }
        controller.close();
      }
    })
  );
}

test("readCapped returns the whole body under or at the cap", async () => {
  assert.deepEqual(await readCapped(streamed("abc", "de"), 10), { text: "abcde", truncated: false, bytesRead: 5 });
  assert.deepEqual(await readCapped(streamed("abc", "de"), 5), { text: "abcde", truncated: false, bytesRead: 5 });
});

test("readCapped stops at the cap and says so", async () => {
  assert.deepEqual(await readCapped(streamed("abc", "def", "ghi"), 4), { text: "abcd", truncated: true, bytesRead: 4 });
});

test("readCapped never invents a character when the cut splits a UTF-8 sequence", async () => {
  // "é" is two bytes; a 2-byte cap keeps "a" plus half of "é", which is dropped.
  const out = await readCapped(streamed("aé"), 2);
  assert.equal(out.text, "a");
  assert.equal(out.truncated, true);
});
