/**
 * Graph reads that are SQL in their own right rather than a delegation (S-30).
 *
 * These are the queries `GraphStore` still spelled out inline after the impact, search, docs
 * and refactor lanes had already been extracted to their own modules: edge lookups by symbol,
 * the property read/write callsite list, the module-level flow graph, and the unresolved-edge
 * tally that `health_check` reports.
 *
 * Moved as-is — same SQL, same parameters, same row shapes. `GraphStore` keeps a method per
 * function so no caller changes.
 */

import type Database from "better-sqlite3";

import type { EdgeRecord, ResolvedEdge, SymbolRecord } from "../types.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST } from "../types.js";
import { buildEdgeToSymbolPairsCte, resolveCanonicalFilePath } from "../impactAnalyzer.js";

export function getDependencies(db: Database.Database, repoId: string, fromId: string, limit: number): EdgeRecord[] {
  return db
    .prepare(
      `
      select repo_id as repoId, from_id as fromId, to_id as toId, type
      from edges
      where repo_id = ? and from_id = ? and type in ('IMPORTS', 'DEPENDS_ON')
      limit ?
      `
    )
    .all(repoId, fromId, limit) as EdgeRecord[];
}

export function getCallEdges(db: Database.Database, repoId: string, symbolId: string, direction: "callers" | "callees", limit: number): EdgeRecord[] {
  // CALLS for the static call graph; PUBLISHES (ISSUE-020) so callers/callees cross the message
  // bus — a publisher counts as a "caller" of the consumer it was matched to, and vice versa.
  // confidence/reason selected so consumers can tag via:"interface" (ISSUE-022) / via:"bus".
  if (direction === "callees") {
    return db
      .prepare(
        `
        select repo_id as repoId, from_id as fromId, to_id as toId, type, confidence, reason
        from edges
        where repo_id = ? and from_id = ? and type in (${CALL_TRAVERSAL_EDGE_SQL_LIST})
        limit ?
        `
      )
      .all(repoId, symbolId, limit) as EdgeRecord[];
  }

  return db
    .prepare(
      `
      select repo_id as repoId, from_id as fromId, to_id as toId, type, confidence, reason
      from edges
      where repo_id = ? and to_id = ? and type in (${CALL_TRAVERSAL_EDGE_SQL_LIST})
      limit ?
      `
    )
    .all(repoId, symbolId, limit) as EdgeRecord[];
}

/** One property symbol plus every read/write callsite that reaches it. */
export interface FieldAccessResult {
  property: { symbolId: string; name: string; kind: string; filePath: string; line: number; declaringType: string | null } | null;
  accesses: {
    mode: "read" | "write";
    enclosingSymbolId: string;
    enclosingName: string | null;
    enclosingKind: string | null;
    filePath: string | null;
    line: number | null;
    toId: string;
    confidence: number | null;
    assignedExpression: string | null;
  }[];
}

export function getFieldAccesses(db: Database.Database, 
  repoId: string,
  symbolId: string,
  mode: "read" | "write" | "all",
  limit: number
): FieldAccessResult {
  const symbol = db
    .prepare(
      `select symbol_id as symbolId, file_path as filePath, name, kind, line
       from symbols where repo_id = ? and symbol_id = ? limit 1`
    )
    .get(repoId, symbolId) as { symbolId: string; filePath: string; name: string; kind: string; line: number } | undefined;
  if (!symbol) return { property: null, accesses: [] };

  // Nearest enclosing type declaration above the property — display-only, for the response.
  const declaringType = (db
    .prepare(
      `select name from symbols
       where repo_id = ? and file_path = ? and kind in ('class','struct','interface','record','record struct') and line <= ?
       order by line desc limit 1`
    )
    .get(repoId, symbol.filePath, symbol.line) as { name: string } | undefined)?.name ?? null;

  const edgeTypes = mode === "read" ? ["PROPERTY_REF"] : mode === "write" ? ["PROPERTY_WRITE"] : ["PROPERTY_REF", "PROPERTY_WRITE"];
  const typeParams: Record<string, string> = {};
  edgeTypes.forEach((t, i) => {
    typeParams[`t${String(i)}`] = t;
  });
  const typePh = edgeTypes.map((_, i) => `@t${String(i)}`).join(",");

  const rows = db
    .prepare(
      `
      with ${buildEdgeToSymbolPairsCte("s.repo_id = @repoId and s.symbol_id = @symbolId")}
      select e.from_id as enclosingSymbolId, sf.name as enclosingName, sf.kind as enclosingKind,
             sf.file_path as filePath, sf.line as line, e.to_id as toId, e.type as type, e.confidence as confidence,
             e.assigned_expression as assignedExpression
      from pairs p
      inner join symbols s on s.repo_id = @repoId and s.symbol_id = p.sid
      inner join edges e on e.rowid = p.eid
      left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.type in (${typePh})
      order by sf.file_path, sf.line
      limit @limit
      `
    )
    .all({ repoId, symbolId, ...typeParams, limit }) as { enclosingSymbolId: string; enclosingName: string | null; enclosingKind: string | null; filePath: string | null; line: number | null; toId: string; type: string; confidence: number | null; assignedExpression: string | null }[];

  return {
    property: { symbolId: symbol.symbolId, name: symbol.name, kind: symbol.kind, filePath: symbol.filePath, line: symbol.line, declaringType },
    accesses: rows.map((r) => ({
      mode: r.type === "PROPERTY_WRITE" ? "write" : "read",
      enclosingSymbolId: r.enclosingSymbolId,
      enclosingName: r.enclosingName,
      enclosingKind: r.enclosingKind,
      filePath: r.filePath,
      line: r.line,
      toId: r.toId,
      confidence: r.confidence,
      assignedExpression: r.assignedExpression ?? null
    }))
  };
}

