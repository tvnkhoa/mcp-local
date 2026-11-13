/**
 * CALLS edges — the batched resolver and its context object. The largest of the five.
 *
 * Release J removed the vector (nearest-name) fallback this lane had for tokens with no named candidate.
 * Every edge it had written was a guess, nearly all into test files (wec.aria 47, ssnet 329, mcp-local
 * 199, this repo 105, wec.be 12 — MCP-ISSUE-084), and its probe stopped after 100 fruitless lookups, so
 * which tokens it reached depended on which rows a run resolved. Such a token is an external boundary.
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
} from "../../repositories/vectorStore.js";
import { buildNamedCandidateMap, pickBestNamedCandidate } from "./edgeResolverShared.js";
import { buildImportedFilesByFile, isPythonFile, normalizeFilePath, pythonImportedFilesForName } from "./moduleResolution.js";
import { immediateTransaction } from "../../repositories/sqliteTx.js";

/**
 * The two `reason` labels that mean "this target came from the callee's NAME alone, across files".
 *
 * Named because MCP-ISSUE-052's suppression keys off exactly this population: a same-file match or a
 * receiver-typed match is evidence, a cross-file name match is a guess, and only a guess may be
 * overruled by a qualified sibling.
 */
const NAME_ONLY_REASON = "resolved callee by name";
const NAME_ONLY_AMBIGUOUS_REASON = "resolved callee by name (ambiguous)";
/**
 * MCP-ISSUE-060: the interface relabel below can fire on a match that came from a bare NAME lookup,
 * where the receiver was never proven. Those edges must not borrow the proven label's credibility —
 * same distinction `resolved property by name (unproven owner)` already draws for MCP-ISSUE-052.
 */
const INTERFACE_METHOD_REASON = "resolved interface method";
const INTERFACE_METHOD_UNPROVEN_REASON = "resolved interface method (unproven receiver)";
const NAME_ONLY_REASONS: ReadonlySet<string> = new Set([NAME_ONLY_REASON, NAME_ONLY_AMBIGUOUS_REASON]);

/** PY-6: `obj.m()` whose receiver no rule typed, bound to a method named `m` by name alone (confidence 0.6). */
const PYTHON_UNTYPED_RECEIVER_REASON = "resolved callee by name (untyped receiver)";

/** PY-7: a test or fixture parameter bound to the fixture of that name in the nearest enclosing conftest.py. */
const PYTEST_FIXTURE_REASON = "resolved pytest fixture (nearest conftest)";
const PYTEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/i;

function isPytestFile(filePath: string): boolean {
  return PYTEST_FILE.test(normalizeFilePath(filePath));
}

/** The function of this name in the conftest.py nearest to `fromFile` up its directory tree (its own directory first). */
export function nearestConftestDefinition<T extends { filePath: string; kind: string }>(candidates: readonly T[], fromFile: string): T | undefined {
  const fromDir = normalizeFilePath(fromFile).replace(/\/?[^/]*$/, "");
  let best: T | undefined;
  let bestDepth = -1;
  for (const c of candidates) {
    if (c.kind !== "function") continue;
    const path = normalizeFilePath(c.filePath);
    const m = /^(?:(.*)\/)?conftest\.py$/i.exec(path);
    if (!m) continue;
    const dir = m[1] ?? "";
    if (dir !== "" && fromDir !== dir && !fromDir.startsWith(`${dir}/`)) continue;
    const depth = dir === "" ? 0 : dir.split("/").length;
    if (depth > bestDepth) {
      best = c;
      bestDepth = depth;
    }
  }
  return best;
}

/** Marks the bare half of a qualified call site that a qualified sibling has already answered. */
const SUPERSEDED_REASON = "superseded by qualified call";

