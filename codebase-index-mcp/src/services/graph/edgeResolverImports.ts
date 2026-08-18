/**
 * IMPORTS edges, including the cross-repo pass and the module tie-break it needs.
 *
 * Split out of `edgeResolver.ts` in S-41 (it was 1424 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { ResolutionStats } from "../../types/index.js";
import { findProviderSymbolByName } from "../../repositories/crossRepoStore.js";
import {
  isKnownExternalToken,
  isKnownExternalNamespace,
  isKnownCrossRepoNamespace,
  stripGenerics,
  vectorSearchSymbols,
  isVectorEnabled,
} from "../../repositories/vectorStore.js";
import { tagExternalNamespaceImports } from "./edgeResolverShared.js";
import {
  EMPTY_ALIASES,
  loadIndexedFilePaths,
  loadRepoPath,
  looksLikeModulePath,
  readTsconfigAliases,
  resolveModuleSpecifier
} from "./moduleResolution.js";

export function resolveImportEdges(db: Database.Database, repoId: string, maxUnresolvedRows = 0): number {
  // Phase 0: Bulk-tag all external namespace imports BEFORE row-limited resolution.
  // This runs without LIMIT so System.*/Microsoft.*/etc. are always tagged regardless of batch size.
  const externalTagged = tagExternalNamespaceImports(db, repoId);

  // Find all IMPORTS edges with unresolved plain-text toId ("import:<path>")
  const unresolvedSql = `
    select distinct e.from_id as fromId, e.to_id as toId, sf.file_path as fromFile
    from edges e
    inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
    where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id like 'import:%'
      and e.reason = 'unresolved import token'
    -- ORDER BY is load-bearing, not cosmetic: with a LIMIT and no ordering, SQLite may return any
    -- N of the qualifying rows, so resolution ran over an arbitrary sample and two identical runs
    -- resolved different edges. The key must fully disambiguate, or the sort is arbitrary again.
    -- MCP-ISSUE-032.
    order by e.from_id, e.to_id, sf.file_path
    ${maxUnresolvedRows > 0 ? "limit ?" : ""}
  `;
  const unresolved = db
    .prepare(unresolvedSql)
    .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
    fromId: string;
    toId: string;
    fromFile: string;
  }[];

  if (unresolved.length === 0) return externalTagged;

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ?`
  );

  // Build a map of all file paths in this repo → module symbolId
  const fileToModuleId = new Map<string, string>();
  const moduleRows = db
    .prepare(`select file_path as filePath, symbol_id as symbolId from symbols where repo_id = ? and kind = 'module'`)
    .all(repoId) as { filePath: string; symbolId: string }[];
  for (const row of moduleRows) {
    // Normalize path separators
    const normalizedPath = row.filePath.replace(/\\/g, "/");
    fileToModuleId.set(normalizedPath, row.symbolId);
  }

  const namespacePathToModuleId = new Map<string, string>();
  const commonRootFolders = new Set(["src", "app", "lib", "test", "tests", "spec", "specs", "packages", "shared", "services", "server", "client"]);
  for (const [filePath, symbolId] of fileToModuleId) {
    const parts = filePath.split("/").filter((part) => part.length > 0);
    if (parts.length < 2) continue;

    const withoutFile = parts.slice(0, -1);
    const startIndex = commonRootFolders.has((withoutFile[0] ?? "").toLowerCase()) ? 1 : 0;
    const candidateParts = withoutFile.slice(startIndex);
    if (candidateParts.length < 2) continue;

    for (let length = 2; length <= Math.min(6, candidateParts.length); length += 1) {
      const alias = candidateParts.slice(candidateParts.length - length).join(".");
      if (alias && !namespacePathToModuleId.has(alias)) {
        namespacePathToModuleId.set(alias, symbolId);
      }
    }
  }

  // P2.1: Build a map of C# namespace → module symbolId for internal namespace resolution.
  // Scans namespace_declaration symbols (kind='module') whose name looks like a dotted namespace.
  // e.g. "CRM.Marketing.Model" → symbolId of the file that declares that namespace.
  const namespaceToModuleId = new Map<string, string>();
  const nsRows = db
    .prepare(
      `select name, symbol_id as symbolId, file_path as filePath
       from symbols
       where repo_id = ? and kind = 'module' and name like '%.%'`
    )
    .all(repoId) as { name: string; symbolId: string; filePath: string }[];
  for (const row of nsRows) {
    // Map full namespace name → symbolId (first occurrence wins)
    if (!namespaceToModuleId.has(row.name)) {
      namespaceToModuleId.set(row.name, row.symbolId);
    }
    // Also map the file's module symbol for the namespace's file
    const normalizedPath = row.filePath.replace(/\\/g, "/");
    const fileModuleId = fileToModuleId.get(normalizedPath);
    if (fileModuleId && !namespaceToModuleId.has(row.name)) {
      namespaceToModuleId.set(row.name, fileModuleId);
    }
  }

  const knownFiles = loadIndexedFilePaths(db, repoId);
  const repoPath = loadRepoPath(db, repoId);
  const aliases = repoPath ? readTsconfigAliases(repoPath) : EMPTY_ALIASES;

  const importResolveCache = new Map<string, string | null>();

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of unresolved) {
      let importPath = row.toId.slice(7); // strip "import:"
      // Strip "static " prefix from "using static" directives before namespace resolution
      if (importPath.startsWith("static ")) importPath = importPath.slice(7);
      const fromDir = row.fromFile.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

      // P2.1: Try C# namespace resolution first for dotted namespace imports
      // e.g. import:CRM.Marketing.Model → find module symbol for that namespace
      //
      // `looksLikeModulePath` is the guard that keeps JS/TS out of this branch. The condition used
      // to be "not relative AND contains a dot", which is also true of `@/db/pool.js` — the ordinary
      // ESM-plus-path-alias form, and the one this workspace's own target stack uses. Those went
      // looking for a C# namespace, found none, and were dropped as unresolvable.
      if (!importPath.startsWith(".") && importPath.includes(".") && !looksLikeModulePath(importPath)) {
        // Check if top-level namespace is a known external — tag and skip
        const topNs = importPath.split(".")[0];
        if (topNs && isKnownExternalNamespace(topNs)) {
          updateStmt.run(row.toId, 0.1, "external boundary", repoId, row.fromId, row.toId);
          continue;
        }

        const cacheKey = `ns|${importPath}`;
        if (importResolveCache.has(cacheKey)) {
          const cachedModuleId = importResolveCache.get(cacheKey);
          if (cachedModuleId) {
            updateStmt.run(cachedModuleId, 0.8, "resolved csharp namespace", repoId, row.fromId, row.toId);
            count += 1;
          }
          continue;
        }

        // Try exact namespace match first, then prefix match (longest prefix wins)
        let matchedModuleId: string | undefined;
        if (namespaceToModuleId.has(importPath)) {
          matchedModuleId = namespaceToModuleId.get(importPath);
        } else {
          // Try progressively shorter namespace prefixes
          const parts = importPath.split(".");
          for (let len = parts.length - 1; len >= 2; len--) {
            const prefix = parts.slice(0, len).join(".");
            if (namespaceToModuleId.has(prefix)) {
              matchedModuleId = namespaceToModuleId.get(prefix);
              break;
            }
          }
        }

        // Fallback: match namespace against folder-derived aliases from C# file paths.
        // This helps when a file does not declare a dotted namespace symbol but lives
        // under a namespace-shaped directory tree (e.g. CRM/Marketing/Model/Foo.cs).
        if (!matchedModuleId) {
          matchedModuleId = namespacePathToModuleId.get(importPath);
        }

        importResolveCache.set(cacheKey, matchedModuleId ?? null);
        if (matchedModuleId) {
          updateStmt.run(matchedModuleId, 0.78, namespacePathToModuleId.has(importPath) ? "resolved csharp namespace (path fallback)" : "resolved csharp namespace", repoId, row.fromId, row.toId);
          count += 1;
        }
        continue;
      }

      // JS/TS: a relative specifier, or one a tsconfig path alias / baseUrl can turn into a path.
      const isPathLike = importPath.startsWith(".") || looksLikeModulePath(importPath);
      if (!isPathLike) continue;

      const cacheKey = `${fromDir}|${importPath}`;
      if (importResolveCache.has(cacheKey)) {
        const cachedModuleId = importResolveCache.get(cacheKey);
        if (cachedModuleId) {
          updateStmt.run(cachedModuleId, 0.95, "resolved relative import", repoId, row.fromId, row.toId);
          count += 1;
        }
        continue;
      }

      // One resolver, shared with the call lane. It knows the ESM `.js → .ts` rewrite (required on a
      // relative import under `"type": "module"`, so it is the normal case rather than a fallback),
      // every TypeScript extension including `.mts`/`.cts`, index files, and tsconfig `paths`.
      const targetFile = resolveModuleSpecifier(row.fromFile, importPath, knownFiles, aliases);
      const matchedModuleId = targetFile ? fileToModuleId.get(targetFile) : undefined;

      importResolveCache.set(cacheKey, matchedModuleId ?? null);

      if (matchedModuleId) {
        updateStmt.run(matchedModuleId, 0.95, "resolved relative import", repoId, row.fromId, row.toId);
        count += 1;
      }
    }
  });
  tx();

  // Phase 3: Resolve cross-repo namespace imports (e.g. CRM.*, SSNet.*)
  // These were intentionally left unresolved by tagExternalNamespaceImports and the main loop.
  const crossRepoResolved = resolveImportsCrossRepo(db, repoId, maxUnresolvedRows);

  return count + externalTagged + crossRepoResolved;
}

/**
 * Resolve IMPORTS edges whose namespace belongs to a known cross-repo namespace (e.g. CRM.*, SSNet.*).
 * If another indexed repo in the same DB declares a matching namespace module, the edge is resolved
 * to that module's symbolId and a cross_repo_deps entry is created.
 * If no provider repo is found, the edge is tagged "external boundary" as fallback
 * (provider repo not yet indexed).
 *
 * Also re-attempts resolution for edges previously tagged "external boundary" with a cross-repo
 * namespace prefix — this handles the case where a provider repo is newly indexed after consumer.
 */
export function resolveImportsCrossRepo(db: Database.Database, repoId: string, maxRows = 0): number {
  // Find all IMPORTS edges that are either unresolved OR previously tagged external boundary
  // for cross-repo namespace prefixes. Excludes edges already resolved to real symbols.
  // maxRows=0 means unlimited (default); when set, caps the number of edges processed.
  const rows = db
    .prepare(
      `SELECT e.from_id as fromId, e.to_id as toId, e.reason as reason
       FROM edges e
       WHERE e.repo_id = ? AND e.type = 'IMPORTS' AND e.to_id LIKE 'import:%'
         AND e.reason IN ('unresolved import token', 'external boundary')
       ${maxRows > 0 ? "LIMIT ?" : ""}`
    )
    .all(...(maxRows > 0 ? [repoId, maxRows] : [repoId])) as { fromId: string; toId: string; reason: string }[];

  if (rows.length === 0) return 0;

  // Filter: only cross-repo namespace prefixes (e.g. CRM.*, SSNet.*)
  const crossRepoRows = rows.filter((row) => {
    let importPath = row.toId.slice(7);
    if (importPath.startsWith("static ")) importPath = importPath.slice(7);
    const topNs = importPath.split(".")[0];
    return topNs ? isKnownCrossRepoNamespace(topNs) : false;
  });

  if (crossRepoRows.length === 0) return 0;

  // Build namespace → module candidates from all other repos indexed in this DB.
  // For disambiguation: if multiple repos share the same namespace, prefer the one
  // with the most symbols (largest provider repo = most complete index).
  const repoSymbolCounts = new Map<string, number>();
  const repoCountRows = db
    .prepare(`SELECT repo_id as repoId, COUNT(*) as cnt FROM symbols WHERE repo_id != ? GROUP BY repo_id`)
    .all(repoId) as { repoId: string; cnt: number }[];
  for (const r of repoCountRows) repoSymbolCounts.set(r.repoId, r.cnt);

  const otherModules = db
    .prepare(
      `SELECT repo_id as repoId, symbol_id as symbolId, name
       FROM symbols
       WHERE repo_id != ? AND kind = 'module' AND name LIKE '%.%'`
    )
    .all(repoId) as { repoId: string; symbolId: string; name: string }[];

  const nsToModules = new Map<string, { symbolId: string; repoId: string }[]>();
  for (const m of otherModules) {
    const list = nsToModules.get(m.name) ?? [];
    list.push({ symbolId: m.symbolId, repoId: m.repoId });
    nsToModules.set(m.name, list);
  }

  // UPDATE without reason restriction — handles both fresh unresolved and re-attempt of external boundary
  const updateStmt = db.prepare(
    `UPDATE edges SET to_id = ?, confidence = ?, reason = ?
     WHERE repo_id = ? AND type = 'IMPORTS' AND from_id = ? AND to_id = ?`
  );
  // Tag external only for edges that were 'unresolved import token' (not already external boundary)
  const tagExternalStmt = db.prepare(
    `UPDATE edges SET confidence = 0.1, reason = 'external boundary'
     WHERE repo_id = ? AND type = 'IMPORTS' AND from_id = ? AND to_id = ? AND reason = 'unresolved import token'`
  );
  const insertCrossRepoDep = db.prepare(
    `INSERT INTO cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  );

  // Pick repo with most symbols — largest = most complete provider when multiple repos share namespace.
  function pickBestModule(candidates: { symbolId: string; repoId: string }[]): { symbolId: string; repoId: string } | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    return candidates.reduce((best, c) => {
      const bestCount = repoSymbolCounts.get(best.repoId) ?? 0;
      const cCount = repoSymbolCounts.get(c.repoId) ?? 0;
      return cCount > bestCount ? c : best;
    });
  }

  let resolved = 0;
  const tx = db.transaction(() => {
    for (const row of crossRepoRows) {
      let importPath = row.toId.slice(7);
      if (importPath.startsWith("static ")) importPath = importPath.slice(7);

      // Try exact namespace match, then progressively shorter prefix (longest wins).
      // When multiple repos share the same namespace, prefer the largest (most symbols).
      let match: { symbolId: string; repoId: string } | undefined;

      const exactCandidates = nsToModules.get(importPath);
      if (exactCandidates && exactCandidates.length >= 1) {
        match = pickBestModule(exactCandidates);
      } else {
        const parts = importPath.split(".");
        for (let len = parts.length - 1; len >= 2; len--) {
          const prefix = parts.slice(0, len).join(".");
          const prefixCandidates = nsToModules.get(prefix);
          if (prefixCandidates && prefixCandidates.length >= 1) {
            match = pickBestModule(prefixCandidates);
            break;
          }
        }
      }

      if (match) {
        updateStmt.run(match.symbolId, 0.70, "resolved cross-repo import", repoId, row.fromId, row.toId);
        insertCrossRepoDep.run(repoId, row.fromId, match.repoId, match.symbolId, "IMPORTS");
        resolved++;
      } else if (row.reason === "unresolved import token") {
        // Provider repo not yet indexed — tag as external boundary (not an error)
        tagExternalStmt.run(repoId, row.fromId, row.toId);
      }
      // If already 'external boundary' and still no provider found — leave as-is
    }
  });
  tx();

  return resolved;
}

// ── Call edge resolution context (pre-built once, reused across batches) ──────
