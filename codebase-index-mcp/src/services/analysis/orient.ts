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
    // MCP-ISSUE-060 (fixed 2026-09-17): this rule used to steer AWAY from rename_assist, because
    // its preview was scoped to the caller/importer graph and measured at 17–22% recall. The scan is
    // now repo-wide, verified hunk-for-hunk against refactor_replace_preview, and guarded by
    // test:refactor-engine §3.12 — so rename_assist is the shorter path again.
    id: "rename",
    keywords: ["rename", "change name", "rename symbol"],
    recommendedTools: [
      { tool: "rename_assist", why: "resolves the identifier from the symbolId and previews a repo-wide rename (parity with refactor_replace_preview)", args: { emitPreview: true } },
      { tool: "refactor_replace_apply", why: "apply the preview with its previewId + approvalToken (use includeLowConfidence:true for top-level identifiers)" },
      { tool: "refactor_replace_rollback", why: "undo an applied change by rollbackId" }
    ],
    caveats: [
      "rename_assist without emitPreview is a read-only advisory; pass scopePaths only to narrow the scan deliberately.",
      "refactor_replace_preview(findMode:'regex') is the equivalent path when you have a pattern rather than a symbolId.",
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
      { tool: "query_docs", why: "full-text over indexed markdown: headings, prose sections and fenced blocks", args: { mode: "search" } }
    ],
    caveats: [
      "an index built before the prose lane (MCP-ISSUE-061 Stage 4) has no prose rows — re-run index_repository(mode:'full', docsMode:'on') if body text never matches.",
      "matches are lexical, not semantic: rows labelled matchTier:'broad' came from the OR top-up, not a full match; pass contentTypes:['heading','prose'] to exclude code samples."
    ]
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
      { tool: "link_tests_to_source", why: "uncommitted change: tests reaching the dirty files (imports, components, workspace packages) + a vitest command per package", args: { forWorkingTreeDiff: true } },
      { tool: "change_impact", why: "ranked tests-to-run for a committed range (baseRef) + residual-risk note" },
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

/**
 * Release I2 (MCP-ISSUE-083) — compound rules. A keyword rule above fires on any one phrase and the
 * table ranks by hit count, so a question naming TWO things ("tests" + "my diff", "cites" + "#737")
 * lost to whichever single-phrase rule shared a word with it (`where is` → find-symbol, `what breaks`
 * → blast-radius, `adr` → docs-search), or matched nothing. A compound rule needs one signal from
 * EVERY group, and a matched compound rule ranks ahead of every keyword rule, in table order.
 *
 * The signals are generic shapes, never repo names: an endpoint / controller / route path plus a
 * consumer or other-repo word; tests plus a working-tree word; a definition word plus a numbered doc
 * (`docs/10`) or a registry; a citation verb plus a decision number, an ADR or a markdown file.
 *
 * Matching runs on {@link normalizeIntent}: lower-case with diacritics folded, so Vietnamese matches
 * with or without its marks ("trích dẫn" and "trich dan" are the same text here).
 *
 * `seed` reads the question once more — the folded, case-preserving text — for the argument the first
 * tool keys on (an action name, a canonical name, a citation target). Still a pure function of the
 * string: regular expressions only, no model, no I/O.
 */
type CompoundRule = {
  rule: IntentRule;
  all: RegExp[][];
  seed?: (folded: string) => { args: Record<string, unknown>; why?: string } | null;
};

