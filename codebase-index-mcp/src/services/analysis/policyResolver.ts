/**
 * Policy resolution and risk scoring utilities
 */

export function scoreChangeRisk(
  impactedFilesCount: number,
  reliabilitySummary: {
    edgeCount: number;
    medianConfidence: number;
    lowConfidenceEdgeCount: number;
    unresolvedRatio: number;
  },
  impactLimit: number
): {
  riskScore: number;
  riskLevel: "high" | "medium" | "low";
  signals: {
    impactBreadth: number;
    unresolvedPenalty: number;
    confidencePenalty: number;
    lowConfidencePenalty: number;
  };
} {
  const clampRisk = (value: number) => Math.max(0, Math.min(1, value));

  const impactBreadth = clampRisk(impactedFilesCount / Math.max(1, impactLimit));
  const unresolvedPenalty = clampRisk(reliabilitySummary.unresolvedRatio);
  const confidencePenalty = clampRisk(1 - reliabilitySummary.medianConfidence);
  const lowConfidencePenalty = reliabilitySummary.edgeCount > 0
    ? clampRisk(reliabilitySummary.lowConfidenceEdgeCount / reliabilitySummary.edgeCount)
    : 0;

  const score01 =
    impactBreadth * 0.5 +
    unresolvedPenalty * 0.25 +
    confidencePenalty * 0.2 +
    lowConfidencePenalty * 0.05;

  const riskScore = Math.round(score01 * 100);
  const riskLevel = riskScore >= 67 ? "high" : riskScore >= 34 ? "medium" : "low";

  return {
    riskScore,
    riskLevel,
    signals: {
      impactBreadth,
      unresolvedPenalty,
      confidencePenalty,
      lowConfidencePenalty
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
