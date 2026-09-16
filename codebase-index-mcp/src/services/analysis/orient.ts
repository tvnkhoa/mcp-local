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
    // MCP-ISSUE-060: this used to recommend `rename_assist(emitPreview:true)` — the one path the
    // registry says NOT to take. Its preview scopes to an `affectedFiles` graph that returns 0/0
    // even for a plain `import { x } from './y.js'`, measured at 17–22% recall against grep, so the
    // preview looks clean and applying it leaves other files calling a name that no longer exists.
    id: "rename",
    keywords: ["rename", "change name", "rename symbol"],
    recommendedTools: [
      { tool: "refactor_replace_preview", why: "regex rename across ALL occurrences; rename_assist's preview misses most of them (MCP-ISSUE-060, open)", args: { findMode: "regex", ambiguityThresholdPercent: 100 } },
      { tool: "refactor_replace_apply", why: "apply the preview (use includeLowConfidence:true for top-level identifiers)" },
      { tool: "refactor_replace_rollback", why: "undo an applied change by rollbackId" }
    ],
    caveats: [
      "do NOT use rename_assist(emitPreview:true) for a symbol used outside its own file — 17–22% recall.",
      "top-level identifiers have no enclosing owner — pass includeLowConfidence:true on apply."
    ]
  },
  {
    id: "entry-points",
    keywords: ["entry point", "entrypoint", "bootstrap", "where does it start", "start up", "starts up", "main", "startup", "wired up"],
    recommendedTools: [
      { tool: "find_entry_points", why: "inventory of entry points", args: { kind: "route_handler" } },
      { tool: "get_folder_summary", why: "per-file symbol/caller counts to spot the hubs, without reading files" }
    ],
    caveats: ["kind:'route_handler' narrows to HTTP; omit it for the broader inventory."]
  },
  {
    id: "grep-pattern",
    keywords: ["grep", "pattern", "regex", "todo", "fixme", "string literal", "config key", "search text", "find text"],
    recommendedTools: [
      { tool: "search_regex", why: "MCP-native grep: matches with context lines AND the enclosing symbol", args: { scanAll: false } },
      { tool: "search_literals", why: "string/interpolated/template literals specifically" }
    ],
    caveats: ["scanAll:true also walks non-code text (json/yaml).", "use this to discover an exact identifier token before search_symbols — that tool is a token matcher, not semantic."]
  },
  {
    id: "file-structure",
    keywords: ["what is in this file", "file structure", "exports", "what does this file", "overview of the file", "who imports"],
    recommendedTools: [
      { tool: "get_file_summary", why: "exports, imports and importedBy — the light call", args: { profile: "compact" } },
      { tool: "get_file_context", why: "all symbols + edges, and takes filePaths[] for up to 50 files at once" }
    ],
    caveats: ["get_file_context edges are budgeted and PROPERTY_REF is excluded — use find_field_accesses for those."]
  },
  {
    id: "dead-code",
    keywords: ["dead code", "unused", "orphan", "not called", "can i delete", "safe to remove"],
    recommendedTools: [
      { tool: "dead_code_scan", why: "public symbols with no inbound edges", args: { filePathPrefix: "src" } }
    ],
    caveats: ["symbols wired by DI, reflection or a framework registry look dead — cross-check bootstrap files before reporting."]
  },
  {
    id: "circular-deps",
    keywords: ["circular", "cycle", "dependency cycle", "import loop"],
    recommendedTools: [
      { tool: "detect_circular_dependencies", why: "fast gate before introducing a new dependency", args: { mode: "module" } }
    ],
    caveats: []
  },
  {
    id: "docs-search",
    keywords: ["documentation", "docs say", "which doc", "readme", "adr", "decision record", "is it documented"],
    recommendedTools: [
      { tool: "query_docs", why: "full-text over indexed markdown", args: { mode: "search" } }
    ],
    caveats: ["no indexer writes 'prose' sections yet (MCP-ISSUE-061), so this matches headings and fenced blocks, not body text."]
  },
  {
    id: "stack-trace",
    keywords: ["stack trace", "exception at", "crashed at", "line number", "threw at", "error at line"],
    recommendedTools: [
      { tool: "find_symbol_at_line", why: "resolve a file+line to a symbolId" },
      { tool: "get_change_context", why: "who calls into the crash point", args: { callerDepth: 2 } }
    ],
    caveats: ["resolves declaration lines most reliably; a line deep inside a body may not resolve."]
  },
  {
    id: "cross-repo",
    keywords: ["cross repo", "other repo", "shared contract", "shared interface", "another service"],
    recommendedTools: [
      { tool: "get_cross_repo_impact", why: "impact across repos in the same index", args: { direction: "outbound" } },
      { tool: "find_package_consumers", why: "who consumes a published package" }
    ],
    caveats: ["only meaningful when the repos share interface/contract symbol names; isolated systems correctly return empty."]
  },
  {
    id: "risk-triage",
    keywords: ["before merge", "before release", "risk", "release gate", "what changed", "review the diff", "pre-release"],
    recommendedTools: [
      { tool: "detect_changes", why: "changed files scored by blast radius", args: { policy: "release-gate", sortBy: "risk" } },
      { tool: "change_impact", why: "diff → dependents + covering tests" }
    ],
    caveats: ["docs-only changes score 0 — MCP cannot judge semantic risk in prose; review those by reading."]
  },
  {
    id: "db-check",
    keywords: ["database", "sql", "postgres", "query the db", "table schema", "connection"],
    recommendedTools: [
      { tool: "mcp__postgres-mcp__health_check", why: "confirm connectivity before querying" },
      { tool: "mcp__postgres-mcp__run_read_query", why: "bounded read-only SQL" }
    ],
    caveats: ["read-only by default and prod is force read-only; writes need POSTGRES_WRITE_ENABLED."]
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
