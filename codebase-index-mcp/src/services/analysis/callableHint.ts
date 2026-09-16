/**
 * callableHint.ts — "you passed a container, here are the callables inside it".
 *
 * MCP-ISSUE-061 Stage 2. `get_call_chain` and `trace_execution_flow` traverse CALLS edges, and a
 * class / interface / struct / module symbol has none of its own — its *methods* do. Passing the
 * container returned an empty graph that was indistinguishable from "this code calls nothing", and
 * the workspace's answer was a row in `.claude/rules/mcp-hard-mode.md` telling every agent, in every
 * session, to resolve a callable symbolId first. That is runtime knowledge being paid for in prompt
 * tokens: the agent needs it at the moment it calls wrongly, not at start-up.
 *
 * So the empty result now explains itself and names the symbols that would have worked. This runs
 * ONLY when the traversal came back empty, so it costs nothing on the normal path.
 *
 * NO-LLM CONSTRAINT: kind lookup and a file query. No model, no inference, no network.
 */

import type { GraphStore } from "../../repositories/graphStore.js";

/** Symbol kinds that own callables rather than being one. */
const CONTAINER_KINDS = new Set(["class", "interface", "struct", "record", "record struct", "module", "impl", "type"]);

/** Symbol kinds a CALLS traversal can actually start from. */
const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);

export type CallableHint = {
  reason: "container_symbol";
  message: string;
  callableCandidates: { symbolId: string; name: string; kind: string; line: number }[];
};

/**
 * Returns a hint when `symbolId` names a container, or `null` when it does not — in which case the
 * empty traversal is the honest answer and must not be dressed up as a user error.
 */
export function buildCallableHint(
  store: GraphStore,
  repoId: string,
  symbolId: string,
  limit = 10
): CallableHint | null {
  const [symbol] = store.getSymbolsByIds(repoId, [symbolId]);
  if (!symbol || !CONTAINER_KINDS.has(symbol.kind)) return null;

  const context = store.getFileContext(repoId, symbol.filePath, 200, false);
  const symbols = context.symbols as { symbolId?: string; name: string; kind: string; line: number }[];

  const callableCandidates = symbols
    .filter((s) => typeof s.symbolId === "string" && CALLABLE_KINDS.has(s.kind))
    .slice(0, limit)
    .map((s) => ({ symbolId: s.symbolId as string, name: s.name, kind: s.kind, line: s.line }));

  return {
    reason: "container_symbol",
    message:
      `'${symbol.name}' is a ${symbol.kind}, and CALLS edges belong to its members, not to it — ` +
      `an empty result here means "wrong symbol kind", not "no calls". ` +
      (callableCandidates.length > 0
        ? `Retry with one of the callable symbolIds below.`
        : `No callable members were indexed for ${symbol.filePath}; check the file was indexed.`),
    callableCandidates
  };
}
