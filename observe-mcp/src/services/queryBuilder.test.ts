import test from "node:test";
import assert from "node:assert/strict";

import type { ObserveLimits } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";
import {
  resolveWindow,
  clampSize,
  sqlString,
  sqlIdent,
  assertTraceId,
  buildSearchLogsSql,
  buildTraceLogsSql,
  buildLogStatsSql,
  buildSampleSql,
  buildTraceSpansSql,
  buildServiceInventorySql,
  buildTraceServiceInventorySql,
  buildContextInventorySql,
  buildServiceContextMatrixSql
} from "./queryBuilder.js";

const cfg = {
  defaultLookbackMs: 3_600_000,
  maxLookbackMs: 604_800_000,
  defaultSize: 100,
  maxSize: 1000
} as unknown as ObserveLimits;

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

test("REGRESSION: buildTraceSpansSql names ONE trace-id column, not an OR of both", () => {
  // A traces stream has `trace_id` (OTel) or `traceid`, never both. DataFusion
  // rejects an unknown column while planning, so the previous
  // `(trace_id = .. OR traceid = ..)` form failed the entire query with
  // "Schema error: No field named traceid" and get_trace_spans returned nothing
  // on every standard traces stream.
  const sql = buildTraceSpansSql("wecrm_traces", "4e1587dc3b8a0393", 50);
  assert.match(sql, /WHERE trace_id = '4e1587dc3b8a0393' ORDER BY start_time ASC LIMIT 50$/);
  assert.equal(/traceid/.test(sql), false);
  assert.equal(/ OR /.test(sql), false);

  // The caller retries with the other spelling when the first is absent.
  const alt = buildTraceSpansSql("wecrm_traces", "4e1587dc3b8a0393", 50, "traceid");
  assert.match(alt, /WHERE traceid = '4e1587dc3b8a0393'/);
  assert.equal(/trace_id/.test(alt), false);
});

test("buildTraceLogsSql keeps the OR — a logs stream really can use either", () => {
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

test("buildSampleSql narrows the sample to one service when asked", () => {
  assert.equal(
    buildSampleSql("wecrm_dev", 5, "CRM.Gateway"),
    'SELECT * FROM "wecrm_dev" WHERE service_name = \'CRM.Gateway\' ORDER BY _timestamp DESC LIMIT 5'
  );
});

// --- discovery builders ------------------------------------------------------

test("buildServiceInventorySql: one round trip for volume, severity split and liveness", () => {
  const sql = buildServiceInventorySql("wecrm_dev", 200);
  assert.match(sql, /^SELECT service_name, COUNT\(\*\) AS log_count/);
  assert.match(sql, /MIN\(_timestamp\) AS first_seen, MAX\(_timestamp\) AS last_seen/);
  assert.match(sql, /COUNT\(DISTINCT instrumentation_library_name\) AS context_count/);
  assert.match(sql, /GROUP BY service_name ORDER BY log_count DESC LIMIT 200$/);
});

test("buildServiceInventorySql: severity matched case-insensitively, both vocabularies", () => {
  // These orgs emit title-case Serilog levels; an OTel-native exporter emits
  // uppercase. UPPER() plus both spellings keeps the counts right either way.
  const sql = buildServiceInventorySql("wecrm_dev", 10);
  assert.match(sql, /UPPER\(severity\) IN \('ERROR', 'FATAL', 'CRITICAL'\)/);
  assert.match(sql, /UPPER\(severity\) IN \('WARNING', 'WARN'\)/);
});

test("buildTraceServiceInventorySql: no severity column, orders by span volume", () => {
  const sql = buildTraceServiceInventorySql("wecrm_traces", 50);
  assert.match(sql, /COUNT\(\*\) AS span_count/);
  assert.match(sql, /ORDER BY span_count DESC LIMIT 50$/);
  // A traces stream has no `severity`; referencing it would fail the query.
  assert.equal(/severity/.test(sql), false);
});

test("buildContextInventorySql: excludes nulls, optionally scopes to a service", () => {
  const all = buildContextInventorySql("wecrm_dev", 100);
  assert.match(all, /WHERE instrumentation_library_name IS NOT NULL GROUP BY/);
  const scoped = buildContextInventorySql("wecrm_dev", 100, "CRM.Gateway");
  assert.match(scoped, /AND service_name = 'CRM\.Gateway'/);
});

test("buildServiceContextMatrixSql pairs service with context", () => {
  const sql = buildServiceContextMatrixSql("wecrm_dev", 1000);
  assert.match(sql, /GROUP BY service_name, instrumentation_library_name ORDER BY count DESC LIMIT 1000$/);
});

test("discovery builders reject an injected stream or service", () => {
  assert.throws(() => buildServiceInventorySql("a; DROP TABLE x", 10), PolicyViolationError);
  assert.throws(() => buildTraceServiceInventorySql("a; DROP TABLE x", 10), PolicyViolationError);
  assert.throws(() => buildServiceContextMatrixSql("a; DROP TABLE x", 10), PolicyViolationError);
  // A service name is a quoted literal, not an identifier — it must be escaped,
  // not rejected, so a legitimate name containing a quote still works.
  assert.match(buildContextInventorySql("wecrm_dev", 10, "a'b"), /service_name = 'a''b'/);
});