export interface CallResolutionContext {
  candidateMap: Map<string, { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null }[]>;
  interfaceByName: Map<string, { symbolId: string; filePath: string }>;
  /**
   * PY-5c: every Python Protocol (kind `interface` in a .py / .pyi file) per name. A Python caller picks its
   * Protocol here like any other name — same file, then a file it imports, then the tie-break — instead of
   * taking `interfaceByName`'s first row by path repo-wide.
   */
  pythonInterfacesByName: Map<string, NamedCandidate[]>;
  /** ISSUE-022: symbolIds của mọi interface — detect bare-name match trúng interface method để fan-out. */
  interfaceIdSet: Set<string>;
  /**
   * MCP-ISSUE-037: subclass files per base-class symbolId — the class-inheritance counterpart of
   * the implementor map `rebuildInterfaceDispatchEdges` builds. Populated from resolved `EXTENDS` edges.
   */
  subclassFilesByBaseId: Map<string, string[]>;
  /** PY-3: base classes per Python class symbolId, in base-list order (`buildPythonBases`), for a member lookup up the chain. */
  basesByClassId: Map<string, string[]>;
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
  /** All unresolved rows pre-fetched once — sliced per batch in memory */
  unresolvedRows: { fromId: string; toId: string; fromFile: string }[];
  /** Current offset into unresolvedRows for batching */
  offset: number;
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
    .prepare(`select symbol_id as symbolId, name, file_path as filePath from symbols where repo_id = ? and kind = 'interface' order by name, file_path, symbol_id`)
    .all(repoId) as { symbolId: string; name: string; filePath: string }[];
  const interfaceByName = new Map<string, { symbolId: string; filePath: string }>();
  const interfaceIdSet = new Set<string>();
  const pythonInterfacesByName = new Map<string, NamedCandidate[]>();
  for (const r of interfaceRows) {
    if (!interfaceByName.has(r.name)) interfaceByName.set(r.name, { symbolId: r.symbolId, filePath: r.filePath });
    interfaceIdSet.add(r.symbolId);
    if (!isPythonFile(r.filePath)) continue;
    const candidate: NamedCandidate = { symbolId: r.symbolId, filePath: r.filePath, kind: "interface", parentSymbolId: null };
    const list = pythonInterfacesByName.get(r.name);
    if (list) list.push(candidate);
    else pythonInterfacesByName.set(r.name, [candidate]);
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
  const basesByClassId = buildPythonBases(db, repoId, candidateMap, importedFilesByFile);

  const updateStmt = db.prepare(
    `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ?`
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

  return { candidateMap, interfaceByName, pythonInterfacesByName, interfaceIdSet, subclassFilesByBaseId, basesByClassId, virtualMethodIds, updateStmt, unresolvedRows, offset: 0, importedFilesByFile };
}

/**
 * PY-3: each Python class's bases, in base-list order, as class symbolIds.
 *
 * Built from the base NAME, never from the EXTENDS row's resolution state: `resolveExtendsEdges` runs after
 * call resolution, so a full run sees `base:Name` tokens here while a scoped run sees the rows of unchanged
 * files already resolved — reading the resolved ids would let the two runs walk different chains. Each name
 * is bound with the call lane's own picker from the subclass's file (same file, imported, tie-break).
 * Order: a class's EXTENDS rows are written together in extraction order and a resolve only updates them,
 * so the first rowid per (class, base) is its position in the list on full and scoped runs alike.
 */
function buildPythonBases(
  db: Database.Database,
  repoId: string,
  candidateMap: CallResolutionContext["candidateMap"],
  importedFilesByFile: Map<string, Set<string>>
): Map<string, string[]> {
  const rows = db
    .prepare(
      `select e.from_id as classId, s.file_path as classFile, e.to_id as toId, t.name as toName, min(e.rowid) as pos
       from edges e
       join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
       where e.repo_id = ? and e.type = 'EXTENDS' and s.kind in ('class', 'interface')
         and (s.file_path like '%.py' or s.file_path like '%.pyi')
       group by e.from_id, e.to_id
       order by e.from_id, pos`
    )
    .all(repoId) as { classId: string; classFile: string; toId: string; toName: string | null; pos: number }[];
  // PY-5 review: a Protocol is kind `interface`, which the candidate map does not hold — without these a
  // class listing a Protocol base lost the Protocol's default methods from its lookup chain.
  const protocolsByName = new Map<string, NamedCandidate[]>();
  for (const p of db
    .prepare(
      `select symbol_id as symbolId, name, file_path as filePath, kind, parent_symbol_id as parentSymbolId from symbols
       where repo_id = ? and kind = 'interface' and (file_path like '%.py' or file_path like '%.pyi')
       order by name, file_path, symbol_id`
    )
    .all(repoId) as (NamedCandidate & { name: string })[]) {
    const list = protocolsByName.get(p.name);
    if (list) list.push(p);
    else protocolsByName.set(p.name, [p]);
  }
  const bases = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.toId.startsWith("base:") ? r.toId.slice(5) : r.toName;
    if (!name) continue;
    const classes = [...pythonLookupFor(candidateMap).classes(name), ...(protocolsByName.get(name) ?? [])].filter((c) => c.symbolId !== r.classId);
    const base = pickBestNamedCandidate(classes, r.classFile, ["class", "interface"], pythonImportedFilesForName(importedFilesByFile, normalizeFilePath(r.classFile), name));
    if (!base) continue;
    const list = bases.get(r.classId);
    if (!list) bases.set(r.classId, [base.symbolId]);
    else if (!list.includes(base.symbolId)) list.push(base.symbolId);
  }
  return bases;
}

type NamedCandidate = { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null };

/**
 * Per-name views of one candidate map, built on first use and kept for as long as the map lives (one
 * resolution context). Without them every dotted Python call site re-filtered the full candidate list of its
 * owner and member names — near-quadratic for `__init__` / `get` / `run` on a large repo.
 */
const pythonLookups = new WeakMap<
  CallResolutionContext["candidateMap"],
  { classes: (name: string) => NamedCandidate[]; methodsByParent: (name: string) => Map<string, NamedCandidate> }
>();

function pythonLookupFor(candidateMap: CallResolutionContext["candidateMap"]) {
  let lookup = pythonLookups.get(candidateMap);
  if (!lookup) {
    const classesByName = new Map<string, NamedCandidate[]>();
    const methodsByName = new Map<string, Map<string, NamedCandidate>>();
    lookup = {
      classes: (name) => {
        let list = classesByName.get(name);
        if (!list) {
          list = (candidateMap.get(name) ?? []).filter((c) => c.kind === "class");
          classesByName.set(name, list);
        }
        return list;
      },
      methodsByParent: (name) => {
        let byParent = methodsByName.get(name);
        if (!byParent) {
          byParent = new Map<string, NamedCandidate>();
          // First per parent in candidate order — what `find` over the list returned.
          for (const c of candidateMap.get(name) ?? []) {
            if (c.kind === "method" && c.parentSymbolId && !byParent.has(c.parentSymbolId)) byParent.set(c.parentSymbolId, c);
          }
          methodsByName.set(name, byParent);
        }
        return byParent;
      }
    };
    pythonLookups.set(candidateMap, lookup);
  }
  return lookup;
}

/** How many classes a Python member lookup visits up an inheritance chain before giving up. */
const MAX_PYTHON_MRO_CLASSES = 16;

/**
 * PY-3: `Owner.member` for a Python caller. The owner is the class named `Owner` the caller can see
 * (same file, then an imported file, then the tie-break), and the member the method of that name declared
 * on it or — breadth-first, in base-list order, like a simple MRO — on one of its resolved bases.
 * Undefined when the owner is not a repo class or no class on the chain declares the member.
 */
export function resolvePythonQualifiedCall(
  ctx: Pick<CallResolutionContext, "candidateMap" | "basesByClassId">,
  calleeName: string,
  fromFile: string,
  importedFiles: ReadonlySet<string> | undefined
): { symbolId: string; filePath: string; kind: string; parentSymbolId: string | null } | undefined {
  const dot = calleeName.lastIndexOf(".");
  const ownerName = calleeName.slice(0, dot);
  const memberName = calleeName.slice(dot + 1);
  if (!ownerName || !memberName) return undefined;
  const lookup = pythonLookupFor(ctx.candidateMap);
  const owner = pickBestNamedCandidate(lookup.classes(ownerName), fromFile, ["class"], importedFiles);
  if (!owner) return undefined;
  const members = lookup.methodsByParent(memberName);
  if (members.size === 0) return undefined;
  return pythonMemberOnChain(members, ctx.basesByClassId, owner.symbolId);
}

/**
 * The member declared on `classId` or — breadth-first, in base-list order, like a simple MRO — on one of its
 * resolved in-repo bases (classes and Protocols). `members` is one name's methods keyed by owner id.
 */
function pythonMemberOnChain<T>(members: ReadonlyMap<string, T>, basesByClassId: ReadonlyMap<string, string[]>, classId: string): T | undefined {
  const queue = [classId];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < MAX_PYTHON_MRO_CLASSES) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const hit = members.get(next);
    if (hit) return hit;
    queue.push(...(basesByClassId.get(next) ?? []));
  }
  return undefined;
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

  const { candidateMap, interfaceByName, interfaceIdSet } = ctx;

  // Phase 1: resolve all rows in memory → collect updates
  const updates: ResolvedUpdate[] = [];
  // Tokens with no named candidate, tagged external boundary after the loop (their order in `updates`
  // is unchanged from when they waited here for the vector fallback release J removed).
  const noCandidate: { fromId: string; oldToId: string }[] = [];

  for (const row of batch) {
    const calleeName = row.toId.slice(7);
    let dispatchMethodName: string | null = null;
    /**
     * MCP-ISSUE-060: HOW the interface was arrived at. `receiver_type` means extraction handed us
     * the receiver and it named an interface. `name` means we matched a bare method name and only
     * afterwards noticed the winner happened to sit on an interface — a guess wearing a proof's label.
     */
    let dispatchVia: "receiver_type" | "name" = "receiver_type";
    // MCP-ISSUE-052: HOW the match was obtained, not just what it is. The receiver-as-class branch
    // added by MCP-ISSUE-036 shared the "resolved callee by name" label with the name-only fallback,
    // so a correct receiver-typed edge and a blind name guess were indistinguishable in `reason` —
    // which is why the consumer report concluded that branch had never fired when in fact it had.
    let matchVia: "name" | "receiver_type" = "name";
    // Whether the name that produced the match had more than one candidate. A single-candidate name
    // is a safe guess; a multi-candidate one is a coin flip that must say so.
    const directCandidates = candidateMap.get(calleeName) ?? [];
    let nameAmbiguous = directCandidates.length > 1;
    // PY-8b: a Python file's star-imported scope is narrowed to the modules that export the name it binds —
    // the bare callee, or the owner of `Owner.member`.
    const importedFiles = isPythonFile(row.fromFile)
      ? pythonImportedFilesForName(ctx.importedFilesByFile, normalizeFilePath(row.fromFile), calleeName.split(".")[0] ?? calleeName)
      : ctx.importedFilesByFile.get(normalizeFilePath(row.fromFile));
    let match = pickBestNamedCandidate(
      directCandidates,
      row.fromFile,
      ["function", "method", "constructor", "class"],
      importedFiles
    );

    // PY-7 (G3): pytest hands a test (or fixture) its fixture by PARAMETER NAME, from the nearest conftest.py
    // up the test's directory tree. The generic pick has no notion of that tree, so a fixture name defined in
    // two conftests went to whichever sorted first. A same-file definition or one the file imports still wins.
    let pytestFixture = false;
    if (!calleeName.includes(".") && isPytestFile(row.fromFile) && !(match && (match.filePath === row.fromFile || importedFiles?.has(normalizeFilePath(match.filePath))))) {
      const fixture = nearestConftestDefinition(directCandidates, row.fromFile);
      if (fixture) {
        match = fixture;
        matchVia = "receiver_type";
        nameAmbiguous = false;
        pytestFixture = true;
      }
    }

    if (calleeName.includes(".")) {
      const parts = calleeName.split(".").filter((x) => x.length > 0);
      const receiverType = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
      const memberName = parts[parts.length - 1] ?? "";
      if (receiverType && memberName) {
        // PY-5c: a Python caller's Protocol is the one it can see, not the first of that name by path.
        const iface = isPythonFile(row.fromFile)
          ? pickBestNamedCandidate(ctx.pythonInterfacesByName.get(receiverType) ?? [], row.fromFile, ["interface"], importedFiles)
          : interfaceByName.get(receiverType);
        if (iface) {
          const memberCandidates = candidateMap.get(memberName) ?? [];
          // PY-5 review: a Python file often holds a Protocol and a class with the same method name
          // (`Executor.close` beside `Store.close`); the file match alone picked whichever id sorted first.
          // The owner link decides for Python; C# keeps the file match unchanged.
          const ifaceMethod =
            (isPythonFile(iface.filePath)
              ? memberCandidates.find((c) => c.kind === "method" && c.parentSymbolId === iface.symbolId)
              : undefined) ??
            memberCandidates.find((c) => c.filePath === iface.filePath && c.kind === "method");
          if (ifaceMethod) {
            match = ifaceMethod;
            dispatchMethodName = memberName;
          }
        }
      }
    }

    // PY-3: a Python `callee:Owner.member` token names its owner class only when the extractor PROVED it
    // (`self.` / `cls.` / `super()`, a typed parameter, `x = Owner(...)`, a class imported or defined in the
    // file). So the owner is looked up among classes the caller can see, the member on that class and then
    // up its resolved EXTENDS chain — and when either is missing the call is an external boundary, never a
    // guess by the member name alone: `super().__init__()` over a pydantic base would otherwise bind to
    // whichever `__init__` in the repo sorts first.
    let pythonReceiverProven = false;
    if (!match && calleeName.includes(".") && isPythonFile(row.fromFile)) {
      pythonReceiverProven = true;
      const proven = resolvePythonQualifiedCall(ctx, calleeName, row.fromFile, importedFiles);
      if (proven) {
        match = proven;
        matchVia = "receiver_type";
        nameAmbiguous = false;
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
    if (!match && !pythonReceiverProven && calleeName.includes(".")) {
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

    if (!match && !pythonReceiverProven && calleeName.includes(".")) {
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
    // PY-6: not for a Python bare token — its receiver was untyped, so it stays a flagged candidate below
    // instead of fanning a name guess out to every Protocol implementer.
    if (match && !dispatchMethodName && match.kind === "method" && match.parentSymbolId && interfaceIdSet.has(match.parentSymbolId) &&
        !(isPythonFile(row.fromFile) && !calleeName.includes("."))) {
      dispatchMethodName = calleeName.split(".").pop() ?? calleeName;
      // MCP-ISSUE-060: `match` here came from a name lookup, not from a proven receiver. Measured on
      // `wec.be`: 986 of 2070 `resolved interface method` edges targeted a method name declared by two
      // or more DIFFERENT interfaces (`CreateAsync` by 35 of them), and every one of those was labelled
      // as proven at 0.8 because the ternary below tested `dispatchMethodName` before `nameAmbiguous`,
      // making the ambiguity branch unreachable. That is how `EmailOnAcidService.GetListClientAsync`
      // acquired a confident CALLS edge into `ISmsConversationService.GetAsync`.
      dispatchVia = matchVia === "receiver_type" ? "receiver_type" : "name";
    }

    if (match) {
      const sameFile = match.filePath === row.fromFile;
      // A receiver-typed match outranks a name guess: the owner came from `parent_symbol_id`, so it
      // is knowledge rather than a heuristic — but it stays below a same-file match, which needs no
      // cross-file inference at all.
      const confidence = dispatchMethodName
        ? dispatchVia === "receiver_type"
          ? (sameFile ? 0.9 : 0.8)
          // An unproven receiver is a name guess that landed on an interface. It keeps the interface
          // fan-out (ISSUE-022 Bug D still wants those implementations reached) but not the credibility.
          : (sameFile ? 0.9 : nameAmbiguous ? 0.7 : 0.75)
        : matchVia === "receiver_type"
          ? (sameFile ? 0.9 : 0.85)
          : (sameFile ? 0.9 : 0.75);
      const reason = pytestFixture
        ? PYTEST_FIXTURE_REASON
        : dispatchMethodName
        ? dispatchVia === "receiver_type"
          ? INTERFACE_METHOD_REASON
          : INTERFACE_METHOD_UNPROVEN_REASON
        : matchVia === "receiver_type"
          ? "resolved callee by receiver type"
          : sameFile
            ? "resolved callee same-file"
            : nameAmbiguous
              ? NAME_ONLY_AMBIGUOUS_REASON
              : NAME_ONLY_REASON;
      // PY-6: a Python bare token never names a method unless the receiver was unknown (`self.` / typed
      // receivers arrive qualified), so a bare-name hit on a method is a candidate, not a proof: below 0.7.
      const untypedPythonReceiver =
        !pytestFixture && !dispatchMethodName && matchVia === "name" && match.kind === "method" &&
        !calleeName.includes(".") && isPythonFile(row.fromFile);
      updates.push({
        fromId: row.fromId,
        oldToId: row.toId,
        newToId: match.symbolId,
        confidence: untypedPythonReceiver ? 0.6 : confidence,
        reason: untypedPythonReceiver ? PYTHON_UNTYPED_RECEIVER_REASON : reason
      });

      // Release L (MCP-ISSUE-094): the interface-dispatch fan-out is no longer written here. It is rebuilt
      // whole by `rebuildInterfaceDispatchEdges` after IMPLEMENTS resolution, from the edges this call wrote.

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
        noCandidate.push({ fromId: row.fromId, oldToId: row.toId });
      }
    }
  }

  for (const pending of noCandidate) {
    updates.push({ fromId: pending.fromId, oldToId: pending.oldToId, newToId: pending.oldToId, confidence: 0.1, reason: "external boundary" });
  }

  // MCP-ISSUE-052: runs last so it sees every resolution this caller produced.
  // Batch boundaries are extended above so a caller's bare and qualified rows are never split.
  suppressBareCallsShadowedByQualified(updates);

  if (updates.length === 0) return 0;

  // Phase 2: use temp table + single UPDATE JOIN for bulk resolution
  // This is dramatically faster than N individual UPDATE statements on large repos
  let count = 0;

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

  // Single transaction: fill temp table + UPDATE JOIN
  // Avoids multiple transaction open/close overhead on large batches
  const batchTx = immediateTransaction(db, () => {
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

    db.exec(`delete from _resolve_batch`);
  });
  batchTx();

  return count;
}

/** ISSUE-022: fan-out cap per call site — MediatR-style interfaces can have hundreds of implementors. */
const MAX_INTERFACE_DISPATCH_FANOUT = 10;

/**
 * Release L (MCP-ISSUE-094): rebuild every `interface-dispatch` CALLS edge of the repo from scratch — a pure
 * function of (CALLS edges resolved to an interface method, resolved IMPLEMENTS, method symbols).
 *
 * The fan-out used to be written inline while a call row resolved, from the IMPLEMENTS edges resolved AT THAT
 * MOMENT. A full run resolves IMPLEMENTS before calls (`runFinalize`); a scoped run does not, so an implementor
 * in a re-extracted file was still an `iface:` token and missing from the fan-out — and a caller outside the
 * run's scope never re-fanned at all. On wec.communication-hub a scoped run lost 407 of these edges. Rebuilt
 * after IMPLEMENTS resolution, every run lands on the same set a full run does.
 *
 * An edge is skipped when the caller already has a CALLS edge to that implementation (a direct resolution
 * wins), so the result does not depend on which rows a later dedup pass looks at.
 */
export function rebuildInterfaceDispatchEdges(db: Database.Database, repoId: string): number {
  // PY-5: Python Protocol implementers first — the fan-out below reads IMPLEMENTS.
  rebuildPythonProtocolImplements(db, repoId);
  db.prepare(`delete from edges where repo_id = ? and type = 'CALLS' and reason = 'interface-dispatch'`).run(repoId);
  const calls = db
    .prepare(
      `select distinct e.from_id as fromId, s.symbol_id as methodId, s.name as name, s.parent_symbol_id as ifaceId
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.to_id
       inner join symbols i on i.repo_id = s.repo_id and i.symbol_id = s.parent_symbol_id and i.kind = 'interface'
       where e.repo_id = ? and e.type = 'CALLS' and e.reason in (?, ?) and s.kind = 'method'
       order by e.from_id, s.symbol_id`
    )
    .all(repoId, INTERFACE_METHOD_REASON, INTERFACE_METHOD_UNPROVEN_REASON) as { fromId: string; methodId: string; name: string; ifaceId: string }[];
  if (calls.length === 0) return 0;
  const implementorFiles = new Map<string, string[]>();
  /** PY-6: Python implementer class ids per interface — Python files often hold several implementers. */
  const pythonImplementors = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `select distinct e.to_id as ifaceId, s.file_path as filePath, s.symbol_id as implId
       from edges e
       inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPLEMENTS' and s.kind in ('class', 'struct', 'record', 'record struct')
       order by e.to_id, s.file_path, s.symbol_id`
    )
    .all(repoId) as { ifaceId: string; filePath: string; implId: string }[]) {
    if (isPythonFile(r.filePath)) {
      const ids = pythonImplementors.get(r.ifaceId);
      if (ids) ids.push(r.implId);
      else pythonImplementors.set(r.ifaceId, [r.implId]);
      continue;
    }
    const list = implementorFiles.get(r.ifaceId);
    // Rows are ordered by (iface, file), so skipping a repeat of the last file keeps the old
    // `distinct (iface, file)` list exactly, now that the row also carries the implementer id.
    if (list) {
      if (list[list.length - 1] !== r.filePath) list.push(r.filePath);
    } else implementorFiles.set(r.ifaceId, [r.filePath]);
  }
  const candidateMap = buildNamedCandidateMap(db, repoId, ["function", "method", "constructor", "class"]);
  // PY-5b: the base chains the Python fan-out walks — only built when a Protocol has implementers.
  const pythonBases = pythonImplementors.size > 0
    ? buildPythonBases(db, repoId, candidateMap, buildImportedFilesByFile(db, repoId))
    : new Map<string, string[]>();
  const insert = db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason)
     select ?, ?, ?, 'CALLS', 0.7, 'interface-dispatch'
     where not exists (select 1 from edges where repo_id = ? and from_id = ? and to_id = ? and type = 'CALLS')`
  );
  let count = 0;
  const tx = immediateTransaction(db, () => {
    for (const call of calls) {
      for (const filePath of (implementorFiles.get(call.ifaceId) ?? []).slice(0, MAX_INTERFACE_DISPATCH_FANOUT)) {
        const impl = (candidateMap.get(call.name) ?? []).find((c) => c.filePath === filePath && c.kind === "method");
        if (!impl || impl.symbolId === call.methodId) continue;
        count += insert.run(repoId, call.fromId, impl.symbolId, repoId, call.fromId, impl.symbolId).changes;
      }
      // PY-6: a Python implementer's method, by owner rather than by file. A pipeline's stage list is
      // usually longer than the C# cap, so Python Protocols get a larger one.
      // PY-5b: the method the implementer RUNS — its own, else the first up its MRO: a base class's, or a
      // (sub-)Protocol's default body. The Protocol member the call already targets is skipped below.
      const byParent = pythonLookupFor(candidateMap).methodsByParent(call.name);
      for (const implId of (pythonImplementors.get(call.ifaceId) ?? []).slice(0, MAX_PYTHON_PROTOCOL_DISPATCH_FANOUT)) {
        const impl = pythonMemberOnChain(byParent, pythonBases, implId);
        if (!impl || impl.symbolId === call.methodId) continue;
        count += insert.run(repoId, call.fromId, impl.symbolId, repoId, call.fromId, impl.symbolId).changes;
      }
    }
  });
  tx();
  return count;
}

/** PY-6: fan-out cap for a call through a Python Protocol (implementers counted, not files). */
const MAX_PYTHON_PROTOCOL_DISPATCH_FANOUT = 40;

/** PY-5: the two reasons `rebuildPythonProtocolImplements` writes; it owns every IMPLEMENTS edge carrying one. */
export const PROTOCOL_EXPLICIT_REASON = "base_list protocol";
export const PROTOCOL_STRUCTURAL_REASON = "structural protocol";
/** Not part of a Protocol's structural contract: every class has them. */
const PROTOCOL_IGNORED_MEMBERS = new Set(["__init__", "__new__", "__init_subclass__", "__class_getitem__", "__post_init__"]);

/**
 * PY-5 (G1): rebuild every Python Protocol IMPLEMENTS edge of the repo from scratch — a pure function of the
 * Python class / interface / method symbols and their EXTENDS rows, so a scoped run lands where a full run does.
 *
 * A Python `Protocol` is stored as kind `interface` (the extractor). PEP 544 typing is structural, so:
 *   - a class listing a Protocol (or a Protocol's sub-Protocol) among its bases implements it — 0.95, explicit;
 *   - any other class whose methods, its own plus those up its in-repo base chain, cover every member the
 *     Protocol declares (its own plus its parent Protocols') implements it — 0.8, structural. A Protocol with
 *     no method members (attributes only) has no structural implementers: it would match every class.
 * Base names are bound with the call lane's picker (same file, imported file, tie-break), from the
 * `base:<Name>` token or the resolved target's name, so the result does not depend on EXTENDS resolution state.
 */
export function rebuildPythonProtocolImplements(db: Database.Database, repoId: string): number {
  db.prepare(`delete from edges where repo_id = ? and type = 'IMPLEMENTS' and reason in (?, ?)`).run(
    repoId,
    PROTOCOL_EXPLICIT_REASON,
    PROTOCOL_STRUCTURAL_REASON
  );
  type TypeRow = { symbolId: string; name: string; kind: string; filePath: string };
  const types = db
    .prepare(
      `select symbol_id as symbolId, name, kind, file_path as filePath from symbols
       where repo_id = ? and kind in ('class', 'interface') and (file_path like '%.py' or file_path like '%.pyi')
       order by name, file_path, symbol_id`
    )
    .all(repoId) as TypeRow[];
  if (!types.some((t) => t.kind === "interface")) return 0;

  const byName = new Map<string, TypeRow[]>();
  for (const t of types) {
    const list = byName.get(t.name);
    if (list) list.push(t);
    else byName.set(t.name, [t]);
  }
  const byId = new Map(types.map((t) => [t.symbolId, t]));

  const methodsByOwner = new Map<string, Map<string, string | null>>();
  for (const m of db
    .prepare(
      `select name, parent_symbol_id as ownerId, signature from symbols
       where repo_id = ? and kind = 'method' and parent_symbol_id is not null
         and (file_path like '%.py' or file_path like '%.pyi')
       order by parent_symbol_id, name`
    )
    .all(repoId) as { name: string; ownerId: string; signature: string | null }[]) {
    if (!byId.has(m.ownerId)) continue;
    const map = methodsByOwner.get(m.ownerId);
    if (!map) methodsByOwner.set(m.ownerId, new Map([[m.name, m.signature]]));
    else if (!map.has(m.name)) map.set(m.name, m.signature);
  }

  const importedFilesByFile = buildImportedFilesByFile(db, repoId);
  const basesById = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `select e.from_id as fromId, e.to_id as toId, t.name as toName, min(e.rowid) as pos
       from edges e
       join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
       left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
       where e.repo_id = ? and e.type = 'EXTENDS' and s.kind in ('class', 'interface')
         and (s.file_path like '%.py' or s.file_path like '%.pyi')
       group by e.from_id, e.to_id
       order by e.from_id, pos`
    )
    .all(repoId) as { fromId: string; toId: string; toName: string | null }[]) {
    const from = byId.get(r.fromId);
    const name = r.toId.startsWith("base:") ? r.toId.slice(5) : r.toName;
    if (!from || !name) continue;
    const candidates = (byName.get(name) ?? []).filter((c) => c.symbolId !== r.fromId);
    const base = pickBestNamedCandidate(candidates, from.filePath, ["interface", "class"], importedFilesByFile.get(normalizeFilePath(from.filePath)));
    if (!base) continue;
    const list = basesById.get(r.fromId);
    if (!list) basesById.set(r.fromId, [base.symbolId]);
    else if (!list.includes(base.symbolId)) list.push(base.symbolId);
  }

  /** The type itself and every in-repo type up its base chain, breadth-first, capped like the call lane's MRO walk. */
  const ancestry = (id: string): string[] => {
    const out: string[] = [];
    const queue = [id];
    while (queue.length > 0 && out.length < MAX_PYTHON_MRO_CLASSES) {
      const next = queue.shift()!;
      if (out.includes(next)) continue;
      out.push(next);
      queue.push(...(basesById.get(next) ?? []));
    }
    return out;
  };

  const protocols = types.filter((t) => t.kind === "interface");
  const required = new Map<string, Map<string, string | null>>();
  for (const p of protocols) {
    const members = new Map<string, string | null>();
    for (const id of ancestry(p.symbolId)) {
      if (byId.get(id)?.kind !== "interface") continue;
      for (const [n, sig] of methodsByOwner.get(id) ?? []) if (!PROTOCOL_IGNORED_MEMBERS.has(n) && !members.has(n)) members.set(n, sig);
    }
    required.set(p.symbolId, members);
  }
  // Built once: the class × Protocol loop below reads each list many times.
  const requiredList = new Map([...required].map(([id, members]) => [id, [...members]] as const));

  const insert = db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason)
     select ?, ?, ?, 'IMPLEMENTS', ?, ?
     where not exists (select 1 from edges where repo_id = ? and from_id = ? and to_id = ? and type = 'IMPLEMENTS')`
  );
  let count = 0;
  const tx = immediateTransaction(db, () => {
    for (const cls of types) {
      if (cls.kind !== "class") continue;
      const chain = ancestry(cls.symbolId);
      const explicit = new Set(chain.filter((id) => byId.get(id)?.kind === "interface"));
      // A Protocol listed as a base also implements the Protocols it extends.
      for (const id of [...explicit]) for (const up of ancestry(id)) if (byId.get(up)?.kind === "interface") explicit.add(up);
      // First along the chain wins, as attribute lookup does.
      const available = new Map<string, string | null>();
      for (const id of chain) for (const [n, sig] of methodsByOwner.get(id) ?? []) if (!available.has(n)) available.set(n, sig);
      for (const p of protocols) {
        let reason: string | null = null;
        let confidence = 0;
        if (explicit.has(p.symbolId)) {
          reason = PROTOCOL_EXPLICIT_REASON;
          confidence = 0.95;
        } else {
          const members = requiredList.get(p.symbolId) ?? [];
          // PY-6: a name match alone made every class with a `run` a Stage; the signature must fit too.
          if (members.length > 0 && members.every(([n, sig]) => available.has(n) && pythonSignaturesCompatible(sig, available.get(n) ?? null))) {
            reason = PROTOCOL_STRUCTURAL_REASON;
            confidence = 0.8;
          }
        }
        if (!reason) continue;
        count += insert.run(repoId, cls.symbolId, p.symbolId, confidence, reason, repoId, cls.symbolId, p.symbolId).changes;
      }
    }
  });
  tx();
  return count;
}

