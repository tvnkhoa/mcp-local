/**
 * CALLS edges — the batched resolver, its context object, and the vector-lookup fallback. The largest of the five and the only one that consults the vector store.
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
import { buildNamedCandidateMap, pickBestNamedCandidate } from "./edgeResolverShared.js";
import { buildImportedFilesByFile, normalizeFilePath } from "./moduleResolution.js";
import { indexWarn } from "../indexing/indexProgress.js";

/**
 * How many fruitless vector lookups to tolerate before concluding the lane cannot pay on this repo.
 *
 * 100 x ~31ms is about 3 seconds of probing — enough to find a hit if hits exist (they cluster, since a
 * near-miss token usually has several siblings), cheap enough that being wrong costs little.
 */
const VECTOR_PROBE_SIZE = 100;

/**
 * The two `reason` labels that mean "this target came from the callee's NAME alone, across files".
 *
 * Named because MCP-ISSUE-052's suppression keys off exactly this population: a same-file match or a
 * receiver-typed match is evidence, a cross-file name match is a guess, and only a guess may be
 * overruled by a qualified sibling.
 */
const NAME_ONLY_REASON = "resolved callee by name";
const NAME_ONLY_AMBIGUOUS_REASON = "resolved callee by name (ambiguous)";
const NAME_ONLY_REASONS: ReadonlySet<string> = new Set([NAME_ONLY_REASON, NAME_ONLY_AMBIGUOUS_REASON]);

/** Marks the bare half of a qualified call site that a qualified sibling has already answered. */
const SUPERSEDED_REASON = "superseded by qualified call";

export interface CallResolutionContext {
  candidateMap: Map<string, { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null }[]>;
  interfaceByName: Map<string, { symbolId: string; filePath: string }>;
  /** ISSUE-022: symbolIds của mọi interface — detect bare-name match trúng interface method để fan-out. */
  interfaceIdSet: Set<string>;
  implementorFilesByIfaceId: Map<string, string[]>;
  /**
   * MCP-ISSUE-037: subclass files per base-class symbolId — the class-inheritance counterpart of
   * `implementorFilesByIfaceId`. Populated from resolved `EXTENDS` edges.
   */
  subclassFilesByBaseId: Map<string, string[]>;
  /**
   * symbolIds of methods declared `abstract` or `virtual`.
   *
   * The gate that makes class fan-out safe. A non-virtual base method is NOT overridden, so a same-named
   * method in a subclass is a `new`/shadow declaration and an entirely different method — fanning out to
   * it would attribute a call to code that never runs, which is exactly the misattribution class of
   * MCP-ISSUE-036. Interface members need no such gate because every interface member is dispatchable by
   * definition.
   */
  virtualMethodIds: Set<string>;
  updateStmt: Statement;
  insertDispatchStmt: Statement;
  /** All unresolved rows pre-fetched once — sliced per batch in memory */
  unresolvedRows: { fromId: string; toId: string; fromFile: string }[];
  /** Current offset into unresolvedRows for batching */
  offset: number;
  /**
   * Adaptive cutoff for the vector fallback, carried across batches.
   *
   * The lane is expensive and, on some repos, worthless. Measured on `wec.communication-hub`: 968 distinct
   * tokens reach it, each KNN costs ~31ms, and **zero** clear the `distance < 0.35` gate — 30 seconds of
   * the resolve phase producing not one edge. Confirmed by differencing a full run with
   * `CODEBASE_INDEX_VECTOR_ENABLED` on and off: byte-identical CALLS reasons, 11331 rows tagged
   * `external boundary` either way.
   *
   * Rather than disable the lane (it can pay on a repo whose unresolved tokens are in-repo near-misses) or
   * leave it unbounded, it measures itself: after `VECTOR_PROBE_SIZE` lookups with no hit, it stops. The
   * capability survives where it works; the waste is capped at a few seconds where it does not.
   */
  vectorProbe: { attempted: number; hits: number; abandoned: boolean };
  /**
   * Per-file set of repo files that file imports, used to scope name candidates.
   *
   * Built from the raw `import:<specifier>` tokens, not from resolved IMPORTS edges: call
   * resolution runs BEFORE import resolution in the post-index phase, so reading resolved edges
   * here would see an empty map on every full index.
   */
  importedFilesByFile: Map<string, Set<string>>;
}

