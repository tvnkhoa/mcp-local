import assert from "node:assert/strict";
import test from "node:test";

import { assessRunHealth, PARSE_FAILURE_DEGRADED_RATIO } from "./runFinalize.js";
import type { RunCounters } from "./runFinalize.js";

/**
 * The check that decides whether a completed run produced a graph worth trusting.
 *
 * It exists because of a measured incident: a full re-index of this workspace reported `ok` while
 * upserting 57 symbols and **0 edges** against 217 parse failures, having previously produced 2097
 * symbols and 6233 edges from the same tree. `health_check` then showed a run at HEAD with status
 * `ok`, so every graph tool answered from an empty index with no warning. The regression cases
 * below are that incident's exact counters.
 *
 * Pure — counters in, verdict out, no store and no SQLite — which is the property that lets the
 * check itself be tested rather than only its effects.
 */

function counters(parts: Partial<RunCounters> = {}): RunCounters {
  return {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    symbolsUpserted: 0,
    edgesUpserted: 0,
    docsUpserted: 0,
    mentionsUpserted: 0,
    parseFailures: 0,
    parseTimeouts: 0,
    edgesDroppedByConfidence: 0,
    edgesDroppedByCallCap: 0,
    edgesDroppedByTypeRefCap: 0,
    ...parts
  };
}

test("a healthy full run is not degraded", () => {
  // The restored run of this workspace, verbatim.
  const health = assessRunHealth(
    counters({ filesScanned: 454, filesIndexed: 400, filesSkipped: 54, symbolsUpserted: 2180, edgesUpserted: 6522 }),
    "full"
  );
  assert.equal(health.degraded, false);
  assert.deepEqual(health.reasons, []);
});

test("the incident run is degraded, and both checks fire", () => {
  const health = assessRunHealth(
    counters({
      filesScanned: 454, filesIndexed: 57, filesSkipped: 54,
      symbolsUpserted: 57, edgesUpserted: 0,
      parseFailures: 217, parseTimeouts: 126
    }),
    "full"
  );
  assert.equal(health.degraded, true);
  assert.equal(health.reasons.length, 2, `expected both checks to fire, got: ${JSON.stringify(health.reasons)}`);
  assert.match(health.reasons[0], /217 of 274 files failed to parse/);
  assert.match(health.reasons[0], /126 timeout/);
  assert.match(health.reasons[1], /0 edges/);
});

test("the parse-failure threshold is a floor, not a tripwire on the first failure", () => {
  // One failure in a large run is normal — an odd file, a generated blob.
  const occasional = assessRunHealth(counters({ filesIndexed: 399, parseFailures: 1, edgesUpserted: 6000 }), "full");
  assert.equal(occasional.degraded, false);

  // Exactly at the threshold must fire, so the boundary is pinned rather than implied.
  const atThreshold = assessRunHealth(counters({ filesIndexed: 90, parseFailures: 10, edgesUpserted: 6000 }), "full");
  assert.equal(10 / 100, PARSE_FAILURE_DEGRADED_RATIO);
  assert.equal(atThreshold.degraded, true);
});

test("zero edges is scoped to full runs", () => {
  const base = { filesIndexed: 40, symbolsUpserted: 300, edgesUpserted: 0 };

  // An incremental or dirty run over files that contain no edges is unremarkable.
  assert.equal(assessRunHealth(counters(base), "incremental").degraded, false);
  assert.equal(assessRunHealth(counters(base), "dirty").degraded, false);
  assert.equal(assessRunHealth(counters(base), "full").degraded, true);
});

test("a tiny repo with no edges is not degraded", () => {
  // Below the file floor, "no edges" says nothing — a three-file repo may genuinely have none.
  const tiny = assessRunHealth(counters({ filesIndexed: 3, symbolsUpserted: 12, edgesUpserted: 0 }), "full");
  assert.equal(tiny.degraded, false);
});

test("an empty run reports nothing rather than dividing by zero", () => {
  const empty = assessRunHealth(counters(), "full");
  assert.equal(empty.degraded, false);
  assert.deepEqual(empty.reasons, []);
});
