import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "./schema.js";
import { recordRun, getLatestRun } from "./runStore.js";
import type { IndexRunSummary } from "../types/index.js";

/**
 * What `index_runs` actually stores (MCP-ISSUE-048).
 *
 * The reported symptom was counters contradicting each other, but the mechanism was columns that did
 * not exist: `recordRun` accepted a wide summary and silently dropped the fields with no column, and
 * `getLatestRun` aliased one column to two names. Neither loses a test — the run still says "ok" — so
 * the only way to hold the fix is to assert the round-trip field by field.
 *
 * `indexVersion` is the one with teeth: `evaluateIncrementalSkip` compares the stored value against
 * INDEX_VERSION, and while nothing was stored that comparison was always `undefined !== "v..."`, so
 * the incremental fast-skip could never fire. A silent permanent full re-index.
 */

function summary(overrides: Partial<IndexRunSummary> = {}): IndexRunSummary {
  return {
    runId: "run-1",
    repoId: "r",
    mode: "full",
    status: "ok",
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:00:10.000Z",
    indexVersion: "v2-string-literals",
    filesScanned: 10,
    filesIndexed: 9,
    filesSkipped: 1,
    symbolsUpserted: 100,
    edgesUpserted: 200,
    docsUpserted: 0,
    mentionsUpserted: 0,
    parseFailures: 0,
    parseTimeouts: 3,
    elapsedMs: 10_000,
    ...overrides
  } as IndexRunSummary;
}

function db() {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  // `index_runs` grows by migration, not by CREATE TABLE — every column `recordRun` writes beyond the
  // original set (commit_sha onward) is added here, so a fixture that skips this fails on the INSERT.
  runGraphMigrations(conn, /* vectorEnabled */ false);
  return conn;
}

test("indexVersion round-trips, so the incremental skip gate can actually compare it", () => {
  const conn = db();
  recordRun(conn, summary());

  const latest = getLatestRun(conn, "r");
  assert.equal(latest?.indexVersion, "v2-string-literals");
});

test("counters the response reported are now persisted, not dropped", () => {
  const conn = db();
  recordRun(
    conn,
    summary({
      parseTimeouts: 3,
      edgesDroppedByConfidence: 11,
      edgesDroppedByCallCap: 12,
      edgesDroppedByTypeRefCap: 13,
      filesPruned: 4,
      edgesPruned: 5,
      edgesDeduplicated: 6,
      symbolsInGraph: 98,
      edgesInGraph: 189,
      extractPhaseMs: 8_000,
      vectorSymbolsIndexed: 77,
      healthReasons: ["symbols but zero edges"]
    })
  );

  const latest = getLatestRun(conn, "r");
  assert.equal(latest?.parseTimeouts, 3);
  assert.equal(latest?.edgesDroppedByConfidence, 11);
  assert.equal(latest?.edgesDroppedByCallCap, 12);
  assert.equal(latest?.edgesDroppedByTypeRefCap, 13);
  assert.equal(latest?.filesPruned, 4);
  assert.equal(latest?.edgesPruned, 5);
  assert.equal(latest?.edgesDeduplicated, 6);
  assert.equal(latest?.vectorSymbolsIndexed, 77);
  assert.deepEqual(latest?.healthReasons, ["symbols but zero edges"]);
  // The authoritative graph size, distinct from the extraction-time upsert counts.
  assert.equal(latest?.symbolsInGraph, 98);
  assert.equal(latest?.edgesInGraph, 189);
  assert.equal(latest?.symbolsUpserted, 100);
  assert.equal(latest?.edgesUpserted, 200);
  // elapsedMs spans the run; extractPhaseMs is contained in it.
  assert.ok((latest?.extractPhaseMs ?? 0) <= (latest?.elapsedMs ?? 0));
});

test("callEdgesAttempted and callEdgesUnresolved are separate columns that partition", () => {
  const conn = db();
  recordRun(conn, summary({ callEdgesAttempted: 500, callEdgesUnresolved: 120 }));

  const latest = getLatestRun(conn, "r");
  assert.equal(latest?.callEdgesAttempted, 500);
  assert.equal(latest?.callEdgesUnresolved, 120);
  // The deprecated alias still reports the attempted population, not the remainder.
  assert.equal(latest?.unresolvedCallsTotal, 500);
});

test("a legacy row with no callEdgesAttempted falls back to the old alias column", () => {
  const conn = db();
  // A pre-fix row: `callEdgesAttempted` was never a column, so only the alias carried the value.
  recordRun(conn, summary({ unresolvedCallsTotal: 4_242 }));

  const latest = getLatestRun(conn, "r");
  assert.equal(latest?.callEdgesAttempted, 4_242);
});
