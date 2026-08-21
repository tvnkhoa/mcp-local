/**
 * The pipeline tool group's own behaviour: the status filter vocabulary,
 * reference normalization, and the log tail bound.
 *
 * These are the three things the group does *before* it reaches the network, so
 * they are the three things worth pinning. Everything about dispatch, the error
 * envelope and the tool table lives in `tools.test.ts`; nothing here touches the
 * network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PIPELINE_LOG_DEFAULT_BYTES,
  PIPELINE_LOG_MAX_BYTES,
  PIPELINE_STATUS_VALUES,
  pipelineRefPath,
  stepUuidPath
} from "./pipelines.js";
import { shapeStepLog, tailBytes } from "./pipelineLog.js";

const UUID = "11111111-2222-3333-4444-555555555555";

// --- the status filter vocabulary -------------------------------------------
//
// This list is load-bearing and was established by probing the live API on
// 2026-08-21 (see the comment on PIPELINE_STATUS_VALUES). The two assertions
// below encode the traps that probe found, so a future "tidy-up" that aligns the
// filter names with the response names reintroduces a silently-empty filter.

test("PASSED is in the vocabulary and SUCCESSFUL/COMPLETED are deliberately not", () => {
  assert.ok(PIPELINE_STATUS_VALUES.includes("PASSED"));
  // The response says SUCCESSFUL, but filtering by it matched nothing live.
  assert.equal(PIPELINE_STATUS_VALUES.includes("SUCCESSFUL" as never), false);
  // COMPLETED is a state, not a filter value; it matched nothing live.
  assert.equal(PIPELINE_STATUS_VALUES.includes("COMPLETED" as never), false);
});

test("the vocabulary has no duplicates and is all upper-case", () => {
  assert.equal(new Set(PIPELINE_STATUS_VALUES).size, PIPELINE_STATUS_VALUES.length);
  for (const value of PIPELINE_STATUS_VALUES) {
    assert.equal(value, value.toUpperCase());
  }
});

// --- reference normalization ------------------------------------------------

test("a pipeline UUID resolves to the braced form Bitbucket uses, braces optional", () => {
  assert.equal(pipelineRefPath(UUID), `{${UUID}}`);
  assert.equal(pipelineRefPath(`{${UUID}}`), `{${UUID}}`);
  assert.equal(pipelineRefPath(`  {${UUID}}  `), `{${UUID}}`);
});

test("a build number is passed through unbraced", () => {
  assert.equal(pipelineRefPath("42"), "42");
});

test("anything else is refused here rather than 404ing upstream", () => {
  assert.throws(() => pipelineRefPath("not-a-uuid"), /invalid_pipeline_ref|neither a pipeline UUID/);
  assert.throws(() => pipelineRefPath("12ab"), /neither a pipeline UUID/);
});

test("a step is only ever addressed by UUID — a build number is refused", () => {
  assert.equal(stepUuidPath(UUID), `{${UUID}}`);
  assert.equal(stepUuidPath(`{${UUID}}`), `{${UUID}}`);
  assert.throws(() => stepUuidPath("42"), /not a step UUID/);
});

// --- log tail ---------------------------------------------------------------

test("a log within the bound is returned whole and not marked truncated", () => {
  const log = "line one\nline two\n";
  assert.deepEqual(tailBytes(log, 1024), { text: log, truncated: false });
});

test("a log over the bound keeps the END, drops the partial first line, and says so", () => {
  const log = "first\nsecond\nthird\nfourth\n";
  const { text, truncated } = tailBytes(log, 14);
  assert.equal(truncated, true);
  // 14 bytes of the tail is "third\nfourth\n" plus part of "second"; the partial
  // line is dropped so the tail starts on a line boundary.
  assert.equal(text, "third\nfourth\n");
  assert.ok(Buffer.byteLength(text, "utf8") <= 14);
  assert.ok(log.endsWith(text));
});

test("a tail with no newline at all is returned as-is rather than emptied", () => {
  const { text, truncated } = tailBytes("abcdefghij", 4);
  assert.equal(truncated, true);
  assert.equal(text, "ghij");
});

test("the log bounds are the documented ones", () => {
  assert.equal(PIPELINE_LOG_DEFAULT_BYTES, 262_144);
  assert.equal(PIPELINE_LOG_MAX_BYTES, 1_048_576);
  assert.ok(PIPELINE_LOG_DEFAULT_BYTES < PIPELINE_LOG_MAX_BYTES);
});

// --- shapeStepLog: the 206 rule ----------------------------------------------

test("a whole log delivered as a partial response is NOT reported as cut", () => {
  // partial=false is what the client now derives from Content-Range offset 0.
  // This is the default path (256 KiB tail vs a 9 KB log) and reading it as a cut
  // deleted the log's real first line.
  const log = "+ umask 000\nbuilding\ndone\n";
  assert.deepEqual(shapeStepLog(log, 262_144, false), { text: log, truncated: false });
});

test("a log upstream really did cut is reported as cut, fragment dropped", () => {
  const raw = "alf a line\nreal line\n";
  assert.deepEqual(shapeStepLog(raw, 262_144, true), { text: "real line\n", truncated: true });
});

test("an over-long body is cut here even when upstream did not cut it", () => {
  const raw = "first\nsecond\nthird\nfourth\n";
  const shaped = shapeStepLog(raw, 14, false);
  assert.equal(shaped.truncated, true);
  assert.ok(raw.endsWith(shaped.text));
  assert.ok(Buffer.byteLength(shaped.text, "utf8") <= 14);
});

test("an empty log is not a cut", () => {
  assert.deepEqual(shapeStepLog("", 262_144, false), { text: "", truncated: false });
});
