/**
 * IMPLEMENTS, PUBLISHES and CONSUMES edges — the contract-level links that cross a class hierarchy or a message bus.
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

export function resolveImplementsEdges(db: Database.Database, repoId: string): number {
  const unresolved = db
    .prepare(
      `
      select distinct e.from_id as fromId, e.to_id as toId
      from edges e
      where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id like 'iface:%'
      order by e.from_id, e.to_id
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
          // ORDER BY is load-bearing because of the `if (!has(name))` first-row-wins below: two files
          // can declare the same interface name, and unordered, "first" was whichever row SQLite
          // happened to hand back. The IMPLEMENTS edge then pointed at a different declaration between
          // runs — and since `to_id` is part of the edge identity, `update or ignore` sometimes
          // collapsed two edges into one and sometimes did not, moving the total.
          `
          select name, symbol_id as symbolId
          from symbols
          where repo_id = ? and kind = 'interface' and name in (${namePlaceholders})
          order by name, symbol_id
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
  // Ordered because these row sets seed `consumersByContract` below, and its per-contract Set therefore
  // inherits their order — which `consumers[0]` then treats as a ranking.
  const consumesRows = db
    .prepare(`select distinct from_id as fromId, to_id as toId from edges where repo_id = ? and type = 'CONSUMES' and to_id like 'contract:%' order by from_id, to_id`)
    .all(repoId) as { fromId: string; toId: string }[];
  const publishesRows = db
    .prepare(`select distinct from_id as fromId, to_id as toId from edges where repo_id = ? and type = 'PUBLISHES' and to_id like 'contract:%' order by from_id, to_id`)
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
      // Same first-row-wins hazard as the interface lookup above: a contract name declared in more than
      // one place resolved to a different symbol per run.
      .prepare(`select name, symbol_id as symbolId from symbols where repo_id = ? and kind in ('class','struct','record','record struct','interface') and name in (${ph}) order by name, symbol_id`)
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
      // Sorted explicitly, not left to Set insertion order. `consumers[0]` is privileged — it UPDATEs the
      // existing edge while the rest are INSERTed — so which consumer lands first decides the edge's
      // identity, and Set order came from a query whose ordering was never guaranteed.
      const consumers = [...(consumersByContract.get(contract) ?? [])].filter((c) => c !== r.fromId).sort();
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
