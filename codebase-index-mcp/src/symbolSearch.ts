import type Database from "better-sqlite3";
import type { ResolvedEdge, SymbolRecord } from "./types.js";
import { vectorSearchSymbols, isVectorEnabled } from "./vectorStore.js";
import { isTestPath } from "./fileFilter.js";
import { expandInterfaceSiblingsImpl } from "./interfaceSiblings.js";

// Kinds that carry graph edges / are usually what a developer means; ranked above
// edgeless namesakes (constructor shares the class name, module shares the file name).
// `record` / `record struct` are class-like (CQRS commands/queries are records) — they were
// indexed as `class` before ISSUE-015, so list them here to keep the same ranking parity.
const RANKED_KIND_BONUS = ["method", "function", "class", "interface", "struct", "record", "record struct"];

// ISSUE-024: rank penalty cho test paths khi ranked=true. Phải lớn hơn RANKED_KIND_BONUS (0.03)
// cộng vài bậc position penalty (0.01/bậc) để production thắng stub cùng coverage, nhưng đủ nhỏ
// để test file có token coverage TỐT HƠN thật sự (sort key chính) vẫn xếp trên.
const TEST_PATH_PENALTY = 0.08;

// SQL ORDER-BY fragment: prefer substantive kinds over their edgeless namesakes when
// names tie (e.g. class before its same-named constructor). `col` is the qualified column.
const kindPriorityOrder = (col: string): string =>
  `case ${col}
     when 'class' then 0 when 'record' then 0 when 'interface' then 1
     when 'struct' then 2 when 'record struct' then 2
     when 'method' then 3 when 'function' then 4
     when 'constructor' then 8 when 'module' then 9
     else 5
   end`;

// ── FTS query builders ─────────────────────────────────────────────────

