import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLog, normalizeSpan, capLog, describeFields, microsToIso } from "./logParser.js";

test("normalizeLog maps OpenObserve/Serilog candidate keys", () => {
  const log = normalizeLog({
    _timestamp: 1_700_000_000_000_000, // microseconds
    severity: "Error",
    body: "boom",
    trace_id: "abc123",
    span_id: "def456",
    instrumentation_library_name: "My.Class",
    service_name: "CRM.CRC.Api",
    exception: "System.Exception: boom"
  });
  assert.equal(log.level, "Error");
  assert.equal(log.message, "boom");
  assert.equal(log.traceId, "abc123");
  assert.equal(log.spanId, "def456");
  assert.equal(log.sourceContext, "My.Class");
  assert.equal(log.service, "CRM.CRC.Api");
  assert.equal(log.exception, "System.Exception: boom");
  assert.equal(log.ts, new Date(1_700_000_000_000).toISOString());
});

test("normalizeLog: millisecond timestamps are not multiplied", () => {
  const log = normalizeLog({ timestamp: 1_700_000_000_000 });
  assert.equal(log.ts, new Date(1_700_000_000_000).toISOString());
});

test("REGRESSION: a span's nanosecond start_time is not read as microseconds", () => {
  // Log `_timestamp` is microseconds but a span's `start_time` is NANOseconds. Treating
  // ns as µs is 1000x out and rendered every span as the year 58576 — visible in
  // get_trace_spans and in discover_services' traces lane.
  const ms = 1_786_316_595_941;
  const span = normalizeSpan({ start_time: ms * 1_000_000, duration: 5_000 });
  assert.equal(span.ts, new Date(ms).toISOString());
  assert.equal(new Date(span.ts as string).getUTCFullYear(), 2026);
  // `duration` stays microseconds — unchanged, and not swept up by the fix.
  assert.equal(span.durationMs, 5);
});

test("timestamp unit inference covers ns / us / ms / s", () => {
  const ms = 1_786_316_595_941;
  const expected = new Date(ms).toISOString();
  assert.equal(microsToIso(ms * 1_000_000), expected, "nanoseconds");
  assert.equal(microsToIso(ms * 1_000), expected, "microseconds");
  assert.equal(microsToIso(ms), expected, "milliseconds");
  assert.equal(microsToIso(Math.floor(ms / 1000)), new Date(Math.floor(ms / 1000) * 1000).toISOString(), "seconds");
});

test("describeFields reports observed types and non-null counts, nulls included", () => {
  const fields = describeFields([
    { a: "x", b: 1, c: null },
    { a: "y", b: null, d: [1, 2] }
  ]);
  assert.deepEqual(fields.map((f) => f.name), ["a", "b", "c", "d"]);
  assert.deepEqual(fields.find((f) => f.name === "a"), { name: "a", types: ["string"], nonNull: 2 });
  assert.deepEqual(fields.find((f) => f.name === "b"), { name: "b", types: ["null", "number"], nonNull: 1 });
  // A field that was null in every sampled row is still reported, so a caller can
  // see it exists rather than concluding the column is absent.
  assert.deepEqual(fields.find((f) => f.name === "c"), { name: "c", types: ["null"], nonNull: 0 });
  assert.deepEqual(fields.find((f) => f.name === "d"), { name: "d", types: ["array"], nonNull: 1 });
});

test("capLog drops message when the exception fully contains it", () => {
  const capped = capLog(
    { ts: null, level: "Error", message: "boom", traceId: null, spanId: null, sourceContext: null, service: null, exception: "System.Exception: boom\n at X" },
    { message: 1000, exception: 1000 }
  );
  assert.equal(capped.message, null);
  assert.equal(capped.exception, "System.Exception: boom\n at X");
});

test("capLog truncates long fields with a marker", () => {
  const long = "x".repeat(500);
  const capped = capLog(
    { ts: null, level: null, message: long, traceId: null, spanId: null, sourceContext: null, service: null, exception: null },
    { message: 100, exception: 100 }
  );
  assert.equal(capped.message, `${"x".repeat(100)}…[+400 chars]`);
});

test("capLog drops the exception entirely when its cap is 0 (nano)", () => {
  const capped = capLog(
    { ts: null, level: null, message: "short", traceId: null, spanId: null, sourceContext: null, service: null, exception: "big stack" },
    { message: 200, exception: 0 }
  );
  assert.equal(capped.exception, null);
  assert.equal(capped.message, "short");
});

test("capLog keeps a redundant message when the exception is dropped (nano)", () => {
  // message ⊂ exception, but exception cap 0 drops it — message is then the only
  // error text, so it must survive (capped to the message budget).
  const capped = capLog(
    { ts: null, level: "Error", message: "boom happened", traceId: null, spanId: null, sourceContext: null, service: null, exception: "System.Exception: boom happened\n at X" },
    { message: 200, exception: 0 }
  );
  assert.equal(capped.exception, null);
  assert.equal(capped.message, "boom happened");
});

test("capLog with Infinity caps keeps fields intact (verbose)", () => {
  const long = "y".repeat(9000);
  const capped = capLog(
    { ts: null, level: null, message: "m", traceId: null, spanId: null, sourceContext: null, service: null, exception: long },
    { message: Number.POSITIVE_INFINITY, exception: Number.POSITIVE_INFINITY }
  );
  assert.equal(capped.exception, long);
  assert.equal(capped.message, "m");
});

// --- resolved service identity -----------------------------------------------

const IDENTITY = { appNameField: "applicationname", unknownServiceSentinel: "unknown_service:dotnet" };

test("normalizeLog: a Serilog-path row reports the app name, not the sentinel", () => {
  // ~19% of rows on these orgs arrive this way. Reporting `service_name` verbatim
  // labels all of them with a value that names no application.
  const log = normalizeLog(
    { service_name: "unknown_service:dotnet", applicationname: "CommunicationHub.Web", body: "x" },
    IDENTITY
  );
  assert.equal(log.service, "CommunicationHub.Web");
});

test("normalizeLog: an OTel-path row is untouched by resolution", () => {
  const log = normalizeLog({ service_name: "CRM.Gateway", body: "x" }, IDENTITY);
  assert.equal(log.service, "CRM.Gateway");
});

test("normalizeLog: without identity config the raw column is reported", () => {
  const log = normalizeLog({ service_name: "unknown_service:dotnet", applicationname: "X" });
  assert.equal(log.service, "unknown_service:dotnet");
});

test("normalizeLog: an unnameable row keeps the sentinel rather than going null", () => {
  const log = normalizeLog({ service_name: "unknown_service:dotnet", body: "x" }, IDENTITY);
  assert.equal(log.service, "unknown_service:dotnet");
});

test("normalizeLog: a non-configured spelling of the app-name field still resolves", () => {
  // OpenObserve's flattening is not consistent about case/underscores, so the
  // configured field is tried first and the known variants after it.
  const log = normalizeLog({ service_name: "unknown_service:dotnet", ApplicationName: "CRM.Report.Api" }, IDENTITY);
  assert.equal(log.service, "CRM.Report.Api");
});
