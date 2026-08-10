import test from "node:test";
import assert from "node:assert/strict";

import type { ObserveLimits } from "../config/index.js";
import { ObserveHttpError } from "../middleware/errors.js";
import {
  classifyIdentitySource,
  describeIdentity,
  identityEnabled,
  identitySourceSelect,
  logColumnsWithIdentity,
  resetIdentityCapability,
  resolveServiceValue,
  resolvedServiceExpr,
  withIdentity
} from "./identity.js";

const LIMITS = {
  appNameField: "applicationname",
  unknownServiceSentinel: "unknown_service:dotnet"
} as unknown as ObserveLimits;

const DISABLED = { appNameField: "", unknownServiceSentinel: "" } as unknown as ObserveLimits;

/** The 400 OpenObserve returns when a query names a column the stream lacks. */
function missingColumn(field: string): ObserveHttpError {
  return new ObserveHttpError(
    400,
    "OpenObserve returned 400 Bad Request.",
    `{"code":20008,"error_detail":"Schema error: No field named ${field}."}`
  );
}

// --- the three quadrants ---------------------------------------------------
// Measured live, per ROW: either the OTel SDK path (real service_name, no app name),
// the Serilog path (sentinel + app name), or — once a team sets service.name on its
// sink — both. Per SERVICE the first two routinely coexist; see `mixed` below.

test("resolveServiceValue: the OTel path keeps its resource name", () => {
  assert.equal(resolveServiceValue("CRM.Gateway", null, LIMITS), "CRM.Gateway");
});

test("resolveServiceValue: the Serilog path recovers the name from the enricher field", () => {
  assert.equal(resolveServiceValue("unknown_service:dotnet", "CommunicationHub.Web", LIMITS), "CommunicationHub.Web");
});

test("resolveServiceValue: a fixed service carrying BOTH keeps the resource name", () => {
  // The third quadrant, which appears the moment a team sets service.name on its
  // Serilog sink. Both fields agree, so either answer is right — but preferring the
  // resource keeps the value identical to the traces lane, which has no app name.
  assert.equal(resolveServiceValue("CommunicationHub.Web", "CommunicationHub.Web", LIMITS), "CommunicationHub.Web");
});

test("resolveServiceValue: an unnameable row stays on the sentinel, it does not go null", () => {
  // This is what keeps `service:"unknown_service:dotnet"` addressing exactly the
  // remainder, with no special case anywhere in the callers.
  assert.equal(resolveServiceValue("unknown_service:dotnet", "", LIMITS), "unknown_service:dotnet");
  assert.equal(resolveServiceValue("unknown_service:dotnet", null, LIMITS), "unknown_service:dotnet");
});

test("resolveServiceValue: disabled config never consults the app-name field", () => {
  assert.equal(identityEnabled(DISABLED), false);
  assert.equal(resolveServiceValue("unknown_service:dotnet", "CommunicationHub.Web", DISABLED), "unknown_service:dotnet");
});

// --- SQL -------------------------------------------------------------------

test("resolvedServiceExpr: three COALESCE arms, with the sentinel quoted", () => {
  assert.equal(
    resolvedServiceExpr(LIMITS),
    "COALESCE(NULLIF(service_name, 'unknown_service:dotnet'), NULLIF(applicationname, ''), service_name)"
  );
});

test("resolvedServiceExpr: a sentinel containing a quote is escaped, not injected", () => {
  const expr = resolvedServiceExpr({
    appNameField: "applicationname",
    unknownServiceSentinel: "it's unknown"
  } as unknown as ObserveLimits);
  assert.ok(expr.includes("'it''s unknown'"), expr);
});

test("resolvedServiceExpr: an unsafe column name is rejected rather than interpolated", () => {
  assert.throws(
    () =>
      resolvedServiceExpr({
        appNameField: "app; DROP TABLE x",
        unknownServiceSentinel: "unknown_service:dotnet"
      } as unknown as ObserveLimits),
    /Unsafe column name/
  );
});

test("resolvedServiceExpr: disabled falls back to the raw column", () => {
  assert.equal(resolvedServiceExpr(DISABLED), "service_name");
  assert.equal(identitySourceSelect(DISABLED), null);
});

