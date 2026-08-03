/**
 * IMPLEMENTS, PUBLISHES and CONSUMES edges — the contract-level links that cross a class hierarchy or a message bus.
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

/**
 * Fan out a call on an `abstract`/`virtual` base member to the overrides in its subclasses
 * (MCP-ISSUE-037) — the class-inheritance counterpart of `interface-dispatch`.
 *
 * **Runs as its own pass over ALREADY-RESOLVED CALLS edges, and that placement is the whole reason this
 * works.** The first attempt lived inside `resolveCallEdgesBatch`, alongside interface dispatch, and
 * produced nothing: the template-method shape has the base calling its own abstract member *in the same
 * file*, so `resolveIntraFileEdges` links it at EXTRACTION time and the edge never appears among the
 * unresolved `callee:` rows the batch resolver iterates. Hooking into the unresolved lane means missing
 * exactly the case this exists for.
 *
 * Reading final CALLS edges instead covers both shapes uniformly — the intra-file link and the
 * cross-file one the batch resolver produces — and needs no knowledge of which phase created the edge.
 */
/**
 * Composite key for the (file, member) override map.
 *
 * A shared function, not two template literals, because building the key inline once with a NUL separator
 * and once with a space made every lookup miss — silently, since a Map returns undefined rather than
 * complaining. The pass reported 0 edges and the only visible symptom was three tests failing. `\u0000` is
 * written as an escape so the separator is legible in source; typed literally it is invisible and turns the
 * file binary to grep.
 */
function overrideKey(filePath: string, memberName: string): string {
  return `${filePath}\u0000${memberName}`;
}

export function resolveBaseClassDispatch(db: Database.Database, repoId: string): number {
  // Capped like interface dispatch: past a point the edges are noise, and a base class with 200
  // subclasses would otherwise multiply every call on it.
  const MAX_SUBCLASS_DISPATCH_FANOUT = 10;

  const virtualCalls = db
    .prepare(
      // The `abstract `/`virtual ` test is on the stored signature. A modifier is always followed by a
      // return type, so the trailing space keeps `abstractPath` and `virtually` from matching. A dedicated
      // modifier column would be sturdier but needs a schema change and a full re-index of every repo.
      `
      select distinct e.from_id as fromId, s.symbol_id as baseMethodId, s.name as memberName,
             s.parent_symbol_id as baseTypeId
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.to_id
      where e.repo_id = ?
        and e.type = 'CALLS'
        and s.kind = 'method'
        and s.parent_symbol_id is not null
        and s.signature is not null
        and (s.signature like '%abstract %' or s.signature like '%virtual %')
      order by e.from_id, s.symbol_id
      `
    )
    .all(repoId) as { fromId: string; baseMethodId: string; memberName: string; baseTypeId: string }[];

  if (virtualCalls.length === 0) return 0;

  const subclassRows = db
    .prepare(
      // Only resolved EXTENDS rows: one still holding a `base:` token is a framework base with nothing
      // in-repo to dispatch to. Ordered before the cap, or which subclasses survive it would be arbitrary
      // and vary between runs (MCP-ISSUE-032).
      `
      select distinct e.to_id as baseId, s.file_path as filePath
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'EXTENDS' and e.to_id not like 'base:%'
        and s.kind in ('class', 'struct', 'record', 'record struct')
      order by e.to_id, s.file_path
      `
    )
    .all(repoId) as { baseId: string; filePath: string }[];

  if (subclassRows.length === 0) return 0;

  const subclassFilesByBaseId = new Map<string, string[]>();
  for (const r of subclassRows) {
    const list = subclassFilesByBaseId.get(r.baseId) ?? [];
    list.push(r.filePath);
    subclassFilesByBaseId.set(r.baseId, list);
  }

  // Every override in the repo, loaded ONCE and keyed by (file, name).
  //
  // This was a `select ... where file_path = ? and name = ? and signature like '%override %'` executed
  // inside the loop below, and the shape is why it was catastrophic: `like '%override %'` cannot use an
  // index, so each call scanned the repo's symbols. On `wec.be` that meant 175 virtual calls x up to 10
  // subclass files = ~1750 scans of 67980 rows — **56851ms to produce 19 edges**. One scan replaces all of
  // them, and the loop becomes in-memory lookups.
  //
  // `override ` is required, not merely preferred. Without it a `new`/shadow method of the same name would
  // be treated as an override, attributing the call to code that cannot run — and for `dead_code_scan` a
  // false "live" hides real dead code, the one direction of error it cannot afford.
  const overrideByFileAndName = new Map<string, string>();
  for (const row of db
    .prepare(
      `select symbol_id as symbolId, file_path as filePath, name from symbols
       where repo_id = ? and kind = 'method' and signature is not null and signature like '%override %'
       order by file_path, name, symbol_id`
    )
    .all(repoId) as { symbolId: string; filePath: string; name: string }[]) {
    // First wins, and the ORDER BY makes "first" the same every run. C# permits overloads, so one
    // (file, name) can hold several overrides; picking a stable one keeps the graph reproducible
    // (MCP-ISSUE-032) even though it cannot distinguish overloads by signature.
    const key = overrideKey(row.filePath, row.name);
    if (!overrideByFileAndName.has(key)) overrideByFileAndName.set(key, row.symbolId);
  }
  if (overrideByFileAndName.size === 0) return 0;
  const insertStmt = db.prepare(
    `insert or ignore into edges (repo_id, from_id, to_id, type, confidence, reason)
     values (?, ?, ?, 'CALLS', 0.7, 'base-class-dispatch')`
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const call of virtualCalls) {
      const files = (subclassFilesByBaseId.get(call.baseTypeId) ?? []).slice(0, MAX_SUBCLASS_DISPATCH_FANOUT);
      for (const filePath of files) {
        const overrideId = overrideByFileAndName.get(overrideKey(filePath, call.memberName));
        if (overrideId === undefined || overrideId === call.baseMethodId) continue;
        const override = { symbolId: overrideId };
        // The base's own edge is left untouched: the fan-out ADDS reachability rather than moving it.
        // Moving it would trade one false "dead" for another.
        insertStmt.run(repoId, call.fromId, override.symbolId);
        count += 1;
      }
    }
  });
  tx();

  return count;
}

