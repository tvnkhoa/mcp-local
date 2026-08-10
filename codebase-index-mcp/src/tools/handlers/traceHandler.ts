/**
 * `trace_execution_flow`.
 *
 * Not a refactor handler at all - it lived in `refactorHandler.ts` only by accident, which
 * showed up as the one import in `tools/graphImpact.ts` that reached into the refactor module.
 * Its real sibling is `handleGetCallChain` in `impactHandler.ts`; it is a separate file rather
 * than appended there because that file is already near the size cap (S-41).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { buildCoverageBlock } from "../../middleware/coverage.js";
import type { HandlerContext } from "./handlerContext.js";
import type { GraphStore } from "../../repositories/graphStore.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";

/**
 * MCP-ISSUE-056: drop test-file nodes from a traced sub-graph, and the edges that pointed at them.
 *
 * A traversal is not a flat list — removing a node without removing its edges leaves hops that name a
 * symbol no longer present, which is a worse answer than either extreme. The entry symbol is always
 * kept: tracing outward FROM a test is a legitimate question, and answering it with an empty graph
 * would be silently wrong.
 */
function filterTracedTests<T extends ReturnType<GraphStore["traceExecutionFlow"]>>(
  result: T,
  excludeTests: boolean,
  entrySymbolId: string
): T {
  if (!excludeTests) return result;
  const keptNodes = result.nodes.filter((n) => n.symbolId === entrySymbolId || !isTestPath(n.filePath));
  const keptIds = new Set(keptNodes.map((n) => n.symbolId));
  return {
    ...result,
    nodes: keptNodes,
    edges: result.edges.filter((e) => keptIds.has(e.fromId) && keptIds.has(e.toId))
  };
}

export function handleTraceExecutionFlow(
  args: { repoId: string; entrySymbolId: string; maxDepth: number; maxNodes: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = filterTracedTests(
    store.traceExecutionFlow(args.repoId, args.entrySymbolId, args.maxDepth, args.maxNodes),
    args.excludeTests,
    args.entrySymbolId
  );
  if (!result.entrySymbol) {
    throw new McpError(ErrorCode.InvalidParams, `trace_execution_flow: entry symbol '${args.entrySymbolId}' not found in repo '${args.repoId}'.`);
  }
  const coverage = buildCoverageBlock({ resultCount: result.nodes.length, truncated: result.truncated, kind: "execution_flow", query: result.entrySymbol.name, edgeProvenance: result.provenance });
  if (profile === "nano") {
    // MCP-ISSUE-049: dedupe BEFORE the slice. Taking the first 10 edges and mapping to a name gave
    // `["Equals","NotifyAsync",…,"NotifyAsync","NotifyAsync"]` — NotifyAsync four times — so the cap
    // was spent on repeats and genuinely distinct callees never made the list.
    const topCallees = [...new Set(result.edges.map((e) => e.toName).filter(Boolean))].slice(0, 10);
    return ctx.asText({ entrySymbol: { name: result.entrySymbol.name, filePath: result.entrySymbol.filePath }, nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated, topCallees, distinctCalleeCount: new Set(result.edges.map((e) => e.toName).filter(Boolean)).size, coverage: coverage.confidence }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({
      entrySymbol: { symbolId: result.entrySymbol.symbolId, name: result.entrySymbol.name, kind: result.entrySymbol.kind, filePath: result.entrySymbol.filePath },
      nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated,
      nodes: result.nodes.map((n) => ({ symbolId: n.symbolId, name: n.name, kind: n.kind, filePath: n.filePath })),
      edges: result.edges.map((e) => ({ fromId: e.fromId, toId: e.toId, fromName: e.fromName, toName: e.toName, confidence: e.confidence })),
      coverage
    }, profile);
  }
  return ctx.asText({ entrySymbol: result.entrySymbol, nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated, nodes: result.nodes, edges: result.edges, coverage }, profile);
}
