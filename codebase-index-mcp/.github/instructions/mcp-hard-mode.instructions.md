---
description: "Always-on MCP-first hard mode for codebase analysis in this workspace. Enforce codebase-index MCP usage before baseline tools, and log fallback issues for future enhancements."
name: "MCP Hard Mode"
applyTo: "**"
---
# MCP Hard Mode (Workspace Level)

This file is the single source of truth for MCP-first operating rules in this workspace.

Enforcement posture:
1. Use the default rules here for normal coding, analysis, and review sessions.
2. For risky refactor, release, or incident-debug work, tighten behavior within this file's existing hard gates and fallback rules instead of switching to a separate profile document.
3. Do not maintain parallel profile documents with duplicated policy content.

## Workspace Repo Profiles

Primary targets in this workspace:

1. `codebase-index-mcp`
2. `postgres-mcp`

Reference and benchmark target (optional):

1. `wec.commnunication-hub`

Recommended MCP target binding:

1. `repoId=codebase-index-mcp`, `repoPath=D:/1.SourceCode/mcp-local/codebase-index-mcp`
2. `repoId=mcp-local`, `repoPath=D:/1.SourceCode/mcp-local`
3. `repoId=wec.commnunication-hub`, `repoPath=D:/1.SourceCode/crm/wec.commnunication-hub`

Path normalization rule (critical):

1. Before `index_repository`, run `list_repositories` and reuse the exact registered `repoPath` string for the target `repoId`.
2. Do not manually rewrite drive-letter casing or slash style when submitting `repoPath`.
3. If `index_repository` fails with allowed-root/path mismatch, rerun with the exact `repoPath` returned by `list_repositories`.

Operational defaults (current implementation baseline):

1. Watch policy is active-repo oriented (`WATCH_ACTIVE_ONLY=true` by default).
2. Idle watcher is stopped by TTL (`WATCH_ACTIVE_TTL_MS`).
3. Watchless by default: `CODEBASE_INDEX_WATCH_AUTO_START=false` for normal operation.
4. Incremental re-index may fast-skip when indexed commit equals `HEAD` and working tree is clean.
5. `watch_repo` manual start is allowed for short debug sessions and should be stopped immediately after diagnostics.

## Re-index Request Flow (Explicit User Ask)

When user asks to re-index, run this flow:

1. `health_check(repoId)`
2. `list_repositories`
3. `index_repository`
   - use exact registered `repoPath`
   - default: `mode: "full"`, `docsMode: "on"`
4. `health_check(repoId)`
   - confirm latest run status is `ok`

Output minimums for re-index response:
1. runId
2. mode
3. filesScanned/filesIndexed
4. symbolsUpserted/edgesUpserted
5. parseFailures
6. fallback/error handling notes (if any)

## Watch Usage Playbook (Feature Lifecycle)

Use watch only as a short-lived accelerator while implementing or debugging a feature. Do not keep watchers running by default.

1. Before coding: run `index_repository` once to establish a clean baseline.
2. During active feature work: run `watch_repo` start for the target repo to capture rapid local edits.
3. During verification: use normal MCP analysis tools (`detect_changes`, `find_impact_files`, `get_symbol_context_pack`) while watch is active.
4. After feature is done (PR-ready or context switch): run `watch_repo` stop immediately.
5. If no active implementation/debug session exists: keep watch disabled and rely on on-demand `index_repository`.

Practical intent:
1. Watch ON = short implementation/debug window.
2. Watch OFF = normal operation, review, and release flow.

Anti-pattern (avoid):
1. Starting watch and leaving it running after feature work is done.
2. Keeping watch active during PR review, release checklist, or non-coding analysis sessions.
3. Starting watch without a clear implementation/debug objective for the current repo.
4. Using watch as a substitute for explicit `index_repository` baseline checkpoints.

## MCP Naming Convention (Policy vs Runtime)

Policy in this file uses short aliases. Tool execution must use concrete runtime MCP names.

