import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "./types.js";

// ── Trivial callee tokens ──────────────────────────────────────────────
// Shared with graphStore.ts — standard JS/TS prototype/runtime methods
// that are never resolvable to user-defined symbols.

export const TRIVIAL_CALLEE_TOKENS = new Set([
  "map", "filter", "find", "findIndex", "findLast", "forEach", "reduce", "reduceRight",
  "some", "every", "flat", "flatMap", "includes", "indexOf", "lastIndexOf", "join",
  "sort", "reverse", "slice", "splice", "pop", "push", "shift", "unshift", "fill",
  "entries", "keys", "values", "at", "concat", "copyWithin",
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll", "startsWith", "endsWith",
  "padStart", "padEnd", "substring", "toUpperCase", "toLowerCase", "charAt", "charCodeAt",
  "then", "catch", "finally", "resolve", "reject", "all", "allSettled", "race", "any",
  "get", "set", "has", "delete", "clear", "add", "size",
  "call", "apply", "bind", "toString", "valueOf", "hasOwnProperty",
  "next", "done", "return", "throw",
  "on", "off", "once", "emit", "pipe", "removeListener", "removeAllListeners",
  "write", "end", "close", "destroy",
  "log", "warn", "error", "info", "debug",
  "prepare", "run", "exec", "iterate",
  "from", "assign", "freeze", "create", "hasOwn", "fromEntries", "is", "keys",
  "now", "parse", "stringify",
  "randomUUID", "createHash", "createHmac", "update", "digest",
  "glob", "stat", "readFile", "writeFile", "mkdir", "rmdir", "unlink",
  "relative", "basename", "dirname", "extname", "resolve", "normalize",
  "execSync", "execFileSync", "spawnSync",
]);

export const TRIVIAL_CALLEE_IN_CLAUSE = [...TRIVIAL_CALLEE_TOKENS]
  .map((t) => `'callee:${t}'`)
  .join(", ");

