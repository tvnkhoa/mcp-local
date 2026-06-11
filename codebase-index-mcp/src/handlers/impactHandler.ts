import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import { validateReadOnlyGraphSql, validateAllowedTables } from "../sqliteGuardrails.js";
import { buildStaleWarning, getRepoStaleness, collectDirtyFiles, countCommitsBehind } from "../gitHelpers.js";
import { buildCoverageBlock } from "../coverage.js";
import { GraphStore } from "../graphStore.js";
import type { HandlerContext } from "./handlerContext.js";

// ── Staleness Gate ────────────────────────────────────────────────────────────
// Stale index is a warning, not a fatal — every other read tool (search_symbols,
// route_map, ...) returns data with a staleness note. Impact tools follow suit:
// return the warning so callers degrade gracefully instead of getting nothing.

function staleWarningFor(repoId: string, store: GraphStore): { note: string; hint: string } | null {
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
    if (profile === "nano") {
      const topEdges = result.edges.slice(0, 10).map((e) => ({ fromName: (e as { fromName?: string }).fromName ?? null, toName: (e as { toName?: string }).toName ?? null, type: (e as { type?: string }).type ?? null }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, edgeCount: result.edges.length, topEdges, hasMore: result.edges.length > topEdges.length }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, edges: result.edges, unresolvedCalls: result.unresolvedCalls }, profile);
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
    const topEdges = rows.slice(0, 10).map((e) => ({ fromName: (e as { fromName?: string }).fromName ?? null, toName: (e as { toName?: string }).toName ?? null, type: e.type, confidence: e.confidence ?? null }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, edgeCount: rows.length, topEdges, hasMore: rows.length > topEdges.length }, profile);
  }
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, depth: args.depth, edges: rows }, profile);
}

// ── get_call_chain ────────────────────────────────────────────────────────────

export function handleGetCallChain(
  args: { repoId: string; symbolId: string; direction: "callers" | "callees"; depth: number; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  type CallChainDirection = "callers" | "callees";
  const direction: CallChainDirection = args.direction;
  const rows = traverseCallGraph(store, args.repoId, args.symbolId, direction, args.depth, args.limit);
  if (profile === "nano") {
    const pathNodes = rows.slice(0, 10).map((e) => ({
      name: direction === "callees" ? (e as { toName?: string }).toName ?? null : (e as { fromName?: string }).fromName ?? null,
      filePath: direction === "callees" ? (e as { toFilePath?: string }).toFilePath ?? null : (e as { fromFilePath?: string }).fromFilePath ?? null,
      // Mark bus hops (PUBLISHES) and interface-dispatch hops so nano output distinguishes
      // them from direct static calls, matching trace_execution_flow. (ISSUE-020/022)
      ...(e.type === "PUBLISHES" ? { via: "bus" } : e.reason === "interface-dispatch" ? { via: "interface" } : {}),
      confidence: e.confidence ?? null
    }));
    const coverageNano = buildCoverageBlock({ resultCount: rows.length, truncated: rows.length >= args.limit, kind: "call_chain", query: args.symbolId });
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, chainLength: rows.length, path: pathNodes, truncated: rows.length > pathNodes.length, coverage: coverageNano.confidence }, profile);
  }
  const coverage = buildCoverageBlock({ resultCount: rows.length, truncated: rows.length >= args.limit, kind: "call_chain", query: args.symbolId });
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, edges: rows, coverage }, profile);
}

// ── find_field_accesses ───────────────────────────────────────────────────────
// ISSUE-018 — semantic "who reads / writes this field" over the existing
// PROPERTY_REF/PROPERTY_WRITE edges, so wrong-level-resolution audits stay in MCP
// instead of falling back to grep. Accepts a property symbolId or a resolvable name.

export function handleFindFieldAccesses(
  args: { repoId: string; symbolId?: string; name?: string; mode: "read" | "write" | "all"; limit: number; profile: string },
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

  const result = store.getFieldAccesses(args.repoId, symbolId, args.mode, args.limit);
  if (!result.property) throw new McpError(ErrorCode.InvalidParams, `find_field_accesses: symbol '${symbolId}' not found in repo '${args.repoId}'.`);

  const reads = result.accesses.filter((a) => a.mode === "read");
  const writes = result.accesses.filter((a) => a.mode === "write");
  const coverage = buildCoverageBlock({ resultCount: result.accesses.length, kind: "field_accesses", query: result.property.name });
  const staleWarning = staleWarningFor(args.repoId, store);

  if (profile === "nano") {
    const top = result.accesses.slice(0, 10).map((a) => ({ mode: a.mode, enclosingName: a.enclosingName, filePath: a.filePath, line: a.line }));
    return ctx.asText({ property: { name: result.property.name, filePath: result.property.filePath }, readCount: reads.length, writeCount: writes.length, top, hasMore: result.accesses.length > top.length, coverage: coverage.confidence, ...(staleWarning && { staleWarning }) }, profile);
  }

  const compactAccess = (a: typeof result.accesses[number]) => ({ mode: a.mode, enclosingName: a.enclosingName, enclosingKind: a.enclosingKind, filePath: a.filePath, line: a.line, confidence: a.confidence });
  if (profile === "compact") {
    return ctx.asText({ property: { symbolId: result.property.symbolId, name: result.property.name, kind: result.property.kind, filePath: result.property.filePath, line: result.property.line, declaringType: result.property.declaringType }, mode: args.mode, readCount: reads.length, writeCount: writes.length, reads: reads.map(compactAccess), writes: writes.map(compactAccess), coverage, indexMeta: buildIndexMeta(store, args.repoId), ...(staleWarning && { staleWarning }) }, profile);
  }

  return ctx.asText({ property: result.property, mode: args.mode, readCount: reads.length, writeCount: writes.length, accesses: result.accesses, coverage, indexMeta: buildIndexMeta(store, args.repoId), ...(staleWarning && { staleWarning }) }, profile);
}

