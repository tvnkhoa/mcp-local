import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { ResolutionStats } from "./types.js";
import { findProviderSymbolByName } from "./crossRepoStore.js";
import {
  isKnownExternalToken,
  isKnownExternalNamespace,
  isKnownCrossRepoNamespace,
  stripGenerics,
  vectorSearchSymbols,
  isVectorEnabled,
} from "./vectorStore.js";

/**
 * Bulk-tag all import edges whose namespace belongs to a known external namespace (System, Microsoft, etc.)
 * as "external boundary" with confidence 0.1. Runs without row LIMIT so external imports are always tagged
 * regardless of batch size or maxUnresolvedRows policy.
 */
function tagExternalNamespaceImports(db: Database.Database, repoId: string): number {
  // Collect all distinct unresolved import namespaces
  const rows = db
    .prepare(
      `SELECT DISTINCT to_id as toId
       FROM edges
       WHERE repo_id = ? AND type = 'IMPORTS' AND to_id LIKE 'import:%'
         AND reason = 'unresolved import token'`
    )
    .all(repoId) as { toId: string }[];

  if (rows.length === 0) return 0;

  // Build set of known NuGet package top-level namespaces from DEPENDS_ON edges
  // e.g. nuget:Newtonsoft.Json → "Newtonsoft", nuget:MassTransit → "MassTransit"
  const nugetTopNamespaces = new Set<string>();
  const nugetRows = db
    .prepare(
      `SELECT DISTINCT to_id as toId FROM edges
       WHERE repo_id = ? AND type = 'DEPENDS_ON' AND to_id LIKE 'nuget:%'`
    )
    .all(repoId) as { toId: string }[];
  for (const nr of nugetRows) {
    const pkgName = nr.toId.slice(6); // strip "nuget:"
    const topNs = pkgName.split(".")[0];
    // Store lowercase for case-insensitive matching against PascalCase namespace tokens
    if (topNs) nugetTopNamespaces.add(topNs.toLowerCase());
  }

  const updateStmt = db.prepare(
    `UPDATE edges SET confidence = 0.1, reason = 'external boundary'
     WHERE repo_id = ? AND type = 'IMPORTS' AND to_id = ? AND reason = 'unresolved import token'`
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      let importPath = row.toId.slice(7); // strip "import:"
      // Strip "static " prefix from "using static" directives (e.g. "static System.Net.WebRequestMethods")
      if (importPath.startsWith("static ")) importPath = importPath.slice(7);
      if (!importPath.includes(".")) continue;
      const topNs = importPath.split(".")[0];
      if (!topNs) continue;
      // Check known external namespaces (System, Microsoft, etc.)
      // OR NuGet package top-level namespaces — use case-insensitive match (nuget ids are lowercase)
      if (isKnownExternalNamespace(topNs) || nugetTopNamespaces.has(topNs.toLowerCase())) {
        const result = updateStmt.run(repoId, row.toId);
        count += result.changes;
      }
    }
  });
  tx();

  return count;
}

function createEmptyResolutionStats(): ResolutionStats {
  return {
    attempts: 0,
    resolved: 0,
    unresolvedByReason: {
      no_candidate: 0,
      ambiguous_candidates: 0,
      boundary_blocked: 0,
      low_confidence: 0
    }
  };
}

function buildNamedCandidateMap(
  db: Database.Database,
  repoId: string,
  allowedKinds?: readonly string[]
): Map<string, { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null }[]> {
  const rows = allowedKinds && allowedKinds.length > 0
    ? db
        .prepare(
          `select symbol_id as symbolId, name, file_path as filePath, kind, parent_symbol_id as parentSymbolId
           from symbols
           where repo_id = ? and kind in (${allowedKinds.map(() => "?").join(", ")})`
        )
        .all(repoId, ...allowedKinds) as { symbolId: string; name: string; filePath: string; kind: string; parentSymbolId: string | null }[]
    : db
        .prepare(
          `select symbol_id as symbolId, name, file_path as filePath, kind, parent_symbol_id as parentSymbolId
           from symbols
           where repo_id = ?`
        )
        .all(repoId) as { symbolId: string; name: string; filePath: string; kind: string; parentSymbolId: string | null }[];

  const byName = new Map<string, { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null }[]>();
  for (const row of rows) {
    const list = byName.get(row.name) ?? [];
    list.push({ symbolId: row.symbolId, filePath: row.filePath, kind: row.kind, parentSymbolId: row.parentSymbolId ?? null });
    byName.set(row.name, list);
  }
  return byName;
}

