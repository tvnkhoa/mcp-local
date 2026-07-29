# MCP-First Cheatsheet (1 Page)

Use this as a fast operator guide for `codebase-index-mcp` and `postgres-mcp` work.

## Repo Targets

1. `codebase-index-mcp`
2. `mcp-local`
3. `wec.communication-hub` (reference)

Always reuse exact `repoPath` from `list_repositories` before `index_repository`.

## Fast Runbooks

### A) Analyze symbol impact

1. `search_symbols(strategy: "name")`
2. `get_symbol_context_pack(name: "<identifier>")`
3. `find_impact_files(view: "files", groupBy: "module")`
4. `get_symbol_source(name or symbolId)` — exact code via MCP; `read_file` only for non-symbol regions

### B) Orient a new area

1. `get_folder_summary(folderPath: "<layer>")`
2. `get_file_summary(filePath: "<top candidate>")`
3. `find_impact_files(view: "surface")`

### C) Re-index safely

1. `health_check(repoId)`
2. `list_repositories`
3. `index_repository(mode: "full", docsMode: "on")`
4. `health_check(repoId)`

Report: runId, mode, filesIndexed, symbolsUpserted, edgesUpserted, parseFailures.

### D) Pre-release risk triage

1. `detect_changes(policy: "release-gate", sortBy: "risk")`
2. For high-risk files: `find_impact_files(view: "surface")`
3. `link_tests_to_source(minScore: 0.7)`

### E) Postgres read check

1. `mcp_health_check`
2. `mcp_run_read_query` with bounded `limit`

### F) Refactor / rename inside MCP (preview-gated, reversible)

Rename a symbol/param:
1. `search_symbols(strategy: "name")` → symbolId
2. `rename_assist(symbolId, newName, emitPreview: true)` → previewId + approvalToken
3. `refactor_replace_apply(previewId, approvalToken, includeLowConfidence: true)`
4. `refactor_replace_rollback(rollbackId)` if needed

Pattern/signature edit across sites:
1. `refactor_replace_preview(findMode: "regex", find, replaceExpression with $1)` (scope with `includePaths`)
2. `refactor_replace_apply` → `refactor_replace_rollback` if needed

## Do / Do Not

Do:
1. Use MCP-first for discovery and impact.
2. Keep calls bounded (`limit`, `profile: "compact"`).
3. Stop when evidence is sufficient.

Do not:
1. Start with broad `grep_search` or repo-wide scans.
2. Repeat equivalent symbol queries more than 2 rewrites.
3. Use fallback without documenting repeated pattern in issue registry.

## Fallback Rule

Fallback is allowed only if:
1. MCP empty/low-confidence after 2 focused attempts.
2. High unresolved graph ratio affects correctness.
3. User asks baseline-first.

When fallback happens:
1. State why.
2. Keep it narrow.
3. Return to MCP path immediately.
4. If repeated pattern, update `mcp-codebase-index-issue-registry.md`.

## Final Answer Checklist

1. Calls used.
2. Gate status (when applicable).
3. Fallback yes/no (+ issue ID if logged).
4. Evidence sufficiency + residual uncertainty.
5. Target repoId(s).
