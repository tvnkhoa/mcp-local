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

`watch_repo` is a short-lived accelerator for an active implementation or debug session, nothing else.
Establish a baseline with `index_repository`, start the watcher, and **stop it the moment the feature
is PR-ready or you switch context**. Keep it off for review, release checklists and any non-coding
analysis; on-demand `index_repository` covers those. A watcher left running after the work is done is
the failure mode this section exists to prevent.

## MCP Naming Convention (Policy vs Runtime)

Short names here map to `mcp__<serverKey>__<toolName>` at runtime — `search_symbols` means
`mcp__codebase-index__search_symbols`. Execution playbooks:
`codebase-index-mcp/.claude/skills/mcp-first-codebase-operations/SKILL.md`.

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

Before any baseline tool call: the three *Enforcement Gates* have passed, or a *Fallback Condition* is
explicitly met and the registry entry is being written in the same turn.

## Tool Selection Guide

**Ask the server, not this file.** `orient(intent: "<what you are trying to do>")` returns the
recommended tools, their arguments and the caveats that apply, from a static keyword table in
`codebase-index-mcp/src/services/analysis/orient.ts`. It covers rename, blast radius, entry points,
grep-by-pattern, file structure, trace/call-flow, dead code, circular deps, docs search, stack traces,
cross-repo, tests, risk triage, freshness and the Postgres check. A thirty-row copy of that table
lived here until 2026-09-16 (MCP-ISSUE-061 Stage 2) and drifted from it — it was still recommending
`rename_assist` for renames months after that path was measured at 17-22% recall.

Four choices `orient` cannot make for you, because they are policy rather than routing:

| Situation | Rule |
|---|---|
| You need to read code | `get_symbol_source` (by symbolId or name), **not** `read_file`. Fall back to `read_file` only for non-symbol regions — config, plain text |
| You need to grep | `search_regex`, **not** baseline grep. It returns the enclosing symbol with each match, which grep cannot |
| You have a business phrase, not an identifier | `search_symbols` is a token matcher, not a semantic engine. Discover the identifier with `search_regex` first — see *Symbol Lookup Rules* below |
| The answer is already sufficient | Stop. Collecting more context after the evidence is in is the most common budget overrun |

> A task-oriented flowchart with profile heuristics lives at `codebase-index-mcp/docs/decision-tree.md`.

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
4. Repeating equivalent MCP queries more than 2 rewrites for the same symbol intent.
5. Collecting extra context after evidence is already sufficient.
6. Performing fallback without creating/updating an issue entry.
7. Repo-wide “safety scan” phrasing/actions are prohibited unless fallback conditions are met.
8. After edits, do NOT broad-scan repository for remaining references. Use MCP impact narrowing first (`search_symbols` -> `get_symbol_context_pack` or `find_impact_files` -> targeted `get_file_summary`/`read_file`).

## One-Page Quick Reference

The call sequence for each goal. Tool arguments are in each tool's own schema — read them there.
Absorbed from `MCP-FIRST-CHEATSHEET.md` (archived 2026-08-03; this file is now the single home for
MCP-first policy and its playbooks).

| Goal | Runbook |
|---|---|
| Analyze a symbol's impact | `search_symbols` → `get_symbol_context_pack` → `find_impact_files` → `get_symbol_source` |
| Orient in a new area | `get_folder_summary` → `get_file_summary` → `find_impact_files(view:"surface")` |
| Understand how a method propagates | `search_symbols` → `trace_execution_flow` → `get_call_chain` |
| Debug from a stack trace | `find_symbol_at_line` → `trace_execution_flow` or `get_change_context` |
| Re-index safely | `health_check` → `list_repositories` → `index_repository` → `health_check` |
| Gate a new feature / refactor | `detect_circular_dependencies` → `dead_code_scan` |
| Rename or bulk-edit inside MCP | `refactor_replace_preview(findMode:"regex")` → `refactor_replace_apply` → `refactor_replace_rollback` — NOT `rename_assist`, see below |
| Validate a Postgres change | `mcp__postgres-mcp__health_check` → `mcp__postgres-mcp__run_read_query` |
| Triage risk before merge | `detect_changes(policy:"release-gate")` → `find_impact_files(view:"surface")` → `link_tests_to_source` |

