import test from "node:test";
import assert from "node:assert/strict";

import type { ObserveConfig } from "./config.js";
import { PolicyViolationError } from "./errors.js";
import {
  resolveWindow,
  clampSize,
  sqlString,
  sqlIdent,
  assertTraceId,
  buildSearchLogsSql,
  buildTraceLogsSql,
  buildLogStatsSql,
  buildSampleSql
} from "./queryBuilder.js";

const cfg = {
  defaultLookbackMs: 3_600_000,
  maxLookbackMs: 604_800_000,
  defaultSize: 100,
  maxSize: 1000
} as unknown as ObserveConfig;

const NOW = 1_700_000_000_000; // fixed epoch ms

test("resolveWindow: relative window ends now and spans the requested lookback", () => {
  const w = resolveWindow({ time: "1h" }, cfg, NOW);
  assert.equal(w.endUs, NOW * 1000);
  assert.equal(w.endUs - w.startUs, 3_600_000 * 1000);
});

test("resolveWindow: default lookback when nothing supplied", () => {
  const w = resolveWindow({}, cfg, NOW);
  assert.equal(w.endUs - w.startUs, cfg.defaultLookbackMs * 1000);
});

test("resolveWindow: absolute epoch-ms start/end", () => {
  const w = resolveWindow({ start: String(NOW - 10_000), end: String(NOW) }, cfg, NOW);
  assert.equal(w.startUs, (NOW - 10_000) * 1000);
  assert.equal(w.endUs, NOW * 1000);
});

test("resolveWindow: rejects end <= start", () => {
  assert.throws(() => resolveWindow({ start: String(NOW), end: String(NOW - 1) }, cfg, NOW), PolicyViolationError);
});

test("resolveWindow: rejects windows over the max lookback", () => {
  assert.throws(() => resolveWindow({ time: "8d" }, cfg, NOW), PolicyViolationError);
});

test("clampSize: default / floor / clamp to max", () => {
  assert.equal(clampSize(undefined, cfg), 100);
  assert.equal(clampSize(0, cfg), 1);
  assert.equal(clampSize(5000, cfg), 1000);
  assert.equal(clampSize(42.9, cfg), 42);
});

test("sqlString escapes embedded quotes", () => {
  assert.equal(sqlString("a'b"), "'a''b'");
});

test("sqlIdent rejects injection, quotes safe names", () => {
  assert.equal(sqlIdent("wecrm_dev"), '"wecrm_dev"');
  assert.throws(() => sqlIdent("a; DROP TABLE x"), PolicyViolationError);
});

test("assertTraceId accepts hex, rejects non-hex", () => {
  assert.equal(assertTraceId("4e1587dc3b8a0393"), "4e1587dc3b8a0393");
  assert.throws(() => assertTraceId("nope!"), PolicyViolationError);
});

test("buildSearchLogsSql: SELECT * by default, projection when columns given", () => {
  assert.match(buildSearchLogsSql("wecrm_dev", { level: "ERROR" }, 10), /^SELECT \* FROM "wecrm_dev" WHERE/);
  const projected = buildSearchLogsSql("wecrm_dev", {}, 10, ["_timestamp", "body"]);
  assert.match(projected, /^SELECT _timestamp, body FROM "wecrm_dev"/);
});

test("buildSearchLogsSql: rejects an unsafe projection column", () => {
  assert.throws(() => buildSearchLogsSql("wecrm_dev", {}, 10, ["body; DROP"]), PolicyViolationError);
});

test("buildTraceLogsSql matches either trace id column and orders ascending", () => {
  const sql = buildTraceLogsSql("wecrm_dev", "4e1587dc3b8a0393", 50);
  assert.match(sql, /trace_id = '4e1587dc3b8a0393' OR traceid = '4e1587dc3b8a0393'/);
  assert.match(sql, /ORDER BY _timestamp ASC/);
});

test("buildLogStatsSql groups and orders by count", () => {
  assert.equal(
    buildLogStatsSql("wecrm_dev", "severity", 10),
    'SELECT severity, COUNT(*) AS count FROM "wecrm_dev" GROUP BY severity ORDER BY count DESC LIMIT 10'
  );
});

test("buildSampleSql selects recent rows for schema discovery", () => {
  assert.equal(buildSampleSql("wecrm_dev", 5), 'SELECT * FROM "wecrm_dev" ORDER BY _timestamp DESC LIMIT 5');
});
