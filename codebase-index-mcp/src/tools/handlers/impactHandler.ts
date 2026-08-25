import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { fileIndexedNote } from "../../middleware/inputGuards.js";
import { validateReadOnlyGraphSql, validateAllowedTables } from "../../middleware/sqliteGuardrails.js";
import { buildStaleWarning, getRepoStaleness, collectDirtyFiles, countCommitsBehind } from "../../services/git/gitHelpers.js";
import type { StaleWarning } from "../../services/git/gitHelpers.js";
import { buildCoverageBlock, summarizeEdgeProvenance } from "../../middleware/coverage.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";
import { GraphStore } from "../../repositories/graphStore.js";
import type { HandlerContext } from "./handlerContext.js";

// ── Staleness Gate ────────────────────────────────────────────────────────────
// Stale index is a warning, not a fatal — every other read tool (search_symbols,
// route_map, ...) returns data with a staleness note. Impact tools follow suit:
// return the warning so callers degrade gracefully instead of getting nothing.

function staleWarningFor(repoId: string, store: GraphStore): StaleWarning | null {
  return buildStaleWarning(
    repoId,
    store,
    `results reflect the indexed commit, not current HEAD — run index_repository(repoId='${repoId}', mode='incremental') for accurate impact.`
  );
}

// ── graph-health collapse ─────────────────────────────────────────────────────
// When the graph is fully resolved, a single flag replaces the all-zero detail object.

function collapseGraphHealth(gh: {
  unresolvedCalls: number;
  unresolvedImports: number;
  unresolvedTypeRefs: number;
  unresolvedProperties?: number;
  importClassificationRatio?: number;
}): unknown {
  const healthy =
    gh.unresolvedCalls === 0 &&
    gh.unresolvedImports === 0 &&
    gh.unresolvedTypeRefs === 0 &&
    (gh.unresolvedProperties ?? 0) === 0 &&
    (gh.importClassificationRatio ?? 1) === 1;
  return healthy ? { complete: true } : gh;
}

// ── formatChangeContextPayload ────────────────────────────────────────────────
// Shared by impactHandler and searchHandler (get_symbol_context_pack)

export function formatChangeContextPayload(
  result: ReturnType<GraphStore["getChangeContext"]>,
  profile: ReturnType<typeof resolveResponseProfile>
): unknown {
  if (profile === "nano") {
    // ISSUE-022: `via` ("interface"/"bus"/"member") chỉ spread khi có — nano/compact giữ lean.
    const topCallers = result.callers.slice(0, 10).map((x) => ({ fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance, ...(x.via ? { via: x.via } : {}), confidence: x.confidence ?? null }));
    const topCallees = result.callees.slice(0, 10).map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null }));
    const topTypeDeps = result.typeDeps.slice(0, 10).map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null }));
    return {
      symbol: result.symbol ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line } : null,
      callerCount: result.callers.length, calleeCount: result.callees.length, typeDepCount: result.typeDeps.length,
      topCallers, topCallees, topTypeDeps,
      hasMoreCallers: result.callers.length > topCallers.length, hasMoreCallees: result.callees.length > topCallees.length, hasMoreTypeDeps: result.typeDeps.length > topTypeDeps.length,
      unresolved: { calls: result.graphHealth.unresolvedCalls, imports: result.graphHealth.unresolvedImports, typeRefs: result.graphHealth.unresolvedTypeRefs },
      reliability: { medianConfidence: result.reliabilitySummary.medianConfidence, unresolvedRatio: result.reliabilitySummary.unresolvedRatio, warning: result.reliabilitySummary.warning }
    };
  }
  if (profile === "compact") {
    // Drop opaque edge ids (fromId/toId) and free-text `reason` — not needed for discovery.
    return {
      symbol: result.symbol ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line } : null,
      callers: result.callers.map((x) => ({ fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance, ...(x.via ? { via: x.via } : {}), confidence: x.confidence ?? null })),
      callees: result.callees.map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null })),
      typeDeps: result.typeDeps.map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null })),
      graphHealth: collapseGraphHealth(result.graphHealth), reliabilitySummary: result.reliabilitySummary
    };
  }
  if (profile === "verbose") {
    return { ...result, summary: { callerCount: result.callers.length, calleeCount: result.callees.length, typeDepCount: result.typeDeps.length } };
  }
  return result;
}

// ── get_dependency_graph ──────────────────────────────────────────────────────

