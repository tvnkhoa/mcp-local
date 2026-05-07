---
name: mcp-first-codebase-operations
description: "Run mcp-local code exploration and impact analysis with MCP-first workflow, strict gates, and bounded fallback."
argument-hint: "Provide repoId, target symbol/file intent, and expected output (analysis, impact, re-index, DB check, or risk triage)."
---

# MCP-First Codebase Operations

## When to Use

- Investigating symbol usage, caller/callee paths, or blast radius
- Running re-index and repository health checks
- Performing risk triage before merge/release
- Mapping tests to source and validating coverage surface
- Running read-only Postgres checks for `postgres-mcp`

## mcp-local Guardrails

1. Use `repoId=codebase-index-mcp` or `repoId=mcp-local` by default for this workspace.
2. Use `repoId=wec.commnunication-hub` only for benchmark/reference comparisons.
3. Treat `.github/instructions/mcp-hard-mode.instructions.md` as policy source-of-truth for gates, blocked behaviors, and fallback rules.
4. Use this skill as execution playbook; do not duplicate full policy blocks in task output.

## Minimal Tool Set

Use the smallest MCP set needed for the task and prefer focused calls with explicit limits.

1. Health and indexing:
   - `health_check`
   - `list_repositories`
   - `index_repository`
   - `watch_repo`
2. Symbol and graph analysis:
   - `search_symbols`
   - `get_symbol_context_pack`
   - `get_change_context`
   - `trace_execution_flow`
   - `get_call_chain`
   - `find_symbol_at_line`
3. Impact and scope:
   - `find_impact_files`
   - `get_file_summary`
   - `get_file_context`
   - `detect_changes`
   - `detect_circular_dependencies`
   - `dead_code_scan`
4. Supplemental:
   - `query_docs`
   - `route_map`
   - `find_implementations`
   - `link_tests_to_source`
5. Database validation (read-only):
   - `mcp_health_check`
   - `mcp_run_read_query`

## Execution Runbooks

### 1. Analysis Runbook

1. Orient scope with one light MCP call (`find_entry_points` or `get_folder_summary`).
2. Resolve symbol with `search_symbols` (`name` first, then `intent` only if needed).
3. Narrow blast radius with `find_impact_files` and summarize with `get_file_summary`.
4. Read code only after MCP scope is sufficient.

### 2. Re-index Runbook

1. `health_check(repoId)`.
2. `list_repositories` and copy exact registered `repoPath`.
3. `index_repository(repoId, repoPath, mode: full, docsMode: on)`.
4. `health_check(repoId)` and report run summary.

### 3. Risk Triage Runbook

1. Start with `detect_changes` (policy-based risk sort).
2. For high-risk files, use `find_impact_files` (`surface`) to validate caller blast radius.
3. Use `link_tests_to_source` (`minScore >= 0.7`) for coverage linkage.

### 4. Watch Lifecycle Runbook

1. Start watch only during active implementation/debug window.
2. Stop watch immediately when feature task ends or context switches.
3. Do not leave watch running during review/release-only sessions.

### 5. Postgres Read-Check Runbook

1. Run `mcp_health_check`.
2. Run `mcp_run_read_query` with bounded `limit` and targeted SQL.
3. If source changed, run `detect_changes` to prioritize impact follow-up.

## Response Contract (Skill Output)

1. List MCP calls used.
2. Report whether fallback occurred.
3. If fallback occurred, include issue ID updated in registry.
4. State evidence sufficiency and residual uncertainty.
5. State target repoId explicitly.

## Verification Checklist

- Hard-mode policy was consulted and followed.
- MCP calls were minimal and fit the task-type runbook.
- Fallback (if any) was justified and logged with issue ID.
- Final answer included concise call trace and evidence statement.

## Done Criteria

- Skill remains execution-focused while policy remains in hard-mode instruction.
- Workflow is MCP-first, minimal, and reproducible.
- Evidence is sufficient without unnecessary context expansion.
