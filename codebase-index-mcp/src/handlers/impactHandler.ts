import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import { validateReadOnlyGraphSql, validateAllowedTables } from "../sqliteGuardrails.js";
import { getRepoStaleness } from "../gitHelpers.js";
import type { GraphStore } from "../graphStore.js";
import type { HandlerContext } from "./handlerContext.js";

// ── Staleness Gate ────────────────────────────────────────────────────────────

function checkStaleness(repoId: string, store: GraphStore): void {
  try {
    const staleness = getRepoStaleness(repoId, store);
    if (staleness.isStale) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Index is stale for repo '${repoId}'. ${staleness.note}. Please run index_repository with mode='incremental' before querying impact.`
      );
    }
  } catch (error) {
    // If we can't determine staleness (e.g., not a git repo), allow the query
    if (error instanceof McpError) {
      throw error;
    }
    // Silently allow if staleness check fails for other reasons
  }
}

// ── formatChangeContextPayload ────────────────────────────────────────────────
// Shared by impactHandler and searchHandler (get_symbol_context_pack)

export function formatChangeContextPayload(
  result: ReturnType<GraphStore["getChangeContext"]>,
  profile: ReturnType<typeof resolveResponseProfile>
): unknown {
  if (profile === "nano") {
    const topCallers = result.callers.slice(0, 10).map((x) => ({ fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance, confidence: x.confidence ?? null }));
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
    return {
      symbol: result.symbol ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line } : null,
      callers: result.callers.map((x) => ({ fromId: x.fromId, fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance, confidence: x.confidence ?? null, reason: x.reason ?? null })),
      callees: result.callees.map((x) => ({ toId: x.toId, toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null, reason: x.reason ?? null })),
      typeDeps: result.typeDeps.map((x) => ({ toId: x.toId, toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null, reason: x.reason ?? null })),
      graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary
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
      confidence: e.confidence ?? null
    }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, chainLength: rows.length, path: pathNodes, truncated: rows.length > pathNodes.length }, profile);
  }
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, edges: rows }, profile);
}

// ── find_impact_files ─────────────────────────────────────────────────────────

export function handleFindImpactFiles(
  args: { repoId: string; filePath: string; limit: number; view: "files" | "surface"; groupBy: "file" | "module"; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  // Staleness gate: check if index is stale before impact analysis
  checkStaleness(args.repoId, store);

  if (args.view === "surface") {
    const result = store.getImpactSurface(args.repoId, args.filePath, args.limit);
    if (profile === "nano") {
      const callers = result.callers;
      const topItems = callers.slice(0, 10).map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, edgeType: x.edgeType }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalCallers: callers.length, topItems, hasMore: callers.length > topItems.length }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result }, profile);
  }
  const result = store.getImpactFiles(args.repoId, args.filePath, args.limit);
  if (args.groupBy === "module") {
    const filePaths = result.impactedFiles.map((f) => f.filePath);
    const grouped = store.groupFilesByModule(filePaths);
    const moduleGroups = Object.entries(grouped).map(([module, files]) => ({ module, fileCount: files.length, topFiles: files.slice(0, 5) }));
    if (profile === "nano") {
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalModules: moduleGroups.length, topModules: moduleGroups.slice(0, 5), hasMore: moduleGroups.length > 5 }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, moduleGroups, graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary }, profile);
  }
  if (profile === "nano") {
    const topFiles = result.impactedFiles.slice(0, 10).map((f) => ({ filePath: f.filePath, symbolCount: (f as { symbolCount?: number }).symbolCount ?? null }));
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalFiles: result.impactedFiles.length, topFiles, hasMore: result.impactedFiles.length > topFiles.length }, profile);
  }
  return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result }, profile);
}

// ── get_change_context ────────────────────────────────────────────────────────

export function handleGetChangeContext(
  args: { repoId: string; symbolId?: string; name?: string; callerDepth: number; calleeDepth: number; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  
  // Staleness gate: check if index is stale before impact analysis
  checkStaleness(args.repoId, store);
  
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  let resolvedSymbolId = args.symbolId;
  if (!resolvedSymbolId && args.name) {
    const context = store.getContextByName(args.repoId, args.name, args.limit);
    if (!context.symbol) {
      return ctx.asText({ symbol: null, callers: [], callees: [], typeDeps: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, note: "symbol not found" }, queryName: args.name }, profile);
    }
    resolvedSymbolId = context.symbol.symbolId;
  }
  const result = store.getChangeContext(args.repoId, resolvedSymbolId!, args.callerDepth, args.calleeDepth, args.limit);
  return ctx.asText(formatChangeContextPayload(result, profile), profile);
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
  return ctx.asText(result, profile);
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

// ── get_folder_summary ────────────────────────────────────────────────────────

export function handleGetFolderSummary(
  args: { repoId: string; folderPath: string; maxFiles: number },
  ctx: HandlerContext
): CallToolResult {
  return ctx.asText(ctx.store.getFolderSummary(args.repoId, args.folderPath, args.maxFiles));
}

// ── route_map ────────────────────────────────────────────────────────────────

export function handleRouteMap(
  args: { repoId: string; filePathPrefix?: string; httpMethod?: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const routes = store.getRouteMap(args.repoId, args.filePathPrefix ?? null, args.httpMethod ?? null, args.limit);
  if (profile === "nano") {
    const topRoutes = routes.slice(0, 10).map((r) => ({ method: r.httpMethod, route: r.routeTemplate, handlerName: r.handlerName, filePath: r.filePath }));
    return ctx.asText({ repoId: args.repoId, count: routes.length, topRoutes, hasMore: routes.length > topRoutes.length }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: routes.length, routes: routes.map((r) => ({ filePath: r.filePath, controllerName: r.controllerName, handlerName: r.handlerName, httpMethod: r.httpMethod, routeTemplate: r.routeTemplate, line: r.line })) }, profile);
  }
  if (profile === "verbose") {
    const byMethod = routes.reduce<Record<string, number>>((acc, row) => { acc[row.httpMethod] = (acc[row.httpMethod] ?? 0) + 1; return acc; }, {});
    return ctx.asText({ repoId: args.repoId, count: routes.length, routes, summary: { byMethod } }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: routes.length, routes }, profile);
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
  args: { repoId: string; mode: "search" | "stale" | "coverage"; query?: string; symbolIds?: string[]; filePath?: string; limit: number },
  ctx: HandlerContext
): CallToolResult {
  if (!ctx.constants.DOCS_TOOLS_ENABLED) {
    throw new McpError(ErrorCode.InvalidParams, "query_docs: docs lane is disabled. Set CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true to enable docs tools.");
  }
  const { store } = ctx;
  if (args.mode === "search") return ctx.asText(store.searchDocs(args.repoId, args.query!, args.limit));
  if (args.mode === "stale") return ctx.asText(store.findStaleDocs(args.repoId, args.symbolIds!));
  return ctx.asText(store.findDocCoverage(args.repoId, args.filePath!));
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
