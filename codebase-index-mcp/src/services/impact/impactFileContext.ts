/**
 * File- and change-scoped context: `get_file_summary`, `get_file_context`, its batched form, and `get_change_context`.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "../../types/index.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES, RESOLVED_TARGET_SQL_PREDICATE } from "../../types/index.js";
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
  compact = false,
  edgeLimit?: number,
  includePropertyRefs = false
): { symbols: SymbolRecord[] | { name: string; kind: string; line: number }[]; edges: ResolvedEdge[]; edgesTruncated?: boolean; graphHealth: GraphHealth } {
  const canonicalPath = resolveCanonicalFilePath(db, repoId, filePath);
  const allSymbols = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
      from symbols
      where repo_id = ? and replace(file_path, char(92), '/') = replace(?, char(92), '/')
      limit ?
      `
    )
    .all(repoId, canonicalPath, limit) as SymbolRecord[];

  // MCP-ISSUE-049: the module pseudo-symbol is dropped from what is REPORTED — this tool counted it
  // and `getFileSummaryImpl` did not, so the two disagreed (7 vs 6) about the same file. The module
  // row stands for the file itself, is not a symbol the caller can navigate to, and
  // `findDocCoverageImpl` already excludes it.
  //
  // It is deliberately kept in the edge query below: IMPORTS edges hang off the module symbol, so
  // filtering it out of `symbolIds` too would silently drop every import edge from the response.
  // `getFileSummaryImpl` makes the same distinction, by unshifting the module id onto its own
  // `symbolIds` after excluding it from `exports`.
  const symbols = allSymbols.filter((s) => s.kind !== "module");

  if (allSymbols.length === 0) {
    return { symbols: [], edges: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, unresolvedProperties: 0, note: "no symbols found" } };
  }

  if (compact) {
    const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalPath);
    return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })), edges: [], graphHealth };
  }

  const symbolIds = allSymbols.map((s) => s.symbolId);
  const placeholders = symbolIds.map(() => "?").join(", ");
  const edgeBudget = resolveEdgeLimit(limit, edgeLimit);
  const edgeRows = db
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
        and (? = 1 or e.type not in ('PROPERTY_REF', 'PROPERTY_WRITE'))
      -- Structure before behaviour before detail. Row order used to be arbitrary, so the first cap
      -- applied filled the budget with whatever the index happened to yield first: on the measured
      -- file that was 40 CALLS edges, starving all 26 IMPORTS and both IMPLEMENTS/EXTENDS — the
      -- edges that answer "what IS this file" before "what does it do".
      order by case e.type
                 when 'IMPLEMENTS' then 0
                 when 'EXTENDS' then 1
                 when 'IMPORTS' then 2
                 when 'DEPENDS_ON' then 3
                 when 'PUBLISHES' then 4
                 when 'CONSUMES' then 5
                 when 'CALLS' then 6
                 when 'TYPE_REF' then 7
                 else 8
               end
      limit ?
      `
    )
    .all(repoId, ...symbolIds, ...symbolIds, includePropertyRefs ? 1 : 0, edgeBudget + 1) as ResolvedEdge[];

  const edges = edgeRows.slice(0, edgeBudget);
  const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalPath);
  return { symbols, edges, edgesTruncated: edgeRows.length > edges.length, graphHealth };
}

/**
 * MCP-ISSUE-060: edges get their own budget, separate from the symbol `limit`.
 *
 * Measured: `get_file_context(profile:"standard")` on a 22-symbol C# service returned **68 663**
 * characters — past the host's token cap, so the response was diverted to a file the agent then had
 * to read back in chunks. `wc`/`grep` over that payload: 200 edges at ~330 characters each, i.e.
 * **96%** of it, of which `PROPERTY_REF` alone was 51%. The same call at `verbose` reached 83 449.
 *
 * The cause was one `limit` doing two jobs: it bounded the symbol query AND the edge query, so a file
 * with few symbols and a dense domain model got no edge bound at all in practice. A TypeScript file
 * of 108 symbols stayed small only because it has zero `PROPERTY_REF` edges — this was a C# tax, on
 * exactly the repo the workspace rules name as the primary target.
 *
 * `PROPERTY_REF`/`PROPERTY_WRITE` are excluded by default because they are the lowest-value edge for
 * "what does this file do" and the highest-volume by far; `compact` already omitted every edge and
 * lost nothing anyone missed. `includePropertyRefs` opts back in.
 */
