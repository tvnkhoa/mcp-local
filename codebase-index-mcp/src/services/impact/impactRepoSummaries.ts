/**
 * Repository- and folder-level answers: folder summaries, module grouping, the route map, the schema snapshot, the read-only graph query, and the repository listings.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "../../types/index.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES } from "../../types/index.js";
import { expandInterfaceSiblingsImpl } from "../graph/interfaceSiblings.js";

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
        -- MCP-ISSUE-055: the registration-site delegate name wins over the joined symbol's name.
        -- When a partial-class handler could not be bound, the join lands on the enclosing Map
        -- and reported "Map" for every route in the group; the recorded name is still correct.
        coalesce(r.handler_name, hs.name) as handlerName,
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
