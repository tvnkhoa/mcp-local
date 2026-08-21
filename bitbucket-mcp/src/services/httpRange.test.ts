/**
 * `Content-Range` parsing — the thing that decides whether a step log was cut.
 *
 * This exists because reading a bare `206` as "the body is a cut" was wrong and
 * shipped: a suffix range wider than the log is satisfied by returning the whole
 * log, still with 206. Probed against a real 9033-byte step log:
 *
 *   Range: bytes=-1000    -> 206  Content-Range: bytes 8033-9032/9033   (a cut)
 *   Range: bytes=-262144  -> 206  Content-Range: bytes 0-9032/9033      (whole)
 *
 * Since 256 KiB is the default, the second line is the common case — so the old
 * check deleted the genuine first line of nearly every log it returned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { rangeStartOffset } from "./httpRange.js";

test("a range starting past byte 0 is a real cut", () => {
  assert.equal(rangeStartOffset("bytes 8033-9032/9033"), 8033);
});

test("a range starting at byte 0 is the whole representation, not a cut", () => {
  // The exact header a 256 KiB suffix request got back for a 9 KB log.
  assert.equal(rangeStartOffset("bytes 0-9032/9033"), 0);
});

test("no Content-Range means no cut", () => {
  assert.equal(rangeStartOffset(null), 0);
});

test("header casing and padding do not change the answer", () => {
  assert.equal(rangeStartOffset("  BYTES 512-1023/2048"), 512);
});

test("an unparseable header is treated as no cut rather than guessed at", () => {
  // Claiming a cut we cannot prove would delete a real log line.
  assert.equal(rangeStartOffset("bytes */9033"), 0);
  assert.equal(rangeStartOffset("garbage"), 0);
  assert.equal(rangeStartOffset(""), 0);
});