function pickBestNamedCandidate<T extends { symbolId: string; filePath: string; kind: string }>(
  candidates: T[],
  fromFile: string,
  kindPriority: readonly string[]
): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const rank = new Map(kindPriority.map((kind, index) => [kind, index]));
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const sameFilePenalty = candidate.filePath === fromFile ? 0 : 100;
    const kindPenalty = rank.get(candidate.kind) ?? 999;
    const score = sameFilePenalty + kindPenalty;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function resolveUnlinkedEdges(db: Database.Database, repoId: string): ResolutionStats {
  const stats = createEmptyResolutionStats();

  // Find edge toIds that don't exist in this repo's symbols.
  // Exclude unresolved placeholders that are handled by dedicated resolvers.
  const unlinked = db
    .prepare(
      `
      select distinct e.from_id as fromId, e.to_id as toId, e.type
      from edges e
      where e.repo_id = ?
        and e.to_id not like 'import:%'
        and e.to_id not like 'callee:%'
        and not exists (
          select 1 from symbols s where s.repo_id = ? and s.symbol_id = e.to_id
        )
      limit 5000
      `
    )
    .all(repoId, repoId) as { fromId: string; toId: string; type: string }[];

  if (unlinked.length === 0) {
    return stats;
  }

  const contractPrefixPattern = /^(nuget|endpoint):/;
  const symbolToIds = [...new Set(unlinked.map((r) => r.toId).filter((toId) => !contractPrefixPattern.test(toId)))];
  const contractIds = [...new Set(unlinked.map((r) => r.toId).filter((toId) => contractPrefixPattern.test(toId)))];

  const candidatesByToId = new Map<string, { toRepoId: string; toSymbolId: string }[]>();

  if (symbolToIds.length > 0) {
    const symbolPlaceholders = symbolToIds.map(() => "?").join(", ");
    const symbolMatches = db
      .prepare(
        `
        select repo_id as toRepoId, symbol_id as toSymbolId
        from symbols
        where repo_id != ? and symbol_id in (${symbolPlaceholders})
        `
      )
      .all(repoId, ...symbolToIds) as { toRepoId: string; toSymbolId: string }[];

    for (const row of symbolMatches) {
      const list = candidatesByToId.get(row.toSymbolId) ?? [];
      list.push({ toRepoId: row.toRepoId, toSymbolId: row.toSymbolId });
      candidatesByToId.set(row.toSymbolId, list);
    }
  }

  if (contractIds.length > 0) {
    const contractPlaceholders = contractIds.map(() => "?").join(", ");
    const contractMatches = db
      .prepare(
        `
        select repo_id as toRepoId, symbol_id as toSymbolId, signature as contractId
        from symbols
        where repo_id != ? and signature in (${contractPlaceholders})
        `
      )
      .all(repoId, ...contractIds) as { toRepoId: string; toSymbolId: string; contractId: string }[];

    for (const row of contractMatches) {
      const list = candidatesByToId.get(row.contractId) ?? [];
      list.push({ toRepoId: row.toRepoId, toSymbolId: row.toSymbolId });
      candidatesByToId.set(row.contractId, list);
    }
  }

  const upsertStmt = db.prepare(
    `
    insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
    values (?, ?, ?, ?, ?)
    on conflict do nothing
    `
  );

  // Lazily-built per-repo symbol counts, used only to break ties when several provider
  // repos export the same contract id. Broadened nuget-export emission (PackageId ??
  // AssemblyName ?? project name, ISSUE-CR-001) makes such collisions more likely; rather
  // than dropping the link as ambiguous, prefer the most complete provider repo — the same
  // heuristic resolveImportsCrossRepo uses (pickBestModule). Only contract (nuget:/endpoint:)
  // toIds get this treatment; genuine symbol-id collisions stay ambiguous.
  let repoSymbolCounts: Map<string, number> | null = null;
  const getRepoSymbolCounts = (): Map<string, number> => {
    if (!repoSymbolCounts) {
      repoSymbolCounts = new Map();
      const rows = db
        .prepare(`select repo_id as repoId, count(*) as cnt from symbols where repo_id != ? group by repo_id`)
        .all(repoId) as { repoId: string; cnt: number }[];
      for (const r of rows) repoSymbolCounts.set(r.repoId, r.cnt);
    }
    return repoSymbolCounts;
  };

  const tx = db.transaction(() => {
    for (const row of unlinked) {
      stats.attempts += 1;
      const candidates = candidatesByToId.get(row.toId) ?? [];
      if (candidates.length === 0) {
        stats.unresolvedByReason.no_candidate += 1;
        continue;
      }
      if (candidates.length > 1) {
        if (!contractPrefixPattern.test(row.toId)) {
          stats.unresolvedByReason.ambiguous_candidates += 1;
          continue;
        }
        const counts = getRepoSymbolCounts();
        const best = candidates.reduce((b, c) =>
          (counts.get(c.toRepoId) ?? 0) > (counts.get(b.toRepoId) ?? 0) ? c : b
        );
        upsertStmt.run(repoId, row.fromId, best.toRepoId, best.toSymbolId, row.type);
        stats.resolved += 1;
        continue;
      }

      upsertStmt.run(repoId, row.fromId, candidates[0].toRepoId, candidates[0].toSymbolId, row.type);
      stats.resolved += 1;
    }
  });
  tx();

  return stats;
}

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
      if (!importPath.startsWith(".") && importPath.includes(".")) {
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

      // Only attempt resolution for relative imports (JS/TS)
      if (!importPath.startsWith(".")) continue;

      // Resolve relative path
      const parts = `${fromDir}/${importPath}`.split("/");
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === ".." && resolved.length > 0) resolved.pop();
        else if (part !== ".") resolved.push(part);
      }
      const resolvedBase = resolved.join("/");

      const cacheKey = `${fromDir}|${importPath}`;
      if (importResolveCache.has(cacheKey)) {
        const cachedModuleId = importResolveCache.get(cacheKey);
        if (cachedModuleId) {
          updateStmt.run(cachedModuleId, 0.95, "resolved relative import", repoId, row.fromId, row.toId);
          count += 1;
        }
        continue;
      }

      // Try with various extensions and index files
      const candidates = [
        resolvedBase,
        `${resolvedBase}.ts`,
        `${resolvedBase}.js`,
        `${resolvedBase}.tsx`,
        `${resolvedBase}.mts`,
        `${resolvedBase}/index.ts`,
        `${resolvedBase}/index.js`,
        // Strip known extensions to allow .js → .ts rewrite
        resolvedBase.replace(/\.js$/, ".ts"),
        resolvedBase.replace(/\.mjs$/, ".ts"),
      ];

      let matchedModuleId: string | undefined;
      for (const candidate of candidates) {
        const moduleId = fileToModuleId.get(candidate);
        if (moduleId) {
          matchedModuleId = moduleId;
          break;
        }
      }

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
function resolveImportsCrossRepo(db: Database.Database, repoId: string, maxRows = 0): number {
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

export interface CallResolutionContext {
  candidateMap: Map<string, { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null }[]>;
  interfaceByName: Map<string, { symbolId: string; filePath: string }>;
  /** ISSUE-022: symbolIds của mọi interface — detect bare-name match trúng interface method để fan-out. */
  interfaceIdSet: Set<string>;
  implementorFilesByIfaceId: Map<string, string[]>;
  updateStmt: Statement;
  insertDispatchStmt: Statement;
  /** All unresolved rows pre-fetched once — sliced per batch in memory */
  unresolvedRows: { fromId: string; toId: string; fromFile: string }[];
  /** Current offset into unresolvedRows for batching */
  offset: number;
}

/**
 * Pre-build all lookup maps needed for call edge resolution.
 * Call this ONCE before batched resolveCallEdgesBatch() calls.
 */
export function buildCallResolutionContext(db: Database.Database, repoId: string): CallResolutionContext {
  const interfaceRows = db
    .prepare(`select symbol_id as symbolId, name, file_path as filePath from symbols where repo_id = ? and kind = 'interface'`)
    .all(repoId) as { symbolId: string; name: string; filePath: string }[];
  const interfaceByName = new Map<string, { symbolId: string; filePath: string }>();
  const interfaceIdSet = new Set<string>();
  for (const r of interfaceRows) {
    if (!interfaceByName.has(r.name)) interfaceByName.set(r.name, { symbolId: r.symbolId, filePath: r.filePath });
    interfaceIdSet.add(r.symbolId);
  }

  // record / record struct are class-like implementors too (ISSUE-013/ISSUE-022).
  const implEdgeRows = db
    .prepare(
      `select distinct e.to_id as ifaceId, s.file_path as filePath
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPLEMENTS' and s.kind in ('class', 'struct', 'record', 'record struct')`
    )
    .all(repoId) as { ifaceId: string; filePath: string }[];
  const implementorFilesByIfaceId = new Map<string, string[]>();
  for (const r of implEdgeRows) {
    const list = implementorFilesByIfaceId.get(r.ifaceId) ?? [];
    list.push(r.filePath);
    implementorFilesByIfaceId.set(r.ifaceId, list);
  }

  const candidateMap = buildNamedCandidateMap(db, repoId, ["function", "method", "constructor", "class"]);

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ?`
  );
  const insertDispatchStmt = db.prepare(
    `
    insert into edges (repo_id, from_id, to_id, type, confidence, reason)
    select ?, ?, ?, 'CALLS', ?, ?
    where not exists (
      select 1 from edges
      where repo_id = ? and from_id = ? and to_id = ? and type = 'CALLS'
    )
    `
  );

  // Pre-fetch ALL unresolved rows once — avoids re-scanning edges table per batch.
  // Filter only on to_id prefix — do NOT filter by reason, because 'qualified call'
  // reason is set at extraction time while to_id is still a callee: placeholder.
  const unresolvedRows = db
    .prepare(
      `select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'CALLS' and e.to_id like 'callee:%'`
    )
    .all(repoId) as { fromId: string; toId: string; fromFile: string }[];

  return { candidateMap, interfaceByName, interfaceIdSet, implementorFilesByIfaceId, updateStmt, insertDispatchStmt, unresolvedRows, offset: 0 };
}

/**
 * Resolve one batch of unresolved CALLS edges using a pre-built context.
 * Slices from pre-fetched in-memory rows — no DB re-scan per batch.
 * Returns number of edges resolved in this batch.
 */
export function resolveCallEdgesBatch(
  db: Database.Database,
  repoId: string,
  ctx: CallResolutionContext,
  batchSize: number
): number {
  const batch = ctx.unresolvedRows.slice(ctx.offset, ctx.offset + batchSize);
  ctx.offset += batchSize;

  if (batch.length === 0) return 0;

  const { candidateMap, interfaceByName, interfaceIdSet, implementorFilesByIfaceId } = ctx;
  // ISSUE-022: cap fan-out per call-site — MediatR-style interfaces can have hundreds of
  // implementors; beyond this the dispatch edges are noise, not signal.
  const MAX_INTERFACE_DISPATCH_FANOUT = 10;

  // Phase 1: resolve all rows in memory → collect updates and inserts
  type UpdateRow = { fromId: string; oldToId: string; newToId: string; confidence: number; reason: string };
  type InsertRow = { fromId: string; toId: string; confidence: number; reason: string };
  type PendingVectorLookup = { fromId: string; oldToId: string; normalized: string };
  const updates: UpdateRow[] = [];
  const inserts: InsertRow[] = [];
  const pendingVectorLookups: PendingVectorLookup[] = [];

  for (const row of batch) {
    const calleeName = row.toId.slice(7);
    let dispatchMethodName: string | null = null;
    let dispatchInterfaceId: string | null = null;
    let match = pickBestNamedCandidate(
      candidateMap.get(calleeName) ?? [],
      row.fromFile,
      ["function", "method", "constructor", "class"]
    );

    if (calleeName.includes(".")) {
      const parts = calleeName.split(".").filter((x) => x.length > 0);
      const receiverType = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
      const memberName = parts[parts.length - 1] ?? "";
      if (receiverType && memberName) {
        const iface = interfaceByName.get(receiverType);
        if (iface) {
          const ifaceMethod = (candidateMap.get(memberName) ?? []).find(
            (c) => c.filePath === iface.filePath && c.kind === "method"
          );
          if (ifaceMethod) {
            match = ifaceMethod;
            dispatchMethodName = memberName;
            dispatchInterfaceId = iface.symbolId;
          }
        }
      }
    }

    if (!match && calleeName.includes(".")) {
      const baseName = calleeName.split(".").pop() ?? calleeName;
      match = pickBestNamedCandidate(
        candidateMap.get(baseName) ?? [],
        row.fromFile,
        ["function", "method", "constructor", "class"]
      );
    }

    // ISSUE-022 (Bug D): a bare-name token that resolved straight to an interface's own method
    // must fan out to implementations too — the qualified path above only fires when extraction
    // knew the receiver type. Detected via parent_symbol_id ∈ interface set.
    if (match && !dispatchMethodName && match.kind === "method" && match.parentSymbolId && interfaceIdSet.has(match.parentSymbolId)) {
      dispatchMethodName = calleeName.split(".").pop() ?? calleeName;
      dispatchInterfaceId = match.parentSymbolId;
    }

    if (match) {
      const confidence = dispatchMethodName
        ? (match.filePath === row.fromFile ? 0.9 : 0.8)
        : (match.filePath === row.fromFile ? 0.9 : 0.75);
      const reason = dispatchMethodName
        ? "resolved interface method"
        : (confidence >= 0.9 ? "resolved callee same-file" : "resolved callee by name");
      updates.push({ fromId: row.fromId, oldToId: row.toId, newToId: match.symbolId, confidence, reason });

      if (dispatchMethodName && dispatchInterfaceId) {
        const implementorFiles = (implementorFilesByIfaceId.get(dispatchInterfaceId) ?? []).slice(0, MAX_INTERFACE_DISPATCH_FANOUT);
        for (const implFilePath of implementorFiles) {
          const implMethod = (candidateMap.get(dispatchMethodName) ?? []).find(
            (c) => c.filePath === implFilePath && c.kind === "method"
          );
          if (!implMethod || implMethod.symbolId === match.symbolId) continue;
          inserts.push({ fromId: row.fromId, toId: implMethod.symbolId, confidence: 0.7, reason: "interface-dispatch" });
        }
      }
    } else {
      const rawName = calleeName.split(".").pop() ?? calleeName;
      const normalized = stripGenerics(rawName);
      // Check both terminal name and full qualified name for external detection
      const strippedCallee = stripGenerics(calleeName);
      if (isKnownExternalToken(normalized) || isKnownExternalToken(strippedCallee)) {
        updates.push({ fromId: row.fromId, oldToId: row.toId, newToId: row.toId, confidence: 0.1, reason: "external boundary" });
      } else if (calleeName.includes(".") && calleeName.startsWith("_")) {
        // DI field pattern: _fieldName.Method — likely injected external dependency
        // Tag as external boundary with slightly higher confidence than pure external
        updates.push({ fromId: row.fromId, oldToId: row.toId, newToId: row.toId, confidence: 0.15, reason: "external boundary (DI field)" });
      } else {
        // Collect unresolved tokens for deferred batch vector fallback (after main loop).
        // Calling vectorSearchSymbols per-row is extremely slow on large repos (~40ms/call).
        pendingVectorLookups.push({ fromId: row.fromId, oldToId: row.toId, normalized });
      }
    }
  }

  // Deferred batch vector fallback: resolve remaining unmatched edges via vector search.
  // This runs once per batch instead of per-row, dramatically reducing SQLite vec0 queries.
  if (pendingVectorLookups.length > 0 && isVectorEnabled()) {
    // Build a dedup map to avoid searching the same token multiple times
    const tokenToResult = new Map<string, { symbolId: string; distance: number } | null>();
    for (const pending of pendingVectorLookups) {
      if (!tokenToResult.has(pending.normalized)) {
        tokenToResult.set(pending.normalized, null); // placeholder
      }
    }
    // Single pass: one vector search per unique token (not per edge)
    for (const token of tokenToResult.keys()) {
      const vecResults = vectorSearchSymbols(db, repoId, token, 3);
      if (vecResults.length > 0 && vecResults[0].distance < 0.35) {
        tokenToResult.set(token, vecResults[0]);
      }
    }
    // Apply results back to edges
    for (const pending of pendingVectorLookups) {
      const result = tokenToResult.get(pending.normalized);
      if (result) {
        updates.push({ fromId: pending.fromId, oldToId: pending.oldToId, newToId: result.symbolId, confidence: 0.52, reason: "resolved callee vector-fallback" });
      } else {
        // No user-defined candidate AND no vector match — tag as external boundary
        updates.push({ fromId: pending.fromId, oldToId: pending.oldToId, newToId: pending.oldToId, confidence: 0.1, reason: "external boundary" });
      }
    }
  } else if (pendingVectorLookups.length > 0) {
    // Vector not enabled — tag all pending (no-candidate) items as external boundary
    for (const pending of pendingVectorLookups) {
      updates.push({ fromId: pending.fromId, oldToId: pending.oldToId, newToId: pending.oldToId, confidence: 0.1, reason: "external boundary" });
    }
  }

  if (updates.length === 0 && inserts.length === 0) return 0;

  // Phase 2: use temp table + single UPDATE JOIN for bulk resolution
  // This is dramatically faster than N individual UPDATE statements on large repos
  let count = 0;
  const { insertDispatchStmt } = ctx;

  db.exec(`
    create temp table if not exists _resolve_batch (
      from_id text not null,
      old_to_id text not null,
      new_to_id text not null,
      confidence real not null,
      reason text not null
    )
  `);
  // Ensure composite index on temp table for fast UPDATE JOIN matching
  db.exec(`create index if not exists _idx_resolve_batch on _resolve_batch(from_id, old_to_id)`);
  db.exec(`delete from _resolve_batch`);

  const insertBatch = db.prepare(
    `insert into _resolve_batch (from_id, old_to_id, new_to_id, confidence, reason) values (?, ?, ?, ?, ?)`
  );

  // Single transaction: fill temp table + UPDATE JOIN + dispatch inserts
  // Avoids multiple transaction open/close overhead on large batches
  const batchTx = db.transaction(() => {
    for (const u of updates) {
      insertBatch.run(u.fromId, u.oldToId, u.newToId, u.confidence, u.reason);
    }

    // Single UPDATE JOIN — resolves all rows in one statement
    const result = db.prepare(`
      update edges
      set
        to_id = b.new_to_id,
        confidence = b.confidence,
        reason = b.reason
      from _resolve_batch b
      where edges.repo_id = ?
        and edges.from_id = b.from_id
        and edges.to_id = b.old_to_id
        and edges.type = 'CALLS'
    `).run(repoId);
    count += result.changes;

    // Handle dispatch inserts in same transaction
    if (inserts.length > 0) {
      for (const ins of inserts) {
        const r = insertDispatchStmt.run(
          repoId, ins.fromId, ins.toId, ins.confidence, ins.reason,
          repoId, ins.fromId, ins.toId
        );
        if (r.changes > 0) count += 1;
      }
    }

    db.exec(`delete from _resolve_batch`);
  });
  batchTx();

  return count;
}

export function resolveCallEdges(db: Database.Database, repoId: string, maxUnresolvedRows = 0): number {
  // Find all CALLS edges with unresolved plain-text toId ("callee:<name>")
  // Join symbols to get the caller's file for same-file resolution priority
  // Filter only on to_id prefix — do NOT filter by reason.
  // 'qualified call' reason is set at extraction time while to_id is still a callee: placeholder.
  const unresolvedSql = `
    select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
    from edges e
    inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    where e.repo_id = ? and e.type = 'CALLS' and e.to_id like 'callee:%'
    ${maxUnresolvedRows > 0 ? "limit ?" : ""}
  `;
  const unresolved = db
    .prepare(unresolvedSql)
    .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
    fromId: string;
    toId: string;
    fromFile: string;
  }[];

  if (unresolved.length === 0) return 0;

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ?`
  );
  const insertDispatchStmt = db.prepare(
    `
    insert into edges (repo_id, from_id, to_id, type, confidence, reason)
    select ?, ?, ?, 'CALLS', ?, ?
    where not exists (
      select 1 from edges
      where repo_id = ? and from_id = ? and to_id = ? and type = 'CALLS'
    )
    `
  );

  // Pre-build interface lookup map: name → { symbolId, filePath }
  const interfaceRows = db
    .prepare(`select symbol_id as symbolId, name, file_path as filePath from symbols where repo_id = ? and kind = 'interface'`)
    .all(repoId) as { symbolId: string; name: string; filePath: string }[];
  const interfaceByName = new Map<string, { symbolId: string; filePath: string }>();
  const interfaceIdSet = new Set<string>();
  for (const r of interfaceRows) {
    if (!interfaceByName.has(r.name)) interfaceByName.set(r.name, { symbolId: r.symbolId, filePath: r.filePath });
    interfaceIdSet.add(r.symbolId);
  }

  // Pre-build implementor files map: interfaceSymbolId → filePath[]
  // record / record struct are class-like implementors too (ISSUE-013/ISSUE-022).
  const implEdgeRows = db
    .prepare(
      `select distinct e.to_id as ifaceId, s.file_path as filePath
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPLEMENTS' and s.kind in ('class', 'struct', 'record', 'record struct')`
    )
    .all(repoId) as { ifaceId: string; filePath: string }[];
  const implementorFilesByIfaceId = new Map<string, string[]>();
  for (const r of implEdgeRows) {
    const list = implementorFilesByIfaceId.get(r.ifaceId) ?? [];
    list.push(r.filePath);
    implementorFilesByIfaceId.set(r.ifaceId, list);
  }

  const candidateMap = buildNamedCandidateMap(db, repoId, ["function", "method", "constructor", "class"]);

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of unresolved) {
      const calleeName = row.toId.slice(7); // strip "callee:"
      let dispatchMethodName: string | null = null;
      let dispatchInterfaceId: string | null = null;
      let match = pickBestNamedCandidate(
        candidateMap.get(calleeName) ?? [],
        row.fromFile,
        ["function", "method", "constructor", "class"]
      );

      // For qualified calls like "IRepository.Save", resolve primary target to the
      // interface method first, then fan out lower-confidence edges to implementing methods.
      if (calleeName.includes(".")) {
        const parts = calleeName.split(".").filter((x) => x.length > 0);
        const receiverType = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
        const memberName = parts[parts.length - 1] ?? "";
        if (receiverType && memberName) {
          const iface = interfaceByName.get(receiverType);
          if (iface) {
            // Find the interface method via the candidateMap (already in memory)
            const ifaceMethod = (candidateMap.get(memberName) ?? []).find(
              (c) => c.filePath === iface.filePath && c.kind === "method"
            );
            if (ifaceMethod) {
              match = ifaceMethod;
              dispatchMethodName = memberName;
              dispatchInterfaceId = iface.symbolId;
            }
          }
        }
      }

      // Retry qualified placeholders like "TypeName.methodName" using terminal symbol name.
      if (!match && calleeName.includes(".")) {
        const baseName = calleeName.split(".").pop() ?? calleeName;
        match = pickBestNamedCandidate(
          candidateMap.get(baseName) ?? [],
          row.fromFile,
          ["function", "method", "constructor", "class"]
        );
      }

      // ISSUE-022 (Bug D): bare-name match landing on an interface's own method → fan out too.
      if (match && !dispatchMethodName && match.kind === "method" && match.parentSymbolId && interfaceIdSet.has(match.parentSymbolId)) {
        dispatchMethodName = calleeName.split(".").pop() ?? calleeName;
        dispatchInterfaceId = match.parentSymbolId;
      }

      if (match) {
        const confidence = dispatchMethodName
          ? (match.filePath === row.fromFile ? 0.9 : 0.8)
          : (match.filePath === row.fromFile ? 0.9 : 0.75);
        const reason = dispatchMethodName
          ? "resolved interface method"
          : (confidence >= 0.9 ? "resolved callee same-file" : "resolved callee by name");
        updateStmt.run(match.symbolId, confidence, reason, repoId, row.fromId, row.toId);
        count += 1;

        if (dispatchMethodName && dispatchInterfaceId) {
          const implementorFiles = (implementorFilesByIfaceId.get(dispatchInterfaceId) ?? []).slice(0, 10);
          for (const implFilePath of implementorFiles) {
            const implMethod = (candidateMap.get(dispatchMethodName) ?? []).find(
              (c) => c.filePath === implFilePath && c.kind === "method"
            );
            if (!implMethod || implMethod.symbolId === match.symbolId) {
              continue;
            }
            const insertResult = insertDispatchStmt.run(
              repoId,
              row.fromId,
              implMethod.symbolId,
              0.7,
              "interface-dispatch",
              repoId,
              row.fromId,
              implMethod.symbolId
            );
            if (insertResult.changes > 0) {
              count += 1;
            }
          }
        }
      } else {
        // No exact match — try external tagging then vector fallback
        const rawName = calleeName.split(".").pop() ?? calleeName;
        const normalized = stripGenerics(rawName);

        if (isKnownExternalToken(normalized)) {
          // Tag as external boundary — reduces unresolved noise
          updateStmt.run(row.toId, 0.1, "external boundary", repoId, row.fromId, row.toId);
        } else if (isVectorEnabled()) {
          // Vector fallback for internal symbols that didn't match exactly
          const vecResults = vectorSearchSymbols(db, repoId, normalized, 3);
          if (vecResults.length > 0 && vecResults[0].distance < 0.35) {
            updateStmt.run(vecResults[0].symbolId, 0.52, "resolved callee vector-fallback", repoId, row.fromId, row.toId);
            count += 1;
          }
        }
      }
    }
  });
  tx();

  return count;
}

