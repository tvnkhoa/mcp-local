import assert from "node:assert/strict";
import test from "node:test";

import { buildServerInfo } from "./indexHandler.js";

/**
 * wec.aria note #9: after a `/mcp` transport switch a session kept talking to an old stdio child.
 * `health_check.server` says which process answered, so the caller can compare it with the served one.
 */

test("buildServerInfo names this process", () => {
  const info = buildServerInfo("stdio", "2026-01-01T00:00:00.000Z");
  assert.equal(info.pid, process.pid);
  assert.equal(info.transport, "stdio");
  assert.equal(info.buildAt, "2026-01-01T00:00:00.000Z");
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
  assert.ok(Date.parse(info.startedAt) <= Date.now());
});

test("startedAt is fixed at module load, not per call", () => {
  assert.equal(buildServerInfo("http", null).startedAt, buildServerInfo("stdio", null).startedAt);
});

test("transport defaults to what the process was started with (stdio under the test runner)", () => {
  assert.equal(buildServerInfo().transport, "stdio");
});
