---
description: "Always-on MCP-first hard mode for codebase analysis in this workspace. Enforce codebase-index MCP usage before baseline tools, and log fallback issues for future enhancements."
name: "MCP Hard Mode"
---
> Scope: applies workspace-wide (all files). Referenced from `CLAUDE.md`.

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

1. `wec.communication-hub`

Recommended MCP target binding:

1. `repoId=codebase-index-mcp`, `repoPath=D:/1.SourceCode/mcp-local/codebase-index-mcp`
2. `repoId=mcp-local`, `repoPath=D:/1.SourceCode/mcp-local`
3. `repoId=wec.communication-hub`, `repoPath=D:/1.SourceCode/crm/wec.communication-hub`

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

Policy in this file uses short tool names. At execution time, Claude Code namespaces
every MCP tool as `mcp__<serverKey>__<toolName>`:

- Codebase index tools → `mcp__codebase-index__<tool>` (e.g. `mcp__codebase-index__search_symbols`).
- PostgreSQL tools → `mcp__postgres-mcp__<tool>` (e.g. `mcp__postgres-mcp__run_read_query`, `mcp__postgres-mcp__health_check`).

So a short name like `search_symbols` in this document means the runtime tool
`mcp__codebase-index__search_symbols`.

Reference: execution playbooks live in `codebase-index-mcp/.claude/skills/mcp-first-codebase-operations/SKILL.md`.

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

> Quick reference: see `codebase-index-mcp/docs/decision-tree.md` for a task-oriented flowchart with profile heuristics and fallback escalation steps.

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
| DB connectivity check | `mcp__postgres-mcp__health_check` | Fast validation before DB read query |
| DB read validation | `mcp__postgres-mcp__run_read_query` | Read-only verification for Postgres tooling |

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

## One-Page Quick Reference

Compressed index of the flows below — scan this, then read the matching flow for the exact calls.
Absorbed from `MCP-FIRST-CHEATSHEET.md` (archived 2026-08-03; this file is now the single home for
MCP-first policy and its playbooks).

| Goal | Runbook | Detailed flow |
|---|---|---|
| Analyze a symbol's impact | `search_symbols` → `get_symbol_context_pack` → `find_impact_files` → `get_symbol_source` | *Standard flow* |
| Orient in a new area | `get_folder_summary` → `get_file_summary` → `find_impact_files(view:"surface")` | *Orientation flow* |
| Understand how a method propagates | `search_symbols` → `trace_execution_flow` → `get_call_chain` | *Execution trace flow* |
| Debug from a stack trace | `find_symbol_at_line` → `trace_execution_flow` or `get_change_context` | *Stack trace debug flow* |
| Re-index safely | `health_check` → `list_repositories` → `index_repository` → `health_check` | *Re-index Request Flow* |
| Gate a new feature / refactor | `detect_circular_dependencies` → `dead_code_scan` | *Health gate flow* |
| Rename or bulk-edit inside MCP | `rename_assist(emitPreview:true)` → `refactor_replace_apply` → `refactor_replace_rollback` | *Refactor / rename flow* |
| Validate a Postgres change | `mcp__postgres-mcp__health_check` → `mcp__postgres-mcp__run_read_query` | *Postgres tool check flow* |
| Triage risk before merge | `detect_changes(policy:"release-gate")` → `find_impact_files(view:"surface")` → `link_tests_to_source` | *Pre-release risk scan flow* |

Always: reuse the exact `repoPath` from `list_repositories`; bound calls with `limit` and
`profile:"compact"`; stop when evidence is sufficient. Report per the *Output Contract* below.

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
Rename a symbol/param — use refactor_replace_preview DIRECTLY, not rename_assist:
1. refactor_replace_preview (findMode: "regex", find: "\bOldName\b",
                             replaceExpression: "NewName", ambiguityThresholdPercent: 100)
2. refactor_replace_apply (previewId, approvalToken, includeLowConfidence: true)
   → includeLowConfidence is needed for top-level identifiers (no enclosing owner type)
3. refactor_replace_rollback (rollbackId)  → if the change must be undone

   DO NOT use `rename_assist(emitPreview: true)` for a symbol used outside its own file.
   Measured against grep on four real symbols: recall 17–22% (2 of 9 occurrences, 1 of 6,
   2 of 10), precision 100%, `riskFlags: []`. It scopes the underlying preview to
   `affectedFiles` from a caller/importer graph that returns 0/0 even for a plain
   `import { x } from './y.js'`, so the preview looks clean and applying it leaves every
   other file calling a name that no longer exists. The same two symbols through
   `refactor_replace_preview` directly: 9/9 and 10/10. Tracked as MCP-ISSUE-060, open.
   `rename_assist` without `emitPreview` is still fine as an advisory read.

