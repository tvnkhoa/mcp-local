/**
 * Performance profile configuration utilities
 */

import type { PerformanceProfile } from "./indexPipeline.js";
import { nonNegativeNumberFromEnv, parseOptionalBooleanEnv } from "./envConfig.js";

export function parsePerformanceProfileEnv(raw: string | undefined): PerformanceProfile | "auto" {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (value === "standard" || value === "off") {
    return "standard";
  }
  if (value === "large" || value === "balanced") {
    return "large";
  }
  if (value === "very-large" || value === "aggressive") {
    return "very-large";
  }
  return "auto";
}

export function resolvePostPhasePolicy(profile: PerformanceProfile): {
  maxUnresolvedRows: number;
  resolveTypeRefs: boolean;
  resolveImplementsInPost: boolean;
} {
  const configuredMaxRows = nonNegativeNumberFromEnv("CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS");
  const configuredResolveTypeRefs = parseOptionalBooleanEnv(process.env.CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS);

  if (profile === "very-large") {
    return {
      maxUnresolvedRows: configuredMaxRows ?? 50_000,
      resolveTypeRefs: configuredResolveTypeRefs ?? false,
      resolveImplementsInPost: false
    };
  }

  if (profile === "large") {
    return {
      maxUnresolvedRows: configuredMaxRows ?? 120_000,
      resolveTypeRefs: configuredResolveTypeRefs ?? true,
      resolveImplementsInPost: true
    };
  }

  return {
    maxUnresolvedRows: configuredMaxRows ?? 0,
    resolveTypeRefs: configuredResolveTypeRefs ?? true,
    resolveImplementsInPost: true
  };
}