/**
 * Pre-build all lookup maps needed for call edge resolution.
 * Call this ONCE before batched resolveCallEdgesBatch() calls.
 */
export function buildCallResolutionContext(db: Database.Database, repoId: string): CallResolutionContext {
  const importedFilesByFile = buildImportedFilesByFile(db, repoId);
  const interfaceRows = db
    // `interfaceByName` keeps the first row per name, so ordering decides which declaration of a
    // duplicated interface name wins.
    .prepare(`select symbol_id as symbolId, name, file_path as filePath from symbols where repo_id = ? and kind = 'interface' order by name, symbol_id`)
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
      // This feeds `implementorFilesByIfaceId`, which is capped by MAX_INTERFACE_DISPATCH_FANOUT at the
      // point of use. Unordered, an interface with more implementors than the cap contributed a
      // different arbitrary subset each run — the largest single source of run-to-run edge drift, at 99
      // of the 120 edges that appeared in one run and not the next.
      `select distinct e.to_id as ifaceId, s.file_path as filePath
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPLEMENTS' and s.kind in ('class', 'struct', 'record', 'record struct')
       order by e.to_id, s.file_path`
    )
    .all(repoId) as { ifaceId: string; filePath: string }[];
  const implementorFilesByIfaceId = new Map<string, string[]>();
  for (const r of implEdgeRows) {
    const list = implementorFilesByIfaceId.get(r.ifaceId) ?? [];
    list.push(r.filePath);
    implementorFilesByIfaceId.set(r.ifaceId, list);
  }

  // MCP-ISSUE-037: the class-inheritance mirror of the two structures above. `EXTENDS` is resolved before
  // this runs, so `to_id` is a real class symbolId; rows still holding a `base:` token are framework bases
  // with nothing in-repo to dispatch to, and the `not like` excludes them rather than mapping them to
  // nothing silently.
  const extendsRows = db
    .prepare(
      `select distinct e.to_id as baseId, s.file_path as filePath
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'EXTENDS' and e.to_id not like 'base:%'
         and s.kind in ('class', 'struct', 'record', 'record struct')
       order by e.to_id, s.file_path`
    )
    .all(repoId) as { baseId: string; filePath: string }[];
  const subclassFilesByBaseId = new Map<string, string[]>();
  for (const r of extendsRows) {
    const list = subclassFilesByBaseId.get(r.baseId) ?? [];
    list.push(r.filePath);
    subclassFilesByBaseId.set(r.baseId, list);
  }

  // Read off the stored signature. A dedicated modifier column would be sturdier than a string test, but
  // it needs a schema change plus a full re-index of every repo, and the signature is already captured
  // verbatim — `protected abstract SentMessageInfo GetMessageInfo(TContract message);`. The trailing space
  // in each pattern is deliberate: a modifier is always followed by a return type, so it keeps
  // `abstractPath` and `virtually` from matching.
  const virtualMethodIds = new Set<string>(
    (
      db
        .prepare(
          `select symbol_id as symbolId from symbols
           where repo_id = ? and kind = 'method' and signature is not null
             and (signature like '%abstract %' or signature like '%virtual %')
           order by symbol_id`
        )
        .all(repoId) as { symbolId: string }[]
    ).map((r) => r.symbolId)
  );

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
      // Ordered because these rows are sliced into batches by `offset`, so row order determines batch
      // membership — and the dispatch insert is `where not exists`, making the outcome order-sensitive.
      `select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = @repoId and e.type = 'CALLS' and e.to_id like 'callee:%'
         -- MCP-ISSUE-052 durability (code review 2026-08-10): a suppressed bare edge is DEMOTED, not
         -- deleted, so it keeps its callee: token and matched the LIKE above on every later run.
         -- Call resolution runs repo-wide even on incremental runs, and by then the qualified sibling
         -- is already resolved, so it is absent from this set: provenByCaller has no proof, the guard
         -- cannot fire, and the bare edge was re-resolved to the wrong same-named method at
         -- confidence 0.75. One unrelated file touched was enough to undo the fix. The
         -- "superseded by qualified call" marker was written and never read; reading it here is what
         -- makes the suppression stick. Re-indexing the caller own file clears it the right way:
         -- deleteEdgesForFile drops the row and extraction re-emits it without the marker.
         and coalesce(e.reason, '') != @supersededReason
       order by e.from_id, e.to_id`
    )
    .all({ repoId, supersededReason: SUPERSEDED_REASON }) as { fromId: string; toId: string; fromFile: string }[];

  return { candidateMap, interfaceByName, interfaceIdSet, implementorFilesByIfaceId, subclassFilesByBaseId, virtualMethodIds, updateStmt, insertDispatchStmt, unresolvedRows, offset: 0, vectorProbe: { attempted: 0, hits: 0, abandoned: false }, importedFilesByFile };
}

