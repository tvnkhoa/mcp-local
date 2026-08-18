/**
 * Resolution state and candidate picking, shared by every edge type: the stats accumulator, the named-candidate map, and `resolveUnlinkedEdges`.
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
import { normalizeFilePath } from "./moduleResolution.js";

/**
 * Bulk-tag all import edges whose namespace belongs to a known external namespace (System, Microsoft, etc.)
 * as "external boundary" with confidence 0.1. Runs without row LIMIT so external imports are always tagged
 * regardless of batch size or maxUnresolvedRows policy.
 */
export function tagExternalNamespaceImports(db: Database.Database, repoId: string): number {
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

export function buildNamedCandidateMap(
  db: Database.Database,
  repoId: string,
  allowedKinds?: readonly string[]
): Map<string, { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null }[]> {
  // ORDER BY, even though nothing here reads the rows in order directly: the per-name lists built below
  // are consumed by `pickBestNamedCandidate`, which keeps the FIRST candidate at the minimum score. Two
  // same-named types in different files score identically, so list order silently decided the winner —
  // and this map feeds CALLS, TYPE_REF and PROPERTY_REF resolution alike, which is why one missing
  // ORDER BY showed up as drift across three edge types at once.
  const rows = allowedKinds && allowedKinds.length > 0
    ? db
        .prepare(
          `select symbol_id as symbolId, name, file_path as filePath, kind, parent_symbol_id as parentSymbolId
           from symbols
           where repo_id = ? and kind in (${allowedKinds.map(() => "?").join(", ")})
           order by name, symbol_id`
        )
        .all(repoId, ...allowedKinds) as { symbolId: string; name: string; filePath: string; kind: string; parentSymbolId: string | null }[]
    : db
        .prepare(
          `select symbol_id as symbolId, name, file_path as filePath, kind, parent_symbol_id as parentSymbolId
           from symbols
           where repo_id = ?
           order by name, symbol_id`
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

export function pickBestNamedCandidate<T extends { symbolId: string; filePath: string; kind: string }>(
  candidates: T[],
  fromFile: string,
  kindPriority: readonly string[],
  /**
   * Repo files `fromFile` imports. A candidate living in one of them outranks a same-named symbol
   * anywhere else in the repo, which is the difference between "the function this file actually
   * calls" and "whichever same-named function sorted first".
   *
   * The concrete failure this fixes: `src/index.ts` calls `numberFromEnv`, declared in both
   * `src/config/envConfig.ts` (imported) and `scripts/benchmark-plan-mode.mjs` (not imported). With
   * only the same-file test the two tied, and the tie-break on `symbolId` picked the benchmark
   * script — a wrong edge, reported with full confidence.
   */
  importedFiles?: ReadonlySet<string>
): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const rank = new Map(kindPriority.map((kind, index) => [kind, index]));
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    // `symbols.file_path` keeps whatever separator `path.relative` produced, which is a backslash on
    // Windows, while the imported-file set is normalized to forward slashes like every other path the
    // server reports. Comparing them raw silently never matches — and a scoping tier that never fires
    // looks exactly like one that is not helping.
    const sameFilePenalty =
      candidate.filePath === fromFile
        ? 0
        : importedFiles?.has(normalizeFilePath(candidate.filePath))
          ? 25
          : 100;
    const kindPenalty = rank.get(candidate.kind) ?? 999;
    const score = sameFilePenalty + kindPenalty;
    // Ties are common — two same-named classes in different files score identically — and `score <
    // bestScore` alone resolved them by input order. Every caller now orders its query, but relying on
    // that leaves the next caller free to reintroduce the bug; breaking the tie on symbolId here makes
    // the function's result a property of its arguments rather than of their arrangement.
    if (score < bestScore || (score === bestScore && candidate.symbolId < best.symbolId)) {
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
        -- MCP-ISSUE-048: these four are also placeholders owned by dedicated resolvers, and omitting
        -- them let them flood the 5000-row window below. On a full run the graph is full of freshly
        -- extracted 'type:'/'iface:' tokens, so the window was spent almost entirely on tokens that
        -- cannot cross a repo boundary (8 links from 521 files), while a 3-file dirty run — whose
        -- graph was still resolved from the previous run — found 459. Same corpus, 57x the links,
        -- purely from which rows the sample happened to contain.
        and e.to_id not like 'type:%'
        and e.to_id not like 'iface:%'
        and e.to_id not like 'property:%'
        and e.to_id not like 'base:%'
        and not exists (
          select 1 from symbols s where s.repo_id = ? and s.symbol_id = e.to_id
        )
      -- See MCP-ISSUE-032: a LIMIT without ORDER BY samples arbitrarily, so which 5000 unlinked
      -- edges get a bridge attempt varied between identical runs.
      order by e.from_id, e.to_id, e.type
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
