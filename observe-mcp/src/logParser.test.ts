import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLog, capLog } from "./logParser.js";

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
