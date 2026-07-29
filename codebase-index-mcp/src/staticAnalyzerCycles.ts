/**
 * Cycle detection over the import/call graph.
 *
 * Self-contained: a DFS with a canonical cycle key, so the same cycle reached from different
 * entry nodes collapses to one reported result.
 */

import type Database from "better-sqlite3";

export function detectCircularDependencies(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  mode: "module" | "symbol",
  includeCalls: boolean,
  maxDepth: number,
  maxCycles: number
): {
  mode: "module" | "symbol";
  cycleCount: number;
  cycles: { path: string[]; edgeTypes: string[]; length: number }[];
} {
  const edgeTypes = includeCalls ? ["IMPORTS", "DEPENDS_ON", "CALLS"] : ["IMPORTS", "DEPENDS_ON"];
  const edgePlaceholders = edgeTypes.map(() => "?").join(", ");
  const params: unknown[] = [repoId, ...edgeTypes];

  let rows: { fromId: string; toId: string; edgeType: string }[];
  if (mode === "module") {
    let filterSql = "";
    if (filePathPrefix) {
      filterSql = " and (replace(sf.file_path, char(92), '/') like ? or replace(st.file_path, char(92), '/') like ?)";
      const prefix = `${filePathPrefix.replace(/\\/g, "/")}%`;
      params.push(prefix, prefix);
    }

    rows = db
      .prepare(
        `
        select distinct
          replace(sf.file_path, char(92), '/') as fromId,
          replace(st.file_path, char(92), '/') as toId,
          e.type as edgeType
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ?
          and e.type in (${edgePlaceholders})
          and sf.file_path is not null
          and st.file_path is not null
          and sf.file_path != st.file_path
          ${filterSql}
        limit 50000
        `
      )
      .all(...params) as { fromId: string; toId: string; edgeType: string }[];
  } else {
    let filterSql = "";
    if (filePathPrefix) {
      filterSql = " and (replace(sf.file_path, char(92), '/') like ? or replace(st.file_path, char(92), '/') like ?)";
      const prefix = `${filePathPrefix.replace(/\\/g, "/")}%`;
      params.push(prefix, prefix);
    }

    rows = db
      .prepare(
        `
        select distinct
          e.from_id as fromId,
          e.to_id as toId,
          e.type as edgeType
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ?
          and e.type in (${edgePlaceholders})
          ${filterSql}
        limit 50000
        `
      )
      .all(...params) as { fromId: string; toId: string; edgeType: string }[];
  }

  const adjacency = new Map<string, { to: string; edgeType: string }[]>();
  for (const row of rows) {
    if (row.fromId === row.toId) {
      continue;
    }
    const list = adjacency.get(row.fromId) ?? [];
    list.push({ to: row.toId, edgeType: row.edgeType });
    adjacency.set(row.fromId, list);
  }

  const nodes = [...adjacency.keys()].sort();
  const seen = new Set<string>();
  const cycles: { path: string[]; edgeTypes: string[]; length: number }[] = [];

  const canonicalCycleKey = (core: string[]): string => {
    const candidates: string[] = [];
    const n = core.length;
    for (let i = 0; i < n; i++) {
      const rotated = [...core.slice(i), ...core.slice(0, i)].join("->");
      candidates.push(rotated);
    }
    const reversed = [...core].reverse();
    for (let i = 0; i < n; i++) {
      const rotated = [...reversed.slice(i), ...reversed.slice(0, i)].join("->");
      candidates.push(rotated);
    }
    candidates.sort();
    return candidates[0] ?? core.join("->");
  };

  const stackNodes: string[] = [];
  const stackEdgeTypes: string[] = [];

  const dfs = (start: string, current: string): void => {
    if (cycles.length >= maxCycles) {
      return;
    }

    const outgoing = adjacency.get(current) ?? [];
    for (const edge of outgoing) {
      if (cycles.length >= maxCycles) {
        return;
      }

      if (edge.to === start && stackNodes.length > 1) {
        const core = [...stackNodes];
        const key = canonicalCycleKey(core);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push({
            path: [...core, start],
            edgeTypes: [...stackEdgeTypes, edge.edgeType],
            length: core.length
          });
        }
        continue;
      }

      if (stackNodes.includes(edge.to) || stackNodes.length >= maxDepth) {
        continue;
      }

      stackNodes.push(edge.to);
      stackEdgeTypes.push(edge.edgeType);
      dfs(start, edge.to);
      stackNodes.pop();
      stackEdgeTypes.pop();
    }
  };

  for (const start of nodes) {
    if (cycles.length >= maxCycles) {
      break;
    }
    stackNodes.length = 0;
    stackEdgeTypes.length = 0;
    stackNodes.push(start);
    dfs(start, start);
  }

  cycles.sort((a, b) => a.length - b.length || a.path.join("->").localeCompare(b.path.join("->")));
  return {
    mode,
    cycleCount: cycles.length,
    cycles
  };
}
