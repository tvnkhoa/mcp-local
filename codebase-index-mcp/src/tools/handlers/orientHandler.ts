import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { classifyIntent } from "../../services/analysis/orient.js";
import type { HandlerContext } from "./handlerContext.js";

// ── orient (ENH-F) ──────────────────────────────────────────────────────────────
// Deterministic intent router (NO LLM — see src/orient.ts). Classifies a free-text task
// and returns the recommended MCP tool(s), caveats, and resolved seed symbols so the agent
// starts on the right tool instead of defaulting to Grep/Read.

export function handleOrient(
  args: { repoId?: string; intent: string; seed?: string; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const { matches, fallback } = classifyIntent(args.intent);

  // Merge recommendations across matched rules, de-duplicated by tool name (first wins).
  const toolSeen = new Set<string>();
  const recommendedTools: { tool: string; why: string; args?: Record<string, unknown> }[] = [];
  for (const rule of matches) {
    for (const t of rule.recommendedTools) {
      if (toolSeen.has(t.tool)) continue;
      toolSeen.add(t.tool);
      recommendedTools.push(t);
    }
  }
  const caveats = [...new Set(matches.flatMap((r) => r.caveats))];

  // Resolve the seed to concrete symbols when a repo is given.
  let seedSymbols: { symbolId: string; name: string; kind: string; filePath: string; score: number }[] = [];
  if (args.seed && args.repoId) {
    seedSymbols = store
      .getSymbolCandidates(args.repoId, args.seed, 5, "intent")
      .map((c) => ({ symbolId: c.symbolId, name: c.name, kind: c.kind, filePath: c.filePath, score: c.score }));
    if (seedSymbols.length === 0) {
      caveats.push(`seed '${args.seed}' did not resolve to an indexed symbol — verify the name or re-index.`);
    }
  } else if (args.seed && !args.repoId) {
    caveats.push("seed provided without repoId — pass repoId to resolve seedSymbols.");
  }

  const classifiedAs = fallback ? ["fallback"] : matches.map((r) => r.id);

  if (profile === "nano") {
    return ctx.asText(
      {
        intent: args.intent,
        classifiedAs,
        recommendedTools: recommendedTools.map((t) => t.tool),
        seedSymbolCount: seedSymbols.length,
        fallback
      },
      profile
    );
  }

  return ctx.asText(
    {
      intent: args.intent,
      classifiedAs,
      recommendedTools,
      seedSymbols,
      caveats,
      fallback
    },
    profile
  );
}
