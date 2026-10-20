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

import { NAME_ONLY_EDGE_REASONS } from "../types/index.js";

export type CoverageConfidence = "high" | "medium" | "low";

/**
 * Roll up how a set of edges was resolved, for `CoverageInput.edgeProvenance` (MCP-ISSUE-052).
 *
 * Takes anything carrying `reason` + `confidence`, so both the BFS traversal rows and the flat
 * call-chain rows can feed the same signal without a shared row type.
 */
export function summarizeEdgeProvenance(
  edges: readonly { reason?: string | null; confidence?: number | null }[]
): { total: number; nameOnly: number; minConfidence: number } {
  let nameOnly = 0;
  let minConfidence = 1;
  for (const e of edges) {
    if (e.reason && NAME_ONLY_EDGE_REASONS.has(e.reason)) nameOnly++;
    if (typeof e.confidence === "number" && e.confidence < minConfidence) minConfidence = e.confidence;
  }
  return { total: edges.length, nameOnly, minConfidence };
}

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
  /**
   * MCP-ISSUE-052: how the edges underneath the result were resolved.
   *
   * The failure this exists for: one CALLS edge resolved by callee name alone pointed at a same-named
   * method in an unrelated class, and the seven-node subtree hanging off it was reported with
   * `confidence: "high"` and `knownGaps: []`. A consuming agent cannot detect that — it is strictly
   * worse than an error. A traversal standing on a guess now says so.
   */
  edgeProvenance?: {
    total: number;
    nameOnly: number;
    minConfidence: number;
  };
  /**
   * Accesses the graph cannot see for this query's language, e.g. TS/JS property edges cover only
   * `this.<member>`. Measured on wec.aria: `find_field_accesses(kb_version_ids)` returned 0 reads,
   * 0 writes and `high` for a Zod field read across two packages. A language gap caps confidence at
   * `medium`, and an empty result under one is `low` — the count is not one the graph can vouch for.
   */
  languageGaps?: string[];
  /**
   * Present when the index is behind HEAD or the tree is dirty (the `staleWarning` the handler
   * already computes): the answer describes an older tree, so it cannot be `high`.
   */
  staleness?: { commitsBehind: number | null; dirtyCount: number } | null;
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

/**
 * R3 exact: coverage for an answer from the TypeScript LanguageService rather than the graph.
 *
 * Two words the graph tools never use. `exact` — the type checker resolved every reference in the
 * program within the caps; what it could NOT see is listed file by file in `gaps` (parse arguments
 * it cannot follow, dynamic `obj[key]` sites, `.vue` files when the Vue lane cannot run), so the
 * caller knows precisely where
 * to look by hand. `gap` — a cap was breached and the answer is withheld entirely: a partial list
 * labelled exact is the one failure this lane must never produce. A stale index lowers `exact` to
 * `high`, because files added since the last index run are not in the program. The freshness gate's
 * note never lands in this block (`applyFreshness` scopes it to the index-derived part), where
 * "this answer comes from the previous index" would contradict `exact`.
 */
export type TypedCoverageBlock = {
  confidence: "exact" | "high" | "gap";
  engine: "typescript-language-service";
  knownGaps: string[];
  gaps: { file: string; line: number | null; reason: string }[];
  suggestFallback: string | null;
};

export function buildTypedCoverageBlock(input: {
  gaps: { file: string; line: number | null; reason: string }[];
  breach?: { kind: string; detail: string } | null;
  staleness?: { commitsBehind: number | null; dirtyCount: number } | null;
}): TypedCoverageBlock {
  if (input.breach) {
    return {
      confidence: "gap",
      engine: "typescript-language-service",
      knownGaps: [
        `the TypeScript LanguageService exceeded its ${input.breach.kind === "memory" ? "memory" : "time"} cap — ${input.breach.detail}. No accesses are returned: a partial list would read as complete.`
      ],
      gaps: [],
      suggestFallback:
        input.breach.kind === "time"
          ? "retry: the program stays warm after a cold build, so the next call usually answers in well under a second; or raise CODEBASE_INDEX_TS_LS_COLD_START_MS."
          : "raise CODEBASE_INDEX_TS_LS_MAX_RSS_MB, or disable the lane (CODEBASE_INDEX_TS_LS_ENABLED=false) to get the graph's lower bound."
    };
  }
  const knownGaps: string[] = [];
  if (input.gaps.length > 0) knownGaps.push(`${String(input.gaps.length)} site(s) the type checker cannot attribute are listed in coverage.gaps, by file.`);
  if (input.staleness) {
    const behind = input.staleness.commitsBehind;
    knownGaps.push(
      `index is ${behind === null ? "an unknown number of" : String(behind)} commit(s) behind HEAD with ${String(input.staleness.dirtyCount)} dirty file(s) — ` +
        "files added since the last index run are not in the program."
    );
  }
  return {
    confidence: input.staleness ? "high" : "exact",
    engine: "typescript-language-service",
    knownGaps,
    gaps: input.gaps,
    suggestFallback: input.staleness ? "re-index (index_repository mode='incremental') for an exact answer." : null
  };
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

  // MCP-ISSUE-052: a result built on name-only edges cannot claim "high", however many rows it has.
  // This is deliberately independent of `lowOrEmpty` — the dangerous case is a LARGE confident answer,
  // not an empty one.
  const prov = input.edgeProvenance;
  const provGaps: string[] = [];
  if (prov && prov.nameOnly > 0) {
    if (confidence === "high") confidence = "medium";
    provGaps.push(
      `${String(prov.nameOnly)} of ${String(prov.total)} traversed edge(s) were resolved by callee NAME only, with no receiver type — ` +
        `such a hop can land on a same-named symbol in an unrelated type, and everything reached through it inherits that doubt.`
    );
  }

  const languageGaps = input.languageGaps ?? [];
  if (languageGaps.length > 0) {
    if (confidence === "high") confidence = "medium";
    if (empty) confidence = "low";
  }

  const staleGaps: string[] = [];
  if (input.staleness) {
    if (confidence === "high") confidence = "medium";
    const behind = input.staleness.commitsBehind;
    staleGaps.push(
      `index is ${behind === null ? "an unknown number of" : String(behind)} commit(s) behind HEAD with ` +
        `${String(input.staleness.dirtyCount)} dirty file(s) — results describe the indexed tree, not the current one.`
    );
  }

  const { gaps, fallback } = gapsFor(input.kind, lowOrEmpty || languageGaps.length > 0, input.query);
  const knownGaps = [...gaps, ...languageGaps, ...provGaps, ...staleGaps];
  const provFallback =
    provGaps.length > 0
      ? "confirm the suspect hops with get_symbol_source before relying on this traversal."
      : staleGaps.length > 0
        ? "re-index (index_repository mode='incremental') before relying on this result."
        : null;
  return {
    confidence,
    knownGaps,
    // No fallback when the result is confidently complete.
    suggestFallback: confidence === "high" ? null : (fallback ?? provFallback)
  };
}
