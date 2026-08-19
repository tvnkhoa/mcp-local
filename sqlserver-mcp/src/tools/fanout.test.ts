import assert from "node:assert/strict";
import test from "node:test";

import { catalogPayload, resolveCatalogs, runAcrossCatalogs } from "./fanout.js";
import { PolicyViolationError } from "../middleware/errors.js";

/**
 * The fan-out mechanism, tested without a database.
 *
 * That is not a convenience — `list_tables` shipped in a state where it had never executed once,
 * because nothing in the suite touched a tool that needed a connection. Every assertion here runs
 * against a fake `runOne`, so the loop, the ordering, the failure capture and the redaction are all
 * pinned by tests CI actually runs.
 */

/** A `runOne` that resolves after `delayMs`, so completion order can be made to differ from request order. */
function slowOne(delays: Readonly<Record<string, number>>) {
  return async (database: string | undefined) => {
    const name = database ?? "(default)";
    await new Promise((resolve) => setTimeout(resolve, delays[name] ?? 0));
    return { database: name, value: name.toUpperCase() };
  };
}

const noop = () => undefined;

// --- resolveCatalogs -----------------------------------------------------------

test("database and databases are mutually exclusive", () => {
  assert.throws(
    () => resolveCatalogs({ database: "A", databases: ["B"] }, 25),
    (error: unknown) =>
      error instanceof PolicyViolationError && error.code === "validation_error"
  );
});

test("a fan-out wider than SQLSERVER_MAX_FANOUT is refused, and the message names the limit", () => {
  assert.throws(
    () => resolveCatalogs({ databases: Array.from({ length: 26 }, (_, i) => `db${String(i)}`) }, 25),
    (error: unknown) =>
      error instanceof PolicyViolationError &&
      error.code === "fanout_limit_exceeded" &&
      /Requested 26 catalogs; SQLSERVER_MAX_FANOUT is 25/.test(error.message)
  );
});

test("a one-element databases array is still a fan-out", () => {
  // The rule that keeps the response shape stable: a caller computing its catalog list must not get
  // a different shape on the day the list happens to hold one entry.
  assert.deepEqual(resolveCatalogs({ databases: ["OnlyOne"] }, 25), {
    catalogs: ["OnlyOne"],
    fannedOut: true
  });
});

test("no database at all is a single run against the connection's own catalog", () => {
  assert.deepEqual(resolveCatalogs({}, 25), { catalogs: [undefined], fannedOut: false });
  assert.deepEqual(resolveCatalogs({ database: "A" }, 25), { catalogs: ["A"], fannedOut: false });
});

// --- runAcrossCatalogs ---------------------------------------------------------

test("results keep request order even when they complete out of order", async () => {
  const outcomes = await runAcrossCatalogs({
    catalogs: ["slow", "fast", "middling"],
    fannedOut: true,
    runOne: slowOne({ slow: 40, fast: 0, middling: 20 }),
    onFailure: noop,
    concurrency: 3
  });
  assert.deepEqual(
    outcomes.map((outcome) => outcome.database),
    ["slow", "fast", "middling"]
  );
});

test("never more than `concurrency` run at once", async () => {
  let inFlight = 0;
  let highWater = 0;
  const outcomes = await runAcrossCatalogs({
    catalogs: ["a", "b", "c", "d", "e", "f"],
    fannedOut: true,
    runOne: async (database) => {
      inFlight += 1;
      highWater = Math.max(highWater, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { database: database as string };
    },
    onFailure: noop,
    concurrency: 2
  });
  assert.equal(outcomes.length, 6);
  assert.equal(highWater, 2, `expected at most 2 concurrent, saw ${String(highWater)}`);
});

test("one bad catalog fills its own slot and the others still return", async () => {
  const outcomes = await runAcrossCatalogs({
    catalogs: ["good", "bad", "alsoGood"],
    fannedOut: true,
    runOne: async (database) => {
      if (database === "bad") {
        throw new Error("boom");
      }
      return { database: database as string, ok: true };
    },
    onFailure: noop,
    concurrency: 3
  });
  assert.equal(outcomes[0]?.error, undefined);
  assert.equal(outcomes[2]?.error, undefined);
  assert.equal(outcomes[1]?.database, "bad");
  assert.ok(outcomes[1]?.errorCode, "a failed slot must carry a machine-readable code");
});

test("a failed slot never carries the driver's own text", async () => {
  // The defect this replaced put `error.message` straight into the slot, so a fan-out printed
  // `Login failed for user 'svc_reporting'` — the very name health_check masks as `***`.
  const driverError = Object.assign(new Error("Login failed for user 'svc_reporting'."), {
    code: "ELOGIN"
  });
  const outcomes = await runAcrossCatalogs({
    catalogs: ["nope"],
    fannedOut: true,
    runOne: () => Promise.reject(driverError),
    onFailure: noop
  });
  const slot = outcomes[0];
  assert.equal(slot?.errorCode, "unauthorized");
  assert.equal(
    slot?.error?.includes("svc_reporting"),
    false,
    `the login name leaked into the slot: ${slot?.error ?? ""}`
  );
});

test("a refusal keeps its own code rather than becoming a generic failure", async () => {
  // `resolve()` throws PolicyViolationError for a catalog outside the allowlist. Raw `.message`
  // discarded that code; toWireError keeps it, and it is the actionable one.
  const outcomes = await runAcrossCatalogs({
    catalogs: ["Forbidden"],
    fannedOut: true,
    runOne: () =>
      Promise.reject(new PolicyViolationError("database_not_allowed", "Catalog is not allowed.")),
    onFailure: noop
  });
  assert.equal(outcomes[0]?.errorCode, "database_not_allowed");
});

test("a single-catalog failure is rethrown, not captured", async () => {
  await assert.rejects(
    runAcrossCatalogs({
      catalogs: [undefined],
      fannedOut: false,
      runOne: () => Promise.reject(new Error("boom")),
      onFailure: noop
    }),
    /boom/
  );
});

test("onFailure sees the raw error, not the mapped one", async () => {
  const seen: unknown[] = [];
  const raw = Object.assign(new Error("Login failed for user 'svc_reporting'."), { code: "ELOGIN" });
  await runAcrossCatalogs({
    catalogs: ["x"],
    fannedOut: true,
    runOne: () => Promise.reject(raw),
    onFailure: (_database, error) => seen.push(error)
  });
  assert.equal(seen[0], raw, "the log is the only place the driver's real message survives");
});

// --- catalogPayload ------------------------------------------------------------

test("the single-catalog shape is flat, with no results wrapper", () => {
  const payload = catalogPayload({ environment: "default", maxRows: 500 }, [
    { database: "AppMain", rows: [1, 2] }
  ], false);
  assert.deepEqual(payload, {
    environment: "default",
    maxRows: 500,
    database: "AppMain",
    rows: [1, 2]
  });
  assert.equal("results" in payload, false);
});

test("the fan-out shape rolls up, and failureCount counts only failed slots", () => {
  const payload = catalogPayload({ environment: "default" }, [
    { database: "a", rows: [] },
    { database: "b", error: "nope", errorCode: "unauthorized" },
    { database: "c", rows: [] }
  ], true);
  assert.ok("catalogCount" in payload, "the fan-out arm must be the one returned");
  assert.equal(payload.catalogCount, 3);
  assert.equal(payload.failureCount, 1);
  assert.equal(payload.results.length, 3);
});