function buildEdgeToSymbolJoinClause(): string {
  return `(
    e.to_id = s.symbol_id
    or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
    or (e.type = 'TYPE_REF' and e.to_id = ('type:' || s.name))
    or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ('property:' || s.name))
    or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ('property:' || coalesce(st.name || '.', '') || s.name))
  )`;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function resolveCanonicalFilePath(db: Database.Database, repoId: string, filePath: string): string {
  const normalized = normalizePath(filePath);

  const fileRow = db
    .prepare(
      `
      select path as filePath
      from files
      where repo_id = ? and lower(replace(path, char(92), '/')) = lower(?)
      order by case when lower(path) = lower(?) then 0 else 1 end
      limit 1
      `
    )
    .get(repoId, normalized, filePath) as { filePath: string } | undefined;

  if (fileRow?.filePath) {
    return fileRow.filePath;
  }

  const symbolRow = db
    .prepare(
      `
      select file_path as filePath
      from symbols
      where repo_id = ? and lower(replace(file_path, char(92), '/')) = lower(?)
      order by case when lower(file_path) = lower(?) then 0 else 1 end
      limit 1
      `
    )
    .get(repoId, normalized, filePath) as { filePath: string } | undefined;

  if (symbolRow?.filePath) {
    return symbolRow.filePath;
  }

  return normalized;
}

export function findModuleSymbolId(db: Database.Database, repoId: string, filePath: string): string | null {
  const row = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
    .get(repoId, filePath) as { symbolId: string } | undefined;
  return row?.symbolId ?? null;
}

export function getEdgeDefaults(edge: EdgeRecord): { confidence: number; reason: string } {
  if (edge.toId.startsWith("callee:")) {
    return { confidence: 0.4, reason: "unresolved callee token" };
  }
  if (edge.toId.startsWith("import:")) {
    return { confidence: 0.5, reason: "unresolved import token" };
  }
  if (edge.toId.startsWith("type:")) {
    return { confidence: 0.45, reason: "unresolved type token" };
  }
  if (edge.toId.startsWith("property:")) {
    return { confidence: 0.5, reason: "unresolved property token" };
  }
  if (edge.type === "CALLS") {
    return { confidence: 1.0, reason: "resolved call edge" };
  }
  if (edge.type === "IMPORTS") {
    return { confidence: 0.95, reason: "resolved import edge" };
  }
  if (edge.type === "TYPE_REF") {
    return { confidence: 0.9, reason: "resolved type reference" };
  }
  if (edge.type === "PROPERTY_REF") {
    return { confidence: 0.85, reason: "resolved property read" };
  }
  if (edge.type === "PROPERTY_WRITE") {
    return { confidence: 0.82, reason: "resolved property write" };
  }
  return { confidence: 1.0, reason: "direct edge" };
}

export function buildReliabilitySummaryImpl(confidences: number[], graphHealth: GraphHealth): ReliabilitySummary {
  // Filter out external/builtin edges (confidence = 0.8) for internal reliability calculation
  const internalConf = confidences.filter((c) => c !== 0.8);
  const sorted = [...internalConf].sort((a, b) => a - b);
  const edgeCount = sorted.length;
  const medianConfidence = edgeCount === 0
    ? 1
    : (edgeCount % 2 === 0
        ? (sorted[edgeCount / 2 - 1] + sorted[edgeCount / 2]) / 2
        : sorted[Math.floor(edgeCount / 2)]);

  const lowConfidenceEdgeCount = sorted.filter((c) => c < 0.75).length;
  
  // Calculate unresolved edges with better categorization
  const unresolvedCalls = graphHealth.unresolvedCalls || 0;
  const unresolvedImports = graphHealth.unresolvedImports || 0;
  const unresolvedTypeRefs = graphHealth.unresolvedTypeRefs || 0;
  const unresolvedProperties = graphHealth.unresolvedProperties || 0;
  
  // Total unresolved (excluding external/builtin imports which are expected)
  const internalUnresolved = unresolvedCalls + unresolvedImports + unresolvedTypeRefs + unresolvedProperties;
  const unresolvedTotal = internalUnresolved;
  
  // Calculate unresolved ratio: unresolved / (resolved + unresolved)
  const unresolvedRatio = edgeCount + unresolvedTotal > 0
    ? unresolvedTotal / (edgeCount + unresolvedTotal)
    : 0;

  // Improved warning logic with more granular thresholds
  let warning: string | null = null;
  if (unresolvedRatio > 0.3) {
    // High unresolved ratio - results likely incomplete
    const breakdown: string[] = [];
    if (unresolvedCalls > 0) breakdown.push(`${unresolvedCalls} call${unresolvedCalls > 1 ? "s" : ""}`);
    if (unresolvedProperties > 0) breakdown.push(`${unresolvedProperties} property ref${unresolvedProperties > 1 ? "s" : ""}`);
    if (unresolvedTypeRefs > 0) breakdown.push(`${unresolvedTypeRefs} type ref${unresolvedTypeRefs > 1 ? "s" : ""}`);
    if (unresolvedImports > 0) breakdown.push(`${unresolvedImports} import${unresolvedImports > 1 ? "s" : ""}`);
    
    warning = `High unresolved ratio (${Math.round(unresolvedRatio * 100)}%): ${breakdown.join(", ")} unresolved — results may be incomplete. Consider re-indexing.`;
  } else if (unresolvedRatio > 0.15) {
    // Medium unresolved ratio - results partially incomplete
    warning = `${internalUnresolved} edge${internalUnresolved > 1 ? "s" : ""} unresolved (${Math.round(unresolvedRatio * 100)}%) — results may be partially incomplete`;
  } else if (medianConfidence < 0.75 && lowConfidenceEdgeCount > 5) {
    // Low confidence edges
    warning = `${lowConfidenceEdgeCount} low-confidence edge${lowConfidenceEdgeCount > 1 ? "s" : ""} — verify critical results`;
  } else if (unresolvedRatio > 0.05 && internalUnresolved > 0) {
    // Low unresolved ratio - acceptable but worth noting
    warning = `${internalUnresolved} edge${internalUnresolved > 1 ? "s" : ""} unresolved (${Math.round(unresolvedRatio * 100)}%) — impact coverage is good`;
  }

  return {
    edgeCount,
    medianConfidence,
    lowConfidenceEdgeCount,
    unresolvedRatio,
    warning
  };
}

export function countUnresolvedEdgesForFileImpl(db: Database.Database, repoId: string, filePath: string, symbolId?: string): GraphHealth {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);

  const symbolFilter = symbolId ? "AND e.from_id = ?" : "";
  const row = db
    .prepare(
      `
      select
        count(case when e.to_id like 'callee:%'
          and e.to_id not in (${TRIVIAL_CALLEE_IN_CLAUSE}) then 1 end) as unresolvedCalls,
        count(case when e.to_id like 'import:%'
          and coalesce(e.reason, '') not in ('node_builtin', 'npm_package') then 1 end) as unresolvedImports,
        count(case when e.to_id like 'type:%' then 1 end) as unresolvedTypeRefs,
        count(case when e.to_id like 'property:%' then 1 end) as unresolvedProperties
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/')
      ${symbolFilter}
      `
    )
    .get(...([repoId, canonicalFilePath, ...(symbolId ? [symbolId] : [])] as [string, string, ...string[]])) as { 
      unresolvedCalls: number; 
      unresolvedImports: number; 
      unresolvedTypeRefs: number;
      unresolvedProperties: number;
    };

  const { unresolvedCalls, unresolvedImports, unresolvedTypeRefs, unresolvedProperties } = row ?? { 
    unresolvedCalls: 0, 
    unresolvedImports: 0, 
    unresolvedTypeRefs: 0,
    unresolvedProperties: 0
  };
  
  let note: string;
  if (unresolvedCalls === 0 && unresolvedImports === 0 && unresolvedTypeRefs === 0 && unresolvedProperties === 0) {
    note = "graph data complete";
  } else {
    const parts: string[] = [];
    if (unresolvedCalls > 0) parts.push(`${unresolvedCalls} call edge${unresolvedCalls > 1 ? "s" : ""} unresolved`);
    if (unresolvedProperties > 0) parts.push(`${unresolvedProperties} property ref${unresolvedProperties > 1 ? "s" : ""} unresolved`);
    if (unresolvedImports > 0) parts.push(`${unresolvedImports} import edge${unresolvedImports > 1 ? "s" : ""} unresolved`);
    if (unresolvedTypeRefs > 0) parts.push(`${unresolvedTypeRefs} type reference${unresolvedTypeRefs > 1 ? "s" : ""} unresolved`);
    note = `${parts.join(", ")} — results may be incomplete`;
  }

  return { unresolvedCalls, unresolvedImports, unresolvedTypeRefs, unresolvedProperties, note };
}
// ── getImpactSurface ───────────────────────────────────────────────────

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
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);
  const edgeJoin = buildEdgeToSymbolJoinClause();

  const callers = db
    .prepare(
      `
      select
        sf.name as callerName,
        sf.file_path as callerFile,
        sf.line as callerLine,
        s.name as symbolAffected,
        e.type as edgeType,
        e.confidence as confidence,
        e.reason as reason
      from symbols s
      inner join edges e
        on e.repo_id = s.repo_id
        and ${edgeJoin}
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = s.repo_id and st.symbol_id = s.parent_symbol_id
      where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
      order by sf.file_path, e.type
      limit ?
      `
    )
    .all(repoId, canonicalFilePath, limit) as {
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
  return {
    callers,
    graphHealth,
    reliabilitySummary: buildReliabilitySummaryImpl(callers.map((x) => x.confidence), graphHealth)
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
} {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);
  const edgeJoin = buildEdgeToSymbolJoinClause();

  const distinctFiles = db
    .prepare(
      `
      select distinct sf.file_path as callerFile
      from symbols s
      inner join edges e
        on e.repo_id = s.repo_id
        and ${edgeJoin}
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = s.repo_id and st.symbol_id = s.parent_symbol_id
      where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
      order by sf.file_path
      limit ?
      `
    )
    .all(repoId, canonicalFilePath, limit) as { callerFile: string }[];

  if (distinctFiles.length === 0) {
    const moduleSymbolId = findModuleSymbolId(db, repoId, canonicalFilePath) ?? undefined;
    const graphHealth = countUnresolvedEdgesForFileImpl(db, repoId, canonicalFilePath, moduleSymbolId);
    return {
      impactedFiles: [],
      graphHealth,
      reliabilitySummary: buildReliabilitySummaryImpl([], graphHealth)
    };
  }

  const ph = distinctFiles.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      select
        sf.file_path as callerFile,
        e.type as edgeType,
        e.confidence as confidence,
        e.reason as reason,
        s.name as symbolAffected
      from symbols s
      inner join edges e
        on e.repo_id = s.repo_id
        and ${edgeJoin}
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = s.repo_id and st.symbol_id = s.parent_symbol_id
      where s.repo_id = ? and s.file_path = ?
        and sf.file_path in (${ph})
        and sf.file_path != s.file_path
      order by sf.file_path
      `
    )
    .all(repoId, canonicalFilePath, ...distinctFiles.map((r) => r.callerFile)) as {
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
  let frontier = [symbolId];
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
  const initialCallerEdgeTypes = symbol.kind === "property"
    ? ["CALLS", "PROPERTY_REF", "PROPERTY_WRITE"]
    : ["CALLS"];
  for (let depth = 1; depth <= callerDepth && frontier.length > 0 && callers.length < limit; depth++) {
    const ph = frontier.map(() => "?").join(",");
    const callerEdgeTypes = depth === 1 ? initialCallerEdgeTypes : ["CALLS"];
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
        callers.push({ ...row, distance: depth });
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
      where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
      limit 20
      `
    )
    .all(repoId, symbolId) as ResolvedEdge[];
  const callees = allCallees.filter((edge) => {
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
  edges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null }[];
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
  const resultEdges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null }[] = [];
  let frontier = [entrySymbolId];
  let depthReached = 0;
  let truncated = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && resultNodes.length < maxNodes; depth++) {
    const nextFrontier: string[] = [];
    for (const currentId of frontier) {
      if (resultNodes.length >= maxNodes) { truncated = true; break; }
      const calleeRows = db
        .prepare(
          `select e.from_id as fromId, e.to_id as toId, e.confidence,
                  sf.name as fromName, st.name as toName,
                  st.repo_id as repoId, st.symbol_id as symbolId, st.file_path as filePath,
                  st.kind, st.line, st.signature
           from edges e
           inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
           inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
           where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
           limit 50`
        )
        .all(repoId, currentId) as (SymbolRecord & { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null })[];

      for (const row of calleeRows) {
        const edgeKey = `${row.fromId}:${row.toId}`;
        if (!visitedEdges.has(edgeKey)) {
          visitedEdges.add(edgeKey);
          resultEdges.push({ fromId: row.fromId, toId: row.toId, fromName: row.fromName, toName: row.toName, confidence: row.confidence ?? null });
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

export function getFolderSummaryImpl(
  db: Database.Database,
  repoId: string,
  folderPath: string,
  maxFiles: number
): {
  folderPath: string;
  totalFiles: number;
  directFiles: number;
  subfolders: string[];
  files: {
    filePath: string;
    language: string | null;
    symbolCount: number;
    exportedCount: number;
    callerCount: number;
  }[];
} {
  const normalized = folderPath.replace(/\\/g, "/").replace(/\/$/, "");
  const prefixFwd = `${normalized}/`;

  const files = db
    .prepare(
      `
      select
        f.path as filePath,
        f.language,
        count(distinct s.symbol_id) as symbolCount,
        sum(case when s.kind in ('function','method','class','interface','struct','property') then 1 else 0 end) as exportedCount
      from files f
      left join symbols s on s.repo_id = f.repo_id and s.file_path = f.path and s.kind != 'module'
      where f.repo_id = ?
        and (
          replace(f.path, char(92), '/') like ?
          or replace(f.path, char(92), '/') = ?
        )
      group by f.path, f.language
      order by f.path
      limit ?
      `
    )
    .all(repoId, `${prefixFwd}%`, normalized, maxFiles) as {
      filePath: string;
      language: string | null;
      symbolCount: number;
      exportedCount: number;
    }[];

  const fallbackFiles = files.length === 0
    ? db
        .prepare(
          `
          select
            s.file_path as filePath,
            null as language,
            count(distinct s.symbol_id) as symbolCount,
            sum(case when s.kind in ('function','method','class','interface','struct','property') then 1 else 0 end) as exportedCount
          from symbols s
          where s.repo_id = ?
            and (
              replace(s.file_path, char(92), '/') like ?
              or replace(s.file_path, char(92), '/') = ?
            )
            and s.kind != 'module'
          group by s.file_path
          order by s.file_path
          limit ?
          `
        )
        .all(repoId, `${prefixFwd}%`, normalized, maxFiles) as {
          filePath: string;
          language: string | null;
          symbolCount: number;
          exportedCount: number;
        }[]
    : [];

  const effectiveFiles = files.length > 0 ? files : fallbackFiles;

  const result = effectiveFiles.map((f) => {
    const callerCount = (db
      .prepare(
        `
        select count(distinct sf.file_path) as cnt
        from symbols s
        inner join edges e on e.repo_id = s.repo_id and e.to_id = s.symbol_id
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
        `
      )
      .get(repoId, f.filePath) as { cnt: number } | undefined)?.cnt ?? 0;

    return { ...f, callerCount };
  });

  const subfolderSet = new Set<string>();
  for (const f of result) {
    const rel = f.filePath.replace(/\\/g, "/");
    const rest = rel.startsWith(prefixFwd) ? rel.slice(prefixFwd.length) : rel.slice(normalized.length + 1);
    const slashIdx = rest.indexOf("/");
    if (slashIdx > 0) {
      subfolderSet.add(`${normalized}/${rest.slice(0, slashIdx)}`);
    }
  }

  const directFiles = result.filter((f) => {
    const rel = f.filePath.replace(/\\/g, "/");
    const rest = rel.startsWith(prefixFwd) ? rel.slice(prefixFwd.length) : rel.slice(normalized.length + 1);
    return !rest.includes("/");
  }).length;

  return {
    folderPath: normalized,
    totalFiles: result.length,
    directFiles,
    subfolders: [...subfolderSet].sort(),
    files: result
  };
}

// ── groupFilesByModule ─────────────────────────────────────────────────

export function groupFilesByModuleImpl(files: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const f of files) {
    const normalized = f.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const key = parts.length > 1 ? parts[0] : "(root)";
    if (!result[key]) result[key] = [];
    result[key].push(f);
  }
  return result;
}

// ── getRouteMap ────────────────────────────────────────────────────────

export function getRouteMapImpl(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  httpMethod: string | null,
  limit: number
): {
  filePath: string;
  controllerSymbolId: string;
  controllerName: string | null;
  handlerSymbolId: string;
  handlerName: string | null;
  httpMethod: string;
  routeTemplate: string;
  line: number;
}[] {
  const conditions = ["r.repo_id = ?"];
  const params: unknown[] = [repoId];

  if (filePathPrefix) {
    conditions.push("replace(r.file_path, char(92), '/') like ?");
    params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
  }

  if (httpMethod) {
    conditions.push("r.http_method = ?");
    params.push(httpMethod.toUpperCase());
  }

  const where = conditions.join(" and ");

  return db
    .prepare(
      `
      select
        r.file_path as filePath,
        r.controller_symbol_id as controllerSymbolId,
        cs.name as controllerName,
        r.handler_symbol_id as handlerSymbolId,
        hs.name as handlerName,
        r.http_method as httpMethod,
        r.route_template as routeTemplate,
        r.line as line
      from routes r
      left join symbols cs on cs.repo_id = r.repo_id and cs.symbol_id = r.controller_symbol_id
      left join symbols hs on hs.repo_id = r.repo_id and hs.symbol_id = r.handler_symbol_id
      where ${where}
      order by r.file_path, r.line
      limit ?
      `
    )
    .all(...params, limit) as {
    filePath: string;
    controllerSymbolId: string;
    controllerName: string | null;
    handlerSymbolId: string;
    handlerName: string | null;
    httpMethod: string;
    routeTemplate: string;
    line: number;
  }[];
}

// ── getRepoSchemaSnapshot ──────────────────────────────────────────────

export function getRepoSchemaSnapshotImpl(
  db: Database.Database,
  repoId: string
): {
  repoId: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  routeCount: number;
  languages: { language: string; fileCount: number }[];
} {
  const fileCount = (db.prepare(`select count(*) as cnt from files where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;
  const symbolCount = (db.prepare(`select count(*) as cnt from symbols where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;
  const edgeCount = (db.prepare(`select count(*) as cnt from edges where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;
  const routeCount = (db.prepare(`select count(*) as cnt from routes where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;

  const languages = db
    .prepare(
      `
      select coalesce(language, 'unknown') as language, count(*) as fileCount
      from files
      where repo_id = ?
      group by coalesce(language, 'unknown')
      order by fileCount desc, language asc
      `
    )
    .all(repoId) as { language: string; fileCount: number }[];

  return { repoId, fileCount, symbolCount, edgeCount, routeCount, languages };
}

// ── runReadOnlyGraphQuery ──────────────────────────────────────────────

export function runReadOnlyGraphQueryImpl(
  db: Database.Database,
  sql: string,
  namedParams: Record<string, string | number | boolean | null>,
  limit: number,
  timeoutMs?: number
): {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  timedOut: boolean;
} {
  const wrappedSql = `select * from (${sql}) as mcp_query limit @__limit`;
  const stmt = db.prepare(wrappedSql);
  const start = Date.now();
  const rows = stmt.all({ ...namedParams, __limit: limit + 1 }) as Record<string, unknown>[];
  const elapsedMs = Date.now() - start;
  const truncated = rows.length > limit;
  const safeRows = truncated ? rows.slice(0, limit) : rows;
  const columns = safeRows.length > 0 ? Object.keys(safeRows[0]) : [];
  const timedOut = timeoutMs !== undefined && timeoutMs > 0 && elapsedMs > timeoutMs;
  return { columns, rows: safeRows, rowCount: safeRows.length, truncated, elapsedMs, timedOut };
}

// ── listIndexedFiles ───────────────────────────────────────────────────

export function listIndexedFilesImpl(
  db: Database.Database,
  repoId: string
): { path: string; language: string | null }[] {
  return db
    .prepare(
      `
      select path, language
      from files
      where repo_id = ?
      order by path asc
      `
    )
    .all(repoId) as { path: string; language: string | null }[];
}

// ── listRepositories ───────────────────────────────────────────────────

export function listRepositoriesImpl(
  db: Database.Database
): { repoId: string; repoPath: string; updatedAt: string; filesIndexed: number; symbolCount: number; lastRunStatus: string | null; lastRunAt: string | null }[] {
  return db
    .prepare(
      `
      select
        r.repo_id as repoId,
        r.repo_path as repoPath,
        r.updated_at as updatedAt,
        coalesce(f.file_count, 0) as filesIndexed,
        coalesce(s.sym_count, 0) as symbolCount,
        lr.status as lastRunStatus,
        lr.finished_at as lastRunAt
      from repositories r
      left join (
        select repo_id, count(*) as file_count from files group by repo_id
      ) f on f.repo_id = r.repo_id
      left join (
        select repo_id, count(*) as sym_count from symbols group by repo_id
      ) s on s.repo_id = r.repo_id
      left join (
        select repo_id, status, finished_at,
               row_number() over (partition by repo_id order by started_at desc) as rn
        from index_runs
      ) lr on lr.repo_id = r.repo_id and lr.rn = 1
      order by r.updated_at desc
      `
    )
    .all() as { repoId: string; repoPath: string; updatedAt: string; filesIndexed: number; symbolCount: number; lastRunStatus: string | null; lastRunAt: string | null }[];
}
