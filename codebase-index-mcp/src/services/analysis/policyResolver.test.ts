import assert from "node:assert/strict";
import test from "node:test";

import { BREADTH_REFERENCE_DEPENDENTS, resolveDetectChangesPolicy, scoreChangeRisk } from "./policyResolver.js";

/**
 * MCP-ISSUE-054 — the risk model must not move with a page size.
 *
 * The defect: `impactBreadth` was `impactedFilesCount / impactLimit`, and `impactedFilesCount` had
 * already been truncated to `impactLimit` by the caller. Any file with at least `impactLimit`
 * dependents therefore scored breadth 1.0 — half the total score — so on one real 83-file diff
 * `GetCustomerConversationTimeline.cs` came out 78/high at the default limit of 20 and 30/low at
 * `impactLimit: 400`. Same diff, same file, opposite verdict.
 *
 * The regression test is `identical inputs score identically whatever impactLimit says`: under the
 * old denominator it cannot pass.
 *
 * **These tests are necessary and were never sufficient** (re-open, 2026-08-10). They pin the scorer
 * in ISOLATION, holding the count constant across the two limits — but in the real pipeline
 * `changeAnalysis.ts` passed `20` and `97` for those two calls, never `24` and `24`, because the
 * truncation lived in the CALLER. A correct test of the wrong seam. The end-to-end assertion, which
 * goes through `getImpactFiles` on a fixture whose true dependent count exceeds the page size, is in
 * `services/impact/changeAnalysis.test.ts` — do not delete it in favour of these.
 */

const CLEAN_RELIABILITY = {
  edgeCount: 100,
  medianConfidence: 0.9,
  lowConfidenceEdgeCount: 0,
  unresolvedRatio: 0
};

test("identical inputs score identically whatever impactLimit says", () => {
  const atDefault = scoreChangeRisk(24, CLEAN_RELIABILITY, 20);
  const atWide = scoreChangeRisk(24, CLEAN_RELIABILITY, 400);

  assert.equal(atDefault.riskScore, atWide.riskScore);
  assert.equal(atDefault.riskLevel, atWide.riskLevel);
  assert.equal(atDefault.signals.impactBreadth, atWide.signals.impactBreadth);
});

test("breadth is measured against the fixed reference, not the caller's cap", () => {
  const { signals } = scoreChangeRisk(25, CLEAN_RELIABILITY, 20);
  assert.equal(signals.impactBreadth, 25 / BREADTH_REFERENCE_DEPENDENTS);
});

test("breadth saturates at the reference and never exceeds 1", () => {
  const { signals } = scoreChangeRisk(BREADTH_REFERENCE_DEPENDENTS * 3, CLEAN_RELIABILITY, 500);
  assert.equal(signals.impactBreadth, 1);
});

test("capHit reports that the PAGE was truncated, without feeding the score", () => {
  // The count is no longer capped, so `count === impactLimit` is a page that happens to be exactly
  // full — not one that cut something off. Only a count ABOVE the page size sets the flag.
  assert.equal(scoreChangeRisk(20, CLEAN_RELIABILITY, 20).signals.capHit, false);

  const capped = scoreChangeRisk(97, CLEAN_RELIABILITY, 20);
  const uncapped = scoreChangeRisk(97, CLEAN_RELIABILITY, 400);
  assert.equal(capped.signals.capHit, true);
  assert.equal(uncapped.signals.capHit, false);
  // The flag is disclosure only — it must not change the verdict.
  assert.equal(capped.riskScore, uncapped.riskScore);
});

test("blast radius alone can reach 'high', so release-gate is a gate that can fire", () => {
  // The weights used to give breadth 0.5 and the three GRAPH-QUALITY penalties the other 0.5, so the
  // widest possible blast radius on a well-indexed repo scored 50 — `medium`. `release-gate`
  // (minRiskScore 67, riskLevels:["high"]) therefore returned empty on any healthy diff, and a gate
  // that never fires is indistinguishable from a gate that passed.
  const widest = scoreChangeRisk(BREADTH_REFERENCE_DEPENDENTS, CLEAN_RELIABILITY, 400);
  assert.equal(widest.riskLevel, "high", `expected high, got ${String(widest.riskScore)}`);
  assert.ok(widest.riskScore >= resolveDetectChangesPolicy("release-gate").minRiskScore);

  // …and an ordinary file is still nowhere near it.
  assert.equal(scoreChangeRisk(3, CLEAN_RELIABILITY, 400).riskLevel, "low");
});

test("breadth still separates shared infrastructure from an ordinary handler", () => {
  const shared = scoreChangeRisk(40, CLEAN_RELIABILITY, 400);
  const ordinary = scoreChangeRisk(2, CLEAN_RELIABILITY, 400);

  assert.ok(
    shared.riskScore > ordinary.riskScore,
    `expected the 40-dependent file to outrank the 2-dependent one, got ${String(shared.riskScore)} vs ${String(ordinary.riskScore)}`
  );
});

test("a file with no dependents and a clean graph scores zero", () => {
  const { riskScore, riskLevel } = scoreChangeRisk(0, { ...CLEAN_RELIABILITY, medianConfidence: 1 }, 20);
  assert.equal(riskScore, 0);
  assert.equal(riskLevel, "low");
});
