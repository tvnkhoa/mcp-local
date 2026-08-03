/**
 * Performance profile configuration utilities
 */

import type { PerformanceProfile } from "../services/indexing/indexPipeline.js";
import { nonNegativeNumberFromEnv, parseOptionalBooleanEnv } from "./envConfig.js";

export function resolvePostPhasePolicy(profile: PerformanceProfile): {
  maxUnresolvedRows: number;
  resolveTypeRefs: boolean;
  resolvePropertyRefs: boolean;
  resolveImplementsInPost: boolean;
} {
  const configuredMaxRows = nonNegativeNumberFromEnv("CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS");
  const configuredResolveTypeRefs = parseOptionalBooleanEnv(process.env.CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS);
  const configuredResolvePropertyRefs = parseOptionalBooleanEnv(process.env.CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS);

  if (profile === "very-large") {
    return {
      maxUnresolvedRows: configuredMaxRows ?? 0,  // unlimited — wec.be has 57k+ distinct pairs, 50k cap caused skips
      resolveTypeRefs: configuredResolveTypeRefs ?? true,
      resolvePropertyRefs: configuredResolvePropertyRefs ?? true,
      resolveImplementsInPost: true
    };
  }

  if (profile === "large") {
    return {
      maxUnresolvedRows: configuredMaxRows ?? 120_000,
      resolveTypeRefs: configuredResolveTypeRefs ?? true,
      resolvePropertyRefs: configuredResolvePropertyRefs ?? true,
      resolveImplementsInPost: true
    };
  }

  return {
    maxUnresolvedRows: configuredMaxRows ?? 0,
    resolveTypeRefs: configuredResolveTypeRefs ?? true,
    resolvePropertyRefs: configuredResolvePropertyRefs ?? true,
    resolveImplementsInPost: true
  };
}
