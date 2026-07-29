/**
 * TYPE_REF and PROPERTY_REF/PROPERTY_WRITE edges: the reference kinds resolved after extraction.
 *
 * Split out of `edgeResolver.ts` in S-41 (it was 1424 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { ResolutionStats } from "../types.js";
import { findProviderSymbolByName } from "../store/crossRepoStore.js";
import {
  isKnownExternalToken,
  isKnownExternalNamespace,
  isKnownCrossRepoNamespace,
  stripGenerics,
  vectorSearchSymbols,
  isVectorEnabled,
} from "../store/vectorStore.js";
import { buildNamedCandidateMap, pickBestNamedCandidate } from "./edgeResolverShared.js";

export function resolveTypeRefEdges(db: Database.Database, repoId: string, maxUnresolvedRows = 0): number {
  const unresolvedSql = `
    select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
    from edges e
    inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    where e.repo_id = ? and e.type = 'TYPE_REF' and e.to_id like 'type:%'
    -- ORDER BY is load-bearing, not cosmetic: with a LIMIT and no ordering, SQLite may return any
    -- N of the qualifying rows, so resolution ran over an arbitrary sample and two identical runs
    -- resolved different edges. The key must fully disambiguate, or the sort is arbitrary again.
    -- MCP-ISSUE-032.
    order by e.from_id, e.to_id, s.file_path
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

  /**
   * Memoized fallback lookup, keyed by type name.
   *
   * Both fallbacks below — the cross-repo provider search and the vector similarity search — depend
   * only on the type name, so the same answer was being recomputed for every occurrence. The primary
   * `pickBestNamedCandidate` match is deliberately NOT memoized: it takes `row.fromFile` to prefer a
   * same-file declaration, so it is genuinely per-row.
   *
   * This matters because of which rows reach here. MCP-ISSUE-034 raised unresolved TYPE_REF rows from
   * 110 to ~3200, and the overwhelming majority are framework types (`Task`, `CancellationToken`,
   * `ILogger`, `IServiceCollection`) that will never resolve — so they always fall through to the
   * expensive path, and they are also the names that repeat most. On `wec.communication-hub` that took
   * `typeResolveMs` from 5214 to 111950. Distinct names are a few hundred against a few thousand rows.
   */
  const fallbackCache = new Map<string, { symbolId: string; confidence: number; reason: string } | null>();

  function resolveFallback(typeName: string): { symbolId: string; confidence: number; reason: string } | null {
    const cached = fallbackCache.get(typeName);
    if (cached !== undefined) {
      return cached;
    }

    let result: { symbolId: string; confidence: number; reason: string } | null = null;

    // Cross-repo fallback: look for the type in provider repos linked via nuget: DEPENDS_ON (ISSUE-006)
    const crossRepoMatch = findProviderSymbolByName(db, repoId, typeName);
    if (crossRepoMatch) {
      result = { symbolId: crossRepoMatch.symbolId, confidence: 0.65, reason: "resolved type cross-repo" };
    } else if (isVectorEnabled()) {
      // Vector fallback for internal types that didn't match exactly
      const vecResults = vectorSearchSymbols(db, repoId, typeName, 3);
      if (vecResults.length > 0 && vecResults[0].distance < 0.30) {
        result = { symbolId: vecResults[0].symbolId, confidence: 0.5, reason: "resolved type vector-fallback" };
      }
    }

    fallbackCache.set(typeName, result);
    return result;
  }

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
        const fallback = resolveFallback(typeName);
        if (fallback) {
          updateStmt.run(fallback.symbolId, fallback.confidence, fallback.reason, repoId, row.fromId, row.toId);
          count += 1;
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
    -- ORDER BY is load-bearing, not cosmetic: with a LIMIT and no ordering, SQLite may return any
    -- N of the qualifying rows, so resolution ran over an arbitrary sample and two identical runs
    -- resolved different edges. The key must fully disambiguate, or the sort is arbitrary again.
    -- MCP-ISSUE-032.
    order by e.from_id, e.to_id, e.type, s.file_path
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