export type ResolvedUpdate = { fromId: string; oldToId: string; newToId: string; confidence: number; reason: string };

/**
 * MCP-ISSUE-052 — drop the bare half of a qualified call site once the qualified half has answered it.
 *
 * The C# extractor emits BOTH tokens for one call site: `callee:Parse` and
 * `callee:ConversationLoopCorrelationCodec.Parse` (`csharpSymbols.ts`, the "simple + qualified" pair).
 * That was safe only while both resolved to the same symbol, because the unique index on
 * `edges(repo_id, from_id, to_id, type)` then collapsed them into one row — which is exactly what the
 * MCP-ISSUE-036 note observed.
 *
 * MCP-ISSUE-036 then taught the qualified token to follow its receiver. The qualified half now lands on
 * the right method while the bare half still goes through `pickBestNamedCandidate` and picks whichever
 * same-named method wins the heuristic. Two different `to_id` values, nothing collapses, and the caller
 * ends up with one correct edge plus one wrong one — the wrong one seeding entire traversals at
 * `confidence: "high"`.
 *
 * The bare edge is suppressed only when all three hold, which is what keeps a genuine same-named local
 * call from being lost:
 *   1. a qualified sibling `X.M` from the SAME caller resolved to a real symbol,
 *   2. the bare edge resolved by name ACROSS files — a same-file or receiver-typed match is evidence
 *      and is left alone,
 *   3. the two disagree about the target.
 *
 * Suppressed edges are demoted rather than deleted: `to_id` returns to its placeholder with
 * `confidence: 0.1`, the same shape as an external-boundary row, so the audit trail survives and
 * MCP-ISSUE-053's unresolved filter hides it from `edgesOut` / `topCallees`.
 */