export function buildFtsQuery(query: string): string {
  const raw = query.trim();

  const spaceTokens = raw.split(/\s+/).filter((t) => t.length >= 2);

  if (spaceTokens.length === 1) {
    const pascal = raw.replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1").trim().split(/\s+/).filter((t) => t.length >= 2);
    if (pascal.length > 1) {
      const andClause = pascal.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
      return `(${andClause}) OR "${raw.replace(/"/g, '""')}"*`;
    }
    const q = raw.replace(/"/g, '""');
    return `"${q}"*`;
  }

  const andClause = spaceTokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");

  const expandedTokens = new Set<string>(spaceTokens);
  for (const tok of spaceTokens) {
    const pascal = tok.replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1").trim().split(/\s+/).filter((t) => t.length >= 2);
    for (const p of pascal) expandedTokens.add(p);
    const snakeParts = tok.split("_").filter((t) => t.length >= 2);
    for (const p of snakeParts) expandedTokens.add(p);
  }

  if (expandedTokens.size > spaceTokens.length) {
    const orClause = [...expandedTokens].map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
    return `(${andClause}) OR (${orClause})`;
  }

  return andClause;
}

export function extractIntentTokens(query: string): string[] {
  const rawTokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const expanded = new Set<string>();
  for (const token of rawTokens) {
    expanded.add(token);
    const pascalParts = token
      .replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    for (const part of pascalParts) {
      expanded.add(part);
    }
    const snakeParts = token.split("_").filter((t) => t.length >= 2);
    for (const part of snakeParts) {
      expanded.add(part);
    }
  }

  return [...expanded].slice(0, 12);
}

export function buildIntentFtsQuery(query: string): string {
  const tokens = extractIntentTokens(query);
  if (tokens.length === 0) {
    return buildFtsQuery(query);
  }

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

// ── rebuildFts ─────────────────────────────────────────────────────────

export function rebuildFtsImpl(db: Database.Database): void {
  const start = Date.now();
  try {
    db.exec(`insert into symbols_fts(symbols_fts) values('rebuild')`);
    db.exec(`insert into symbols_fts(symbols_fts) values('optimize')`);
    const elapsed = Date.now() - start;
    process.stderr.write(`[index-fts] rebuilt symbols_fts in ${elapsed}ms\n`);
  } catch (e) {
    process.stderr.write(`[index-fts-error] symbols_fts rebuild failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// ── searchSymbols ──────────────────────────────────────────────────────

export function searchSymbolsImpl(
  db: Database.Database,
  query: string,
  repoId: string | null,
  language: string | null,
  kind: string | null,
  filePath: string | null,
  limit: number,
  strategy: "name" | "intent" = "name"
): (SymbolRecord & { repoPath: string | null })[] {
  const langJoin = language
    ? `inner join files f on f.repo_id = s.repo_id and f.path = s.file_path and f.language = '${language.replace(/'/g, "''")}'`
    : "left join files f on f.repo_id = s.repo_id and f.path = s.file_path";

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (repoId) {
    conditions.push("s.repo_id = ?");
    params.push(repoId);
  }
  if (kind) {
    conditions.push("s.kind = ?");
    params.push(kind);
  }
  if (filePath) {
    conditions.push("s.file_path like ?");
    params.push(`%${filePath}%`);
  }

  let useFts = false;
  try {
    db.prepare("select * from symbols_fts limit 0").all();
    useFts = true;
  } catch {
    useFts = false;
  }

  if (useFts) {
    const ftsWhere = conditions.length > 0 ? `and ${conditions.join(" and ")}` : "";
    const ftsQuery = strategy === "intent" ? buildIntentFtsQuery(query) : buildFtsQuery(query);
    const ftsResults = db
      .prepare(
        `
        select
          s.repo_id as repoId,
          s.symbol_id as symbolId,
          s.file_path as filePath,
          s.name,
          s.kind,
          s.line,
          s.signature,
          r.repo_path as repoPath
        from symbols_fts
        inner join symbols s on s.rowid = symbols_fts.rowid
        ${langJoin}
        inner join repositories r on r.repo_id = s.repo_id
        where symbols_fts match ?
        ${ftsWhere}
        order by rank
        limit ?
        `
      )
      .all(ftsQuery, ...params, limit) as (SymbolRecord & { repoPath: string | null })[];

    // Hybrid: if FTS returns few results and vector is available, augment with vector search
    if (ftsResults.length < 3 && isVectorEnabled() && repoId) {
      const vecResults = vectorSearchSymbols(db, repoId, query, limit);
      const seen = new Set(ftsResults.map((r) => r.symbolId));
      for (const vr of vecResults) {
        if (ftsResults.length >= limit) break;
        if (seen.has(vr.symbolId)) continue;
        const sym = db.prepare(`
          select
            s.repo_id as repoId,
            s.symbol_id as symbolId,
            s.file_path as filePath,
            s.name,
            s.kind,
            s.line,
            s.signature,
            r.repo_path as repoPath
          from symbols s
          inner join repositories r on r.repo_id = s.repo_id
          where s.repo_id = ? and s.symbol_id = ?
          limit 1
        `).get(repoId, vr.symbolId) as (SymbolRecord & { repoPath: string | null }) | undefined;
        if (sym) {
          ftsResults.push(sym);
          seen.add(vr.symbolId);
        }
      }
    }

    return ftsResults;
  }

  if (strategy === "intent") {
    const tokens = extractIntentTokens(query);
    if (tokens.length > 0) {
      const tokenClauses = tokens.map(() => "(s.name like ? or s.signature like ?)");
      conditions.unshift(`(${tokenClauses.join(" or ")})`);
      const tokenParams: string[] = [];
      for (const token of tokens) {
        tokenParams.push(`%${token}%`, `%${token}%`);
      }
      params.unshift(...tokenParams);
    } else {
      conditions.unshift("(s.name like ? or s.signature like ?)");
      params.unshift(`%${query}%`, `%${query}%`);
    }
  } else {
    conditions.unshift("(s.name like ? or s.signature like ?)");
    params.unshift(`%${query}%`, `%${query}%`);
  }
  const where = conditions.join(" and ");
  return db
    .prepare(
      `
      select
        s.repo_id as repoId,
        s.symbol_id as symbolId,
        s.file_path as filePath,
        s.name,
        s.kind,
        s.line,
        s.signature,
        r.repo_path as repoPath
      from symbols s
      ${langJoin}
      inner join repositories r on r.repo_id = s.repo_id
      where ${where}
      order by s.name
      limit ?
      `
    )
    .all(...params, limit) as (SymbolRecord & { repoPath: string | null })[];
}

// ── getSearchSuggestions ───────────────────────────────────────────────

export function getSearchSuggestionsImpl(
  db: Database.Database,
  query: string,
  repoId: string | null,
  limit: number
): string[] {
  const cappedLimit = Math.max(1, Math.min(limit, 10));
  const tokens = extractIntentTokens(query).slice(0, 6);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (repoId) {
    conditions.push("s.repo_id = ?");
    params.push(repoId);
  }

  if (tokens.length > 0) {
    const tokenClauses = tokens.map(() => "s.name like ?");
    conditions.push(`(${tokenClauses.join(" or ")})`);
    for (const token of tokens) {
      params.push(`%${token}%`);
    }
  } else {
    conditions.push("s.name like ?");
    params.push(`%${query.trim()}%`);
  }

  const where = conditions.join(" and ");
  const rows = db
    .prepare(
      `
      select s.name as name, count(*) as hits
      from symbols s
      where ${where}
      group by s.name
      order by hits desc, length(s.name) asc, s.name asc
      limit ?
      `
    )
    .all(...params, cappedLimit) as { name: string; hits: number }[];

  return rows.map((r) => r.name);
}

// ── getSymbolDetail ────────────────────────────────────────────────────

export function getSymbolDetailImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  limit: number
): {
  symbol: SymbolRecord | null;
  edgesOut: ResolvedEdge[];
  edgesIn: ResolvedEdge[];
} {
  const symbol = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, end_line as endLine, signature
      from symbols
      where repo_id = ? and symbol_id = ?
      limit 1
      `
    )
    .get(repoId, symbolId) as SymbolRecord | undefined;

  if (!symbol) {
    return { symbol: null, edgesOut: [], edgesIn: [] };
  }

  const edgesOut = db
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
      where e.repo_id = ? and e.from_id = ?
      limit ?
      `
    )
    .all(repoId, symbolId, limit) as ResolvedEdge[];

  const edgesIn = db
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
      where e.repo_id = ? and e.to_id = ?
      limit ?
      `
    )
    .all(repoId, symbolId, limit) as ResolvedEdge[];

  return { symbol, edgesOut, edgesIn };
}

// ── findCallersByName ──────────────────────────────────────────────────

export function findCallersByNameImpl(
  db: Database.Database,
  repoId: string,
  symbolName: string,
  limit: number
): {
  symbolName: string;
  callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
} {
  const targets = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and name = ?`)
    .all(repoId, symbolName) as { symbolId: string }[];

  if (targets.length === 0) {
    return { symbolName, callers: [] };
  }

  const ph = targets.map(() => "?").join(",");
  const callers = db
    .prepare(
      `
      select distinct sf.name as callerName, sf.file_path as callerFile, sf.line as callerLine, sf.kind
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'CALLS' and e.to_id in (${ph})
      order by sf.file_path, sf.line
      limit ?
      `
    )
    .all(repoId, ...targets.map((t) => t.symbolId), limit) as {
    callerName: string;
    callerFile: string;
    callerLine: number;
    kind: string;
  }[];

  return { symbolName, callers };
}

