/**
 * CALLS edges — the batched resolver, its context object, and the vector-lookup fallback. The largest of the five and the only one that consults the vector store.
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