export function handleGetDependencyGraph(
  args: { repoId: string; symbolId?: string; filePath?: string; depth: number; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  if (args.filePath) {
    const result = store.getModuleFlow(args.repoId, args.filePath, args.limit);
    const collapsed = result.collapsed ? { collapsed: result.collapsed } : {};
    if (profile === "nano") {
      // MCP-ISSUE-049: names alone are not identity. Distinct edges that share a name pair — an
      // interface, its implementation and a test double — rendered as indistinguishable repeats,
      // which made the (working) duplicate collapse look broken. An unresolved target drops
      // `toName` entirely, leaving a row naming nothing at all.
      const topEdges = result.edges.slice(0, 10).map((e) => ({ fromId: e.fromId, fromName: e.fromName, toId: e.toId, toName: e.toName, type: e.type }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, edgeCount: result.edges.length, topEdges, hasMore: result.edges.length > topEdges.length, ...collapsed }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, edges: result.edges, unresolvedCalls: result.unresolvedCalls, ...collapsed }, profile);
  }
  let rows = traverseDependencyGraph(store, args.repoId, args.symbolId!, args.depth, args.limit);
  if (rows.length === 0) {
    const detail = store.getSymbolDetail(args.repoId, args.symbolId!, 1);
    if (detail.symbol) {
      const moduleSymbolId = store.findModuleSymbolId(args.repoId, detail.symbol.filePath);
      if (moduleSymbolId) {
        rows = traverseDependencyGraph(store, args.repoId, moduleSymbolId, args.depth, args.limit);
      }
    }
  }
  if (profile === "nano") {
    // MCP-ISSUE-049: same widening as the module-flow branch above.
    const topEdges = rows.slice(0, 10).map((e) => ({ fromId: e.fromId, fromName: e.fromName, toId: e.toId, toName: e.toName, type: e.type, confidence: e.confidence ?? null }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, edgeCount: rows.length, topEdges, hasMore: rows.length > topEdges.length }, profile);
  }
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, depth: args.depth, edges: rows }, profile);
}

// ── get_call_chain ────────────────────────────────────────────────────────────

export function handleGetCallChain(
  args: { repoId: string; symbolId: string; direction: "callers" | "callees"; depth: number; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  type CallChainDirection = "callers" | "callees";
  const direction: CallChainDirection = args.direction;
  // MCP-ISSUE-056: `excludeTests` is applied on the FAR end of each hop, inside `getCallEdges`'s
  // SQL. It used to be a post-filter here, which had two consequences: the traversal spent its
  // `limit` on rows that were then discarded, and `truncated` below was computed on the shortened
  // array — so a genuinely truncated chain reported `truncated: false`.
  const rows = traverseCallGraph(store, args.repoId, args.symbolId, direction, args.depth, args.limit, args.excludeTests);
  const coverage = buildCoverageBlock({ resultCount: rows.length, truncated: rows.length >= args.limit, kind: "call_chain", query: args.symbolId, edgeProvenance: summarizeEdgeProvenance(rows) });

  // MCP-ISSUE-049: every profile must carry enough identity to act on. `getCallEdges` now resolves
  // both endpoints, so the far end of each hop has a name, a file and an id — before, nano emitted
  // `{confidence, via}` with the name/file nulled and stripped, and compact returned raw edge rows
  // whose only endpoint information was an opaque 24-hex id. `get_symbol_context_pack{nano}` keeps
  // full identity and is the model this follows.
  const farEnd = (e: (typeof rows)[number]) =>
    direction === "callees"
      ? { symbolId: e.toId, name: e.toName ?? null, filePath: e.toFilePath ?? null }
      : { symbolId: e.fromId, name: e.fromName ?? null, filePath: e.fromFilePath ?? null };
  // Mark bus hops (PUBLISHES) and interface-dispatch hops so output distinguishes
  // them from direct static calls, matching trace_execution_flow. (ISSUE-020/022)
  const via = (e: (typeof rows)[number]) =>
    e.type === "PUBLISHES" ? { via: "bus" } : e.reason === "interface-dispatch" ? { via: "interface" } : {};

  /**
   * MCP-ISSUE-060: truncation is reported at EVERY profile, not only at nano.
   *
   * Measured: `get_call_chain(direction:"callers", limit:5)` at `compact` returned 5 edges and no
   * truncation field of any kind, while the identical query at `nano` returned
   * `chainLength: 44, truncated: true`. An agent on the documented default profile reports "5
   * callers" for a symbol with 44. A profile may change how MUCH is returned; it must never change
   * whether the response is honest about being a page.
   *
   * `truncated` means the row limit bound the result — the same condition `coverage` is computed
   * from at the top of this function, now surfaced instead of only being folded into a word.
   */
  const chainTruncation = { chainLength: rows.length, truncated: rows.length >= args.limit };

  if (profile === "nano") {
    const pathNodes = rows.slice(0, 10).map((e) => ({ ...farEnd(e), ...via(e), confidence: e.confidence ?? null }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, ...chainTruncation, path: pathNodes, hasMore: rows.length > pathNodes.length, coverage: coverage.confidence }, profile);
  }
  if (profile === "compact") {
    const edges = rows.map((e) => ({
      fromId: e.fromId, fromName: e.fromName ?? null, fromFilePath: e.fromFilePath ?? null,
      toId: e.toId, toName: e.toName ?? null, toFilePath: e.toFilePath ?? null,
      type: e.type, ...via(e), confidence: e.confidence ?? null
    }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, ...chainTruncation, edges, coverage }, profile);
  }
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, ...chainTruncation, edges: rows, coverage }, profile);
}

