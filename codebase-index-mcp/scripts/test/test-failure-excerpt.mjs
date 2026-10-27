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

// No failure markers: just the tail, as before. No output at all: said so.
assert.deepEqual(failureExcerpt("a\nb\nc", { tail: 2 }), ["b", "c"]);
assert.deepEqual(failureExcerpt(""), ["(no output)"]);

console.log("test-failure-excerpt: all checks passed");
