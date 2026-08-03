/**
 * Discovery queries: where execution enters, and who implements a contract.
 *
 * `findSimilarInterfaceNames` sits beside `findImplementations` because it exists only to answer
 * a miss from it - `find_implementations` returning nothing is usually a misspelled interface,
 * and the handler pairs the two calls.
 */

import type Database from "better-sqlite3";

export function findEntryPoints(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  kind: string | null,
  limit: number
): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null; entryReason: string }[] {
  // Dedicated fast-path: surface C# route handlers from the routes table
  if (kind === "route_handler") {
    const routeConditions: string[] = ["r.repo_id = ?"];
    const routeParams: unknown[] = [repoId];
    if (filePathPrefix) {
      routeConditions.push("replace(r.file_path, char(92), '/') like ?");
      routeParams.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
    }
    const routeWhere = routeConditions.join(" and ");
    routeParams.push(limit);
    const routeRows = db
      .prepare(
        `
        select
          r.handler_symbol_id as symbolId,
          coalesce(hs.name, r.handler_symbol_id) as name,
          'route_handler' as kind,
          r.file_path as filePath,
          r.line as line,
          r.http_method || ' ' || r.route_template as signature
        from routes r
        left join symbols hs on hs.repo_id = r.repo_id and hs.symbol_id = r.handler_symbol_id
        where ${routeWhere}
        order by r.file_path, r.line
        limit ?
        `
      )
      .all(...routeParams) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string }[];
    return routeRows.map((r) => ({ ...r, entryReason: "route_handler" }));
  }

  // Tier 1: runtime bootstrap files — match regardless of path separator (Windows stores backslash)
  const bootstrapFileNames = [
    "Program.cs", "Startup.cs", "main.ts", "main.js", "index.ts", "index.js",
    "App.tsx", "App.ts", "server.ts", "server.js"
  ];
  const bootstrapOrClauses = bootstrapFileNames
    .map(() => "(replace(s.file_path, char(92), '/') like ? or replace(s.file_path, char(92), '/') = ?)")
    .join(" or ");
  const bootstrapParams = bootstrapFileNames.flatMap((f) => [`%/${f}`, f]);

  const bootstrapRows = db
    .prepare(
      `
      select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
      from symbols s
      where s.repo_id = ?
        and s.kind in ('module', 'function', 'method', 'class', 'record', 'record struct')
        and (${bootstrapOrClauses})
      order by s.file_path, s.line
      limit ?
      `
    )
    .all(repoId, ...bootstrapParams, Math.min(limit, 20)) as {
      symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null;
    }[];

  const bootstrapResults = bootstrapRows.map((r) => ({ ...r, entryReason: "bootstrap_file" }));
  const remaining = limit - bootstrapResults.length;

  if (remaining <= 0) {
    return bootstrapResults;
  }

  // Tier 2: uncalled public symbols (no incoming CALLS edges)
  const conditions: string[] = [
    "s.repo_id = ?",
    "s.kind not in ('module', 'property', 'constructor', 'type')"
  ];
  const params: unknown[] = [repoId];

  if (filePathPrefix) {
    conditions.push("replace(s.file_path, char(92), '/') like ?");
    params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
  }
  if (kind) {
    conditions.push("s.kind = ?");
    params.push(kind);
  }

  // Exclude symbols already in bootstrap results
  const bootstrapIds = bootstrapResults.map((r) => r.symbolId);
  if (bootstrapIds.length > 0) {
    const bph = bootstrapIds.map(() => "?").join(", ");
    conditions.push(`s.symbol_id not in (${bph})`);
    params.push(...bootstrapIds);
  }

  const where = conditions.join(" and ");
  params.push(repoId, remaining);

  const uncalledRows = db
    .prepare(
      `
      select s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
      from symbols s
      where ${where}
        and not exists (
          select 1 from edges e
          where e.repo_id = ? and e.type = 'CALLS' and e.to_id = s.symbol_id
        )
      order by s.file_path, s.line
      limit ?
      `
    )
    .all(...params) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];

  const uncalledResults = uncalledRows.map((r) => ({ ...r, entryReason: "uncalled_symbol" }));

  // Filter out well-known bootstrap function/method names that are never called by other code
  // but are conventional entry points or lifecycle hooks — not truly dead code.
  const bootstrapFunctionNames = new Set([
    "main", "bootstrap", "setup", "configure", "init", "start", "boot",
    "run", "launch", "startup", "initialize", "teardown", "cleanup", "shutdown",
    "onLoad", "onReady", "afterAll", "beforeAll", "afterEach", "beforeEach"
  ]);
  const filteredResults = uncalledResults.filter(
    (r) => !bootstrapFunctionNames.has(r.name) && !bootstrapFunctionNames.has(r.name.toLowerCase())
  );

  return [...bootstrapResults, ...filteredResults];
}

export function findImplementations(
  db: Database.Database,
  repoId: string,
  interfaceName: string,
  limit: number
): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] {
  // Find resolved IMPLEMENTS edges (toId = symbolId of interface)
  const targets = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and name = ? and kind = 'interface'`)
    .all(repoId, interfaceName) as { symbolId: string }[];

  // Also check unresolved iface: placeholder edges
  const rows: { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] = [];

  if (targets.length > 0) {
    const ph = targets.map(() => "?").join(",");
    const fromResolved = db
      .prepare(
        `
        select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
        from edges e
        inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id in (${ph})
        order by s.file_path, s.line
        limit ?
        `
      )
      .all(repoId, ...targets.map((t) => t.symbolId), limit) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];
    rows.push(...fromResolved);
  }

  // Also check unresolved iface: placeholders
  const fromUnresolved = db
    .prepare(
      `
      select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id = ?
      order by s.file_path, s.line
      limit ?
      `
    )
    .all(repoId, `iface:${interfaceName}`, limit) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];

  for (const r of fromUnresolved) {
    if (!rows.some((existing) => existing.symbolId === r.symbolId)) {
      rows.push(r);
    }
  }

  return rows.slice(0, limit);
}

/**
 * Suggest indexed interface names similar to a (likely mistyped or unindexed) name.
 * Used by find_implementations to surface a "did you mean" list when an exact match
 * yields zero implementations — mirrors findSimilarPackageContractIds for packages.
 * Matches case-insensitively on substring (covers prefix/suffix/typo-adjacent names).
 */
export function findSimilarInterfaceNames(
  db: Database.Database,
  repoId: string,
  interfaceName: string,
  limit: number
): string[] {
  const needle = `%${interfaceName.trim()}%`;
  const rows = db
    .prepare(
      `select distinct name from symbols
       where repo_id = ? and kind = 'interface' and name like ? collate nocase and name != ?
       order by length(name), name
       limit ?`
    )
    .all(repoId, needle, interfaceName, limit) as { name: string }[];
  return rows.map((r) => r.name);
}