// ── find_field_accesses ───────────────────────────────────────────────────────
// ISSUE-018 — semantic "who reads / writes this field" over the existing
// PROPERTY_REF/PROPERTY_WRITE edges, so wrong-level-resolution audits stay in MCP
// instead of falling back to grep. Accepts a property symbolId or a resolvable name.

export function handleFindFieldAccesses(
  args: { repoId: string; symbolId?: string; name?: string; mode: "read" | "write" | "all"; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  let symbolId = args.symbolId;
  if (!symbolId && args.name) {
    // Prefer an actual property symbol when several share the name.
    const candidates = store.getSymbolCandidates(args.repoId, args.name, 10);
    symbolId = (candidates.find((c) => c.kind === "property") ?? candidates[0])?.symbolId;
  }
  if (!symbolId) throw new McpError(ErrorCode.InvalidParams, "find_field_accesses: provide symbolId or a resolvable name.");

  // MCP-ISSUE-056: `excludeTests` is applied in the query — the filed case returned 5 of 7 reads of
  // "HandledBy" from test files, and filtering after the `limit` spent the budget on the dropped rows.
  const rawFieldAccesses = store.getFieldAccesses(args.repoId, symbolId, args.mode, args.limit, args.excludeTests);
  const property = rawFieldAccesses.property;
  if (!property) throw new McpError(ErrorCode.InvalidParams, `find_field_accesses: symbol '${symbolId}' not found in repo '${args.repoId}'.`);
  const result = { ...rawFieldAccesses, property };

  const reads = result.accesses.filter((a) => a.mode === "read");
  const writes = result.accesses.filter((a) => a.mode === "write");
  const coverage = buildCoverageBlock({ resultCount: result.accesses.length, kind: "field_accesses", query: result.property.name });
  const staleWarning = staleWarningFor(args.repoId, store);

  // MCP-ISSUE-047: `getSymbolCandidates` matches by case-insensitive substring, so `name:"owner"`
  // resolves to `Owner`, `OwnerId` or `AssignedOwnerName` and the response reports only the winner.
  // Echo what was asked when it differs, so the caller can see a substitution happened.
  const nameResolution =
    args.name !== undefined && args.name !== result.property.name
      ? {
          queriedName: args.name,
          resolvedName: result.property.name,
          note: "resolved by case-insensitive substring match — pass symbolId to pin an exact symbol"
        }
      : null;

  if (profile === "nano") {
    const top = result.accesses.slice(0, 10).map((a) => ({ mode: a.mode, enclosingName: a.enclosingName, filePath: a.filePath, line: a.line }));
    return ctx.asText({ property: { name: result.property.name, filePath: result.property.filePath }, readCount: reads.length, writeCount: writes.length, top, hasMore: result.accesses.length > top.length, coverage: coverage.confidence, ...(nameResolution && { nameResolution }), ...(staleWarning && { staleWarning }) }, profile);
  }

  const compactAccess = (a: typeof result.accesses[number]) => ({ mode: a.mode, enclosingName: a.enclosingName, enclosingKind: a.enclosingKind, filePath: a.filePath, line: a.line, confidence: a.confidence, ...(a.assignedExpression ? { assignedExpression: a.assignedExpression } : {}) });
  if (profile === "compact") {
    return ctx.asText({ property: { symbolId: result.property.symbolId, name: result.property.name, kind: result.property.kind, filePath: result.property.filePath, line: result.property.line, declaringType: result.property.declaringType }, mode: args.mode, readCount: reads.length, writeCount: writes.length, reads: reads.map(compactAccess), writes: writes.map(compactAccess), coverage, indexMeta: buildIndexMeta(store, args.repoId), ...(nameResolution && { nameResolution }), ...(staleWarning && { staleWarning }) }, profile);
  }

  return ctx.asText({ property: result.property, mode: args.mode, readCount: reads.length, writeCount: writes.length, accesses: result.accesses, coverage, indexMeta: buildIndexMeta(store, args.repoId), ...(nameResolution && { nameResolution }), ...(staleWarning && { staleWarning }) }, profile);
}

// ── find_impact_files ─────────────────────────────────────────────────────────

export function handleFindImpactFiles(
  args: { repoId: string; filePath: string; limit: number; view: "files" | "surface"; groupBy: "file" | "module"; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  // Stale index → warn (embedded in payload), don't block.
  const staleWarning = staleWarningFor(args.repoId, store);
  // MCP-ISSUE-060: "this path is not in the index" and "this path has no dependents" are different
  // answers, and both used to render as `totalImpactedCount: 0` with `graph data complete` beside it.
  // A 29-file server added to this workspace after the last index run was in exactly that state, and
  // every file-scoped tool agreed it was nothing.
  const warn = { ...(staleWarning ? { staleWarning } : {}), ...fileIndexedNote(store, args.repoId, args.filePath) };

  if (args.view === "surface") {
    // MCP-ISSUE-056: the filed case returned 9 of 15 callers from a single test file. `excludeTests`
    // goes INTO the query — as a post-filter over an already-LIMIT-ed page it could return `[]` for a
    // symbol that has production callers, which reads as "nothing calls this".
    const result = store.getImpactSurface(args.repoId, args.filePath, args.limit, args.excludeTests);
    const surfaceWiring = result.wiringNote ? { wiringNote: result.wiringNote } : {};
    const callers = result.callers;
    if (profile === "nano") {
      const topItems = callers.slice(0, 10).map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, edgeTypes: x.edgeTypes }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalCallers: callers.length, topItems, hasMore: callers.length > topItems.length, ...surfaceWiring, ...warn }, profile);
    }
    // MCP-ISSUE-049: `groupBy` used to be unreachable here — the surface branch returned before
    // `args.groupBy` was ever read, so `groupBy:"module"` produced an ungrouped list with no note
    // that the parameter had been ignored. Grouped through the same helper the files view uses.
    if (args.groupBy === "module") {
      const grouped = store.groupFilesByModule([...new Set(callers.map((x) => x.callerFile))]);
      const moduleGroups = Object.entries(grouped).map(([module, files]) => ({
        module,
        fileCount: files.length,
        callerCount: callers.filter((x) => files.includes(x.callerFile)).length,
        topFiles: files.slice(0, 5)
      }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, groupBy: "module", totalCallers: callers.length, moduleGroups, graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary, ...surfaceWiring, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result, callers, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
  }
  // MCP-ISSUE-056: same filter as the surface view, and likewise in-query so it applies before the cap.
  const result = store.getImpactFiles(args.repoId, args.filePath, args.limit, args.excludeTests);
  const filesWiring = result.wiringNote ? { wiringNote: result.wiringNote } : {};
  if (args.groupBy === "module") {
    const filePaths = result.impactedFiles.map((f) => f.filePath);
    const grouped = store.groupFilesByModule(filePaths);
    const moduleGroups = Object.entries(grouped).map(([module, files]) => ({ module, fileCount: files.length, topFiles: files.slice(0, 5) }));
    if (profile === "nano") {
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalModules: moduleGroups.length, topModules: moduleGroups.slice(0, 5), hasMore: moduleGroups.length > 5, ...filesWiring, ...warn }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, moduleGroups, graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary, ...filesWiring, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
  }
  if (profile === "nano") {
    const topFiles = result.impactedFiles.slice(0, 10).map((f) => ({ filePath: f.filePath, symbolCount: (f as { symbolCount?: number }).symbolCount ?? null }));
    // `totalFiles` is the true dependent count (MCP-ISSUE-054), so `hasMore` compares against it —
    // otherwise a blast radius of 300 shown 10 at a time reported `totalFiles: 20`.
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalFiles: result.totalImpactedCount, topFiles, hasMore: result.totalImpactedCount > topFiles.length, ...filesWiring, ...warn }, profile);
  }
  return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
}