export const DEFAULT_FILE_CONTEXT_EDGE_LIMIT = 40;

function resolveEdgeLimit(symbolLimit: number, edgeLimit: number | undefined): number {
  if (edgeLimit != null && edgeLimit > 0) return edgeLimit;
  return Math.min(symbolLimit, DEFAULT_FILE_CONTEXT_EDGE_LIMIT);
}

// ── getBatchContext ────────────────────────────────────────────────────

export function getBatchContextImpl(
  db: Database.Database,
  repoId: string,
  filePaths: string[],
  limit: number,
  compact = false,
  edgeLimit?: number,
  includePropertyRefs = false
): { symbols: SymbolRecord[] | { name: string; kind: string; filePath: string; line: number }[]; edges: ResolvedEdge[]; edgesTruncated?: boolean } {
  if (filePaths.length === 0) {
    return { symbols: [], edges: [] };
  }
  const canonicalPaths = filePaths.map((fp) => resolveCanonicalFilePath(db, repoId, fp));
  const placeholders = canonicalPaths.map(() => "?").join(", ");
  const allSymbols = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
      from symbols
      where repo_id = ? and replace(file_path, char(92), '/') in (${placeholders.split(", ").map(() => "replace(?, char(92), '/')").join(", ")})
      limit ?
      `
    )
    .all(repoId, ...canonicalPaths, limit) as SymbolRecord[];

  // MCP-ISSUE-049: same split as the single-file path above — the module pseudo-symbol is excluded
  // from the reported set (so `symbolCount` agrees with get_file_summary) but kept for the edge query
  // (so IMPORTS edges, which hang off it, survive). The batched form had the identical asymmetry.
  const symbols = allSymbols.filter((s) => s.kind !== "module");

  if (allSymbols.length === 0) {
    return { symbols: [], edges: [] };
  }

  if (compact) {
    return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })), edges: [] };
  }

  const symbolIds = allSymbols.map((s) => s.symbolId);
  const symPlaceholders = symbolIds.map(() => "?").join(", ");
  // MCP-ISSUE-060: the batch form gets the same edge budget as the single-file form. Missing it here
  // first time round left `get_file_context({filePaths})` with the original unbounded shape while
  // `{filePath}` was fixed — the same tool answering two different ways depending on which argument
  // the caller reached for.
  const edgeBudget = resolveEdgeLimit(limit, edgeLimit);
  const edgeRows = db
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
        and (? = 1 or e.type not in ('PROPERTY_REF', 'PROPERTY_WRITE'))
      order by case e.type
                 when 'IMPLEMENTS' then 0
                 when 'EXTENDS' then 1
                 when 'IMPORTS' then 2
                 when 'DEPENDS_ON' then 3
                 when 'PUBLISHES' then 4
                 when 'CONSUMES' then 5
                 when 'CALLS' then 6
                 when 'TYPE_REF' then 7
                 else 8
               end
      limit ?
      `
    )
    .all(repoId, ...symbolIds, ...symbolIds, includePropertyRefs ? 1 : 0, edgeBudget + 1) as ResolvedEdge[];

  const edges = edgeRows.slice(0, edgeBudget);
  return { symbols, edges, edgesTruncated: edgeRows.length > edges.length };
}
// ── getChangeContext ───────────────────────────────────────────────────

export function getChangeContextImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  callerDepth: number,
  calleeDepth: number,
  limit: number,
  /**
   * MCP-ISSUE-056: applied in SQL, before every `limit ?`. As a post-filter it could return
   * `callers: []` for a symbol whose first page of rows happened to be test files.
   */
  excludeTests = false
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
          ${excludeTests ? "and (sf.file_path is null or is_test_path(sf.file_path) = 0)" : ""}
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
      -- MCP-ISSUE-053: unresolved tokens are excluded in SQL, not after it. At profile "nano" with
      -- limit 8 they filled 6 of the 8 slots as bare {"confidence":0.1} objects — no name, no path,
      -- no id — while calleeCount counted them, so the count could not even be used to decide
      -- whether raising the limit would help. They remain reported, in unresolved / graphHealth.
      where e.repo_id = ? and e.from_id = ? and e.type in (${CALL_TRAVERSAL_EDGE_SQL_LIST})
        and ${RESOLVED_TARGET_SQL_PREDICATE}
        ${excludeTests ? "and (st.file_path is null or is_test_path(st.file_path) = 0)" : ""}
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