Pattern / signature edit across many sites:
1. refactor_replace_preview (findMode: "regex", find: "<pattern>", replaceExpression: "<$1 template>")
   → regex with capture-group substitution ($1, $&); scope with includePaths to bound it
2. refactor_replace_apply (previewId, approvalToken)
3. refactor_replace_rollback (rollbackId) if needed

Prefer this over baseline multi-file find/replace: it is preview-gated, HMAC-approved, and reversible.
```

### Postgres tool check flow (when task touches `postgres-mcp`)
```
1. mcp__postgres-mcp__health_check
   → confirm MCP server + PostgreSQL connectivity
2. mcp__postgres-mcp__run_read_query (targeted read-only SQL, bounded limit)
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
- `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`

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
| `find_impact_files` view `"surface"` | Confidence 0.75 is TYPE_REF, not direct call | Note confidence and `edgeTypes` in output |
| `find_symbol_at_line` | Often resolves declaration-level positions, not inner-block lines | Prefer declaration line or pair with one focused search |
| `get_cross_repo_impact` | Returns empty when repos have no shared symbols (normal for isolated systems) | Only useful when repos share interface/contract symbol names (e.g., shared library pattern) |

### Fixed by B-13 / MCP-ISSUE-043 (2026-08-05) — `requiredOwnerType` changed meaning

| Was | Now |
|---|---|
| `requiredOwnerType` / `guards.allowOwnerTypes` meant "sites **within** the declaring type": the owner was the class the code sits in, so a member's external call sites were rejected naming each *caller's* own class. The workaround was to give up the guard and use `refactor_replace_preview` | The owner is proven from the C# AST — the type that **owns** the referenced member. Static (`Codec.M`), instance, `this`, `base`, namespace-qualified and one-hop-nested (`a.B.M`) receivers all resolve, so a migration reaches a member's consumers. Non-C# files still use the enclosing-type text scan, labelled `enclosing_type_fallback` |
| A site whose owner could not be inferred was **dropped** by the guard, indistinguishable from "not found" | It is **kept**, flagged `ambiguous_target` (so it cannot apply) and explained in `ambiguousReasons`, which names the rule that failed. Only a proven *different* owner lands in `rejectedSites`. Expect `totalMatches` to be higher than before, with `unresolvedOccurrences` accounting for the difference |
| `refactor_replace_preview` surfaced neither `rejectedSites` nor `ambiguousReasons`, so a guard that dropped every site read as an empty result | Both are in the response (counts at `nano`, detail above it) |

### Fixed by MCP-ISSUE-060 (2026-08-25) — do not work around these any more

| Was | Now |
|---|---|
| `find_impact_files` reported `totalImpactedCount: 0` for a class whose callers all reach it through its interface, while `get_symbol_context_pack` reported 14 for the same class in the same session. `expandInterfaceSiblingsImpl` was imported by four impact modules and called by none | Both views expand the queried file's symbols through their interface siblings. Measured on `wec.be`: 0 → 11 callers. Takes effect on the EXISTING index — no re-index needed |
| `get_symbol_context_pack(name:…)` pooled callers across every same-named symbol, so `CreateMessageAsync` returned **16** callers of which 15 were other methods' | Callers and importers are scoped to the selected symbol, as callees always were. 16 → 1, matching `get_call_chain`. `candidates[]` still lists the homonyms |
| An unknown `repoId` returned `edges: []` with `coverage.confidence:"high"`, or `graphHealth.note:"graph data complete"`, or a clean `rowCount: 1` from `query_graph` | Refused with `not_found` naming the repoId, by every tool that takes one. `health_check` and `index_repository` still answer for an unregistered repo, by design |
| A file absent from the index answered `{"symbolCount":0,"exports":[]}` — indistinguishable from an empty file | `find_impact_files` carries `fileIndexed: false` and says an empty result means "not indexed", not "no dependents" |
| `detect_changes` with a `baseRef` git cannot resolve reported `changedFileCount: 0, highRiskCount: 0, note:"using git range diff"` | Fails with `INVALID_PARAMS` naming the ref. Working-tree mode on a non-git directory still returns empty, which is correct there |
| `detect_changes` `changedFileCount` was the post-cap page length — 100 against a real 300, cut alphabetically so a whole server was invisible | `changedFileCount` is the true count; `changedFilesReturned` and `changedFilesDroppedByLimit` describe the page |
| `search_symbols` at `compact` — the documented default — omitted `symbolId`, which `get_call_chain` requires | `symbolId` at every profile |
| `search_symbols(ranked: true)` with no `repoId` returned 0 for every query and every strategy | Cross-repo ranked search works. An unknown repoId still returns nothing |
| `route_map` and `get_call_chain` reported truncation only at `nano`; at `compact` a 44-hop chain looked like 5 | `hasMore` / `chainLength` / `truncated` at every profile |
| `get_file_context{profile:"standard"}` returned 68 663 chars for a 22-symbol C# file — past the token cap. 96% was edges, half of them `PROPERTY_REF` | Edges have their own budget (40), property refs are excluded (use `find_field_accesses`), structural edges are kept first, `edgesTruncated` says so. 70 526 → 21 070 chars |
| `search_regex` could not see `.claude/` or `.github/` in ANY mode, `scanAll` included | Both the search walk and the indexer walk pass `dot: true`. The indexer half needs a re-index per repo |
| `dead_code_scan` reported the program's own `main` on a Python repo, `suppressed.total: 0` | A language whose lane records no CALLS edges anywhere in the repo is suppressed as `language_lane_has_no_call_edges`. `wec.rag` Python: 0 candidates, 294 suppressed |
| `refactor_symbol_migration` / `change_value_representation` advertised `readOnlyHint: true` while `dryRun:false` wrote files | Annotated `destructiveHint: true` unconditionally. They still lack the HMAC gate the `refactor_replace_*` trio has — see MCP-ISSUE-060, open |
| A bare-name match that happened to land on an interface method was labelled `resolved interface method` at 0.8, indistinguishable from a receiver-proven one. On `wec.be`, 986 of 2070 such edges named a method two or more interfaces declare | Name-derived ones are `resolved interface method (unproven receiver)` and count as name-only provenance, so a traversal standing on them cannot report `high`. **Applies on the next index run** |

