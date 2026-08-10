import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "../../repositories/schema.js";
import { getImpactFilesImpl } from "./impactSurface.js";
import { scoreChangeRisk, BREADTH_REFERENCE_DEPENDENTS } from "../analysis/policyResolver.js";

/**
 * MCP-ISSUE-054, the end-to-end half — the assertion the registry says must exist before the entry
 * can be closed again.
 *
 * `policyResolver.test.ts` pins the scorer alone and passed throughout the defect, because the
 * truncation was one layer up: `getImpactFiles(repoId, file, impactLimit)` returned at most
 * `impactLimit` rows and `changeAnalysis.ts` fed `impactedFiles.length` to the scorer. A test that
 * hands the scorer the same number twice cannot observe that. So these go through the STORE call, on
 * a fixture whose true dependent count (60) exceeds both the default page size (20) and the breadth
 * reference (50) — the only region where the bug was visible.
 *
 * Against the real schema on `:memory:`, matching `graphQueries.test.ts`: a bespoke fixture schema
 * would let this pass while the columns the impact query depends on drift.
 */

const REPO = "r";
const TARGET = "src/Shared/Codec.cs";
const DEPENDENT_COUNT = 60;

/** One target file with a symbol, and `DEPENDENT_COUNT` distinct files that each CALL it. */
function fixture(): Database.Database {
  const db = new Database(":memory:");
  initGraphSchema(db);
  db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)")
    .run(REPO, "/tmp/r", new Date(0).toISOString());

  const addSymbol = (symbolId: string, filePath: string, name: string) => {
    db.prepare(
      `insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values (?, ?, ?, ?, ?, ?)`
    ).run(REPO, symbolId, filePath, name, "method", 1);
    db.prepare(`insert into files (repo_id, path, content_hash, language, updated_at) values (?, ?, ?, ?, ?)`)
      .run(REPO, filePath, "h", "csharp", new Date(0).toISOString());
  };

  addSymbol("target", TARGET, "Parse");
  for (let i = 0; i < DEPENDENT_COUNT; i += 1) {
    // Half the dependents are tests, so the same fixture exercises MCP-ISSUE-056's in-query filter.
    const isTest = i % 2 === 1;
    const filePath = isTest ? `tests/Caller${String(i)}Tests.cs` : `src/App/Caller${String(i)}.cs`;
    addSymbol(`caller${String(i)}`, filePath, `Use${String(i)}`);
    db.prepare(
      `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
    ).run(REPO, `caller${String(i)}`, "target", "CALLS", 1.0, "resolved call edge");
  }
  return db;
}

const PAGE_SIZES = [20, 50, 400];

test("the dependent COUNT is invariant under the page size", () => {
  const db = fixture();
  for (const limit of PAGE_SIZES) {
    const result = getImpactFilesImpl(db, REPO, TARGET, limit);
    assert.equal(
      result.totalImpactedCount,
      DEPENDENT_COUNT,
      `impactLimit ${String(limit)} reported ${String(result.totalImpactedCount)} dependents`
    );
    // The PAGE still honours the limit — that is what `limit` is for, and dropping it would trade
    // one defect for a payload blowup.
    assert.equal(result.impactedFiles.length, Math.min(limit, DEPENDENT_COUNT));
    assert.equal(result.truncated, DEPENDENT_COUNT > limit);
  }
  db.close();
});

test("riskScore is identical at impactLimit 20 / 50 / 400 — the defect, end to end", () => {
  const db = fixture();
  const scores = PAGE_SIZES.map((limit) => {
    const impact = getImpactFilesImpl(db, REPO, TARGET, limit);
    // Exactly what `scoreFileImpact` does. Written out rather than imported so this test fails if
    // that function starts passing the truncated `impactedFiles.length` again.
    return scoreChangeRisk(impact.totalImpactedCount, impact.reliabilitySummary, limit);
  });

  const [first, ...rest] = scores;
  for (const other of rest) {
    assert.equal(other.riskScore, first.riskScore, `scores drifted across page sizes: ${JSON.stringify(scores.map((s) => s.riskScore))}`);
    assert.equal(other.riskLevel, first.riskLevel);
    assert.equal(other.signals.impactBreadth, first.signals.impactBreadth);
    // Second-order: the reliability summary must come from the untruncated edge set too, or the
    // confidence-derived signals keep moving with the page even once breadth is fixed.
    assert.equal(other.signals.lowConfidencePenalty, first.signals.lowConfidencePenalty);
    assert.equal(other.signals.confidencePenalty, first.signals.confidencePenalty);
  }

  // 60 dependents is past the reference, so breadth saturates — the region where truncating the
  // numerator at 20 produced `20/50 = 0.4` and inverted the verdict.
  assert.equal(first.signals.impactBreadth, 1);
  assert.ok(DEPENDENT_COUNT > BREADTH_REFERENCE_DEPENDENTS);
  db.close();
});

test("excludeTests is applied before the page, not after it", () => {
  const db = fixture();
  // MCP-ISSUE-056: with the filter running after a LIMIT of 20 over a caller set whose test files
  // sort first, this returned far fewer rows than asked for — or none at all.
  const filtered = getImpactFilesImpl(db, REPO, TARGET, 20, true);
  assert.equal(filtered.impactedFiles.length, 20);
  assert.equal(filtered.totalImpactedCount, DEPENDENT_COUNT / 2);
  assert.ok(filtered.impactedFiles.every((f) => !f.filePath.startsWith("tests/")), "a test file survived the filter");
  db.close();
});