type PyParam = { name: string; annotation: string | null; hasDefault: boolean; star: "" | "*" | "**" };

/** `def run(self, ctx: Ctx) -> Out` → its parameters (self / cls dropped) and return annotation; null when unreadable. */
export function parsePythonSignature(rawSignature: string | null): { params: PyParam[]; returns: string | null } | null {
  if (!rawSignature || rawSignature.endsWith("...")) return null;
  // A string literal (`sep=")"`, a forward reference `"Repo"`) keeps its text but loses the punctuation the
  // bracket and comma scans below read as structure.
  const signature = rawSignature.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (lit) => lit.replace(/[()[\]{},=:]/g, " "));
  const open = signature.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i += 1) {
    const ch = signature[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const parts: string[] = [];
  let current = "";
  depth = 0;
  for (const ch of signature.slice(open + 1, close)) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  const params: PyParam[] = [];
  for (const raw of parts.map((x) => x.trim()).filter((x) => x.length > 0 && x !== "/" && x !== "*")) {
    const star = raw.startsWith("**") ? "**" : raw.startsWith("*") ? "*" : "";
    const body = raw.slice(star.length);
    const eq = topLevelIndex(body, "=");
    const head = eq >= 0 ? body.slice(0, eq) : body;
    const colon = topLevelIndex(head, ":");
    params.push({
      name: (colon >= 0 ? head.slice(0, colon) : head).trim(),
      annotation: colon >= 0 ? head.slice(colon + 1).trim() || null : null,
      hasDefault: eq >= 0,
      star
    });
  }
  if (params[0] && (params[0].name === "self" || params[0].name === "cls") && !params[0].star) params.shift();
  const tail = signature.slice(close + 1);
  const arrow = tail.indexOf("->");
  const returns = arrow >= 0 ? tail.slice(arrow + 2).trim() || null : null;
  return { params, returns };
}

function topLevelIndex(text: string, needle: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === needle && depth === 0) return i;
  }
  return -1;
}

