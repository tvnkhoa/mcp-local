/**
 * `get_symbol_context_pack`: candidates, callers, callees and change context in one response.
 *
 * Exists to collapse what would otherwise be four round trips, which is why it is the tool the
 * workspace rules recommend after a name lookup.
 */

import type Database from "better-sqlite3";
import type { SymbolRecord } from "./types.js";
import { expandInterfaceSiblingsImpl } from "./interfaceSiblings.js";
import { buildFtsQuery, kindPriorityOrder } from "./symbolSearchFts.js";

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