export function resolveTypeRefEdges(db: Database.Database, repoId: string, maxUnresolvedRows = 0): number {
  const unresolvedSql = `
    select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
    from edges e
    inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    where e.repo_id = ? and e.type = 'TYPE_REF' and e.to_id like 'type:%'
    ${maxUnresolvedRows > 0 ? "limit ?" : ""}
  `;
  const unresolved = db
    .prepare(unresolvedSql)
    .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
    fromId: string;
    toId: string;
    fromFile: string;
  }[];

  if (unresolved.length === 0) return 0;

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ? and type = 'TYPE_REF'`
  );

  const candidateMap = buildNamedCandidateMap(db, repoId, ["class", "interface", "struct", "type"]);

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of unresolved) {
      const rawTypeName = row.toId.slice(5);
      const typeName = rawTypeName.split(".").pop() ?? rawTypeName;
      const match = pickBestNamedCandidate(
        candidateMap.get(typeName) ?? [],
        row.fromFile,
        ["class", "interface", "struct", "type"]
      );

      if (match) {
        const confidence = match.filePath === row.fromFile ? 0.9 : 0.75;
        const reason = confidence >= 0.9 ? "resolved type same-file" : "resolved type by name";
        updateStmt.run(match.symbolId, confidence, reason, repoId, row.fromId, row.toId);
        count += 1;
      } else {
        // Cross-repo fallback: look for the type in provider repos linked via nuget: DEPENDS_ON (ISSUE-006)
        const crossRepoMatch = findProviderSymbolByName(db, repoId, typeName);
        if (crossRepoMatch) {
          updateStmt.run(crossRepoMatch.symbolId, 0.65, "resolved type cross-repo", repoId, row.fromId, row.toId);
          count += 1;
        } else if (isVectorEnabled()) {
          // Vector fallback for internal types that didn't match exactly
          const vecResults = vectorSearchSymbols(db, repoId, typeName, 3);
          if (vecResults.length > 0 && vecResults[0].distance < 0.30) {
            updateStmt.run(vecResults[0].symbolId, 0.50, "resolved type vector-fallback", repoId, row.fromId, row.toId);
            count += 1;
          }
        }
      }
    }
  });
  tx();

  return count;
}

export function resolvePropertyEdges(db: Database.Database, repoId: string, maxUnresolvedRows = 0): number {
  const unresolvedSql = `
    select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile, e.type as edgeType
    from edges e
    inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    where e.repo_id = ? and e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id like 'property:%'
      and (e.reason is null or e.reason = 'unresolved property token')
    ${maxUnresolvedRows > 0 ? "limit ?" : ""}
  `;
  const unresolved = db
    .prepare(unresolvedSql)
    .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
    fromId: string;
    toId: string;
    fromFile: string;
    edgeType: "PROPERTY_REF" | "PROPERTY_WRITE";
  }[];

  if (unresolved.length === 0) return 0;

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ? and type = ?`
  );

  const propertyCandidates = buildNamedCandidateMap(db, repoId, ["property"]);
  // Method candidates: fallback for method-group references (e.g. _repo.FindByCondition used
  // without () — accessed as delegate/expression). Only used for PROPERTY_REF, not PROPERTY_WRITE.
  const methodCandidates = buildNamedCandidateMap(db, repoId, ["method", "function"]);
  const typeRows = db
    .prepare(
      `
      select name, file_path as filePath
      from symbols
      where repo_id = ? and kind in ('class', 'interface', 'struct', 'type')
      `
    )
    .all(repoId) as { name: string; filePath: string }[];

  const typeFilesByName = new Map<string, Set<string>>();
  for (const row of typeRows) {
    const list = typeFilesByName.get(row.name) ?? new Set<string>();
    list.add(row.filePath);
    typeFilesByName.set(row.name, list);
  }

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of unresolved) {
      const token = row.toId.slice("property:".length);
      const memberName = token.split(".").pop() ?? "";
      if (!memberName) {
        continue;
      }

      const rawTypeName = token.slice(0, Math.max(0, token.length - memberName.length - 1));
      const typeName = rawTypeName.split(".").pop() ?? rawTypeName;
      const namedCandidates = propertyCandidates.get(memberName) ?? [];
      if (namedCandidates.length === 0) {
        // No property symbol — try method candidates (method-group references like _repo.FindByCondition)
        // Only applicable to PROPERTY_REF (method groups), not PROPERTY_WRITE (assignment targets).
        if (row.edgeType === "PROPERTY_REF") {
          const methodCands = methodCandidates.get(memberName) ?? [];
          if (methodCands.length > 0) {
            // Apply type-constraint if available
            const constrained = (() => {
              if (!typeName) return methodCands;
              const files = typeFilesByName.get(typeName);
              if (!files || files.size === 0) return methodCands;
              const filtered = methodCands.filter((c) => files.has(c.filePath));
              return filtered.length > 0 ? filtered : methodCands;
            })();
            const match = pickBestNamedCandidate(constrained, row.fromFile, ["method", "function"]);
            if (match) {
              const sameFile = match.filePath === row.fromFile;
              updateStmt.run(match.symbolId, sameFile ? 0.80 : 0.68, "resolved method group", repoId, row.fromId, row.toId, row.edgeType);
              count += 1;
              continue;
            }
          }
        }
        // No user-defined property with this name — tag as external boundary
        // (framework/BCL token: Utc, UTF8, StoredProcedure, FindByCondition method groups, etc.)
        updateStmt.run(row.toId, 0.1, "external boundary", repoId, row.fromId, row.toId, row.edgeType);
        count += 1;
        continue;
      }

      // P1.3: Type-constrained candidates first
      const constrainedCandidates = (() => {
        if (!typeName) {
          return namedCandidates;
        }
        const files = typeFilesByName.get(typeName);
        if (!files || files.size === 0) {
          return namedCandidates;
        }
        const filtered = namedCandidates.filter((candidate) => files.has(candidate.filePath));
        return filtered.length > 0 ? filtered : namedCandidates;
      })();

      const match = pickBestNamedCandidate(constrainedCandidates, row.fromFile, ["property"]);
      if (match) {
        const sameFile = match.filePath === row.fromFile;
        const confidence = row.edgeType === "PROPERTY_WRITE"
          ? (sameFile ? 0.84 : 0.72)
          : (sameFile ? 0.88 : 0.75);
        const reason = sameFile ? "resolved property same-file" : "resolved property by name";
        updateStmt.run(match.symbolId, confidence, reason, repoId, row.fromId, row.toId, row.edgeType);
        count += 1;
        continue;
      }

      // P1.3: Ambiguity fallback — when pickBestNamedCandidate returns null (too many
      // candidates, no proximity winner), resolve with low confidence using folder proximity.
      // This avoids leaving high-volume tokens like property:Id permanently unresolved.
      if (constrainedCandidates.length > 0) {
        // Pick candidate whose file path shares the longest common prefix with fromFile
        const fromDir = row.fromFile.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
        let bestCandidate = constrainedCandidates[0];
        let bestScore = 0;
        for (const candidate of constrainedCandidates) {
          const candDir = candidate.filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
          // Count shared path segments
          const fromParts = fromDir.split("/");
          const candParts = candDir.split("/");
          let shared = 0;
          for (let i = 0; i < Math.min(fromParts.length, candParts.length); i++) {
            if (fromParts[i] === candParts[i]) shared++;
            else break;
          }
          if (shared > bestScore) {
            bestScore = shared;
            bestCandidate = candidate;
          }
        }
        // Only emit ambiguous resolution when there's at least some folder proximity
        // or when type-constrained to a single candidate
        if (bestScore > 0 || constrainedCandidates.length === 1) {
          const confidence = constrainedCandidates.length === 1 ? 0.6 : 0.5;
          const reason = constrainedCandidates.length === 1
            ? "resolved property single-candidate"
            : "resolved property ambiguous";
          updateStmt.run(bestCandidate.symbolId, confidence, reason, repoId, row.fromId, row.toId, row.edgeType);
          count += 1;
        }
      }
    }
  });
  tx();

  return count;
}

