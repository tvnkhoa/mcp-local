import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "./schema.js";
import { recordRun, getLatestRun, markRunTrigger, markRunTreeDirty, getLatestWorkRunTreeDirty, getLatestWorkRunMode, INDEX_RUNS_KEPT_PER_REPO, markRunTreeKey, getLatestRunTreeKey } from "./runStore.js";
import type { IndexRunSummary, SkipBucket } from "../types/index.js";

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

test("skippedByReason round-trips, and its absence reads as absent rather than empty", () => {
  const conn = db();
  const skipped: SkipBucket[] = [
    { reason: "unknown_extension", extension: ".vue", count: 187 },
    { reason: "file_too_large", extension: ".md", count: 1 },
    { reason: "unknown_extension", extension: "Dockerfile", count: 5 }
  ];
  recordRun(conn, summary({ runId: "run-skips", skippedByReason: skipped }));
  assert.deepEqual(getLatestRun(conn, "r")?.skippedByReason, skipped);

  recordRun(conn, summary({ runId: "run-none", finishedAt: "2026-08-04T00:00:20.000Z" }));
  const latest = getLatestRun(conn, "r");
  assert.equal(latest?.runId, "run-none");
  assert.equal(latest?.skippedByReason, undefined);
  assert.equal("skippedByReasonJson" in (latest ?? {}), false, "the raw JSON column alias must not leak");
});

test("a query-triggered run says so, and an untagged run carries no triggeredBy", () => {
  const conn = db();
  recordRun(conn, summary({ runId: "plain" }));
  assert.equal(getLatestRun(conn, "r")?.triggeredBy, undefined);
  recordRun(conn, summary({ runId: "by-query", finishedAt: "2026-08-04T00:00:20.000Z" }));
  markRunTrigger(conn, "by-query", "query");
  assert.equal(getLatestRun(conn, "r")?.triggeredBy, "query");
});

test("a scoped run's scope round-trips; a full run has none (release J)", () => {
  const conn = db();
  recordRun(conn, summary({ runId: "full" }));
  const full = getLatestRun(conn, "r");
  assert.equal(full?.scope, undefined);
  assert.equal("scope" in (full ?? {}), false, "absent, not null");
  const scope = "scoped: 4 changed, 12 dependent file(s) re-extracted";
  recordRun(conn, summary({ runId: "dirty", mode: "dirty", scope, finishedAt: "2026-08-04T00:00:20.000Z" }));
  assert.equal(getLatestRun(conn, "r")?.scope, scope);
});

test("release M: index_runs keeps the latest 200 rows per repo, and always the latest WORK run behind any number of skips", () => {
  const conn = db();
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
  // One dirty-tree full run, then many fast-skips: the R1 gate must still see the full run's tree_dirty.
  recordRun(conn, summary({ runId: "work", mode: "full", startedAt: at(0), finishedAt: at(0), indexVersion: "v14" }));
  markRunTreeDirty(conn, "work");
  for (let i = 1; i <= INDEX_RUNS_KEPT_PER_REPO + 50; i += 1) {
    recordRun(conn, summary({ runId: `skip-${String(i)}`, mode: "incremental", startedAt: at(i), finishedAt: at(i), indexVersion: "v14", skipReason: "head unchanged" } as Partial<IndexRunSummary>));
  }
  recordRun(conn, summary({ runId: "other-repo", repoId: "o", startedAt: at(0), finishedAt: at(0) }));
  const count = (repo: string) => (conn.prepare("select count(*) as n from index_runs where repo_id = ?").get(repo) as { n: number }).n;
  assert.equal(count("r"), INDEX_RUNS_KEPT_PER_REPO + 1, "the cap, plus the latest work run kept behind it");
  assert.equal(count("o"), 1, "per repo");
  assert.equal(getLatestRun(conn, "r")?.runId, `skip-${String(INDEX_RUNS_KEPT_PER_REPO + 50)}`, "the F guard's row (latest) is untouched");
  assert.equal(getLatestWorkRunTreeDirty(conn, "r"), true, "the skip gate still reads the dirty full run");
  assert.equal(getLatestWorkRunMode(conn, "r"), "full");
  assert.equal((conn.prepare("select count(*) as n from index_runs where run_id = 'skip-1'").get() as { n: number }).n, 0, "the oldest skips went");
});

test("MCP-ISSUE-101: the tree key is the LATEST run's — a later run that recorded none vouches for nothing", () => {
  const conn = db();
  assert.equal(getLatestRunTreeKey(conn, "r"), null);
  recordRun(conn, summary({ runId: "keyed" }));
  markRunTreeKey(conn, "keyed", "{\"head\":\"h\",\"files\":{}}");
  assert.equal(getLatestRunTreeKey(conn, "r"), "{\"head\":\"h\",\"files\":{}}");
  assert.equal(getLatestRunTreeKey(conn, "other"), null, "per repo");
  recordRun(conn, summary({ runId: "unkeyed", status: "failed", finishedAt: "2026-08-04T00:00:20.000Z" }));
  assert.equal(getLatestRunTreeKey(conn, "r"), null);
});