1. Codebase index aliases:
   - `health_check` -> `mcp_codebase-inde_health_check`
   - `list_repositories` -> `mcp_codebase-inde_list_repositories`
   - `index_repository` -> `mcp_codebase-inde_index_repository`
   - `watch_repo` -> `mcp_codebase-inde_watch_repo`
   - `search_symbols` -> `mcp_codebase-inde_search_symbols`
   - `get_symbol_context_pack` -> `mcp_codebase-inde_get_symbol_context_pack`
   - `get_symbol_source` -> `mcp_codebase-inde_get_symbol_source`
   - `find_impact_files` -> `mcp_codebase-inde_find_impact_files`
   - `rename_assist` -> `mcp_codebase-inde_rename_assist`
   - `refactor_replace_preview` -> `mcp_codebase-inde_refactor_replace_preview`
   - `refactor_replace_apply` -> `mcp_codebase-inde_refactor_replace_apply`
   - `get_file_summary` -> `mcp_codebase-inde_get_file_summary`
   - `get_file_context` -> `mcp_codebase-inde_get_file_context`
   - `detect_changes` -> `mcp_codebase-inde_detect_changes`
2. PostgreSQL aliases:
   - `mcp_health_check` -> `mcp_postgres-mcp_health_check`
   - `mcp_run_read_query` -> `mcp_postgres-mcp_run_read_query`

Reference: execution playbooks live in `.github/skills/mcp-first-codebase-operations/SKILL.md`.

## Hard Rules
1. For codebase analysis tasks, use MCP codebase-index tools first.
2. Do not start with baseline tools (`grep_search`, `file_search`, `read_file`) unless one of the fallback conditions is met.
3. Keep MCP calls focused and bounded (`limit`, `profile: "compact"`) to control token usage.
4. Do not use broad baseline scans (repo-wide grep/file search) before completing the required MCP-first flow.
5. For each user question, complete MCP discovery and impact steps before any code read, except when editing a file explicitly provided by the user.
6. If fallback is used, issue logging is mandatory in the same turn before continuing deeper baseline exploration.
7. For documentation-only change review, baseline review is allowed by default because MCP (no-LLM mode) is not reliable for semantic risk detection in docs.
8. If previous turn had MCP-policy violation, next turn must start with explicit recovery: `health_check` -> required MCP-first flow for the new ask.
9. Apply the correct flow by task type:
   - Analysis/refactor/debug -> Enforcement Gates.
   - Operational request (re-index/health/watch) -> Re-index Flow or Watch Usage.

## Per-Turn Compliance Self-Check (Mandatory)

Before any baseline tool call, verify and satisfy:
1. Discovery gate already passed.
2. Scope gate already passed.
3. Confidence gate already passed, or fallback condition is explicitly met.
4. If fallback is used, issue entry update is prepared in the same turn.
5. No duplicate MCP query with equivalent intent beyond rewrite limit.
6. Tool names in execution plan map to concrete MCP runtime names.

## Tool Selection Guide

> Quick reference: see `DECISION-TREE.md` for a task-oriented flowchart with profile heuristics and fallback escalation steps.

| Intent | Preferred tool | Notes |
|--------|---------------|-------|
| Bootstrap / entry points | `find_entry_points` | `kind: "route_handler"` for HTTP routes |
| Orient new module | `get_folder_summary` | Returns per-file symbolCount/callerCount without reading |
| Look up exact symbol name | `search_symbols` strategy `"name"` | Use source-level identifier token, not prose |
| Look up by token fragment | `search_symbols` strategy `"intent"` | Keep query short and identifier-like |
| Grep source by pattern / discover an identifier token | `search_regex` | MCP-native replacement for `grep_search`: returns matches with context + enclosing symbol. `scanAll=true` for non-code text (json/yaml). Use to find exact symbol names before `search_symbols`. |
| Full context for one symbol | `get_symbol_context_pack` | Single call: candidates + callers + callees + change-context |
| Callers/callees drill-down | `get_change_context` | Use `profile: "compact"`, callerDepth ≤ 2 |
| Call chain traversal | `get_call_chain` | Must use callable symbolId (function/method), not container symbol |
| Execution sub-graph | `trace_execution_flow` | Use callable symbolId from `search_symbols` or `find_symbol_at_line` |
| Who uses this file | `find_impact_files` view `"files"` | Blast radius grouped by module |
| What calls into this file | `find_impact_files` view `"surface"` | Caller surface per symbol |
| File structure + exports | `get_file_summary` | Shows exports, imports, importedBy |
| Read a symbol's exact code | `get_symbol_source` | Source span from disk by symbolId/name — use INSTEAD of baseline `read_file`; `contextLines` to widen |
| Bulk pattern / signature edit | `refactor_replace_preview` findMode `"regex"` | Capture-group substitution ($1, $&) in `replaceExpression`; then apply → rollback |
| Execute a rename | `rename_assist` emitPreview `true` | Returns applyable preview (previewId + token); apply with `includeLowConfidence: true` for top-level identifiers |
| Dead public symbols | `dead_code_scan` | Entry points wired by runtime/DI may appear dead; manual verify required |
| Circular deps check | `detect_circular_dependencies` | Fast gate before implementing new dependency |
| Test ↔ source mapping | `link_tests_to_source` | Use `minScore: 0.7` for reliable results |
| Docs search | `query_docs` mode `"search"` | Full-text across indexed markdown/docs |
| Stack trace line → symbolId | `find_symbol_at_line` | Best for declaration lines; inner-block lines may not resolve |
| Multi-file symbol map | `get_file_context` | Use `filePaths` array (up to 50 files); profile=compact; richer than `get_file_summary` — returns all symbols + edges |
| Cross-repo shared contracts | `get_cross_repo_impact` | direction: `"outbound"`/`"inbound"`; only useful when repos share interface/symbol names |
| Pre-release risk triage | `detect_changes` | policy: `"quick-triage"`/`"strict-review"`/`"release-gate"`; sortBy: `"risk"`; compares working tree vs last indexed commit |
| DB connectivity check | `mcp_health_check` | Fast validation before DB read query |
| DB read validation | `mcp_run_read_query` | Read-only verification for Postgres tooling |