/** A route path such as `/customers/global-search` — a leading slash after a space, quote or paren. */
const ROUTE_PATH = /(?:^|[\s"'`(])(\/[a-z0-9_{][\w\-{}:./]*)/i;

/** The last two-hump segment (PascalCase / camelCase) of the first identifier that has one. */
function identifierSeed(folded: string): { name: string; qualified: string } | null {
  for (const token of folded.match(/[A-Za-z_][\w.]*/g) ?? []) {
    const segments = token.split(".").filter(Boolean);
    const humped = segments.filter((seg) => /^[A-Z][a-z0-9]+[A-Z]/.test(seg) || /^[a-z][a-z0-9]*[A-Z]/.test(seg));
    const last = humped[humped.length - 1];
    if (last) return { name: last, qualified: segments.join(".") };
  }
  return null;
}

function routePathSeed(folded: string): string | null {
  const m = ROUTE_PATH.exec(folded);
  if (!m?.[1]) return null;
  const path = m[1].replace(/[.,;:?!]+$/, "");
  // A file path ("/src/app.ts") is not a route.
  if (/\.[a-z0-9]{1,5}$/i.test(path) || !/[a-z]/i.test(path)) return null;
  return path;
}

const COMPOUND_RULES: CompoundRule[] = [
  {
    // R11: "tests for my diff". Before: nothing matched it (fallback), or the keyword `tests` rule did.
    rule: {
      id: "tests-for-diff",
      keywords: [],
      recommendedTools: [
        { tool: "link_tests_to_source", why: "tests reaching the working-tree diff (imports, components, workspace packages), with one test-runner command per package — returned to run yourself, nothing is executed", args: { forWorkingTreeDiff: true } },
        { tool: "change_impact", why: "the committed equivalent: ranked tests-to-run for a baseRef range + residual-risk note" }
      ],
      caveats: [
        "forWorkingTreeDiff reads the diff from git, so it takes no filePath (the two are exclusive); minScore defaults to 0.7 in this mode.",
        "the per-package commands are returned, never run."
      ]
    },
    all: [
      [/\btests?\b/, /\bspecs?\b/],
      [
        /\buncommitted\b/, /\bunstaged\b/, /\bdiff\b/, /\bedit(?:ed|s)?\b/, /\bjust (?:changed|modified|touched|wrote)\b/,
        /\b(?:my|current|local|pending|staged|working[- ]tree) changes?\b/, /\bworking[- ]tree\b/,
        /\bthay doi\b/, /\bvua sua\b/, /\bchua commit\b/, /\bdang sua\b/
      ]
    ]
  },
  {
    // R5: "who cites decision #737", "what does CLAUDE.md cite". Before: `adr` sent it to docs-search.
    rule: {
      id: "doc-citations",
      keywords: [],
      recommendedTools: [
        { tool: "query_docs", why: "the repo's own citations (.codebase-index/citations.json) in markdown, code comments and opted-in string literals — target lists everything citing it, filePath lists what that file cites, each resolved to file:line", args: { mode: "cites" } }
      ],
      caveats: [
        "target is matched with the repo's own citation patterns, so write the shorthand the repo writes (wec.aria cites a decision as '15 #737'); a target no pattern matches is tried as a file path. A repo with no citations.json has no citations."
      ]
    },
    all: [
      [/\bcit(?:e|es|ed|ing)\b/, /\bcitations?\b/, /\breferenc(?:es|ed|ing)\b/, /\btrich dan\b/, /\bdan chieu\b/],
      [/#\d+/, /\badr[/\- ]?\d+/, /\bdocs?\/\d+/, /\.mdx?\b/, /\bdecisions?\b/, /\bspec-\d+/]
    ],
    seed: (folded) => {
      const outgoing = /\b(?:what|which)\b.*?\b(?:does|do)\s+(\S+?)\s+cite\b/i.exec(folded);
      if (outgoing?.[1]) return { args: { filePath: outgoing[1].replace(/^[`'"]|[`'"]$/g, "") } };
      const target =
        /\bdocs?\/\d+[\w.-]*\s*#\d+[a-z]?/i.exec(folded) ??
        /\badr[/-]\d+/i.exec(folded) ??
        /\bspec-\d+/i.exec(folded) ??
        /(?:\bdecisions?\s+)?#\d+[a-z]?/i.exec(folded) ??
        /[\w.\-/]+\.mdx?\b/i.exec(folded);
      return target ? { args: { target: target[0] } } : null;
    }
  },
  {
    // R4: "where is kb_version_ids defined in docs/10". Before: `where is` sent it to find-symbol.
    rule: {
      id: "doc-term",
      keywords: [],
      recommendedTools: [
        { tool: "query_docs", why: "one canonical name answered from the repo's registry doc (registryDoc in .codebase-index/citations.json): the table rows that define it with their section, the lines that only mention it, and the Zod keys that declare it", args: { mode: "term" } },
        { tool: "find_field_accesses", why: "reads and writes of the name in code" }
      ],
      caveats: [
        "query is matched exactly against the first cell of the registry's table rows; without query, mode:'term' is the reverse report (Zod keys the registry does not define).",
        "a repo with no registryDoc in citations.json has no registry to answer from — use query_docs mode:'search'."
      ]
    },
    all: [
      [/\bdefin(?:e|ed|es|ing|ition)\b/, /\bcanonical\b/, /\bregistry\b/, /\bglossary\b/, /\bten nay\b/, /\bten chuan\b/, /\bdinh nghia\b/],
      [/\bdocs?\/\d+/, /\bcanonical\b/, /\bregistry\b/, /\bglossary\b/]
    ],
    seed: (folded) => {
      const snake = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/.exec(folded);
      if (snake) return { args: { query: snake[0] } };
      const ticked = /`([^`\s]+)`/.exec(folded);
      return ticked?.[1] ? { args: { query: ticked[1] } } : null;
    }
  },
  {
    // R9: "what breaks in Aria if VehicleController.GetListOwnedVehicle changes". Before: blast-radius,
    // whose same-repo find_impact_files cannot see an HTTP consumer in another repo.
    rule: {
      id: "endpoint-consumers",
      keywords: [],
      recommendedTools: [
        { tool: "get_cross_repo_impact", why: "with direction:'inbound' on a controller action (name or symbolId, or its file via filePath) it lists the consumers in other repos whose endpoint matches the action's route — HttpClient calls and declared JS/TS route sources — with file:line, route and match kind", args: { direction: "inbound" } },
        { tool: "route_map", why: "find the action that serves a route path, when you have the path rather than the action" },
        { tool: "find_impact_files", why: "same-repo dependents of the action, which the cross-repo view does not list" }
      ],
      caveats: [
        "a name shared by several symbols answers through the one that carries an endpoint contract; with more than one carrier it returns status 'ambiguous' listing every candidate — pass the chosen symbolId then.",
        "cross-repo links are written by the consumer repo's run: index the provider first, then the consumer."
      ]
    },
    all: [
      [/\bendpoints?\b/, /controllers?\b/, /\broutes?\b/, /\bapi (?:call|route|endpoint)s?\b/, ROUTE_PATH],
      [
        /\bbreaks?\b/, /\bbroken\b/, /\bwho calls\b/, /\bcallers?\b/, /\bconsumers?\b/, /\bwho (?:uses|consumes|depends)\b/,
        /\bimpact\b/, /\baffect(?:s|ed)?\b/, /\bother repos?\b/, /\banother (?:repo|service|app)\b/, /\bcross[- ]repo\b/,
        /\bhong\b/, /\bai goi\b/, /\banh huong\b/
      ]
    ],
    seed: (folded) => {
      const ident = identifierSeed(folded);
      if (ident) {
        const why = ident.qualified !== ident.name
          ? `seed: ${ident.qualified} → name '${ident.name}' (pass its symbolId instead if the name is shared)`
          : `seed: name '${ident.name}'`;
        return { args: { name: ident.name }, why };
      }
      const route = routePathSeed(folded);
      if (route) {
        return {
          args: { name: `<the action serving ${route}>` },
          why: `seed: route ${route} — resolve it to its action with route_map, then pass that action's name or symbolId`
        };
      }
      return null;
    }
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

/** Diacritics folded (NFD minus combining marks; `đ` is a letter of its own, not a mark), case kept. */
export function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/** The text every rule matches against: diacritics folded, lower-case. */
export function normalizeIntent(text: string): string {
  return foldDiacritics(text).toLowerCase();
}

function applySeed(compound: CompoundRule, folded: string): IntentRule {
  const seeded = compound.seed?.(folded);
  if (!seeded) return compound.rule;
  const [first, ...rest] = compound.rule.recommendedTools;
  if (!first) return compound.rule;
  const why = seeded.why ? `${first.why}. ${seeded.why}` : first.why;
  return { ...compound.rule, recommendedTools: [{ ...first, why, args: { ...first.args, ...seeded.args } }, ...rest] };
}

/**
 * Deterministic classification. Compound rules whose every group matches come first, in table order;
 * then the keyword rules, ranked by number of distinct keyword hits (ties keep table order).
 */
export function classifyIntent(intent: string): ClassifyResult {
  const folded = foldDiacritics(intent);
  const text = folded.toLowerCase();

  const compound = COMPOUND_RULES
    .filter((c) => c.all.every((group) => group.some((re) => re.test(text))))
    .map((c) => applySeed(c, folded));

  const scored = INTENT_RULES.map((rule) => {
    const hits = rule.keywords.filter((k) => text.includes(k)).length;
    return { rule, hits };
  })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  const matches = [...compound, ...scored.map((s) => s.rule)];
  if (matches.length === 0) {
    return { matches: [FALLBACK], fallback: true };
  }
  return { matches, fallback: false };
}
