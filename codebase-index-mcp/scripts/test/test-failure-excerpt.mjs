/**
 * `run-tests.mjs` names the failing test (CI run 40475337059 failed `test:unit` 490/491 with no test name in
 * the log): `failureExcerpt` prints every `not ok` line with its YAML block before the tail.
 *
 * Usage: node scripts/test/test-failure-excerpt.mjs
 */

import assert from "node:assert/strict";

import { failureExcerpt } from "../lib/failureExcerpt.mjs";

const filler = Array.from({ length: 60 }, (_, i) => `ok ${String(i + 1)} - passing ${String(i + 1)}`);
const failing = [
  "# Subtest: a query from another process while a full index runs",
  "not ok 61 - a query from another process while a full index runs",
  "  ---",
  "  duration_ms: 812.5",
  "  location: 'D:\\\\repo\\\\src\\\\middleware\\\\freshness.test.ts:1:2'",
  "  failureType: 'testCodeFailure'",
  "  error: 'the child was still running'",
  "  ...",
];
const summary = Array.from({ length: 30 }, (_, i) => `# summary line ${String(i)}`);
const tap = [...filler.slice(0, 30), ...failing, ...filler.slice(30), "1..91", "# pass 90", "# fail 1", ...summary].join("\n");

// The old tail-only output: the failing name is not in the last 25 lines.
assert.equal(tap.split("\n").slice(-25).some((line) => line.includes("a query from another process")), false);

const out = failureExcerpt(tap);
assert.equal(out[0], "1 failing test(s):");
assert.deepEqual(out.slice(1, 1 + failing.length - 1), failing.slice(1), "the not ok line and its whole YAML block, in order");
assert.ok(out.includes("last 25 line(s):"));
assert.deepEqual(out.slice(-25), tap.split("\n").slice(-25), "the tail is still printed");

// CRLF output (Windows) parses the same way.
assert.deepEqual(failureExcerpt(tap.replaceAll("\n", "\r\n")), out);

// Nested failures (a subtest and its parent) are both listed; a cap names how many were left out.
const many = Array.from({ length: 12 }, (_, i) => `    not ok ${String(i + 1)} - broken ${String(i + 1)}`).join("\n");
const capped = failureExcerpt(many, { maxFailures: 10 });
assert.equal(capped[0], "12 failing test(s), first 10 shown:");
// 10 listed, then the 12-line output is short enough to appear whole in the tail.
assert.equal(capped.filter((line) => /not ok/.test(line)).length, 10 + 12);

// A long YAML block is cut, and an unterminated one does not run off the end.
const longBlock = ["not ok 1 - long", "  ---", ...Array.from({ length: 100 }, (_, i) => `  line ${String(i)}`)].join("\n");
const cut = failureExcerpt(longBlock, { maxBlockLines: 10 });
assert.ok(cut.includes("  … (block truncated)"));

// A .mjs harness (CI run 42577407542, test:index-lock-contention): no TAP; its `info` lines (stdout) and
// `FAIL`/`✗` lines (stderr) come before a long server-stderr dump. Both are kept, ahead of the tail, and in order.
const harnessOut = [
  "  PASS  baseline index_repository lk-small-1",
  "  info  window 31234 ms; reads 24: small:120/fresh big:2410",
  "  info  server A main-thread ticks late > 100 ms: 3, max 1450 ms",
  "",
  "Results: 9 passed, 1 failed",
  "  FAIL  (b) no server-thread block > 1000 ms — [{\"blockedMs\":1450}]",
  "  ✗ FAIL: another harness's style",
  "--- test-index-lock-contention:A stderr (last 65536 bytes before exit 1) ---",
  ...Array.from({ length: 200 }, (_, i) => `[lag-sampler] {"at":${String(i)},"heartbeat":true,"maxMs":12}`),
  "✓ index lk-big-1 · 1200 files · 22.8s",
  "--- end test-index-lock-contention:A stderr ---",
].join("\n");
assert.equal(harnessOut.split("\n").slice(-25).some((line) => line.includes("FAIL")), false, "the tail alone loses the FAIL line");
const hx = failureExcerpt(harnessOut);
assert.deepEqual(hx.slice(0, 5), [
  "harness FAIL/info line(s):",
  "  info  window 31234 ms; reads 24: small:120/fresh big:2410",
  "  info  server A main-thread ticks late > 100 ms: 3, max 1450 ms",
  "  FAIL  (b) no server-thread block > 1000 ms — [{\"blockedMs\":1450}]",
  "  ✗ FAIL: another harness's style",
]);
assert.ok(hx.includes("last 25 line(s):"));
assert.deepEqual(hx.slice(-25), harnessOut.split("\n").slice(-25), "the tail is still printed");
assert.equal(hx.filter((line) => line.includes("PASS")).length, 0, "PASS lines are not harness lines");
// A harness line already in the tail is not repeated; long lines and many lines are capped.
assert.deepEqual(failureExcerpt("x\n  FAIL  near the end", { tail: 5 }), ["x", "  FAIL  near the end"]);
const capH = failureExcerpt([...Array.from({ length: 50 }, (_, i) => `  info  ${"v".repeat(3000)} ${String(i)}`), ...Array(30).fill("z")].join("\n"));
assert.equal(capH[0], "harness FAIL/info line(s), first 40 of 50:");
assert.ok(capH[1].endsWith(" … (line truncated)") && capH[1].length < 2100);

// No failure markers: just the tail, as before. No output at all: said so.
assert.deepEqual(failureExcerpt("a\nb\nc", { tail: 2 }), ["b", "c"]);
assert.deepEqual(failureExcerpt(""), ["(no output)"]);

console.log("test-failure-excerpt: all checks passed");