## Symbol Lookup Rules (Critical)

`search_symbols` is **NOT a semantic search engine**. It is a token-based identifier matcher.

Rules:
1. Use exact identifier tokens from the target language/module: `indexRepository`, `detect_changes`, `SqlGuardrails`, not narrative prose.
2. If you only have a business description (Vietnamese or English), extract the likely identifier token first via one of:
   - A narrow `search_regex` (MCP-native, preferred) scoped with `filePathPrefix`/`language` to discover exact symbol names; fall back to baseline `grep_search` only if MCP is unavailable.
   - Infer from project naming convention (`verbNoun`, `PascalCase`, or known tool name).
3. After finding the identifier, use `search_symbols` strategy `"name"` for exact match (score ≥ 0.9).
4. Fall back to strategy `"intent"` only if `"name"` returns 0 results; rewrite with shorter token fragment.
5. Max 2 rewrite attempts. If still empty, use `grep_search` as fallback and log issue.

No-LLM acceptance note:
- Q5-style business phrase lookup is not expected to match baseline semantic quality.
- Success criteria in no-LLM mode is: discover identifier token, then resolve correct symbol via `search_symbols` strategy `"name"`.

## Enforcement Gates (Hard)
Applicability note:
1. These gates are mandatory for code analysis/change-impact tasks.
2. For explicit operational requests (`re-index`, `health_check`, `watch_repo`), use the dedicated operational flow instead of symbol-oriented gates.

Baseline tools are blocked until ALL gates pass:
1. Discovery gate:
   - Run at least one of: `find_entry_points` or `get_folder_summary`
   - Run `search_symbols` with `strategy: "name"` (using identifier token)
   - Exception: if identifier token is unknown, allow one narrow `grep_search` bootstrap to discover token, then return to MCP path immediately
2. Scope gate:
   - Run at least one of: `find_impact_files` (view `"files"` or `"surface"`)
   - Run `get_file_summary` for each key target file
3. Confidence gate:
   - If MCP evidence is sufficient, continue MCP-only or minimal decisive `read_file`
   - If MCP evidence is insufficient, fallback is allowed only under Fallback Conditions below

Confidence interpretation standard:
1. Consider MCP evidence low-confidence when confidence < 0.7 on critical impact links, or when only TYPE_REF exists where direct CALLS evidence is required.
2. Prefer one additional focused MCP query before baseline fallback.

## Blocked Behaviors
1. Starting with `grep_search`, `file_search`, or large `read_file` ranges before MCP gates complete.
2. Using natural-language phrases as `search_symbols` query (will always return 0 results).
3. Using `trace_execution_flow` or `get_call_chain` with class-level symbolId (returns empty graph).
4. Repeating equivalent MCP queries more than 2 rewrites for the same symbol intent.
5. Collecting extra context after evidence is already sufficient.
6. Performing fallback without creating/updating an issue entry.
7. Repo-wide “safety scan” phrasing/actions are prohibited unless fallback conditions are met.
8. After edits, do NOT broad-scan repository for remaining references. Use MCP impact narrowing first (`search_symbols` -> `get_symbol_context_pack` or `find_impact_files` -> targeted `get_file_summary`/`read_file`).

