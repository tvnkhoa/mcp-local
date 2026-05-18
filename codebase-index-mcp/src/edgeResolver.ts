import type Database from "better-sqlite3";
import type { ResolutionStats } from "./types.js";
import { findProviderSymbolByName } from "./crossRepoStore.js";
import {
  isKnownExternalToken,
  isKnownExternalNamespace,
  stripGenerics,
  vectorSearchSymbols,
  isVectorEnabled,
} from "./vectorStore.js";

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
): Map<string, { symbolId: string; filePath: string; kind: string }[]> {
  const rows = allowedKinds && allowedKinds.length > 0
    ? db
        .prepare(
          `select symbol_id as symbolId, name, file_path as filePath, kind
           from symbols
           where repo_id = ? and kind in (${allowedKinds.map(() => "?").join(", ")})`
        )
        .all(repoId, ...allowedKinds) as { symbolId: string; name: string; filePath: string; kind: string }[]
    : db
        .prepare(
          `select symbol_id as symbolId, name, file_path as filePath, kind
           from symbols
           where repo_id = ?`
        )
        .all(repoId) as { symbolId: string; name: string; filePath: string; kind: string }[];

  const byName = new Map<string, { symbolId: string; filePath: string; kind: string }[]>();
  for (const row of rows) {
    const list = byName.get(row.name) ?? [];
    list.push({ symbolId: row.symbolId, filePath: row.filePath, kind: row.kind });
    byName.set(row.name, list);
  }
  return byName;
}

function pickBestNamedCandidate(
  candidates: { symbolId: string; filePath: string; kind: string }[],
  fromFile: string,
  kindPriority: readonly string[]
): { symbolId: string; filePath: string; kind: string } | undefined {
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

  const tx = db.transaction(() => {
    for (const row of unlinked) {
      stats.attempts += 1;
      const candidates = candidatesByToId.get(row.toId) ?? [];
      if (candidates.length === 0) {
        stats.unresolvedByReason.no_candidate += 1;
        continue;
      }
      if (candidates.length > 1) {
        stats.unresolvedByReason.ambiguous_candidates += 1;
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
  // Find all IMPORTS edges with unresolved plain-text toId ("import:<path>")
  const unresolvedSql = `
    select distinct e.from_id as fromId, e.to_id as toId, sf.file_path as fromFile
    from edges e
    inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
    where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id like 'import:%'
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
      const importPath = row.toId.slice(7); // strip "import:"
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

        importResolveCache.set(cacheKey, matchedModuleId ?? null);
        if (matchedModuleId) {
          updateStmt.run(matchedModuleId, 0.8, "resolved csharp namespace", repoId, row.fromId, row.toId);
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

  return count;
}

export function resolveCallEdges(db: Database.Database, repoId: string, maxUnresolvedRows = 0): number {
  // Find all CALLS edges with unresolved plain-text toId ("callee:<name>")
  // Join symbols to get the caller's file for same-file resolution priority
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
  for (const r of interfaceRows) {
    if (!interfaceByName.has(r.name)) interfaceByName.set(r.name, { symbolId: r.symbolId, filePath: r.filePath });
  }

  // Pre-build implementor files map: interfaceSymbolId → filePath[]
  const implEdgeRows = db
    .prepare(
      `select distinct e.to_id as ifaceId, s.file_path as filePath
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPLEMENTS' and s.kind in ('class', 'struct')`
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
              match = { symbolId: ifaceMethod.symbolId, filePath: iface.filePath, kind: "method" };
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
          const implementorFiles = implementorFilesByIfaceId.get(dispatchInterfaceId) ?? [];
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
              0.65,
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
    `update edges set to_id = ? where repo_id = ? and from_id = ? and to_id = ? and type = 'IMPLEMENTS'`
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
        updateStmt.run(matchId, repoId, row.fromId, row.toId);
        count += 1;
      }
    }
  });
  tx();

  return count;
}
