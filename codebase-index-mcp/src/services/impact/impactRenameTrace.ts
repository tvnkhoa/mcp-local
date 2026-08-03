/**
 * Rename impact and execution-flow tracing — the two answers that walk the graph from a single symbol.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "../types.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES } from "../types.js";
import { expandInterfaceSiblingsImpl } from "../graph/interfaceSiblings.js";

export function getRenameImpactImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  limit: number
): {
  symbol: SymbolRecord | null;
  callers: ResolvedEdge[];
  importers: ResolvedEdge[];
  affectedFileCount: number;
} {
  const symbol = db
    .prepare(
      `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
       from symbols where repo_id = ? and symbol_id = ? limit 1`
    )
    .get(repoId, symbolId) as SymbolRecord | undefined ?? null;

  if (!symbol) {
    return { symbol: null, callers: [], importers: [], affectedFileCount: 0 };
  }

  const callerRows = db
    .prepare(
      `select e.from_id as fromId, e.to_id as toId, e.type,
              s.name as fromName, s.file_path as fromFilePath,
              t.name as toName, t.file_path as toFilePath,
              e.confidence, e.reason
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
       where e.repo_id = ? and e.to_id = ? and e.type = 'CALLS'
       order by s.file_path
       limit ?`
    )
    .all(repoId, symbolId, limit) as ResolvedEdge[];

  const importerRows = db
    .prepare(
      `select e.from_id as fromId, e.to_id as toId, e.type,
              s.name as fromName, s.file_path as fromFilePath,
              t.name as toName, t.file_path as toFilePath,
              e.confidence, e.reason
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
       where e.repo_id = ? and e.to_id = ? and e.type = 'IMPORTS'
       order by s.file_path
       limit ?`
    )
    .all(repoId, symbolId, limit) as ResolvedEdge[];

  const affectedFilePaths = new Set<string>();
  for (const r of callerRows) if (r.fromFilePath) affectedFilePaths.add(r.fromFilePath);
  for (const r of importerRows) if (r.fromFilePath) affectedFilePaths.add(r.fromFilePath);

  return {
    symbol,
    callers: callerRows,
    importers: importerRows,
    affectedFileCount: affectedFilePaths.size
  };
}

// ── traceExecutionFlow ─────────────────────────────────────────────────

export function traceExecutionFlowImpl(
  db: Database.Database,
  repoId: string,
  entrySymbolId: string,
  maxDepth: number,
  maxNodes: number
): {
  entrySymbol: SymbolRecord | null;
  nodes: SymbolRecord[];
  edges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null; via?: string }[];
  depthReached: number;
  truncated: boolean;
} {
  const entrySymbol = db
    .prepare(
      `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
       from symbols where repo_id = ? and symbol_id = ? limit 1`
    )
    .get(repoId, entrySymbolId) as SymbolRecord | undefined ?? null;

  if (!entrySymbol) {
    return { entrySymbol: null, nodes: [], edges: [], depthReached: 0, truncated: false };
  }

  const visitedSymbols = new Set<string>([entrySymbolId]);
  const visitedEdges = new Set<string>();
  const resultNodes: SymbolRecord[] = [entrySymbol];
  const resultEdges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null; via?: string }[] = [];
  let frontier = [entrySymbolId];
  let depthReached = 0;
  let truncated = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && resultNodes.length < maxNodes; depth++) {
    const nextFrontier: string[] = [];
    for (const currentId of frontier) {
      if (resultNodes.length >= maxNodes) { truncated = true; break; }
      // CALLS for normal control flow; PUBLISHES (ISSUE-020) to cross the message bus into the
      // resolved consumer. Unresolved (external) bus edges keep a `contract:` to_id and are
      // excluded by the inner join, so only matched producer→consumer hops are followed.
      const calleeRows = db
        .prepare(
          `select e.from_id as fromId, e.to_id as toId, e.confidence, e.type as edgeType, e.reason as edgeReason,
                  sf.name as fromName, st.name as toName,
                  st.repo_id as repoId, st.symbol_id as symbolId, st.file_path as filePath,
                  st.kind, st.line, st.signature
           from edges e
           inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
           inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
           where e.repo_id = ? and e.from_id = ? and e.type in (${CALL_TRAVERSAL_EDGE_SQL_LIST})
           limit 50`
        )
        .all(repoId, currentId) as (SymbolRecord & { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null; edgeType: string; edgeReason: string | null })[];

      for (const row of calleeRows) {
        const edgeKey = `${row.fromId}:${row.toId}`;
        if (!visitedEdges.has(edgeKey)) {
          visitedEdges.add(edgeKey);
          // ISSUE-020/022: tag bus hops and interface-dispatch hops so the flow distinguishes them.
          const via = row.edgeType === "PUBLISHES" ? "bus" : row.edgeReason === "interface-dispatch" ? "interface" : undefined;
          resultEdges.push({ fromId: row.fromId, toId: row.toId, fromName: row.fromName, toName: row.toName, confidence: row.confidence ?? null, ...(via && { via }) });
        }
        if (!visitedSymbols.has(row.toId) && resultNodes.length < maxNodes) {
          visitedSymbols.add(row.toId);
          resultNodes.push({ repoId: row.repoId, symbolId: row.symbolId, filePath: row.filePath, name: row.toName, kind: row.kind, line: row.line, signature: row.signature });
          nextFrontier.push(row.toId);
        }
      }
    }
    frontier = nextFrontier;
    depthReached = depth + 1;
  }

  if (frontier.length > 0 && resultNodes.length >= maxNodes) truncated = true;

  return { entrySymbol, nodes: resultNodes, edges: resultEdges, depthReached, truncated };
}

// ── getFolderSummary ───────────────────────────────────────────────────