Always: reuse the exact `repoPath` from `list_repositories`; bound calls with `limit` and
`profile:"compact"`; stop when evidence is sufficient. Report per the *Output Contract* below.

## Required MCP-First Flow

The table above IS the flow set — it names the exact call sequence for each goal. Nine prose blocks
repeating those sequences with argument hints used to follow it; they were removed on 2026-09-16
(MCP-ISSUE-061 Stage 2) because a tool's arguments are advertised in its own schema, which the client
already has, and duplicating them here cost ~1 100 tokens in every session to restate what the tool
would tell you for free.

Two things those blocks carried that the table does not, kept here because they are live constraints:

### Renaming: do not use `rename_assist(emitPreview: true)` for a symbol used outside its own file

Use `refactor_replace_preview` directly instead:

```
1. refactor_replace_preview (findMode: "regex", find: "\bOldName\b",
                             replaceExpression: "NewName", ambiguityThresholdPercent: 100)
2. refactor_replace_apply (previewId, approvalToken, includeLowConfidence: true)
3. refactor_replace_rollback (rollbackId)   → if it must be undone
```

Measured against grep on four real symbols, `rename_assist`'s preview recall is **17–22%** (2 of 9
occurrences, 1 of 6, 2 of 10) at 100% precision with `riskFlags: []` — it scopes the preview to
`affectedFiles` from a caller/importer graph that returns 0/0 even for a plain
`import { x } from './y.js'`, so the preview looks clean and applying it leaves every other file
calling a name that no longer exists. The same symbols through `refactor_replace_preview`: 9/9 and
10/10. **MCP-ISSUE-060, still open.** `rename_assist` without `emitPreview` remains a fine advisory
read. `includeLowConfidence: true` is required for top-level identifiers, which have no enclosing
owner type.

### After a parser or indexer upgrade, not per task

Run `index_repository(mode: "full", docsMode: "on")`, then check that `find_symbol_at_line` resolves
the same symbolId for a path spelled with forward slashes and with backslashes, and that a
representative query per language in scope returns non-empty. This is a release safeguard; it is not
part of any normal task.

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
| `dead_code_scan` | Runtime-wired symbols may appear dead | Cross-check bootstrap/registration paths before reporting |
| `link_tests_to_source` | Score 0.55 links are `name_similarity` only — unreliable | Filter with `minScore: 0.7` |
| `find_impact_files` view `"surface"` | Confidence 0.75 is TYPE_REF, not direct call | Note confidence and `edgeTypes` in output |
| `find_symbol_at_line` | Often resolves declaration-level positions, not inner-block lines | Prefer declaration line or pair with one focused search |
| `get_cross_repo_impact` | Returns empty when repos have no shared symbols (normal for isolated systems) | Only useful when repos share interface/contract symbol names (e.g., shared library pattern) |
| `refactor_symbol_migration` / `change_value_representation` | **Fixed 2026-09-17.** They now require `previewId` + `approvalToken` from a prior `dryRun:true` call, like the `refactor_replace_*` trio, and refuse if the source changed since the approval | Run `dryRun:true` (the default), read the preview, pass its `previewId` and `approvalToken` back with `dryRun:false` |

### Already fixed — do not design around the old behaviour

Three "Was / Now" changelogs used to live here, for B-13 / MCP-ISSUE-043, MCP-ISSUE-060 and
MCP-ISSUE-049 — about 1 900 tokens describing behaviour that no longer exists. They were removed on
2026-09-16 (MCP-ISSUE-061 Stage 2): once a fix has landed, the current behaviour is simply what the
tools do, and the before/after record belongs where this workspace keeps measured evidence.

**`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`** is that record. Read the entry for
a tool when it behaves unexpectedly and you need to know whether this is a known defect, a fixed one,
or something new worth filing.

One item from those tables is **still open** and was kept above rather than deleted: `rename_assist`'s
17–22% preview recall (see *Renaming*, under *Required MCP-First Flow*). The other — the missing
approval gate on the two migration tools — was closed on 2026-09-17; its row now records the current
behaviour rather than the defect.

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