// ── get_change_context ────────────────────────────────────────────────────────

export function handleGetChangeContext(
  args: { repoId: string; symbolId?: string; name?: string; callerDepth: number; calleeDepth: number; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;

  // Stale index → warn (embedded in payload), don't block.
  const staleWarning = staleWarningFor(args.repoId, store);
  const warn = staleWarning ? { staleWarning } : {};

  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  let resolvedSymbolId = args.symbolId;
  if (!resolvedSymbolId && args.name) {
    const context = store.getContextByName(args.repoId, args.name, args.limit);
    if (!context.symbol) {
      // `found: false` is an explicit not-found signal that survives compact null-stripping
      // (the `symbol: null` sentinel is dropped under the now-default compact profile).
      return ctx.asText({ found: false, symbol: null, callers: [], callees: [], typeDeps: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, note: "symbol not found" }, queryName: args.name, ...warn }, profile);
    }
    resolvedSymbolId = context.symbol.symbolId;
  }
  // MCP-ISSUE-056: filter both directions IN the query, so `limit` is spent on rows the caller
  // asked for. The counts in the payload are derived from these arrays, so `callerCount` /
  // `calleeCount` stay honest about what was returned.
  const result = store.getChangeContext(args.repoId, resolvedSymbolId!, args.callerDepth, args.calleeDepth, args.limit, args.excludeTests);
  return ctx.asText({ ...(formatChangeContextPayload(result, profile) as Record<string, unknown>), ...warn }, profile);
}

