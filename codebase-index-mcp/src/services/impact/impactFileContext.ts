/**
 * File- and change-scoped context: `get_file_summary`, `get_file_context`, its batched form, and `get_change_context`.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "../../types/index.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES } from "../../types/index.js";
import { expandInterfaceSiblingsImpl } from "../graph/interfaceSiblings.js";
import { TRIVIAL_CALLEE_TOKENS, buildReliabilitySummaryImpl, countUnresolvedEdgesForFileImpl, normalizePath, resolveCanonicalFilePath } from "./impactShared.js";

export function getFileSummaryImpl(
  db: Database.Database,
  repoId: string,
  filePath: string
): {
  file: { filePath: string; language: string | null };
  exports: SymbolRecord[];
  imports: ResolvedEdge[];
  importedBy: { fromFilePath: string; edgeType: string }[];
  graphHealth: GraphHealth;
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);

  const fileRow = db
    .prepare(
      `
      select path as filePath, language
      from files
      where repo_id = ? and replace(path, char(92), '/') = ?
      order by case when path = ? then 0 else 1 end
      limit 1
      `
    )
    .get(repoId, normalizePath(filePath), filePath) as { filePath: string; language: string | null } | undefined;

  const exports = db
    .prepare(
      `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
       from symbols where repo_id = ? and file_path = ? and kind != 'module'
       order by line limit 50`
    )
    .all(repoId, canonicalFilePath) as SymbolRecord[];

  const moduleSymbol = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
    .get(repoId, canonicalFilePath) as { symbolId: string } | undefined;

  const symbolIds = exports.map((s) => s.symbolId);
  if (moduleSymbol) symbolIds.unshift(moduleSymbol.symbolId);

  const imports = symbolIds.length > 0
    ? db
        .prepare(
          `
          select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
                 e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type
          from edges e
          left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ? and e.from_id in (${symbolIds.map(() => "?").join(",")})
            and e.type = 'IMPORTS'
          limit 20
          `
        )
        .all(repoId, ...symbolIds) as ResolvedEdge[]
    : [];

  const importedBy = symbolIds.length > 0
    ? (db
        .prepare(
          `
          select distinct sf.file_path as fromFilePath, e.type as edgeType
          from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          where e.repo_id = ? and e.to_id in (${symbolIds.map(() => "?").join(",")})
            and sf.file_path != ?
          order by sf.file_path
          limit 20
          `
        )
        .all(repoId, ...symbolIds, canonicalFilePath) as { fromFilePath: string; edgeType: string }[])
    : [];

  return {
    file: fileRow ?? { filePath: canonicalFilePath, language: null },
    exports,
    imports,
    importedBy,
    graphHealth: countUnresolvedEdgesForFileImpl(db, repoId, canonicalFilePath)
  };
}

// ── getFileContext ─────────────────────────────────────────────────────

export function getFileContextImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit: number,
  compact = false
): { symbols: SymbolRecord[] | { name: string; kind: string; line: number }[]; edges: ResolvedEdge[]; graphHealth: GraphHealth } {
  const canonicalPath = resolveCanonicalFilePath(db, repoId, filePath);
  const symbols = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
      from symbols
      where repo_id = ? and replace(file_path, char(92), '/') = replace(?, char(92), '/')
      limit ?
      `
    )
    .all(repoId, canonicalPath, limit) as SymbolRecord[];

  if (symbols.length === 0) {
    return { symbols: [], edges: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, unresolvedProperties: 0, note: "no symbols found" } };
  }

  if (compact) {
    const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalPath);
    return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })), edges: [], graphHealth };
  }

  const symbolIds = symbols.map((s) => s.symbolId);
  const placeholders = symbolIds.map(() => "?").join(", ");
  const edges = db
    .prepare(
      `
      select
        e.from_id as fromId,
        sf.name as fromName,
        sf.file_path as fromFilePath,
        e.to_id as toId,
        st.name as toName,
        st.file_path as toFilePath,
        e.type
      from edges e
      left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ? and (e.from_id in (${placeholders}) or e.to_id in (${placeholders}))
      limit ?
      `
    )
    .all(repoId, ...symbolIds, ...symbolIds, limit) as ResolvedEdge[];

  const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalPath);
  return { symbols, edges, graphHealth };
}

// ── getBatchContext ────────────────────────────────────────────────────

export function getBatchContextImpl(
  db: Database.Database,
  repoId: string,
  filePaths: string[],
  limit: number,
  compact = false
): { symbols: SymbolRecord[] | { name: string; kind: string; filePath: string; line: number }[]; edges: ResolvedEdge[] } {
  if (filePaths.length === 0) {
    return { symbols: [], edges: [] };
  }
  const canonicalPaths = filePaths.map((fp) => resolveCanonicalFilePath(db, repoId, fp));
  const placeholders = canonicalPaths.map(() => "?").join(", ");
  const symbols = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
      from symbols
      where repo_id = ? and replace(file_path, char(92), '/') in (${placeholders.split(", ").map(() => "replace(?, char(92), '/')").join(", ")})
      limit ?
      `
    )
    .all(repoId, ...canonicalPaths, limit) as SymbolRecord[];

  if (symbols.length === 0) {
    return { symbols: [], edges: [] };
  }

  if (compact) {
    return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })), edges: [] };
  }

  const symbolIds = symbols.map((s) => s.symbolId);
  const symPlaceholders = symbolIds.map(() => "?").join(", ");
  const edges = db
    .prepare(
      `
      select
        e.from_id as fromId,
        sf.name as fromName,
        sf.file_path as fromFilePath,
        e.to_id as toId,
        st.name as toName,
        st.file_path as toFilePath,
        e.type
      from edges e
      left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ? and (e.from_id in (${symPlaceholders}) or e.to_id in (${symPlaceholders}))
      limit ?
      `
    )
    .all(repoId, ...symbolIds, ...symbolIds, limit) as ResolvedEdge[];

  return { symbols, edges };
}
// ── getChangeContext ───────────────────────────────────────────────────

export function getChangeContextImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  callerDepth: number,
  calleeDepth: number,
  limit: number
): {
  symbol: SymbolRecord | null;
  callers: (ResolvedEdge & { distance: number })[];
  callees: ResolvedEdge[];
  typeDeps: ResolvedEdge[];
  graphHealth: GraphHealth;
  reliabilitySummary: ReliabilitySummary;
} {
  const symbol = db
    .prepare(
      `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
       from symbols where repo_id = ? and symbol_id = ? limit 1`
    )
    .get(repoId, symbolId) as SymbolRecord | undefined;

  if (!symbol) {
    const graphHealth = { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, unresolvedProperties: 0, note: "symbol not found" };
    return {
      symbol: null,
      callers: [],
      callees: [],
      typeDeps: [],
      graphHealth,
      reliabilitySummary: buildReliabilitySummaryImpl([], graphHealth)
    };
  }

  // BFS callers up to callerDepth
  const callers: (ResolvedEdge & { distance: number })[] = [];
  const visitedCallers = new Set<string>([symbolId]);
  // ISSUE-022: mở rộng frontier depth-1 sang interface siblings (interface method ↔ impl
  // method, class → own members) để caller gọi qua DI interface vẫn hiện ra — kể cả trên
  // index cũ chưa có interface-dispatch edges. Row đến từ sibling được tag `via`.
  const interfaceSiblings = expandInterfaceSiblingsImpl(db, repoId, [symbolId]);
  const viaBySiblingId = new Map(interfaceSiblings.map((s) => [s.symbolId, s.via]));
  for (const s of interfaceSiblings) visitedCallers.add(s.symbolId);
  let frontier = [symbolId, ...interfaceSiblings.map((s) => s.symbolId)];
  const declaringType = symbol.kind === "property"
    ? (db
        .prepare(
          `
          select name
          from symbols
          where repo_id = ? and file_path = ? and kind in ('class', 'struct') and line < ?
          order by line desc
          limit 1
          `
        )
        .get(repoId, symbol.filePath, symbol.line) as { name: string } | undefined)
    : undefined;
  const propertyTokenFallback = symbol.kind === "property" && declaringType?.name
    ? `property:${declaringType.name}.${symbol.name}`
    : null;
  // Callers cross the bus too: a publisher is a "caller" of the consumer it was matched to
  // (PUBLISHES edge), so include it alongside CALLS — consistent with getCallEdges / trace.
  const initialCallerEdgeTypes = symbol.kind === "property"
    ? [...CALL_TRAVERSAL_EDGE_TYPES, "PROPERTY_REF", "PROPERTY_WRITE"]
    : [...CALL_TRAVERSAL_EDGE_TYPES];
  for (let depth = 1; depth <= callerDepth && frontier.length > 0 && callers.length < limit; depth++) {
    const ph = frontier.map(() => "?").join(",");
    const callerEdgeTypes = depth === 1 ? initialCallerEdgeTypes : [...CALL_TRAVERSAL_EDGE_TYPES];
    const edgeTypePh = callerEdgeTypes.map(() => "?").join(",");
    const includePropertyFallback = depth === 1 && propertyTokenFallback !== null;
    const fallbackClause = includePropertyFallback
      ? "or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ?)"
      : "";
    const rows = db
      .prepare(
        `
        select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
             e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type,
             e.confidence as confidence, e.reason as reason
        from edges e
        left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ?
          and ((e.type in (${edgeTypePh}) and e.to_id in (${ph})) ${fallbackClause})
        limit ?
        `
      )
      .all(
        ...[
          repoId,
          ...callerEdgeTypes,
          ...frontier,
          ...(includePropertyFallback && propertyTokenFallback ? [propertyTokenFallback] : []),
          limit - callers.length
        ]
      ) as ResolvedEdge[];

    const nextFrontier: string[] = [];
    for (const row of rows) {
      if (!visitedCallers.has(row.fromId)) {
        visitedCallers.add(row.fromId);
        // ISSUE-022: tag nguồn gốc merge — sibling frontier hoặc edge interface-dispatch đã
        // resolve sẵn trong DB; bus edges giữ via:"bus" (mirror trace_execution_flow).
        const siblingVia = depth === 1 ? viaBySiblingId.get(row.toId) : undefined;
        const via = siblingVia ?? (row.reason === "interface-dispatch" ? "interface" : row.type === "PUBLISHES" ? "bus" : undefined);
        const confidence = via === "interface" ? Math.min(row.confidence ?? 1, 0.7) : row.confidence;
        callers.push({ ...row, ...(via ? { via } : {}), confidence, distance: depth });
        nextFrontier.push(row.fromId);
      }
    }
    frontier = nextFrontier;
  }

  // Callees (depth 1)
  const allCallees = db
    .prepare(
      `
      select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
         e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type,
         e.confidence as confidence, e.reason as reason
      from edges e
      left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ? and e.from_id = ? and e.type in (${CALL_TRAVERSAL_EDGE_SQL_LIST})
      limit 20
      `
    )
    .all(repoId, symbolId) as ResolvedEdge[];
  const callees = allCallees.filter((edge) => {
    // Drop unresolved external bus hops (PUBLISHES still carrying a `contract:` token) — they
    // have no target symbol, mirroring how trace_execution_flow's inner join excludes them.
    if (edge.toId.startsWith("contract:")) {
      return false;
    }
    if (!edge.toId.startsWith("callee:")) {
      return true;
    }
    const token = edge.toId.slice("callee:".length);
    return !TRIVIAL_CALLEE_TOKENS.has(token);
  });

  // Type deps: IMPORTS from same file
  const moduleSymbol = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
    .get(repoId, symbol.filePath) as { symbolId: string } | undefined;

  const typeDeps = moduleSymbol
    ? (db
        .prepare(
          `
          select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
                 e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type,
                 e.confidence as confidence, e.reason as reason
          from edges e
          left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ? and e.from_id = ? and e.type = 'IMPORTS'
          limit 10
          `
        )
        .all(repoId, moduleSymbol.symbolId) as ResolvedEdge[])
        .filter((x) => x.toName !== null)
    : [];

  const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, symbol.filePath, symbol.symbolId);
  const confidenceSeries = [
    ...callers.map((x) => x.confidence ?? 1),
    ...callees.map((x) => x.confidence ?? 1),
    ...typeDeps.map((x) => x.confidence ?? 1)
  ];

  return {
    symbol,
    callers,
    callees,
    typeDeps,
    graphHealth,
    reliabilitySummary: buildReliabilitySummaryImpl(confidenceSeries, graphHealth)
  };
}
// ── getRenameImpact ────────────────────────────────────────────────────
