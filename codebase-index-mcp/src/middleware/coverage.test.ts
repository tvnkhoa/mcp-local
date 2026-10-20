import assert from "node:assert/strict";
import test from "node:test";

import { buildCoverageBlock } from "./coverage.js";

/**
 * A count the graph cannot vouch for must not be reported as `high`.
 *
 * Measured on wec.aria (2026-10-20): `find_field_accesses(kb_version_ids)` returned 0 reads, 0 writes
 * and `coverage: "high"` for a Zod contract field read across two packages, from an index 463 commits
 * behind HEAD. A confident zero sends an agent back to grep for good.
 */

const TS_GAP = "TS/JS property edges cover only `this.<member>` accesses";

test("an empty result under a language gap is low, with the gap named", () => {
  const c = buildCoverageBlock({ resultCount: 0, expectedNonZero: true, kind: "field_accesses", query: "kb_version_ids", languageGaps: [TS_GAP] });
  assert.equal(c.confidence, "low");
  assert.ok(c.knownGaps.includes(TS_GAP));
  assert.notEqual(c.suggestFallback, null);
});

test("a non-empty result under a language gap is capped at medium — it is a lower bound", () => {
  const c = buildCoverageBlock({ resultCount: 4, kind: "field_accesses", query: "name", languageGaps: [TS_GAP] });
  assert.equal(c.confidence, "medium");
  assert.ok(c.knownGaps.includes(TS_GAP));
});

test("a stale index caps confidence at medium and says how far behind it is", () => {
  const c = buildCoverageBlock({ resultCount: 3, kind: "field_accesses", staleness: { commitsBehind: 463, dirtyCount: 2 } });
  assert.equal(c.confidence, "medium");
  assert.ok(c.knownGaps.some((g) => g.includes("463 commit(s) behind")));
  assert.match(c.suggestFallback ?? "", /re-index/);
});

test("an unknown distance behind HEAD is reported as unknown, not as a number", () => {
  const c = buildCoverageBlock({ resultCount: 1, kind: "search", staleness: { commitsBehind: null, dirtyCount: 0 } });
  assert.ok(c.knownGaps.some((g) => g.includes("an unknown number of commit(s)")));
});

test("a fresh, gap-free, non-empty result is still high", () => {
  const c = buildCoverageBlock({ resultCount: 5, kind: "field_accesses", staleness: null, languageGaps: [] });
  assert.equal(c.confidence, "high");
  assert.deepEqual(c.knownGaps, []);
  assert.equal(c.suggestFallback, null);
});