/**
 * Resolve `base:Name` tokens to the base class symbol (MCP-ISSUE-037).
 *
 * Kept separate from `resolveImplementsEdges` rather than generalised over both token prefixes, because
 * the two differ in a way that matters downstream: an unresolvable interface is an external contract and a
 * legitimate end state, while an unresolvable base class means the hierarchy simply stops there and no
 * dispatch fan-out is possible. Same tagging, different meaning, and collapsing them would hide which one
 * a given edge is.
 */
export function resolveExtendsEdges(db: Database.Database, repoId: string): number {
  const unresolved = db
    .prepare(
      `
      select distinct e.from_id as fromId, e.to_id as toId
      from edges e
      where e.repo_id = ? and e.type = 'EXTENDS' and e.to_id like 'base:%'
      order by e.from_id, e.to_id
      `
    )
    .all(repoId) as { fromId: string; toId: string }[];

  if (unresolved.length === 0) return 0;

  const baseNames = [...new Set(unresolved.map((row) => row.toId.slice("base:".length)))];
  const placeholders = baseNames.map(() => "?").join(",");
  const rows = db
    .prepare(
      // Ordered for the same first-row-wins reason as the interface lookup below: two files can declare
      // the same class name, and unordered the winner moved between runs (MCP-ISSUE-032).
      `
      select name, symbol_id as symbolId
      from symbols
      where repo_id = ? and kind in ('class', 'struct', 'record', 'record struct') and name in (${placeholders})
      order by name, symbol_id
      `
    )
    .all(repoId, ...baseNames) as { name: string; symbolId: string }[];

  const baseByName = new Map<string, string>();
  for (const row of rows) {
    if (!baseByName.has(row.name)) baseByName.set(row.name, row.symbolId);
  }

  const updateStmt = db.prepare(
    `update or ignore edges set to_id = ?, confidence = ?, reason = ?
     where repo_id = ? and from_id = ? and to_id = ? and type = 'EXTENDS'`
  );
  const tagExternalStmt = db.prepare(
    `update edges set confidence = 0.1, reason = 'external boundary'
     where repo_id = ? and from_id = ? and to_id = ? and type = 'EXTENDS'`
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of unresolved) {
      const match = baseByName.get(row.toId.slice("base:".length));
      if (match && match !== row.fromId) {
        // `update or ignore`: a partial class listing the same base twice, or two base-list entries
        // collapsing to one symbol, would otherwise violate the unique index and abort the transaction.
        updateStmt.run(match, 0.95, "base_list class", repoId, row.fromId, row.toId);
        count += 1;
      } else {
        // A framework base — ControllerBase, DbContext, BackgroundService. Tagged rather than left as a
        // raw token so it is classified, matching how unresolvable interfaces are handled.
        tagExternalStmt.run(repoId, row.fromId, row.toId);
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