## Required MCP-First Flow

### Standard flow (symbol known)
```
1. search_symbols (strategy: "name", identifier token)
   → get symbolId for the matched symbol
2. get_symbol_context_pack (name: "<identifier>")
   → one call: candidates + callers + callees + change context
3. find_impact_files (view: "files", groupBy: "module")
   → blast radius scoped to target file
4. get_symbol_source (symbolId or name)
   → exact source span of the symbol, read from disk via MCP (NOT a baseline read_file).
     Prefer this to read the code you are about to change; use contextLines to widen.
5. read_file ONLY for non-symbol regions (config, plain text) get_symbol_source can't target
```

### Orientation flow (new module / unknown codebase area)
```
1. get_folder_summary (folderPath: "<layer>")
   → per-file symbol/caller metrics, no file reads needed
2. get_file_summary (filePath: "<high-callerCount file>")
   → exports + importedBy in one call
3. find_impact_files (view: "surface")
   → who calls into it and which methods
```

### Execution trace flow (understand how a method propagates)
```
1. search_symbols (strategy: "name") → get callable symbolId
2. trace_execution_flow (entrySymbolId: "<callable symbolId>", maxDepth: 4)
3. get_call_chain (symbolId: "<callable symbolId>", direction: "callees")
```

### Stack trace debug flow (crash line → symbol → call graph)
```
1. find_symbol_at_line (filePath: "path\\or/path/to/file", line: <N>)
   → get callable symbolId from the crash line
   NOTE: separator is normalized; forward and backslash should both resolve.
2. trace_execution_flow (entrySymbolId: "<symbolId>", maxDepth: 3)
   → full execution sub-graph from the crash point
   OR get_change_context (symbolId: "<symbolId>", callerDepth: 2)
   → who calls into this method (blast radius for the crash)
```

### Post-upgrade verification flow (only when MCP parser/indexer is upgraded)
```
1. index_repository (mode: "full", docsMode: "on")
   → refresh graph after engine/parser changes
2. find_symbol_at_line with paired paths on same target line
   - test A: filePath with forward slash
   - test B: filePath with backslash
   - PASS if both resolve the same symbolId
3. Run sample capability checks by language/domain in scope
   - TypeScript package: `search_symbols` + `get_file_summary`
   - C# sample repo (if used): `route_map` + `find_implementations`
   - PASS if representative queries return non-empty results on target repos
   NOTE: this is a release/upgrade safeguard, not a per-task mandatory step.
```

### Health gate flow (before new feature / refactor)
```
1. detect_circular_dependencies (mode: "module") → confirm 0 cycles
2. dead_code_scan (filePathPrefix: "<src path>") → find orphaned publics
   NOTE: runtime-wired symbols may appear "dead"; cross-check bootstrap/registration files before reporting.
```

### Refactor / rename flow (execute changes inside MCP — do not hand-edit each file)
```
Rename a symbol/param:
1. search_symbols (strategy: "name") → get symbolId
2. rename_assist (symbolId, newName, emitPreview: true)
   → returns previewId + approvalToken (word-boundary match across affected files)
3. refactor_replace_apply (previewId, approvalToken, includeLowConfidence: true)
   → includeLowConfidence is needed for top-level identifiers (no enclosing owner type)
4. refactor_replace_rollback (rollbackId)  → if the change must be undone

Pattern / signature edit across many sites:
1. refactor_replace_preview (findMode: "regex", find: "<pattern>", replaceExpression: "<$1 template>")
   → regex with capture-group substitution ($1, $&); scope with includePaths to bound it
2. refactor_replace_apply (previewId, approvalToken)
3. refactor_replace_rollback (rollbackId) if needed

Prefer this over baseline multi-file find/replace: it is preview-gated, HMAC-approved, and reversible.
```

### Postgres tool check flow (when task touches `postgres-mcp`)
```
1. mcp_health_check
   → confirm MCP server + PostgreSQL connectivity
2. mcp_run_read_query (targeted read-only SQL, bounded limit)
   → validate behavior without write impact
3. detect_changes (policy: "quick-triage")
   → prioritize follow-up impact checks when source has changed
```