// ── find_impact_files ─────────────────────────────────────────────────────────

export function handleFindImpactFiles(
  args: { repoId: string; filePath: string; limit: number; view: "files" | "surface"; groupBy: "file" | "module"; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  // Stale index → warn (embedded in payload), don't block.
  const staleWarning = staleWarningFor(args.repoId, store);
  const warn = staleWarning ? { staleWarning } : {};

  if (args.view === "surface") {
    const result = store.getImpactSurface(args.repoId, args.filePath, args.limit);
    const surfaceWiring = result.wiringNote ? { wiringNote: result.wiringNote } : {};
    if (profile === "nano") {
      const callers = result.callers;
      const topItems = callers.slice(0, 10).map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, edgeType: x.edgeType }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalCallers: callers.length, topItems, hasMore: callers.length > topItems.length, ...surfaceWiring, ...warn }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
  }
  const result = store.getImpactFiles(args.repoId, args.filePath, args.limit);
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
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalFiles: result.impactedFiles.length, topFiles, hasMore: result.impactedFiles.length > topFiles.length, ...filesWiring, ...warn }, profile);
  }
  return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
}

// ── get_change_context ────────────────────────────────────────────────────────

export function handleGetChangeContext(
  args: { repoId: string; symbolId?: string; name?: string; callerDepth: number; calleeDepth: number; limit: number; profile: string },
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
  const result = store.getChangeContext(args.repoId, resolvedSymbolId!, args.callerDepth, args.calleeDepth, args.limit);
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
  const profile = resolveResponseProfile((args.profile ?? "standard") as Parameters<typeof resolveResponseProfile>[0]);
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
  args: { repoId: string; filePathPrefix?: string; httpMethod?: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const routes = store.getRouteMap(args.repoId, args.filePathPrefix ?? null, args.httpMethod ?? null, args.limit);

  const emptyHint =
    routes.length === 0
      ? { hint: "no routes found — route_map only extracts ASP.NET C# attribute routing ([Route]/[HttpGet]/...); non-C# repos and convention/Minimal-API routing won't appear here. Try search_symbols or find_entry_points(kind='route_handler')." }
      : {};

  if (profile === "nano") {
    const topRoutes = routes.slice(0, 10).map((r) => ({ method: r.httpMethod, route: r.routeTemplate, handlerName: r.handlerName, filePath: r.filePath }));
    return ctx.asText({ repoId: args.repoId, count: routes.length, topRoutes, hasMore: routes.length > topRoutes.length, ...emptyHint }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: routes.length, routes: routes.map((r) => ({ filePath: r.filePath, controllerName: r.controllerName, handlerName: r.handlerName, httpMethod: r.httpMethod, routeTemplate: r.routeTemplate, line: r.line })), ...emptyHint }, profile);
  }
  if (profile === "verbose") {
    const byMethod = routes.reduce<Record<string, number>>((acc, row) => { acc[row.httpMethod] = (acc[row.httpMethod] ?? 0) + 1; return acc; }, {});
    return ctx.asText({ repoId: args.repoId, count: routes.length, routes, summary: { byMethod }, ...emptyHint }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: routes.length, routes, ...emptyHint }, profile);
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

export function handleQueryDocs(
  args: { repoId: string; mode: "search" | "stale" | "coverage"; query?: string; symbolIds?: string[]; filePath?: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  if (!ctx.constants.DOCS_TOOLS_ENABLED) {
    throw new McpError(ErrorCode.InvalidParams, "query_docs: docs lane is disabled. Set CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true to enable docs tools.");
  }
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  if (args.mode === "search") {
    // Always return a keyed object (stable shape regardless of result count), attaching a
    // docs-lane hint only when empty — mirrors the find_implementations wrapper convention.
    const results = store.searchDocs(args.repoId, args.query!, args.limit);
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
  if (args.mode === "stale") return ctx.asText(store.findStaleDocs(args.repoId, args.symbolIds!), profile);
  return ctx.asText(store.findDocCoverage(args.repoId, args.filePath!), profile);
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

function traverseCallGraph(store: GraphStore, repoId: string, symbolId: string, direction: "callers" | "callees", depth: number, limit: number) {
  const all: ReturnType<GraphStore["getCallEdges"]> = [];
  const visited = new Set<string>();
  let frontier = [symbolId];
  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) break;
      const edges = store.getCallEdges(repoId, current, direction, limit - all.length);
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
