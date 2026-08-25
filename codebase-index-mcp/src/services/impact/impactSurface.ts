/**
 * `find_impact_files` in both its views — the caller surface per symbol, and the blast radius grouped by file.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "../../types/index.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES } from "../../types/index.js";
import { buildEdgeToSymbolPairsCte, buildImpactSeed, buildReliabilitySummaryImpl, countUnresolvedEdgesForFileImpl, findModuleSymbolId, resolveCanonicalFilePath, wiringNoteFor } from "./impactShared.js";

export function getImpactSurfaceImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit: number,
  /**
   * MCP-ISSUE-056: applied IN the query, before `limit`. As a post-filter it could empty a result
   * that had production callers further down the page — see `registerGraphFunctions`.
   */
  excludeTests = false
): {
  callers: {
    callerName: string;
    callerFile: string;
    callerLine: number;
    symbolAffected: string;
    /**
     * MCP-ISSUE-049: was `edgeType: string`, one row per edge type, so a caller reaching a symbol
     * by both CALLS and TYPE_REF appeared twice and the caller count double-counted it. Now one row
     * per (caller, affected symbol) carrying every way it reaches there.
     */
    edgeTypes: string[];
    confidence: number;
    reason: string | null;
  }[];
  graphHealth: GraphHealth;
  reliabilitySummary: ReliabilitySummary;
  wiringNote?: string;
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);
  const seed = buildImpactSeed(db, repoId, canonicalFilePath);

  const callers = db
    .prepare(
      `
      with ${buildEdgeToSymbolPairsCte(seed.symbolFilter)}
      select
        sf.name as callerName,
        sf.file_path as callerFile,
        sf.line as callerLine,
        s.name as symbolAffected,
        e.type as edgeType,
        e.confidence as confidence,
        e.reason as reason
      from pairs p
      inner join symbols s on s.repo_id = @repoId and s.symbol_id = p.sid
      inner join edges e on e.rowid = p.eid
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      -- MCP-ISSUE-060: was \`sf.file_path != s.file_path\`. Once the seed can hold siblings living in
      -- OTHER files, \`s.file_path\` is the interface's file, not the queried one — that form both
      -- admitted the interface's declaring file as an "impacted" file and dropped genuine callers
      -- that happen to live in it. Self-exclusion is against the file that was asked about.
      where sf.file_path != @filePath
        and (@excludeTests = 0 or is_test_path(sf.file_path) = 0)
      order by sf.file_path, e.type
      limit @limit
      `
    )
    .all({ repoId, filePath: canonicalFilePath, limit, excludeTests: excludeTests ? 1 : 0 }) as {
      callerName: string;
      callerFile: string;
      callerLine: number;
      symbolAffected: string;
      edgeType: string;
      confidence: number;
      reason: string | null;
    }[];

  const moduleSymbolId = findModuleSymbolId(db, repoId, canonicalFilePath) ?? undefined;
  const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalFilePath, moduleSymbolId);

  // P2.1: Filter out low-confidence PROPERTY_REF edges (common generic tokens like Create/Cancel/Submit)
  // that produce false positives. Users can still see them via query_graph if needed.
  //
  // Applied BEFORE the merge below, deliberately: merging first would let a dropped PROPERTY_REF
  // survive as a string inside `edgeTypes`, which is the filter leaking rather than applying.
  const filteredCallers = callers.filter((c) =>
    c.edgeType !== "PROPERTY_REF" || c.confidence >= 0.7
  );

  // MCP-ISSUE-049: collapse one-row-per-edge-type into one row per caller→symbol pair. `confidence`
  // becomes the strongest edge's, and `reason` the reason of that same winning edge, so the two stay
  // consistent with each other. Insertion order is preserved, which keeps the SQL `order by
  // sf.file_path, e.type` meaningful in the output.
  const merged = new Map<string, {
    callerName: string; callerFile: string; callerLine: number; symbolAffected: string;
    edgeTypes: string[]; confidence: number; reason: string | null;
  }>();
  for (const c of filteredCallers) {
    const key = `${c.callerFile}\u0000${c.callerName}\u0000${String(c.callerLine)}\u0000${c.symbolAffected}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        callerName: c.callerName, callerFile: c.callerFile, callerLine: c.callerLine,
        symbolAffected: c.symbolAffected, edgeTypes: [c.edgeType], confidence: c.confidence, reason: c.reason
      });
      continue;
    }
    if (!existing.edgeTypes.includes(c.edgeType)) existing.edgeTypes.push(c.edgeType);
    if (c.confidence > existing.confidence) {
      existing.confidence = c.confidence;
      existing.reason = c.reason;
    }
  }
  const mergedCallers = [...merged.values()];

  // When no external callers surface, the file may be a DI/reflection-wired shape whose
  // callers are invoked at runtime — explain that instead of implying "no dependents".
  const wiringNote = mergedCallers.length === 0 ? wiringNoteFor(db, repoId, canonicalFilePath) : undefined;

  return {
    callers: mergedCallers,
    graphHealth,
    reliabilitySummary: buildReliabilitySummaryImpl(mergedCallers.map((x) => x.confidence), graphHealth),
    ...(wiringNote ? { wiringNote } : {})
  };
}

// ── getImpactFiles ─────────────────────────────────────────────────────

/**
 * Every file that depends on `filePath`, plus the TRUE size of that blast radius.
 *
 * MCP-ISSUE-054 (re-opened 2026-08-10): `limit` used to be applied to the one and only query, so the
 * caller could not tell `min(trueDependents, limit)` from `trueDependents` — and `detect_changes`
 * fed that truncated number straight into the risk scorer. Same diff, same file, same commit:
 * `medium` at the default `impactLimit: 20` and `high` at any wider page. The first fix moved the
 * cap out of the scoring DENOMINATOR; it was still in the NUMERATOR, one layer up, here.
 *
 * So the count and the page are now two different questions. The aggregate pass is unbounded and
 * answers "how wide is this really" (`totalImpactedCount`) and "how reliable are those edges"
 * (`reliabilitySummary`); `limit` then selects the page of detail rows to return. It costs a full
 * walk of the caller set where the old form could stop early — which is the price of the count being
 * a measurement rather than a floor.
 */
export function getImpactFilesImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit: number,
  /** MCP-ISSUE-056: in-query, before the cap — a post-filter can empty a page that had real rows. */
  excludeTests = false
): {
  impactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[];
  /** Dependent files BEFORE `limit` — the number that may be scored. Never truncated. */
  totalImpactedCount: number;
  /** `totalImpactedCount > limit`: the returned page is a window, the count is not. */
  truncated: boolean;
  graphHealth: GraphHealth;
  /** Computed over the FULL dependent set, not the returned page — it feeds the risk model too. */
  reliabilitySummary: ReliabilitySummary;
  wiringNote?: string;
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);
  const seed = buildImpactSeed(db, repoId, canonicalFilePath);
  const pairs = buildEdgeToSymbolPairsCte(seed.symbolFilter);

  // Pass 1 — unbounded. One row per dependent file carrying its strongest edge confidence, which is
  // exactly what the per-file merge below would arrive at, so the summary over this set matches the
  // summary the old code built over its (truncated) page.
  const allCallerFiles = db
    .prepare(
      `
      with ${pairs}
      select sf.file_path as callerFile, max(e.confidence) as confidence
      from pairs p
      inner join symbols s on s.repo_id = @repoId and s.symbol_id = p.sid
      inner join edges e on e.rowid = p.eid
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      -- MCP-ISSUE-060: self-exclusion is against the QUERIED file, not the matched symbol's file,
      -- which may now be an interface declared elsewhere. See buildImpactSeed.
      where sf.file_path != @filePath
        and (@excludeTests = 0 or is_test_path(sf.file_path) = 0)
      group by sf.file_path
      order by sf.file_path
      `
    )
    .all({ repoId, filePath: canonicalFilePath, excludeTests: excludeTests ? 1 : 0 }) as {
      callerFile: string;
      confidence: number;
    }[];

  const totalImpactedCount = allCallerFiles.length;
  const distinctFiles = allCallerFiles.slice(0, Math.max(0, limit));
  const truncated = totalImpactedCount > distinctFiles.length;

  if (distinctFiles.length === 0) {
    const moduleSymbolId = findModuleSymbolId(db, repoId, canonicalFilePath) ?? undefined;
    const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalFilePath, moduleSymbolId);
    const wiringNote = wiringNoteFor(db, repoId, canonicalFilePath);
    return {
      impactedFiles: [],
      totalImpactedCount,
      truncated,
      graphHealth,
      reliabilitySummary: buildReliabilitySummaryImpl(allCallerFiles.map((x) => x.confidence), graphHealth),
      ...(wiringNote ? { wiringNote } : {})
    };
  }

  // Named parameters, because the CTE repeats `symbolFilter` once per branch.
  const fileParams: Record<string, string> = { repoId, filePath: canonicalFilePath };
  distinctFiles.forEach((r, i) => {
    fileParams[`f${String(i)}`] = r.callerFile;
  });
  const ph = distinctFiles.map((_, i) => `@f${String(i)}`).join(", ");
  const rows = db
    .prepare(
      `
      with ${pairs}
      select
        sf.file_path as callerFile,
        e.type as edgeType,
        e.confidence as confidence,
        e.reason as reason,
        s.name as symbolAffected
      from pairs p
      inner join symbols s on s.repo_id = @repoId and s.symbol_id = p.sid
      inner join edges e on e.rowid = p.eid
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where sf.file_path in (${ph})
        and sf.file_path != @filePath
      order by sf.file_path
      `
    )
    .all(fileParams) as {
      callerFile: string;
      edgeType: string;
      confidence: number;
      reason: string | null;
      symbolAffected: string;
    }[];

  const byFile = new Map<string, { reason: string; confidence: number; symbolsAffected: Set<string> }>();
  for (const row of rows) {
    const existing = byFile.get(row.callerFile);
    if (existing) {
      existing.symbolsAffected.add(row.symbolAffected);
      if (row.confidence > existing.confidence) {
        existing.confidence = row.confidence;
        existing.reason = row.reason ?? row.edgeType;
      }
    } else {
      byFile.set(row.callerFile, {
        reason: row.reason ?? row.edgeType,
        confidence: row.confidence,
        symbolsAffected: new Set([row.symbolAffected])
      });
    }
  }

  const impactedFiles = Array.from(byFile.entries()).map(([fp, v]) => ({
    filePath: fp,
    reason: v.reason,
    confidence: v.confidence,
    symbolsAffected: Array.from(v.symbolsAffected)
  }));

  const moduleSymbolId = findModuleSymbolId(db, repoId, canonicalFilePath) ?? undefined;
  const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalFilePath, moduleSymbolId);
  return {
    impactedFiles,
    totalImpactedCount,
    truncated,
    graphHealth,
    // Over `allCallerFiles`, NOT `impactedFiles`: the summary feeds `lowConfidencePenalty` and
    // `confidencePenalty` in the risk model, so computing it over the page would leave two more
    // scoring inputs moving with the page size — the second-order half of MCP-ISSUE-054.
    reliabilitySummary: buildReliabilitySummaryImpl(allCallerFiles.map((x) => x.confidence), graphHealth)
  };
}
// ── getFileSummary ─────────────────────────────────────────────────────