test("identitySourceSelect: counts both paths in one aggregate", () => {
  const sql = identitySourceSelect(LIMITS) ?? "";
  assert.ok(sql.includes("AS enricher_rows"), sql);
  assert.ok(sql.includes("AS resource_rows"), sql);
  // A NULL service_name is a resource row, not a silently dropped one.
  assert.ok(sql.includes("service_name IS NULL"), sql);
});

test("classifyIdentitySource: both paths present is `mixed`, not a coin flip", () => {
  // The common case live, not an edge one: CRM.Gateway ran 15,528 rows through the
  // SDK provider and 3,836 through the Serilog sink in the same hour.
  assert.equal(classifyIdentitySource(10, 0), "resource");
  assert.equal(classifyIdentitySource(0, 10), "enricher");
  assert.equal(classifyIdentitySource(10, 10), "mixed");
  assert.equal(classifyIdentitySource(0, 0), null);
});

// --- projection ------------------------------------------------------------

test("logColumnsWithIdentity: an explicit projection gains the app-name field", () => {
  assert.deepEqual(logColumnsWithIdentity(["_timestamp", "body"], LIMITS), [
    "_timestamp",
    "body",
    "applicationname"
  ]);
  // Already listed → unchanged; SELECT * (empty) already returns it → unchanged.
  assert.deepEqual(logColumnsWithIdentity(["body", "applicationname"], LIMITS), ["body", "applicationname"]);
  assert.deepEqual(logColumnsWithIdentity([], LIMITS), []);
});

// --- capability downgrade --------------------------------------------------

test("withIdentity: a stream without the field downgrades once and is remembered", async () => {
  resetIdentityCapability();
  const seen: string[] = [];
  const run = async (expr: string) => {
    seen.push(expr);
    if (expr !== "service_name") {
      throw missingColumn("applicationname");
    }
    return "rows";
  };

  const first = await withIdentity("env:stream", LIMITS, run);
  assert.equal(first.result, "rows");
  assert.equal(first.resolved, false);
  assert.equal(seen.length, 2, "expected one resolved attempt then one raw retry");

  // Second call must not pay for the discovery again.
  const second = await withIdentity("env:stream", LIMITS, run);
  assert.equal(second.resolved, false);
  assert.equal(seen.length, 3);
  assert.equal(seen[2], "service_name");
});

test("withIdentity: the downgrade is per stream, not global", async () => {
  resetIdentityCapability();
  await withIdentity("env:no-field", LIMITS, async (expr) => {
    if (expr !== "service_name") throw missingColumn("applicationname");
    return null;
  });
  const other = await withIdentity("env:has-field", LIMITS, async () => "rows");
  assert.equal(other.resolved, true);
});

test("withIdentity: an unrelated bad-column error propagates and marks nothing", async () => {
  // The broad missing-column matcher would otherwise let a caller's own typo in
  // `stream` permanently label a perfectly capable stream as unresolvable.
  resetIdentityCapability();
  await assert.rejects(
    withIdentity("env:stream", LIMITS, async () => {
      throw missingColumn("severity_text");
    }),
    (error: unknown) => error instanceof ObserveHttpError && String(error.detail).includes("severity_text")
  );
  const after = await withIdentity("env:stream", LIMITS, async () => "rows");
  assert.equal(after.resolved, true);
});

test("withIdentity: disabled config never attempts the resolved expression", async () => {
  resetIdentityCapability();
  const seen: string[] = [];
  const run = await withIdentity("env:stream", DISABLED, async (expr) => {
    seen.push(expr);
    return "rows";
  });
  assert.deepEqual(seen, ["service_name"]);
  assert.equal(run.resolved, false);
});

// --- the echoed block ------------------------------------------------------

test("describeIdentity: a downgraded response says why, naming the sentinel it fell back to", () => {
  const echoed = describeIdentity(LIMITS, false);
  assert.equal(echoed.resolved, false);
  assert.equal(echoed.field, "applicationname");
  assert.ok(/unknown_service:dotnet/.test(String(echoed.note)));

  const resolved = describeIdentity(LIMITS, true);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.note, null);

  const off = describeIdentity(DISABLED, false);
  assert.equal(off.field, null);
  assert.ok(/disabled/.test(String(off.note)));
});