/** File-level edge list plus the unresolved-call tail that could not be attributed. */
export interface ModuleFlowResult {
  edges: ResolvedEdge[];
  unresolvedCalls: { count: number; samples: string[] };
}

export function getModuleFlow(db: Database.Database, repoId: string, filePath: string, limit: number): ModuleFlowResult {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);

  const all = db
    .prepare(
      `
      with target_symbols as (
        select symbol_id
        from symbols
        where repo_id = ? and file_path = ?
      )
      select
        e.from_id as fromId,
        sf.name as fromName,
        sf.file_path as fromFilePath,
        e.to_id as toId,
        st.name as toName,
        st.file_path as toFilePath,
        e.type
      from edges e
      left join symbols sf
        on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st
        on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ?
        and (
          e.from_id in (select symbol_id from target_symbols)
          or e.to_id in (select symbol_id from target_symbols)
        )
      order by
        case
          when sf.file_path = ? and st.file_path = ? then 0
          when sf.file_path = ? then 1
          when st.file_path = ? then 2
          else 3
        end,
        e.type
      limit ?
      `
    )
    .all(repoId, canonicalFilePath, repoId, canonicalFilePath, canonicalFilePath, canonicalFilePath, canonicalFilePath, limit) as ResolvedEdge[];

  const edges: ResolvedEdge[] = [];
  const unresolvedNames: string[] = [];

  for (const row of all) {
    if (row.toId.startsWith("callee:")) {
      unresolvedNames.push(row.toId.slice(7));
    } else {
      edges.push(row);
    }
  }

  // Dedupe and cap samples
  const uniqueNames = [...new Set(unresolvedNames)];
  return {
    edges,
    unresolvedCalls: {
      count: unresolvedNames.length,
      samples: uniqueNames.slice(0, 20)
    }
  };
}

export function getSymbolsByIds(db: Database.Database, repoId: string, symbolIds: string[]): SymbolRecord[] {
  if (symbolIds.length === 0) {
    return [];
  }

  const placeholders = symbolIds.map(() => "?").join(", ");
  return db
    .prepare(
      `
      select
        repo_id as repoId,
        symbol_id as symbolId,
        file_path as filePath,
        name,
        kind,
        line,
        signature
      from symbols
      where repo_id = ? and symbol_id in (${placeholders})
      `
    )
    .all(repoId, ...symbolIds) as SymbolRecord[];
}

export function getRepository(db: Database.Database, repoId: string): { repoId: string; repoPath: string; updatedAt: string } | null {
  const row = db
    .prepare(
      `
      select repo_id as repoId, repo_path as repoPath, updated_at as updatedAt
      from repositories
      where repo_id = ?
      limit 1
      `
    )
    .get(repoId) as { repoId: string; repoPath: string; updatedAt: string } | undefined;

  return row ?? null;
}

/** Unresolved-edge tally by token class, as reported by health_check. */
export interface UnresolvedStats {
  noCandidates: number;
  ambiguous: number;
  externalBoundary: number;
  importsTotal: number;
  importsClassified: number;
  importClassificationRatio: number;
  trulyUnresolved: number;
}

export function getUnresolvedStats(db: Database.Database, repoId: string): UnresolvedStats {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reason = 'unresolved callee token' OR reason = 'unresolved import token'
                    OR reason = 'unresolved type token' OR reason = 'unresolved property token'
               THEN 1 ELSE 0 END) as trulyUnresolved,
      SUM(CASE WHEN reason = 'external boundary' THEN 1 ELSE 0 END) as externalBoundary
      ,SUM(CASE WHEN type = 'IMPORTS' THEN 1 ELSE 0 END) as importsTotal
      ,SUM(CASE WHEN type = 'IMPORTS' AND coalesce(reason, '') != 'unresolved import token' THEN 1 ELSE 0 END) as importsClassified
    FROM edges
    WHERE repo_id = ?
      AND (to_id LIKE 'callee:%' OR to_id LIKE 'import:%'
           OR to_id LIKE 'type:%' OR to_id LIKE 'property:%')
  `).get(repoId) as { trulyUnresolved: number | null; externalBoundary: number | null; importsTotal: number | null; importsClassified: number | null } | undefined;

  const bridgeRow = db.prepare(`
    SELECT SUM(CASE WHEN reason = 'namespace package contract bridge' THEN 1 ELSE 0 END) as packageBridgeImports
    FROM edges
    WHERE repo_id = ? AND type = 'DEPENDS_ON'
  `).get(repoId) as { packageBridgeImports: number | null } | undefined;

  const latestRun = db.prepare(`
    SELECT unresolved_no_candidate as noCandidates,
           unresolved_ambiguous as ambiguous
    FROM index_runs
    WHERE repo_id = ?
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(repoId) as { noCandidates: number | null; ambiguous: number | null } | undefined;

  return {
    noCandidates: latestRun?.noCandidates ?? 0,
    ambiguous: latestRun?.ambiguous ?? 0,
    externalBoundary: row?.externalBoundary ?? 0,
    importsTotal: row?.importsTotal ?? 0,
    importsClassified: (row?.importsClassified ?? 0) + (bridgeRow?.packageBridgeImports ?? 0),
    importClassificationRatio: (row?.importsTotal ?? 0) > 0 ? Math.min(1, ((row?.importsClassified ?? 0) + (bridgeRow?.packageBridgeImports ?? 0)) / (row?.importsTotal ?? 1)) : 1,
    trulyUnresolved: row?.trulyUnresolved ?? 0,
  };
}
