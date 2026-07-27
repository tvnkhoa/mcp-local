import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_UPSTREAM_BACKOFF_MS,
  backoffFromSchedule,
  encodePathSegment,
  isRetryableStatus,
  isTransientUpstreamStatus,
  truncateForLog
} from "./http/index.js";

// --- Regression: upstream client helper extraction ---------------------------
// observe-mcp and bitbucket-mcp had byte-identical copies of sleep / enc /
// truncate / the backoff schedule, and a shared transience rule inside two
// different retry policies. The helpers are now shared; the policies are not.

test("http: isTransientUpstreamStatus is the clients' rule, not isRetryableStatus", () => {
  // Shared by both clients: no response at all is the most retryable case.
  assert.equal(isTransientUpstreamStatus(0), true);
  assert.equal(isTransientUpstreamStatus(429), true);
  // ANY 5xx, not just the common four.
  for (const status of [500, 501, 502, 503, 504, 505, 599]) {
    assert.equal(isTransientUpstreamStatus(status), true, `${status} should be transient`);
  }
  for (const status of [200, 201, 301, 400, 401, 403, 404, 409, 422]) {
    assert.equal(isTransientUpstreamStatus(status), false, `${status} should not be transient`);
  }

  // The two predicates genuinely differ — that is why both exist.
  assert.notEqual(isTransientUpstreamStatus(0), isRetryableStatus(0));
  assert.notEqual(isTransientUpstreamStatus(408), isRetryableStatus(408));
  assert.notEqual(isTransientUpstreamStatus(501), isRetryableStatus(501));
});

test("http: backoffFromSchedule clamps to the last entry", () => {
  assert.deepEqual([...DEFAULT_UPSTREAM_BACKOFF_MS], [250, 750]);
  assert.equal(backoffFromSchedule(0), 250);
  assert.equal(backoffFromSchedule(1), 750);
  // Beyond the schedule the last delay repeats rather than growing unbounded.
  assert.equal(backoffFromSchedule(2), 750);
  assert.equal(backoffFromSchedule(99), 750);
  // Defensive edges.
  assert.equal(backoffFromSchedule(-1), 250);
  assert.equal(backoffFromSchedule(0, []), 0);
  assert.equal(backoffFromSchedule(5, [10, 20, 30]), 30);
});

test("http: truncateForLog only clips when over the limit", () => {
  assert.equal(truncateForLog("abc", 5), "abc");
  assert.equal(truncateForLog("abcde", 5), "abcde");
  assert.equal(truncateForLog("abcdef", 5), "abcde…");
  assert.equal(truncateForLog("", 5), "");
});

test("http: encodePathSegment escapes separators so a segment cannot climb the path", () => {
  assert.equal(encodePathSegment("simple"), "simple");
  assert.equal(encodePathSegment("with space"), "with%20space");
  assert.equal(encodePathSegment("a/b"), "a%2Fb");
  assert.equal(encodePathSegment(".."), "..");
  assert.equal(encodePathSegment("../../etc"), "..%2F..%2Fetc");
  assert.equal(encodePathSegment("feature/JIRA-1"), "feature%2FJIRA-1");
});