### Fixed by MCP-ISSUE-049 (2026-08-04) — do not work around these any more

| Was | Now |
|---|---|
| `get_call_chain` compact returned `fromId`/`toId` only, so a second call was needed per hop | Every profile carries `symbolId` + name + file on each hop |
| `get_dependency_graph{profile:"nano"}` `topEdges` carried names only, so distinct edges sharing a name pair read as duplicates and an unresolved target named nothing at all | `topEdges` carries `fromId`/`toId` in both the `filePath` and `symbolId` branches |
| `query_docs{mode:"stale"}` still returned archived-doc false positives after the `code_call` fix, because `doc_mentions` was append-only — a relabel inserted a row and the legacy `backtick` row outlived every re-index | The docs lane is replace-per-file. One re-index with `docsMode:"on"` genuinely clears them |
| `get_symbol_detail`, `find_symbol_at_line`, `get_folder_summary` and `find_entry_points` accepted `profile` but never advertised it, so a client honouring `additionalProperties:false` had to reject it (MCP-ISSUE-051) | All **38** profile-taking tools advertise it. A parity test now compares every tool's zod key set against its advertised `properties`, in both directions |
| `find_impact_files{view:"surface"}` listed a caller once per edge type | One row per caller→symbol pair, with `edgeTypes[]` — **an array**, and the scalar `edgeType` is gone |
| `find_impact_files{view:"surface"}` silently ignored `groupBy` | `groupBy:"module"` groups, and the response echoes `groupBy` |
| `query_docs` returned an object for `search` and bare arrays for `stale`/`coverage` | All three modes return `{ repoId, mode, count, results }` |
| `query_docs{mode:"search"}` mixed code symbols into doc results | Opt-in via `includeSymbols:true`; off by default |
| `query_docs{mode:"stale"}` matched identifiers inside pasted code samples | Code-block mentions are a separate `code_call` type, excluded from staleness; `includeCodeMentions:true` opts in. **Takes effect on re-index** — this one changes how mentions are written, not just read |
| Six tools had no way to exclude test files | `excludeTests` on `find_implementations`, `route_map`, `search_literals`, `get_symbol_context_pack`, `get_value_contract_impact`, `get_feature_bundle` (default `false`) |
| Intent ranking put EF migration `Up`/`Down` on top of every business-phrase query | Migrations are demoted below tests as the **primary** sort key; an explicit name query still finds them |
| `health_check` without `repoId` reported `symbolsIndexed: 0` | Repo-scoped counters are omitted, `scope:"server"` and a `note` say why |
| `repo://…/routes`, raw `query_graph` rows and `rename_assist.hints` returned backslashes | One convention everywhere: forward slashes |
| `get_file_context` and `get_file_summary` disagreed on `symbolCount` | Both exclude the module pseudo-symbol |
| `rename_assist` advisory omitted the declaring file | `affectedFiles`/`affectedFileCount` include it, matching `emitPreview:true` |

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
- Target repoId(s): must explicitly state whether result applies to `codebase-index-mcp`, `postgres-mcp`, `mcp-local`, `wec.communication-hub`, or a subset.