// ── findSymbolAtLine ───────────────────────────────────────────────────

export function findSymbolAtLineImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  line: number,
  resolveCanonicalFilePath: (repoId: string, fp: string) => string
): SymbolRecord | null {
  const canonicalFilePath = resolveCanonicalFilePath(repoId, filePath);

  const row = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
             name, kind, line, signature
      from symbols
      where repo_id = ? and file_path = ? and kind != 'module' and line <= ?
      order by line desc
      limit 1
      `
    )
    .get(repoId, canonicalFilePath, line) as SymbolRecord | undefined;

  return row ?? null;
}

// ── findReferences ─────────────────────────────────────────────────────

export function findReferencesImpl(
  db: Database.Database,
  repoId: string,
  symbolName: string,
  limit: number
): {
  symbolName: string;
  matchedSymbols: SymbolRecord[];
  callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
  importedByFiles: string[];
  totalFound: number;
} {
  const targets = db
    .prepare(
      `select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
              name, kind, line, signature
       from symbols where repo_id = ? and name = ?`
    )
    .all(repoId, symbolName) as SymbolRecord[];

  if (targets.length === 0) {
    return { symbolName, matchedSymbols: [], callers: [], importedByFiles: [], totalFound: 0 };
  }

  const ph = targets.map(() => "?").join(",");
  const targetIds = targets.map((t) => t.symbolId);

  const callers = db
    .prepare(
      `
      select distinct sf.name as callerName, sf.file_path as callerFile, sf.line as callerLine, sf.kind
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'CALLS' and e.to_id in (${ph})
      order by sf.file_path, sf.line
      limit ?
      `
    )
    .all(repoId, ...targetIds, limit) as {
    callerName: string;
    callerFile: string;
    callerLine: number;
    kind: string;
  }[];

  const importedByRows = db
    .prepare(
      `
      select distinct sf.file_path as importerFile
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id in (${ph})
        and sf.file_path not in (${ph})
      order by sf.file_path
      limit ?
      `
    )
    .all(repoId, ...targetIds, ...targetIds.map((id) => {
      const sym = targets.find((t) => t.symbolId === id);
      return sym?.filePath ?? "";
    }), limit) as { importerFile: string }[];

  const importedByFiles = importedByRows.map((r) => r.importerFile);
  const totalFound = callers.length + importedByFiles.length;

  return { symbolName, matchedSymbols: targets, callers, importedByFiles, totalFound };
}

// ── getContextByName ───────────────────────────────────────────────────

export function getContextByNameImpl(
  db: Database.Database,
  repoId: string,
  name: string,
  limit: number
): {
  symbol: SymbolRecord | null;
  callers: { callerName: string; callerFile: string; callerLine: number; kind: string; via?: "interface" | "member" }[];
  callees: { calleeName: string; calleeFile: string | null; calleeLine: number | null; kind: string | null }[];
  importedByFiles: string[];
  allMatchedSymbols: SymbolRecord[];
} {
  let candidates: SymbolRecord[] = [];
  let useFts = false;
  try {
    db.prepare("select * from symbols_fts limit 0").all();
    useFts = true;
  } catch { useFts = false; }

  if (useFts) {
    candidates = db
      .prepare(
        `
        select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath,
               s.name, s.kind, s.line, s.signature
        from symbols_fts
        inner join symbols s on s.rowid = symbols_fts.rowid
        where s.repo_id = ? and symbols_fts match ?
        order by case when s.name = ? then 0 else 1 end, ${kindPriorityOrder("s.kind")}, rank
        limit ?
        `
      )
      .all(repoId, buildFtsQuery(name), name, limit) as SymbolRecord[];
  } else {
    candidates = db
      .prepare(
        `select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
                name, kind, line, signature
         from symbols where repo_id = ? and (name = ? or name like ?)
         order by case when name = ? then 0 else 1 end, ${kindPriorityOrder("kind")}, name
         limit ?`
      )
      .all(repoId, name, `%${name}%`, name, limit) as SymbolRecord[];
  }

  if (candidates.length === 0) {
    return { symbol: null, callers: [], callees: [], importedByFiles: [], allMatchedSymbols: [] };
  }

  const symbol = candidates[0];
  const targetIds = candidates.map((c) => c.symbolId);
  const ph = targetIds.map(() => "?").join(",");

  // ISSUE-022: mở rộng targets sang interface siblings (class → members, impl method ↔
  // interface method) để caller gọi qua DI interface không vô hình với context pack.
  const siblings = expandInterfaceSiblingsImpl(db, repoId, targetIds.slice(0, 10));
  const viaBySiblingId = new Map(siblings.map((s) => [s.symbolId, s.via]));
  const allTargetIds = [...targetIds, ...siblings.map((s) => s.symbolId)];
  const allPh = allTargetIds.map(() => "?").join(",");

  const callerRows = db
    .prepare(
      `
      select sf.name as callerName, sf.file_path as callerFile, sf.line as callerLine, sf.kind,
             e.to_id as toId, e.reason as reason
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'CALLS' and e.to_id in (${allPh})
      order by sf.file_path, sf.line
      limit ?
      `
    )
    .all(repoId, ...allTargetIds, limit) as { callerName: string; callerFile: string; callerLine: number; kind: string; toId: string; reason: string | null }[];

  // Dedup theo caller identity; ưu tiên row direct (không via) khi caller xuất hiện cả 2 đường.
  const callersByKey = new Map<string, { callerName: string; callerFile: string; callerLine: number; kind: string; via?: "interface" | "member" }>();
  for (const row of callerRows) {
    const via = viaBySiblingId.get(row.toId) ?? (row.reason === "interface-dispatch" ? ("interface" as const) : undefined);
    const key = `${row.callerFile}:${row.callerLine}:${row.callerName}`;
    const existing = callersByKey.get(key);
    if (existing && !existing.via) continue;
    if (existing && via) continue;
    callersByKey.set(key, { callerName: row.callerName, callerFile: row.callerFile, callerLine: row.callerLine, kind: row.kind, ...(via ? { via } : {}) });
  }
  const callers = [...callersByKey.values()].slice(0, limit);

  const calleeRows = db
    .prepare(
      `
      select st.name as calleeName, st.file_path as calleeFile, st.line as calleeLine, st.kind
      from edges e
      left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
      limit ?
      `
    )
    .all(repoId, symbol.symbolId, limit) as { calleeName: string | null; calleeFile: string | null; calleeLine: number | null; kind: string | null }[];

  const callees = calleeRows
    .filter((r) => r.calleeName != null)
    .map((r) => ({ calleeName: r.calleeName!, calleeFile: r.calleeFile, calleeLine: r.calleeLine, kind: r.kind }));

  const importedByRows = db
    .prepare(
      `
      select distinct sf.file_path as importerFile
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id in (${ph})
      order by sf.file_path
      limit ?
      `
    )
    .all(repoId, ...targetIds, limit) as { importerFile: string }[];

  return {
    symbol,
    callers,
    callees,
    importedByFiles: importedByRows.map((r) => r.importerFile),
    allMatchedSymbols: candidates
  };
}

// ── getSymbolCandidates ────────────────────────────────────────────────

export function getSymbolCandidatesImpl(
  db: Database.Database,
  repoId: string,
  name: string,
  limit: number,
  strategy: "name" | "intent" = "name",
  filters: { kind?: string | null; language?: string | null; filePath?: string | null; excludeTests?: boolean } = {}
): {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  signature: string | null;
  /** ISSUE-024: "EnclosingType.Member" khi symbol có parent (C# methods/properties) — phân biệt 20 hit cùng tên Handle. */
  qualifiedName?: string;
  matchType: "exact" | "prefix" | "contains";
  score: number;
  confidence: number;
}[] {
  // Filter clauses (kind/language/filePath) — previously dropped on the ranked path.
  const filterConds: string[] = [];
  const filterParams: unknown[] = [];
  const langJoin = filters.language
    ? "inner join files f on f.repo_id = s.repo_id and f.path = s.file_path"
    : "";
  if (filters.language) {
    filterConds.push("f.language = ?");
    filterParams.push(filters.language);
  }
  if (filters.kind) {
    filterConds.push("s.kind = ?");
    filterParams.push(filters.kind);
  }
  if (filters.filePath) {
    filterConds.push("s.file_path like ?");
    filterParams.push(`%${filters.filePath}%`);
  }
  const filterWhere = filterConds.length > 0 ? `and ${filterConds.join(" and ")}` : "";

  const tokens = strategy === "intent" ? extractIntentTokens(name) : [];

  // Intent: OR the tokens across name+signature (mirrors searchSymbolsImpl's intent branch),
  // then rank by token coverage. Without this, a multi-word query falls to the substring
  // path below and matches nothing (no symbol name contains the whole phrase) → 0 results.
  if (strategy === "intent" && tokens.length > 0) {
    // ISSUE-024: parent (enclosing type) name tham gia pre-filter + scoring haystack — token
    // domain ("ConversationAssigned") match vào tên CLASS của member tên generic (Handle).
    const tokenClauses = tokens.map(() => "(s.name like ? or s.signature like ? or p.name like ?)").join(" or ");
    const tokenParams: string[] = [];
    for (const t of tokens) tokenParams.push(`%${t}%`, `%${t}%`, `%${t}%`);
    const fetchLimit = Math.min(Math.max(limit * 4, 50), 500);
    const allRows = db
      .prepare(
        `
        select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath,
               s.name, s.kind, s.line, s.signature, p.name as parentName
        from symbols s
        left join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
        ${langJoin}
        where s.repo_id = ? and (${tokenClauses}) ${filterWhere}
        order by length(s.name)
        limit ?
        `
      )
      .all(repoId, ...tokenParams, ...filterParams, fetchLimit) as (SymbolRecord & { parentName?: string | null })[];
    const rows = filters.excludeTests ? allRows.filter((r) => !isTestPath(r.filePath)) : allRows;

    const lowerTokens = tokens.map((t) => t.toLowerCase());
    const scored = rows.map((row) => {
      const hay = `${row.name} ${row.signature ?? ""} ${row.parentName ?? ""}`.toLowerCase();
      const matched = lowerTokens.filter((t) => hay.includes(t)).length;
      const coverage = matched / lowerTokens.length;
      const kindBonus = RANKED_KIND_BONUS.includes(row.kind) ? 0.03 : 0;
      const testPenalty = isTestPath(row.filePath) ? TEST_PATH_PENALTY : 0;
      const confidenceRaw = Math.max(0, Math.min(1, 0.5 + 0.45 * coverage + kindBonus - testPenalty));
      const matchType: "exact" | "prefix" | "contains" = coverage >= 1 ? "exact" : "contains";
      return { row, matched, matchType, confidenceRaw };
    });
    scored.sort(
      (a, b) =>
        b.matched - a.matched ||
        b.confidenceRaw - a.confidenceRaw ||
        a.row.name.length - b.row.name.length ||
        a.row.name.localeCompare(b.row.name)
    );
    return scored.slice(0, limit).map(({ row, matchType, confidenceRaw }, index) => {
      const confidence = Math.max(0, Math.min(1, confidenceRaw - Math.min(index * 0.01, 0.2)));
      return {
        symbolId: row.symbolId,
        name: row.name,
        kind: row.kind,
        filePath: row.filePath,
        line: row.line,
        signature: row.signature ?? null,
        ...(row.parentName ? { qualifiedName: `${row.parentName}.${row.name}` } : {}),
        matchType,
        score: Math.round(confidence * 100),
        confidence
      };
    });
  }

  // strategy === "name" (default) — substring/exact ranking, behavior preserved.
  // excludeTests post-filter có thể loại bớt rows nên over-fetch x2 để vẫn lấp đủ limit.
  const fetchLimit = filters.excludeTests ? limit * 2 : limit;
  const allRows = db
    .prepare(
      `
      select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath,
             s.name, s.kind, s.line, s.signature, p.name as parentName
      from symbols s
      left join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
      ${langJoin}
      where s.repo_id = ? and (s.name = ? or s.name like ?) ${filterWhere}
      order by
        case
          when lower(s.name) = lower(?) then 0
          when lower(s.name) like lower(?) then 1
          else 2
        end,
        length(s.name),
        s.file_path,
        s.line
      limit ?
      `
    )
    .all(repoId, name, `%${name}%`, ...filterParams, name, `${name}%`, fetchLimit) as (SymbolRecord & { parentName?: string | null })[];
  const rows = (filters.excludeTests ? allRows.filter((r) => !isTestPath(r.filePath)) : allRows).slice(0, limit);

  const normalizedQuery = name.toLowerCase();
  return rows.map((row, index) => {
    const normalizedName = row.name.toLowerCase();
    const matchType: "exact" | "prefix" | "contains" =
      normalizedName === normalizedQuery
        ? "exact"
        : normalizedName.startsWith(normalizedQuery)
          ? "prefix"
          : "contains";

    const base = matchType === "exact" ? 0.96 : matchType === "prefix" ? 0.88 : 0.72;
    const kindBonus = RANKED_KIND_BONUS.includes(row.kind) ? 0.03 : 0;
    const testPenalty = isTestPath(row.filePath) ? TEST_PATH_PENALTY : 0;
    const positionPenalty = Math.min(index * 0.01, 0.2);
    const confidence = Math.max(0, Math.min(1, base + kindBonus - testPenalty - positionPenalty));

    return {
      symbolId: row.symbolId,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      signature: row.signature ?? null,
      ...(row.parentName ? { qualifiedName: `${row.parentName}.${row.name}` } : {}),
      matchType,
      score: Math.round(confidence * 100),
      confidence
    };
  });
}
