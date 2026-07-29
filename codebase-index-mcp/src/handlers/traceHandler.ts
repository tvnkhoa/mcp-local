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
import { resolveResponseProfile } from "../response/responseFormatter.js";
import { buildCoverageBlock } from "../response/coverage.js";
import type { HandlerContext } from "./handlerContext.js";

export function handleTraceExecutionFlow(
  args: { repoId: string; entrySymbolId: string; maxDepth: number; maxNodes: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = store.traceExecutionFlow(args.repoId, args.entrySymbolId, args.maxDepth, args.maxNodes);
  if (!result.entrySymbol) {
    throw new McpError(ErrorCode.InvalidParams, `trace_execution_flow: entry symbol '${args.entrySymbolId}' not found in repo '${args.repoId}'.`);
  }
  const coverage = buildCoverageBlock({ resultCount: result.nodes.length, truncated: result.truncated, kind: "execution_flow", query: result.entrySymbol.name });
  if (profile === "nano") {
    return ctx.asText({ entrySymbol: { name: result.entrySymbol.name, filePath: result.entrySymbol.filePath }, nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated, topCallees: result.edges.slice(0, 10).map((e) => e.toName), coverage: coverage.confidence }, profile);
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
