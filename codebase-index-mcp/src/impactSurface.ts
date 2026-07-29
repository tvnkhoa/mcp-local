/**
 * `find_impact_files` in both its views — the caller surface per symbol, and the blast radius grouped by file.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "./types.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES } from "./types.js";
import { expandInterfaceSiblingsImpl } from "./interfaceSiblings.js";
import { buildEdgeToSymbolPairsCte, buildReliabilitySummaryImpl, countUnresolvedEdgesForFileImpl, findModuleSymbolId, resolveCanonicalFilePath, wiringNoteFor } from "./impactShared.js";

export function getImpactSurfaceImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit: number
): {
  callers: {
    callerName: string;
    callerFile: string;
    callerLine: number;
    symbolAffected: string;
    edgeType: string;
    confidence: number;
    reason: string | null;
  }[];
  graphHealth: GraphHealth;
  reliabilitySummary: ReliabilitySummary;
  wiringNote?: string;
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);

  const callers = db
    .prepare(
      `
      with ${buildEdgeToSymbolPairsCte("s.repo_id = @repoId and s.file_path = @filePath")}
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
      where sf.file_path != s.file_path
      order by sf.file_path, e.type
      limit @limit
      `
    )
    .all({ repoId, filePath: canonicalFilePath, limit }) as {
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
  const filteredCallers = callers.filter((c) =>
    c.edgeType !== "PROPERTY_REF" || c.confidence >= 0.7
  );

  // When no external callers surface, the file may be a DI/reflection-wired shape whose
  // callers are invoked at runtime — explain that instead of implying "no dependents".
  const wiringNote = filteredCallers.length === 0 ? wiringNoteFor(db, repoId, canonicalFilePath) : undefined;

  return {
    callers: filteredCallers,
    graphHealth,
    reliabilitySummary: buildReliabilitySummaryImpl(filteredCallers.map((x) => x.confidence), graphHealth),
    ...(wiringNote ? { wiringNote } : {})
  };
}

// ── getImpactFiles ─────────────────────────────────────────────────────

export function getImpactFilesImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit: number
): {
  impactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[];
  graphHealth: GraphHealth;
  reliabilitySummary: ReliabilitySummary;
  wiringNote?: string;
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);
  const pairs = buildEdgeToSymbolPairsCte("s.repo_id = @repoId and s.file_path = @filePath");

  const distinctFiles = db
    .prepare(
      `
      with ${pairs}
      select distinct sf.file_path as callerFile
      from pairs p
      inner join symbols s on s.repo_id = @repoId and s.symbol_id = p.sid
      inner join edges e on e.rowid = p.eid
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where sf.file_path != s.file_path
      order by sf.file_path
      limit @limit
      `
    )
    .all({ repoId, filePath: canonicalFilePath, limit }) as { callerFile: string }[];

  if (distinctFiles.length === 0) {
    const moduleSymbolId = findModuleSymbolId(db, repoId, canonicalFilePath) ?? undefined;
    const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalFilePath, moduleSymbolId);
    const wiringNote = wiringNoteFor(db, repoId, canonicalFilePath);
    return {
      impactedFiles: [],
      graphHealth,
      reliabilitySummary: buildReliabilitySummaryImpl([], graphHealth),
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
        and sf.file_path != s.file_path
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
    graphHealth,
    reliabilitySummary: buildReliabilitySummaryImpl(impactedFiles.map((x) => x.confidence), graphHealth)
  };
}
// ── getFileSummary ─────────────────────────────────────────────────────
