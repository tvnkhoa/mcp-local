/**
 * ENH-C — Universal coverage/confidence signal.
 *
 * Graph-read tools can return a low or zero count that *looks* authoritative but is
 * actually an artifact of incomplete static analysis (e.g. IMPLEMENTS not capturing a
 * shape, DI/reflection-wired callers, unresolved edges). A bare count is then more
 * dangerous than an error. `buildCoverageBlock` attaches a small, uniform confidence
 * signal so the agent can trust-but-verify: proceed when confidence is high, fall back
 * deliberately (with a concrete suggestion) when a known gap is flagged.
 *
 * This mirrors the existing `graphHealth`/`reliabilitySummary` contract already returned
 * by find_impact_files / get_change_context, extending the same idea to tools that lack it.
 */

export type CoverageConfidence = "high" | "medium" | "low";

export type CoverageBlock = {
  confidence: CoverageConfidence;
  knownGaps: string[];
  suggestFallback: string | null;
};

export type CoverageKind =
  | "implementations"
  | "call_chain"
  | "execution_flow"
  | "change_impact"
  | "search"
  | "context_pack"
  | "field_accesses";

export type CoverageInput = {
  /** Number of results the tool is about to return. */
  resultCount: number;
  /** True when an empty result is suspicious (the caller expected at least one). */
  expectedNonZero?: boolean;
  /** True when results were capped (e.g. rows.length === limit, or a truncated flag). */
  truncated?: boolean;
  /** Optional resolution signals from the impact graph (when the tool has them). */
  graphHealth?: {
    unresolvedCalls?: number;
    unresolvedImports?: number;
    unresolvedTypeRefs?: number;
    unresolvedProperties?: number;
  };
  reliabilitySummary?: {
    medianConfidence?: number;
    unresolvedRatio?: number;
  };
  kind: CoverageKind;
  /** Query echoed back into the fallback suggestion (e.g. the interface name). */
  query?: string;
};

function unresolvedTotal(gh: CoverageInput["graphHealth"]): number {
  if (!gh) return 0;
  return (
    (gh.unresolvedCalls ?? 0) +
    (gh.unresolvedImports ?? 0) +
    (gh.unresolvedTypeRefs ?? 0) +
    (gh.unresolvedProperties ?? 0)
  );
}

/**
 * Per-kind known-gap notes + fallback hints. Only the gaps relevant to the current
 * result shape are emitted (kept terse so the block stays cheap under compact profiles).
 */
function gapsFor(kind: CoverageKind, lowOrEmpty: boolean, query: string | undefined): { gaps: string[]; fallback: string | null } {
  if (!lowOrEmpty) return { gaps: [], fallback: null };
  const q = query ?? "<name>";
  switch (kind) {
    case "implementations":
      return {
        gaps: [
          "IMPLEMENTS edges require C# indexing; TS/JS interfaces and unindexed C# won't resolve."
        ],
        fallback: `grep the interface (rg ': .*${q}') or retry search_symbols(strategy='intent') — re-index if the type was added since the last index.`
      };
    case "call_chain":
      return {
        gaps: [
          "call edges may be unresolved, or callers reach the target via DI/reflection (no static CALLS edge).",
          "message-bus hops (PUBLISHES/CONSUMES) are matched heuristically by contract name and may be incomplete."
        ],
        fallback: `widen depth/limit, or find_impact_files('${q}') for the file-level blast radius.`
      };
    case "execution_flow":
      return {
        gaps: [
          "flow stops at unresolved call edges; reflection/DI-dispatched hops are not traced.",
          "producer→consumer bus hops are heuristic contract-name matches; a missing consumer leaves the flow short."
        ],
        fallback: "check find_impact_files / get_call_chain for edges the static trace can't follow."
      };
    case "change_impact":
      return {
        gaps: ["dependents/tests are derived from static edges; DI/reflection-wired or untested code is under-counted."],
        fallback: "run the broader test suite for shared-infra changes flagged with low confidence."
      };
    case "search":
      return {
        gaps: ["0 results may mean the wrong search strategy, a too-narrow filter, or a stale index."],
        fallback: `retry search_symbols('${q}', strategy='intent', ranked=true) for multi-word/natural-language queries, or re-index if the symbol was added recently.`
      };
    case "context_pack":
      return {
        gaps: ["empty callers/callees can mean the symbol is an entry point reached via routing/DI rather than static CALLS edges."],
        fallback: `find_impact_files / get_change_context for '${q}', or re-index if the symbol was added since the last index.`
      };
    case "field_accesses":
      return {
        gaps: ["accesses are derived from PROPERTY_REF/PROPERTY_WRITE edges; dynamic/reflective access and unindexed languages are not captured."],
        fallback: `grep the field (rg '\\.${q}\\b') to confirm, or re-index if the property was added recently.`
      };
  }
}

export function buildCoverageBlock(input: CoverageInput): CoverageBlock {
  const empty = input.resultCount === 0;
  // An empty result surfaces gaps + a fallback hint (the dangerous "looks authoritative" case).
  const lowOrEmpty = empty;

  const unresolved = unresolvedTotal(input.graphHealth);
  const unresolvedRatio = input.reliabilitySummary?.unresolvedRatio ?? 0;
  const medianConfidence = input.reliabilitySummary?.medianConfidence ?? 1;

  let confidence: CoverageConfidence = "high";
  if (
    medianConfidence < 0.6 ||
    unresolvedRatio > 0.2 ||
    unresolved > 0 ||
    input.truncated === true
  ) {
    confidence = "medium";
  }
  if ((empty && input.expectedNonZero === true) || unresolvedRatio > 0.5) {
    confidence = "low";
  }

  const { gaps, fallback } = gapsFor(input.kind, lowOrEmpty, input.query);
  return {
    confidence,
    knownGaps: gaps,
    // No fallback when the result is confidently complete.
    suggestFallback: confidence === "high" ? null : fallback
  };
}