export function resolveImplementsEdges(db: Database.Database, repoId: string): number {
  const unresolved = db
    .prepare(
      `
      select distinct e.from_id as fromId, e.to_id as toId
      from edges e
      where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id like 'iface:%'
      `
    )
    .all(repoId) as { fromId: string; toId: string }[];

  if (unresolved.length === 0) return 0;

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ?
     where repo_id = ? and from_id = ? and to_id = ? and type = 'IMPLEMENTS'`
  );
  // Tag unresolvable iface: edges as external boundary (NuGet/framework interfaces not in source)
  const tagExternalStmt = db.prepare(
    `update edges set confidence = 0.1, reason = 'external boundary'
     where repo_id = ? and from_id = ? and to_id = ? and type = 'IMPLEMENTS'`
  );

  const interfaceNames = [...new Set(unresolved.map((row) => row.toId.slice(6)))];
  const namePlaceholders = interfaceNames.map(() => "?").join(",");
  const interfaceRows = interfaceNames.length === 0
    ? []
    : db
        .prepare(
          `
          select name, symbol_id as symbolId
          from symbols
          where repo_id = ? and kind = 'interface' and name in (${namePlaceholders})
          `
        )
        .all(repoId, ...interfaceNames) as { name: string; symbolId: string }[];

  const interfaceByName = new Map<string, string>();
  for (const row of interfaceRows) {
    if (!interfaceByName.has(row.name)) {
      interfaceByName.set(row.name, row.symbolId);
    }
  }

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of unresolved) {
      const ifaceName = row.toId.slice(6); // strip "iface:"
      const matchId = interfaceByName.get(ifaceName);

      if (matchId) {
        // Resolved to internal interface symbol
        updateStmt.run(matchId, 0.95, "base_list interface", repoId, row.fromId, row.toId);
        count += 1;
      } else {
        // Interface not found in repo symbols — likely external NuGet/framework interface.
        // Tag as external boundary so it is classified (not silently left as iface: placeholder).
        tagExternalStmt.run(repoId, row.fromId, row.toId);
      }
    }
  });
  tx();

  return count;
}

/**
 * ISSUE-020 — resolve message-bus PUBLISHES/CONSUMES edges by matching `contract:<T>` tokens
 * across the producer→consumer boundary that has no static CALLS edge.
 *
 * After this pass:
 *  - each PUBLISHES edge's `to_id` is rewritten from `contract:T` to the symbol of the type that
 *    CONSUMES the same contract (so trace_execution_flow can hop from publisher to consumer);
 *    a publisher with multiple consumers gets one resolved edge per consumer.
 *  - each CONSUMES edge's `to_id` is rewritten to the in-repo contract type symbol when present
 *    (so "who consumes contract X" is answerable).
 *  - contracts with no matching counterpart are tagged `external boundary` (consumed/published in
 *    another repo or an external service) rather than left as raw `contract:` placeholders.
 *
 * Matching is heuristic (by contract type name); this is a known coverage gap surfaced via the
 * ENH-C coverage block on the traversal tools.
 */
export function resolvePublishesConsumesEdges(db: Database.Database, repoId: string): number {
  const consumesRows = db
    .prepare(`select distinct from_id as fromId, to_id as toId from edges where repo_id = ? and type = 'CONSUMES' and to_id like 'contract:%'`)
    .all(repoId) as { fromId: string; toId: string }[];
  const publishesRows = db
    .prepare(`select distinct from_id as fromId, to_id as toId from edges where repo_id = ? and type = 'PUBLISHES' and to_id like 'contract:%'`)
    .all(repoId) as { fromId: string; toId: string }[];
  if (consumesRows.length === 0 && publishesRows.length === 0) return 0;

  // contract name → consumer type symbol ids (from_id of CONSUMES edges)
  const consumersByContract = new Map<string, Set<string>>();
  for (const r of consumesRows) {
    const contract = r.toId.slice("contract:".length);
    const set = consumersByContract.get(contract) ?? new Set<string>();
    set.add(r.fromId);
    consumersByContract.set(contract, set);
  }

  // Resolve in-repo contract type symbols by name (for CONSUMES → contract type).
  const contractNames = [...new Set([...consumesRows, ...publishesRows].map((r) => r.toId.slice("contract:".length)))];
  const contractSymbolByName = new Map<string, string>();
  if (contractNames.length > 0) {
    const ph = contractNames.map(() => "?").join(",");
    const rows = db
      .prepare(`select name, symbol_id as symbolId from symbols where repo_id = ? and kind in ('class','struct','record','record struct','interface') and name in (${ph})`)
      .all(repoId, ...contractNames) as { name: string; symbolId: string }[];
    for (const r of rows) if (!contractSymbolByName.has(r.name)) contractSymbolByName.set(r.name, r.symbolId);
  }

  const updatePub = db.prepare(`update or ignore edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ? and type = 'PUBLISHES'`);
  const insertPub = db.prepare(`insert or ignore into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, 'PUBLISHES', ?, ?)`);
  const tagExternalPub = db.prepare(`update edges set confidence = 0.1, reason = 'external boundary' where repo_id = ? and from_id = ? and to_id = ? and type = 'PUBLISHES'`);
  const updateCon = db.prepare(`update or ignore edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ? and type = 'CONSUMES'`);
  const tagExternalCon = db.prepare(`update edges set confidence = 0.1, reason = 'external boundary' where repo_id = ? and from_id = ? and to_id = ? and type = 'CONSUMES'`);

  let count = 0;
  const tx = db.transaction(() => {
    // CONSUMES → contract type symbol (or external)
    for (const r of consumesRows) {
      const contract = r.toId.slice("contract:".length);
      const sym = contractSymbolByName.get(contract);
      if (sym && sym !== r.fromId) updateCon.run(sym, 0.9, "message contract type", repoId, r.fromId, r.toId);
      else tagExternalCon.run(repoId, r.fromId, r.toId);
    }
    // PUBLISHES → consumer symbol(s) (or external when no consumer indexed)
    for (const r of publishesRows) {
      const contract = r.toId.slice("contract:".length);
      const consumers = [...(consumersByContract.get(contract) ?? [])].filter((c) => c !== r.fromId);
      if (consumers.length === 0) {
        tagExternalPub.run(repoId, r.fromId, r.toId);
        continue;
      }
      updatePub.run(consumers[0], 0.7, "message bus contract match", repoId, r.fromId, r.toId);
      count += 1;
      for (let i = 1; i < consumers.length; i++) {
        insertPub.run(repoId, r.fromId, consumers[i], 0.7, "message bus contract match");
        count += 1;
      }
    }
  });
  tx();

  return count;
}