// ── get_file_summary ──────────────────────────────────────────────────────────

export function handleGetFileSummary(
  args: { repoId: string; filePath: string; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = ctx.store.getFileSummary(args.repoId, args.filePath);
  if (profile === "nano") {
    const topSymbols = result.exports.slice(0, 5).map((s) => ({ name: s.name, kind: s.kind }));
    return ctx.asText({ filePath: result.file.filePath, language: result.file.language, symbolCount: result.exports.length, topSymbols }, profile);
  }
  if (profile === "verbose") {
    return ctx.asText({ ...result, indexMeta: buildIndexMeta(ctx.store, args.repoId) }, profile);
  }
  // compact/standard: drop redundant per-entry repoId+filePath from exports (constant = this file),
  // drop redundant import `from*` (always this file's own module), collapse healthy graphHealth.
  return ctx.asText({
    file: result.file,
    symbolCount: result.exports.length,
    exports: result.exports.map((s) => ({ symbolId: s.symbolId, name: s.name, kind: s.kind, line: s.line, signature: s.signature })),
    imports: result.imports.map((i) => ({ toName: i.toName, toFilePath: i.toFilePath, type: i.type })),
    importedBy: result.importedBy,
    graphHealth: collapseGraphHealth(result.graphHealth),
    indexMeta: buildIndexMeta(ctx.store, args.repoId)
  }, profile);
}

// ── list_repositories ─────────────────────────────────────────────────────────

export function handleListRepositories(args: { profile?: string }, ctx: HandlerContext): CallToolResult {
  // B-03: the fallback is `compact` because that is what `listRepositoriesSchema` declares, and
  // what CLAUDE.md states is the default for every read tool. It read `standard`, which is how the
  // tool came to answer at a profile it never advertised. Unreachable through the tool now that the
  // schema default applies; kept for direct callers (harnesses) and aligned so the two agree.
  const profile = resolveResponseProfile((args.profile ?? "compact") as Parameters<typeof resolveResponseProfile>[0]);
  const repos = ctx.store.listRepositories();
  if (profile === "nano") {
    return ctx.asText({
      count: repos.length,
      repos: repos.map((r) => {
        const repo = r as { repoId?: string; filesIndexed?: number; lastRunStatus?: string };
        return { repoId: repo.repoId, filesIndexed: repo.filesIndexed ?? null, lastRunStatus: repo.lastRunStatus ?? null };
      })
    }, profile);
  }
  return ctx.asText(repos, profile);
}

// ── get_file_context ──────────────────────────────────────────────────────────

export function handleGetFileContext(
  args: { repoId: string; filePath?: string; filePaths?: string[]; limit: number; compact: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0], args.compact);
  if (args.filePaths) {
    const result = store.getBatchContext(args.repoId, args.filePaths, args.limit, profile === "compact" || profile === "nano");
    if (profile === "nano") {
      const symbols = (result.symbols as { name: string; kind: string; filePath: string; line: number }[]).slice(0, 20);
      return ctx.asText({ fileCount: args.filePaths.length, symbolCount: result.symbols.length, topSymbols: symbols, hasMoreSymbols: result.symbols.length > symbols.length }, profile);
    }
    if (profile === "verbose") {
      return ctx.asText({ ...result, summary: { fileCount: args.filePaths.length, symbolCount: result.symbols.length, edgeCount: result.edges.length } }, profile);
    }
    return ctx.asText(result, profile);
  }
  const result = store.getFileContext(args.repoId, args.filePath!, args.limit, profile === "compact" || profile === "nano");
  if (profile === "nano") {
    const symbols = (result.symbols as { name: string; kind: string; line: number }[]).slice(0, 12);
    return ctx.asText({ filePath: args.filePath, symbolCount: result.symbols.length, topSymbols: symbols, hasMoreSymbols: result.symbols.length > symbols.length }, profile);
  }
  if (profile === "verbose") {
    return ctx.asText({ ...result, summary: { symbolCount: result.symbols.length, edgeCount: result.edges.length } }, profile);
  }
  return ctx.asText(result, profile);
}

