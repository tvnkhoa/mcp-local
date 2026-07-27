---
description: "Use the codebase-index MCP for code analysis: index repos, search symbols, trace calls, find blast radius, and run safe refactors. MCP-first — always query before reading files."
argument-hint: "[repoId or path] [task: index|search|impact|refactor|health]"
---

# Codebase Index MCP

Use this when asked to analyze code structure, find symbols, trace dependencies, check change impact, or run safe refactors. The MCP server maintains a live SQLite graph of symbols and edges — always query it before reading files directly.

## Step 0 — Resolve repoId

Run `list_repositories` to get registered repos and their exact `repoPath` strings. Copy the path verbatim — do not rewrite drive-letter casing or slash style.

## Step 1 — Health Check

```
health_check(repoId: "<repoId>")
```

If `shouldReindex: true` or the repo is not found, run:

```
index_repository(
  repoId: "<repoId>",
  repoPath: "<exact path from list_repositories>",
  mode: "incremental",
  docsMode: "off",
  profile: "compact"
)
```

## Core Workflows

### Find a symbol
```
search_symbols(repoId, query: "ExactIdentifierToken", strategy: "name", profile: "compact")
→ get_symbol_context_pack(repoId, name: "ExactIdentifierToken")   // callers + callees + change context in one call
```

Use `strategy: "name"` first. Fall back to `strategy: "intent"` only if name returns 0 results. Max 2 rewrites.

### Analyze change impact
```
find_impact_files(repoId, changedFiles: ["src/foo.ts"], depth: 2, profile: "compact")
link_tests_to_source(repoId, filePath: "src/foo.ts", minScore: 0.7)
```

### Trace execution flow
```
search_symbols → get callable symbolId
trace_execution_flow(repoId, entrySymbolId: "<id>", maxDepth: 4)
get_call_chain(repoId, symbolId: "<id>", direction: "callers", depth: 3)
```

Note: use a **callable** symbolId (function/method), not a class or module-level id.

### Safe refactor (always preview → apply → rollback)
```
// Step 1: Preview
refactor_replace_preview(repoId, searchPattern: "oldName", replacePattern: "newName",
  scope: { filePaths: ["src/**/*.ts"] })
// Returns previewId, approvalToken, hunks, riskFlags

// Step 2: Review hunks and riskFlags carefully before applying

// Step 3: Apply (requires approval token from preview)
refactor_replace_apply(previewId, approvalToken, includeLowConfidence: false)

// Step 4: Rollback if needed
refactor_replace_rollback(applyId)
```

Approval tokens expire in 30 minutes. Re-run preview if expired.

### Code quality checks
```
dead_code_scan(repoId, filePathPrefix: "src/")
detect_circular_dependencies(repoId, mode: "module")
```

## MCP-First Rules

1. Query MCP before reading files — `search_symbols` → `get_symbol_context_pack` → targeted file read
2. Use `profile: "compact"` for most calls; `profile: "nano"` for high-volume queries
3. Soft cap: 5 MCP calls per question; hard cap: 8 with fallback
4. Baseline tools (`grep`, `read_file`) allowed only after 2 failed MCP attempts
5. If fallback is used, log the gap to `docs/mcp-codebase-index-issue-registry.md`

## Tool Reference

| Category | Tools |
|----------|-------|
| Health & Index | `health_check`, `index_repository`, `list_repositories`, `watch_repo` |
| Search | `search_symbols`, `get_symbol_context_pack`, `get_file_context`, `find_symbol_at_line` |
| Structure | `get_file_summary`, `get_folder_summary`, `find_entry_points`, `route_map` |
| Impact | `find_impact_files`, `detect_changes`, `get_change_context`, `link_tests_to_source` |
| Graph | `get_call_chain`, `trace_execution_flow`, `find_implementations`, `get_cross_repo_impact` |
| Quality | `dead_code_scan`, `detect_circular_dependencies`, `get_symbol_blame` |
| Refactor | `refactor_replace_preview`, `refactor_replace_apply`, `refactor_replace_rollback`, `refactor_symbol_migration` |
| Advanced | `query_graph`, `rename_assist`, `query_docs` |

## Response Contract

Include in every analysis response:
- MCP calls used (tool name + key args)
- Whether fallback occurred and why
- Gate status: Discovery / Scope / Confidence — passed or failed
- Target repoId(s) explicitly stated