export function suppressBareCallsShadowedByQualified(updates: ResolvedUpdate[]): number {
  // fromId → member name → the symbolIds a qualified token proved for that member
  const provenByCaller = new Map<string, Map<string, Set<string>>>();
  for (const u of updates) {
    if (!u.oldToId.startsWith("callee:")) continue;
    const token = u.oldToId.slice(7);
    if (!token.includes(".")) continue;
    // Still a placeholder — the qualified token did not resolve, so it proves nothing.
    if (u.newToId === u.oldToId) continue;
    const member = token.split(".").pop() ?? "";
    if (!member) continue;
    let byMember = provenByCaller.get(u.fromId);
    if (!byMember) {
      byMember = new Map<string, Set<string>>();
      provenByCaller.set(u.fromId, byMember);
    }
    const ids = byMember.get(member) ?? new Set<string>();
    ids.add(u.newToId);
    byMember.set(member, ids);
  }
  if (provenByCaller.size === 0) return 0;

  let suppressed = 0;
  for (const u of updates) {
    if (!u.oldToId.startsWith("callee:")) continue;
    const token = u.oldToId.slice(7);
    if (token.includes(".")) continue;
    if (u.newToId === u.oldToId) continue;
    if (!NAME_ONLY_REASONS.has(u.reason)) continue;
    const proven = provenByCaller.get(u.fromId)?.get(token);
    if (!proven || proven.has(u.newToId)) continue;
    u.newToId = u.oldToId;
    u.confidence = 0.1;
    u.reason = SUPERSEDED_REASON;
    suppressed++;
  }
  return suppressed;
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
  batchSize: number,
  /**
   * Optional side-channel for the two populations that are NOT resolutions of the attempted set:
   * rows touched by the UPDATE (a pair can be several rows) and dispatch edges newly inserted.
   * Kept out of the return value so `callEdgesResolved` stays a partition of `callEdgesAttempted`
   * (MCP-ISSUE-048).
   */
  stats?: { rowsUpdated: number; dispatchInserted: number }
): number {
  // MCP-ISSUE-052: never split one caller across two batches. The bare/qualified pairing at the end
  // of this function needs every row of a `from_id` in the same pass, and the pre-fetch is ordered by
  // `from_id`, so extending to the end of the caller that straddles the boundary is enough.
  let batchEnd = Math.min(ctx.offset + batchSize, ctx.unresolvedRows.length);
  const boundaryFromId = ctx.unresolvedRows[batchEnd - 1]?.fromId;
  while (batchEnd < ctx.unresolvedRows.length && ctx.unresolvedRows[batchEnd].fromId === boundaryFromId) {
    batchEnd++;
  }
  const batch = ctx.unresolvedRows.slice(ctx.offset, batchEnd);
  ctx.offset = batchEnd;

  if (batch.length === 0) return 0;

  const { candidateMap, interfaceByName, interfaceIdSet, implementorFilesByIfaceId } = ctx;
  // ISSUE-022: cap fan-out per call-site — MediatR-style interfaces can have hundreds of
  // implementors; beyond this the dispatch edges are noise, not signal.
  const MAX_INTERFACE_DISPATCH_FANOUT = 10;

  // Phase 1: resolve all rows in memory → collect updates and inserts
  type InsertRow = { fromId: string; toId: string; confidence: number; reason: string };
  type PendingVectorLookup = { fromId: string; oldToId: string; normalized: string };
  const updates: ResolvedUpdate[] = [];
  const inserts: InsertRow[] = [];
  const pendingVectorLookups: PendingVectorLookup[] = [];

  for (const row of batch) {
    const calleeName = row.toId.slice(7);
    let dispatchMethodName: string | null = null;
    let dispatchInterfaceId: string | null = null;
    // MCP-ISSUE-052: HOW the match was obtained, not just what it is. The receiver-as-class branch
    // added by MCP-ISSUE-036 shared the "resolved callee by name" label with the name-only fallback,
    // so a correct receiver-typed edge and a blind name guess were indistinguishable in `reason` —
    // which is why the consumer report concluded that branch had never fired when in fact it had.
    let matchVia: "name" | "receiver_type" = "name";
    // Whether the name that produced the match had more than one candidate. A single-candidate name
    // is a safe guess; a multi-candidate one is a coin flip that must say so.
    const directCandidates = candidateMap.get(calleeName) ?? [];
    let nameAmbiguous = directCandidates.length > 1;
    const importedFiles = ctx.importedFilesByFile.get(normalizeFilePath(row.fromFile));
    let match = pickBestNamedCandidate(
      directCandidates,
      row.fromFile,
      ["function", "method", "constructor", "class"],
      importedFiles
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

    // The receiver is a CLASS, not an interface — `CrossChannelReplyHelpers.ResolveSubject(...)`, the
    // ordinary static-helper call. The block above only consults `interfaceByName`, so this fell through
    // to the name-only fallback below, which discards the receiver entirely.
    //
    // Discarding it is not merely imprecise, it attributes the call to the WRONG method. Two classes can
    // hold a same-named static helper — `ActivityCursor.EncodeCursor` and a private `EncodeCursor` in
    // `GetInboxConversations`, both real in this repo — and the name-only lookup picks one winner for
    // both. Every call then lands on that winner, the other symbol shows zero incoming calls, and
    // `dead_code_scan` reports a method with nine call sites as dead. Worse, the extractor emits the
    // qualified token AND the bare one, which resolve to the same symbol and collapse under the unique
    // index, so the count does not even hint that something was lost.
    if (!match && calleeName.includes(".")) {
      const parts = calleeName.split(".").filter((x) => x.length > 0);
      const receiverType = parts.slice(0, -1).join(".");
      const memberName = parts[parts.length - 1] ?? "";
      const ownerClass = (candidateMap.get(receiverType) ?? []).find((c) => c.kind === "class");
      if (ownerClass && memberName) {
        const members = candidateMap.get(memberName) ?? [];
        // parent linkage first; file identity as the fallback, because symbols indexed before
        // parent_symbol_id existed carry no parent and would otherwise silently miss.
        match =
          members.find((c) => c.kind === "method" && c.parentSymbolId === ownerClass.symbolId) ??
          members.find((c) => c.kind === "method" && c.filePath === ownerClass.filePath);
        // The owner was PROVEN from the receiver, not guessed from a name — record that, and stop
        // an earlier multi-candidate reading from labelling this edge ambiguous.
        if (match) {
          matchVia = "receiver_type";
          nameAmbiguous = false;
        }
      }
    }

    if (!match && calleeName.includes(".")) {
      const baseName = calleeName.split(".").pop() ?? calleeName;
      const baseCandidates = candidateMap.get(baseName) ?? [];
      nameAmbiguous = baseCandidates.length > 1;
      match = pickBestNamedCandidate(
        baseCandidates,
        row.fromFile,
        ["function", "method", "constructor", "class"],
        importedFiles
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
      const sameFile = match.filePath === row.fromFile;
      // A receiver-typed match outranks a name guess: the owner came from `parent_symbol_id`, so it
      // is knowledge rather than a heuristic — but it stays below a same-file match, which needs no
      // cross-file inference at all.
      const confidence = dispatchMethodName
        ? (sameFile ? 0.9 : 0.8)
        : matchVia === "receiver_type"
          ? (sameFile ? 0.9 : 0.85)
          : (sameFile ? 0.9 : 0.75);
      const reason = dispatchMethodName
        ? "resolved interface method"
        : matchVia === "receiver_type"
          ? "resolved callee by receiver type"
          : sameFile
            ? "resolved callee same-file"
            : nameAmbiguous
              ? NAME_ONLY_AMBIGUOUS_REASON
              : NAME_ONLY_REASON;
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
      // The adaptive cutoff. `abandoned` persists across batches via ctx, so a repo whose vector lane
      // pays nothing stops paying after the probe rather than once per batch.
      if (ctx.vectorProbe.abandoned) break;
      const vecResults = vectorSearchSymbols(db, repoId, token, 3);
      ctx.vectorProbe.attempted += 1;
      if (vecResults.length > 0 && vecResults[0].distance < 0.35) {
        ctx.vectorProbe.hits += 1;
        tokenToResult.set(token, vecResults[0]);
      }
      if (ctx.vectorProbe.hits === 0 && ctx.vectorProbe.attempted >= VECTOR_PROBE_SIZE) {
        ctx.vectorProbe.abandoned = true;
        // Warn, not log: a capability switching itself off is exactly the kind of silent degradation that
        // produced MCP-ISSUE-038, so it has to be visible in the default quiet mode.
        indexWarn(
          `[index-resolve] vector fallback abandoned for ${repoId}: ${String(VECTOR_PROBE_SIZE)} lookups, 0 matches under the confidence gate. ` +
            `Remaining unresolved callees are tagged external boundary without a vector attempt.`
        );
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

  // MCP-ISSUE-052: runs after the vector lane so it sees every resolution this caller produced.
  // Batch boundaries are extended above so a caller's bare and qualified rows are never split.
  suppressBareCallsShadowedByQualified(updates);

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
    // MCP-ISSUE-048: count PAIRS, not rows. The attempted population is `select distinct from_id,
    // to_id`, but this UPDATE rewrites every row matching a pair — and `edges` has no unique index, so
    // one pair can be several rows. Returning `result.changes` made "resolved" exceed "attempted",
    // which drove resolveCallsCoverage above 1.0 and made attempted−resolved go negative.
    count += updates.length;
    if (stats) stats.rowsUpdated += result.changes;

    // Handle dispatch inserts in same transaction
    if (inserts.length > 0) {
      for (const ins of inserts) {
        const r = insertDispatchStmt.run(
          repoId, ins.fromId, ins.toId, ins.confidence, ins.reason,
          repoId, ins.fromId, ins.toId
        );
        // NOT added to `count`: a dispatch edge is newly created, never part of the attempted
        // population, so counting it as a resolution broke the partition.
        if (r.changes > 0 && stats) stats.dispatchInserted += 1;
      }
    }

    db.exec(`delete from _resolve_batch`);
  });
  batchTx();

  return count;
}