### Pre-release risk scan flow (before merge / release)
```
1. detect_changes (policy: "release-gate", sortBy: "risk", riskLevels: ["high", "medium"])
   → list changed files with risk score sorted by impact
   NOTE: risk=0 for docs-only changes; high risk = files with many callers in graph
2. For each high-risk file → find_impact_files (view: "surface") → verify caller blast radius
3. link_tests_to_source (filePath: "<high-risk file>", minScore: 0.7) → confirm test coverage exists
4. For docs-only changed files, run baseline review (read_file + targeted grep/semantic checks)
   → assess business/rationale/regression-risk text changes that MCP risk score cannot capture
```

## Fallback Conditions (Baseline Allowed)
Baseline tools are allowed only when at least one condition is true:
1. MCP returns empty/low-confidence after 2 focused query attempts.
2. Graph health indicates unresolved edges likely affecting correctness (`unresolvedRatio > 0.3`).
3. Symbol is only discoverable via natural-language description (no identifier token known yet).
4. User explicitly requests baseline-first behavior.
5. Change set is documentation-heavy and requires semantic risk review (policy/process/decision changes) that MCP no-LLM scoring may miss.

When fallback is used:
1. Cite the specific MCP failure (empty result / low confidence / high unresolved ratio).
   - Use low-confidence threshold: confidence < 0.7 or only TYPE_REF edges for critical caller mapping.
2. Keep fallback narrowly scoped: `grep_search` with exact term, not repo-wide.
3. Return to MCP path immediately after identifier is found.

## Mandatory Issue Logging on Fallback
When fallback is used, add or update an entry in:
- `mcp-codebase-index-issue-registry.md`

Record minimum fields:
- Scenario
- Tool/query attempted (MCP)
- Expected vs actual
- Impact
- Workaround used (baseline path)
- Enhancement proposal

Operational rule:
1. Use or create a stable issue ID.
2. If the same pattern occurs 3+ times, mark as enhancement candidate.
3. Do not close analysis summary without mentioning the issue ID.

## Known Tool Limitations (Do Not Repeat These Mistakes)

| Tool | Limitation | Correct Usage |
|------|-----------|---------------|
| `search_symbols` | Single-token name match is best; long prose still weak | Use identifier tokens. For multi-word intent, `strategy: "intent"` now also works WITH `ranked: true` (returns scored candidates) — previously that combo returned 0 |
| `find_impact_files` / `get_change_context` | Stale index no longer blocks — returns data + `staleWarning` instead of erroring | No need to pre-re-index; re-index only when the warning matters for accuracy |
| `trace_execution_flow` | Container-level symbolId can return sparse graph | Resolve callable symbolId first |
| `get_call_chain` | Same as above | Use callable symbolId |
| `dead_code_scan` | Runtime-wired symbols may appear dead | Cross-check bootstrap/registration paths before reporting |
| `link_tests_to_source` | Score 0.55 links are `name_similarity` only — unreliable | Filter with `minScore: 0.7` |
| `find_impact_files` view `"surface"` | Confidence 0.75 is TYPE_REF, not direct call | Note confidence and edgeType in output |
| `find_symbol_at_line` | Often resolves declaration-level positions, not inner-block lines | Prefer declaration line or pair with one focused search |
| `get_cross_repo_impact` | Returns empty when repos have no shared symbols (normal for isolated systems) | Only useful when repos share interface/contract symbol names (e.g., shared library pattern) |

## Efficiency Limits
- Default budget: soft cap 5 tool calls per question.
- Hard cap: 8 tool calls when fallback and/or mandatory issue logging is required.
- Max 2 query rewrites for symbol discovery.
- Prefer `profile: "compact"` or `"nano"` unless debugging edge details.
- Stop as soon as evidence is sufficient.
- If call budget is exceeded, provide a short checkpoint summary before continuing.

## Output Contract
Include in final summary:
- MCP calls used
- Whether fallback occurred
- If fallback occurred: issue ID updated in registry
- Gate status: Discovery/Scope/Confidence passed or failed
- Evidence sufficiency statement and residual uncertainty (if any)
- Target repoId(s): must explicitly state whether result applies to `codebase-index-mcp`, `postgres-mcp`, `mcp-local`, `wec.commnunication-hub`, or a subset.
