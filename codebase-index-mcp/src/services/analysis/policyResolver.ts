/**
 * Policy resolution and risk scoring utilities
 */

/**
 * The dependent count at which blast radius counts as "as wide as it gets" for scoring.
 *
 * MCP-ISSUE-054: this used to be `impactLimit` — the caller's PAGINATION parameter, which also caps
 * `impactedFilesCount` before it arrives here. The two cancelled: any file with at least `impactLimit`
 * dependents scored `impactBreadth = 1.0`, and since breadth is half the score, the same file on the
 * same diff came out 78/high at the default limit of 20 and 30/low at `impactLimit: 400`. A risk model
 * whose verdict moves with a page size is not a risk model.
 *
 * A fixed reference makes the score comparable across runs and across repos. 50 is the calibration
 * point: on the reference 83-file diff it separates genuinely shared infrastructure (interfaces,
 * DbContext, projection services) from ordinary handlers, which the saturated version could not do.
 */
export const BREADTH_REFERENCE_DEPENDENTS = 50;

/**
 * How the four signals combine. Recalibrated 2026-08-10 with the MCP-ISSUE-054 re-open.
 *
 * Blast radius used to carry 0.5, and the other 0.5 was three penalties that measure *how much the
 * index trusts its own edges* — unresolved ratio, median confidence, share of weak edges. That is
 * uncertainty about the GRAPH, not risk in the CHANGE, and weighting it at half meant a
 * well-indexed repo could not produce a high-risk file: the widest possible blast radius on a clean
 * graph scored 50, i.e. `medium`. `detect_changes(policy:"release-gate")` — minRiskScore 67,
 * `riskLevels:["high"]` — therefore returned empty on essentially any diff, and a gate that never
 * fires reads exactly like a gate that passed.
 *
 * Under 0.7 a file at the reference blast radius clears `high` on its own (70), and the penalties
 * remain able to push a borderline file up. The 67/34 boundaries and the 20/40/67 policy floors are
 * unchanged — they were never the broken part, the reachable range under them was.
 */
export const RISK_WEIGHTS = {
  impactBreadth: 0.7,
  unresolvedPenalty: 0.15,
  confidencePenalty: 0.1,
  lowConfidencePenalty: 0.05
} as const;

export function scoreChangeRisk(
  /** The TRUE dependent count. Passing a `limit`-truncated count is the MCP-ISSUE-054 defect. */
  impactedFilesCount: number,
  reliabilitySummary: {
    edgeCount: number;
    medianConfidence: number;
    lowConfidenceEdgeCount: number;
    unresolvedRatio: number;
  },
  /**
   * The caller's PAGE size. Used ONLY to report whether the returned page of dependent rows was a
   * window onto a larger set — never as the scoring denominator, and (since the re-open fix) never
   * as a bound on `impactedFilesCount` either. See {@link BREADTH_REFERENCE_DEPENDENTS}.
   */
  impactLimit: number
): {
  riskScore: number;
  riskLevel: "high" | "medium" | "low";
  signals: {
    impactBreadth: number;
    unresolvedPenalty: number;
    confidencePenalty: number;
    lowConfidencePenalty: number;
    /**
     * True when there are MORE dependents than the caller's page could hold. Disclosure about the
     * returned rows only — since the re-open fix the score is measured from the untruncated count,
     * so `capHit` no longer implies the verdict is understated.
     */
    capHit: boolean;
  };
} {
  const clampRisk = (value: number) => Math.max(0, Math.min(1, value));

  const impactBreadth = clampRisk(impactedFilesCount / BREADTH_REFERENCE_DEPENDENTS);
  // `>` not `>=`: the count is no longer capped, so `count === impactLimit` is a page that happens
  // to be exactly full, not a page that cut something off.
  const capHit = impactLimit > 0 && impactedFilesCount > impactLimit;
  const unresolvedPenalty = clampRisk(reliabilitySummary.unresolvedRatio);
  const confidencePenalty = clampRisk(1 - reliabilitySummary.medianConfidence);
  const lowConfidencePenalty = reliabilitySummary.edgeCount > 0
    ? clampRisk(reliabilitySummary.lowConfidenceEdgeCount / reliabilitySummary.edgeCount)
    : 0;

  const score01 =
    impactBreadth * RISK_WEIGHTS.impactBreadth +
    unresolvedPenalty * RISK_WEIGHTS.unresolvedPenalty +
    confidencePenalty * RISK_WEIGHTS.confidencePenalty +
    lowConfidencePenalty * RISK_WEIGHTS.lowConfidencePenalty;

  const riskScore = Math.round(score01 * 100);
  const riskLevel = riskScore >= 67 ? "high" : riskScore >= 34 ? "medium" : "low";

  return {
    riskScore,
    riskLevel,
    signals: {
      impactBreadth,
      unresolvedPenalty,
      confidencePenalty,
      lowConfidencePenalty,
      capHit
    }
  };
}

export function resolveDetectChangesPolicy(policy: "quick-triage" | "strict-review" | "release-gate" | "custom"): {
  minRiskScore: number;
  riskLevels: ("high" | "medium" | "low")[];
  maxResults: number;
  sortBy: "risk" | "impact" | "path";
} {
  if (policy === "quick-triage") {
    return {
      minRiskScore: 20,
      riskLevels: ["high", "medium"],
      maxResults: 20,
      sortBy: "risk"
    };
  }

  if (policy === "strict-review") {
    return {
      minRiskScore: 40,
      riskLevels: ["high", "medium"],
      maxResults: 50,
      sortBy: "impact"
    };
  }

  if (policy === "release-gate") {
    return {
      minRiskScore: 67,
      riskLevels: ["high"],
      maxResults: 100,
      sortBy: "risk"
    };
  }

  return {
    minRiskScore: 0,
    riskLevels: ["high", "medium", "low"],
    maxResults: 100,
    sortBy: "risk"
  };
}