// ── index meta helper ─────────────────────────────────────────────────────────

type IndexMeta = {
  branch: string | null;
  commitSha: string | null;
  indexedAt: string;
  indexLag?: { commitsBehind?: number; dirtyCount: number };
  dirtyFiles?: string[];
};

const DIRTY_FILES_CAP = 20;

/**
 * Index provenance for graph-read responses: branch/commitSha/indexedAt. Pure DB read —
 * deterministic, no git subprocess. `withFreshness:true` (ENH-A) additionally probes the
 * git working tree for `indexLag`/`dirtyFiles` so the agent knows which results to distrust
 * mid-edit; both are omitted when the tree is clean and HEAD matches the indexed commit.
 *
 * Freshness is git-derived and therefore NON-deterministic, so it is attached ONLY by
 * edit-verification tools (find_impact_files, change_impact) — never by the navigation
 * tools the token benchmark snapshots (file/folder summary, context pack), which must stay
 * deterministic and lean. Attach per-handler only — NOT in asText (cost; repo-less tools).
 */
export function buildIndexMeta(store: GraphStore, repoId: string, withFreshness = false): IndexMeta | null {
  const latestRun = store.getLatestRun(repoId);
  if (!latestRun) return null;

  const meta: IndexMeta = {
    branch: latestRun.branch,
    commitSha: latestRun.commitSha,
    indexedAt: latestRun.finishedAt
  };

  if (withFreshness) {
    const repo = store.getRepository(repoId);
    if (repo) {
      let dirtyCount = 0;
      try {
        const dirty = collectDirtyFiles(repo.repoPath);
        dirtyCount = dirty.size;
        if (dirtyCount > 0) {
          meta.dirtyFiles = [...dirty].slice(0, DIRTY_FILES_CAP);
        }
      } catch {
        // non-git repo / git error — leave dirty info off
      }
      const staleness = getRepoStaleness(repoId, store);
      const commitsBehind = staleness.isStale
        ? countCommitsBehind(repo.repoPath, latestRun.commitSha) ?? undefined
        : undefined;
      // Surface indexLag whenever the tree is dirty OR the index is stale — gate on isStale,
      // not on commitsBehind, which is falsy-zero for a diverged/rewound HEAD and would
      // otherwise drop the staleness signal on a clean tree.
      if (dirtyCount > 0 || staleness.isStale) {
        meta.indexLag = { dirtyCount, ...(commitsBehind !== undefined ? { commitsBehind } : {}) };
      }
    }
  }

  return meta;
}

// ── get_folder_summary ────────────────────────────────────────────────────────

export function handleGetFolderSummary(
  args: { repoId: string; folderPath: string; maxFiles: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = ctx.store.getFolderSummary(args.repoId, args.folderPath, args.maxFiles);
  return ctx.asText({ ...result, indexMeta: buildIndexMeta(ctx.store, args.repoId) }, profile);
}

// ── route_map ────────────────────────────────────────────────────────────────

export function handleRouteMap(
  args: { repoId: string; filePathPrefix?: string; httpMethod?: string; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const routesRaw = store.getRouteMap(args.repoId, args.filePathPrefix ?? null, args.httpMethod ?? null, args.limit);
  // MCP-ISSUE-049: 6 of 34 routes in the filed case were test-only endpoints.
  const routes = args.excludeTests ? routesRaw.filter((r) => !isTestPath(r.filePath)) : routesRaw;

  /**
   * MCP-ISSUE-060: `hasMore` at every profile, not only nano.
   *
   * Measured on `wec.be`: `route_map` at `compact` — the documented default — returned
   * `{"count":100,"routes":[...]}` with no `hasMore`, no `total`, nothing. The SAME query at `nano`
   * returned `hasMore: true`. A monolith with hundreds of controllers reported 100 routes as if that
   * were all of them. `routesRaw.length >= args.limit` is the honest signal: the store's own LIMIT
   * bound the result, so more may exist. It is computed BEFORE `excludeTests` filters, because that
   * filter shrinks the page without changing whether the query hit its cap.
   */
  const routesTruncated = routesRaw.length >= args.limit;

  const emptyHint =
    routes.length === 0
      ? { hint: "no routes found — route_map reads C# attribute and minimal-API routing, plus JS/TS app|router|fastify.VERB('/path', handler). Not read yet: NestJS decorators, Next.js file routing, app.use(prefix, router) mounting, all/head/options. Try find_entry_points(kind='route_handler')." }
      : {};

  if (profile === "nano") {
    const topRoutes = routes.slice(0, 10).map((r) => ({ method: r.httpMethod, route: r.routeTemplate, handlerName: r.handlerName, filePath: r.filePath }));
    return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated || routes.length > topRoutes.length, topRoutes, ...emptyHint }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated, routes: routes.map((r) => ({ filePath: r.filePath, controllerName: r.controllerName, handlerName: r.handlerName, httpMethod: r.httpMethod, routeTemplate: r.routeTemplate, line: r.line })), ...emptyHint }, profile);
  }
  if (profile === "verbose") {
    const byMethod = routes.reduce<Record<string, number>>((acc, row) => { acc[row.httpMethod] = (acc[row.httpMethod] ?? 0) + 1; return acc; }, {});
    return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated, routes, summary: { byMethod }, ...emptyHint }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated, routes, ...emptyHint }, profile);
}