const ANNOTATION_WRAPPER = /^(?:typing\.)?(?:Optional|Annotated|Final|ClassVar)\[(.*)\]$/;

/** `Optional[pkg.Foo]` → `Foo`; quotes, `| None` and a module path ignored. Null means "says nothing". */
function annotationHead(annotation: string | null): string | null {
  if (!annotation) return null;
  let t = annotation.replace(/["']/g, "").trim();
  const union = t.split("|").map((x) => x.trim()).filter((x) => x !== "None");
  t = union[0] ?? t;
  const wrapped = ANNOTATION_WRAPPER.exec(t);
  if (wrapped?.[1]) t = (wrapped[1].split(",")[0] ?? "").trim();
  const head = (t.split("[")[0] ?? "").trim().split(".").pop() ?? "";
  // A TypeVar by convention (`T`, `TKey`, `T_co`) binds to anything: a generic Protocol's `x: T` fits `x: int`.
  if (!head || head === "Any" || head === "object" || TYPEVAR_NAME.test(head)) return null;
  // `List[X]` and `list[X]` are the same type.
  return head.toLowerCase();
}

const TYPEVAR_NAME = /^(?:[A-Z]|T[A-Z0-9_]\w*|\w+_(?:co|contra))$/;

/**
 * PY-6: can an implementer method stand in for a Protocol member? Positional arity must fit (an implementer
 * with `*args` takes any), and where both sides annotate a parameter or the return, the annotated class
 * names must agree. An unreadable signature is not evidence against.
 */
export function pythonSignaturesCompatible(protocolSig: string | null, implSig: string | null): boolean {
  const proto = parsePythonSignature(protocolSig);
  const impl = parsePythonSignature(implSig);
  if (!proto || !impl) return true;
  const positional = (ps: PyParam[]) => ps.filter((x) => !x.star);
  const protoPos = positional(proto.params);
  const implPos = positional(impl.params);
  const implVarArgs = impl.params.some((x) => x.star === "*");
  if (!implVarArgs && implPos.length < protoPos.length) return false;
  if (implPos.filter((x) => !x.hasDefault).length > protoPos.length) return false;
  for (let i = 0; i < Math.min(protoPos.length, implPos.length); i += 1) {
    const a = annotationHead(protoPos[i]!.annotation);
    const b = annotationHead(implPos[i]!.annotation);
    if (a && b && a !== b) return false;
  }
  const ra = annotationHead(proto.returns);
  const rb = annotationHead(impl.returns);
  return !(ra && rb && ra !== rb);
}
