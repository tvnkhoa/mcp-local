/**
 * ENH-F — `orient` intent router.
 *
 * Lowers the "which MCP tool do I even start with?" activation cost that pushes the agent
 * back to Grep/Read. Given a free-text intent it returns the recommended tool(s), caveats,
 * and (when a seed is given) resolved seed symbols.
 *
 * NO-LLM CONSTRAINT (enforced by `npm run guard:no-llm-runtime`): classification MUST be
 * pure, deterministic keyword matching — a static rule table only. Do NOT add any LLM /
 * model / network / embedding call here; the no-LLM guard will (and must) fail the build.
 */

export type IntentRule = {
  id: string;
  keywords: string[];
  recommendedTools: { tool: string; why: string; args?: Record<string, unknown> }[];
  caveats: string[];
};

const INTENT_RULES: IntentRule[] = [
  {
    id: "implement-like",
    keywords: ["implement like", "similar to", "same pattern", "mirror", "scaffold", "vertical slice", "like the", "by mirroring"],
    recommendedTools: [
      { tool: "get_feature_bundle", why: "gathers the whole slice (entity → config → commands/queries → endpoints) to copy in one call", args: { seedSymbol: "<entity>" } },
      { tool: "get_symbol_context_pack", why: "callers/callees of the seed if you need usage context too" }
    ],
    caveats: ["get_feature_bundle is a C# vertical-slice name-pattern heuristic; check unresolvedRoles."]
  },
  {
    id: "rename",
    keywords: ["rename", "change name", "rename symbol"],
    recommendedTools: [
      { tool: "rename_assist", why: "preview-gated, reversible rename across affected files", args: { emitPreview: true } },
      { tool: "refactor_replace_apply", why: "apply the preview (use includeLowConfidence:true for top-level identifiers)" }
    ],
    caveats: ["top-level identifiers have no enclosing owner — pass includeLowConfidence:true on apply."]
  },
  {
    id: "blast-radius",
    keywords: ["blast radius", "impact", "what breaks", "who depends", "downstream", "ripple", "affected by", "dependents"],
    recommendedTools: [
      { tool: "find_impact_files", why: "files/symbols that depend on the target" },
      { tool: "change_impact", why: "if you've already edited — maps the diff to dependents + covering tests" }
    ],
    caveats: ["impact reflects the indexed commit; re-index (mode='dirty') if the working tree changed.", "DI/reflection-wired types return a wiringNote instead of static callers."]
  },
  {
    id: "endpoint-inventory",
    keywords: ["endpoint inventory", "list endpoints", "routes", "api surface", "http endpoints", "route map"],
    recommendedTools: [
      { tool: "route_map", why: "mapped HTTP routes/handlers (attribute + Minimal API)" },
      { tool: "find_entry_points", why: "broader entry-point inventory if route_map is thin" }
    ],
    caveats: ["route_map covers C# attribute routing + Minimal API; non-ASP.NET dispatch won't appear."]
  },
  {
    id: "trace-flow",
    keywords: ["trace", "execution flow", "call path", "what calls", "call chain", "flows through"],
    recommendedTools: [
      { tool: "trace_execution_flow", why: "forward execution flow from an entry symbol" },
      { tool: "get_call_chain", why: "callers/callees to a fixed depth" }
    ],
    caveats: ["unresolved call edges lower coverage; reflection/DI hops are not traced."]
  },
  {
    id: "tests",
    keywords: ["test coverage", "which tests", "tests to run", "covering tests", "what tests"],
    recommendedTools: [
      { tool: "change_impact", why: "ranked tests-to-run for the current diff + residual-risk note" },
      { tool: "link_tests_to_source", why: "test→source links for a specific file" }
    ],
    caveats: ["test links are heuristic; low-score links may be missed (raise/lower testLinkMinScore)."]
  },
  {
    id: "find-symbol",
    keywords: ["find", "where is", "locate", "definition of", "search for"],
    recommendedTools: [
      { tool: "search_symbols", why: "ranked symbol search (multi-word → strategy='intent')", args: { strategy: "intent" } },
      { tool: "get_symbol_source", why: "read the exact source span once located" }
    ],
    caveats: []
  },
  {
    id: "freshness",
    keywords: ["stale", "up to date", "reindex", "re-index", "fresh", "dirty", "out of date"],
    recommendedTools: [
      { tool: "health_check", why: "reports index staleness + working-tree dirty state" },
      { tool: "index_repository", why: "mode='dirty' re-indexes only working-tree-changed files (fast extraction refresh)", args: { mode: "dirty" } }
    ],
    caveats: ["mode='dirty' skips pruning (subset scan); use mode='full' after a branch switch."]
  }
];

const FALLBACK: IntentRule = {
  id: "fallback",
  keywords: [],
  recommendedTools: [
    { tool: "search_symbols", why: "generic discovery entry point", args: { strategy: "intent" } },
    { tool: "get_symbol_context_pack", why: "callers/callees once you have a symbol" }
  ],
  caveats: ["intent unclassified; starting from generic discovery."]
};

export type ClassifyResult = { matches: IntentRule[]; fallback: boolean };

/** Deterministic keyword scoring — rules are ranked by number of distinct keyword hits. */
export function classifyIntent(intent: string): ClassifyResult {
  const text = intent.toLowerCase();
  const scored = INTENT_RULES.map((rule) => {
    const hits = rule.keywords.filter((k) => text.includes(k)).length;
    return { rule, hits };
  })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) {
    return { matches: [FALLBACK], fallback: true };
  }
  return { matches: scored.map((s) => s.rule), fallback: false };
}