// ── query_graph ───────────────────────────────────────────────────────────────

const ALLOWED_QUERY_GRAPH_TABLES = new Set(["repositories", "files", "symbols", "edges", "index_runs", "routes", "cross_repo_deps", "refactor_previews", "refactor_preview_hunks", "refactor_applies", "refactor_apply_changes", "refactor_apply_hunks", "refactor_rollbacks", "vec_symbol_map"]);

export function handleQueryGraph(
  args: { repoId: string; sql: string; params?: Record<string, unknown>; limit: number; timeoutMs: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const readOnlyCheck = validateReadOnlyGraphSql(args.sql);
  if (!readOnlyCheck.ok) {
    throw new McpError(ErrorCode.InvalidParams, readOnlyCheck.message);
  }
  const allowlistCheck = validateAllowedTables(
    readOnlyCheck.sanitizedSql,
    ALLOWED_QUERY_GRAPH_TABLES
  );
  if (!allowlistCheck.ok) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${allowlistCheck.message} Allowed tables: ${[...ALLOWED_QUERY_GRAPH_TABLES].join(", ")}.`
    );
  }

  let result: ReturnType<typeof store.runReadOnlyGraphQuery>;
  try {
    result = store.runReadOnlyGraphQuery(allowlistCheck.sanitizedSql, { ...args.params, repoId: args.repoId }, args.limit, args.timeoutMs);
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.replace(/['"][^'"]{0,200}['"]/g, "'...'").slice(0, 300);
    throw new McpError(ErrorCode.InternalError, `query_graph: query failed — ${safe}. Check SQL syntax and allowed tables.`);
  }

  const { elapsedMs, timedOut: timeoutExceeded } = result;
  if (timeoutExceeded) {
    throw new McpError(ErrorCode.InvalidRequest, `query_graph: query exceeded timeout of ${args.timeoutMs}ms (took ${elapsedMs}ms). Simplify the query or increase timeoutMs.`);
  }

  if (profile === "nano") {
    return ctx.asText({ columns: result.columns, rowCount: result.rowCount, truncated: result.truncated, elapsedMs, timeoutExceeded }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ columns: result.columns, rowCount: result.rowCount, truncated: result.truncated, elapsedMs, timeoutExceeded, rows: result.rows }, profile);
  }
  return ctx.asText({ repoId: args.repoId, sql: allowlistCheck.sanitizedSql, params: { ...args.params, repoId: args.repoId }, limit: args.limit, elapsedMs, timeoutMs: args.timeoutMs, timeoutExceeded, columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated }, profile);
}

// ── query_docs ────────────────────────────────────────────────────────────────

/**
 * `query_docs` — one tool, one envelope.
 *
 * MCP-ISSUE-049: `mode:"search"` returned a keyed object while `stale` and `coverage` returned bare
 * arrays, so the same tool answered in three shapes and a caller had to branch on the mode it had
 * just requested. All three now return `{ repoId, mode, count, results, ...hint }` — the shape
 * `search` already had, which is also the convention every other read tool here follows.
 */
export function handleQueryDocs(
  args: { repoId: string; mode: "search" | "stale" | "coverage"; query?: string; symbolIds?: string[]; filePath?: string; limit: number; includeSymbols: boolean; includeCodeMentions: boolean; contentTypes?: string[]; profile: string },
  ctx: HandlerContext
): CallToolResult {
  if (!ctx.constants.DOCS_TOOLS_ENABLED) {
    throw new McpError(ErrorCode.InvalidParams, "query_docs: docs lane is disabled. Set CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true to enable docs tools.");
  }
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  if (args.mode === "search") {
    const results = store.searchDocs(args.repoId, args.query!, args.limit, args.includeSymbols, args.contentTypes ?? null);
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "search",
        query: args.query,
        count: results.length,
        results,
        ...(results.length === 0 && { hint: "no documentation matched — ensure the docs lane was indexed for this repo (index_repository with docsMode='on') and try broader query terms." })
      },
      profile
    );
  }

  if (args.mode === "stale") {
    const results = store.findStaleDocs(args.repoId, args.symbolIds!, args.includeCodeMentions);
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "stale",
        symbolIds: args.symbolIds,
        count: results.length,
        results,
        ...(results.length === 0 && {
          hint: args.includeCodeMentions
            ? "no doc mentions reference these symbols — the docs lane may not be indexed for this repo (index_repository with docsMode='on'), or nothing documents them."
            : "no PROSE doc mentions reference these symbols — the docs lane may not be indexed (index_repository with docsMode='on'), nothing documents them, or they are only named inside fenced code samples (retry with includeCodeMentions=true)."
        })
      },
      profile
    );
  }

  const results = store.findDocCoverage(args.repoId, args.filePath!);
  return ctx.asText(
    {
      repoId: args.repoId,
      mode: "coverage",
      filePath: args.filePath,
      count: results.length,
      documented: results.filter((r) => r.hasDocs).length,
      results,
      ...(results.length === 0 && { hint: "no symbols found for this file — check the path against list_repositories/get_file_summary, and that the file was indexed." })
    },
    profile
  );
}

// ── internal graph traversal helpers ─────────────────────────────────────────

function traverseDependencyGraph(store: GraphStore, repoId: string, symbolId: string, depth: number, limit: number) {
  const all: ReturnType<GraphStore["getDependencies"]> = [];
  const visited = new Set<string>();
  let frontier = [symbolId];
  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) break;
      const edges = store.getDependencies(repoId, current, limit - all.length);
      for (const edge of edges) {
        const key = `${edge.fromId}:${edge.toId}:${edge.type}`;
        if (visited.has(key)) continue;
        visited.add(key);
        all.push(edge);
        nextFrontier.push(edge.toId);
      }
    }
    frontier = nextFrontier;
  }
  return all;
}

function traverseCallGraph(store: GraphStore, repoId: string, symbolId: string, direction: "callers" | "callees", depth: number, limit: number, excludeTests = false) {
  const all: ReturnType<GraphStore["getCallEdges"]> = [];
  const visited = new Set<string>();
  // MCP-ISSUE-022: the callers direction must see through DI. Production code calls the
  // interface method; only tests `new` the concrete class. Seeding the frontier with the
  // symbol's interface siblings (interface method ↔ impl method, class → members) is the
  // query-layer half of that fix — the resolution-layer half is the interface-dispatch
  // CALLS edges written at resolve time. Both are needed: resolution cannot see a caller
  // whose edge lands on the sibling rather than on `symbolId` itself.
  //
  // This lived in services/graph/graphTraversal.ts until S-41 (a1d992c) re-homed the loose
  // src files, inlined the traversal here without it, and left the fixed module orphaned.
  // Covered by scripts/test/test-call-chain-interface.mjs — do not drop it again.
  let frontier =
    direction === "callers"
      ? [symbolId, ...store.expandInterfaceSiblings(repoId, [symbolId]).map((s) => s.symbolId)]
      : [symbolId];
  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) break;
      // MCP-ISSUE-056: `limit` is spent during traversal, so ORDER decides what survives truncation —
      // `interface-dispatch` edges are a speculative fan-out and must be the ones dropped. That
      // ordering is now inside `getCallEdges`'s SQL (`order by … then 1 else 0 end`), because it has
      // to be applied BEFORE the `limit ?`. Sorting here, as this first shipped, reordered a page the
      // database had already truncated: a no-op for what survives.
      const edges = store.getCallEdges(repoId, current, direction, limit - all.length, excludeTests);
      for (const edge of edges) {
        const key = `${edge.fromId}:${edge.toId}:${edge.type}`;
        if (visited.has(key)) continue;
        visited.add(key);
        all.push(edge);
        nextFrontier.push(direction === "callees" ? edge.toId : edge.fromId);
      }
    }
    frontier = nextFrontier;
  }
  return all;
}
