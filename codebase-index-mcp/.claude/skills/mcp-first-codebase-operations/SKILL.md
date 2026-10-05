---
name: mcp-first-codebase-operations
description: "Execution playbook for the codebase-index MCP tools in this workspace: which argument each tool keys on (symbolId vs name vs filePath), how to chain them without wasted calls, profile choice, and what to do when `orient` disagrees with the issue registry. Use when running analysis, impact, re-index, risk-triage or refactor calls against repoId codebase-index-mcp, mcp-local or wec.communication-hub. Policy (gates, fallback, budget, output contract) lives in .claude/rules/mcp-hard-mode.md and is not repeated here."
argument-hint: "repoId, the target symbol/file, and the goal (analysis, impact, re-index, triage, refactor)."
---

# MCP-First Codebase Operations

Two sources are already in context, and this file does not repeat them:

- `.claude/rules/mcp-hard-mode.md` holds the gates, fallback conditions, call budget, output
  contract, and the *One-Page Quick Reference* call sequences.
- `orient(repoId: "<repoId>", intent: "<what you are doing>")` returns the routing table from
  `src/services/analysis/orient.ts`. Call it first when the right tool is unclear.

This file adds what neither of those gives you: what each tool **keys on**, how to chain calls
without a wasted one, and the one docs-lane condition `orient` cannot check.

## What each tool keys on

Calls fail or return nothing when a name is passed where an id is expected. Authority:
`contracts/codebase-index.json`.

| Tool | Keys on | Get the key from |
|---|---|---|
| `search_symbols` | `query` (an identifier token), `strategy: "name"` first | — |
| `get_symbol_context_pack` | **`name`** (no symbolId parameter) | the identifier itself |
| `get_change_context`, `get_symbol_source`, `get_symbol_blame`, `find_field_accesses` | `symbolId` **or** `name` | `search_symbols` |
| `get_call_chain`, `get_symbol_detail`, `trace_execution_flow` (`entrySymbolId`), `rename_assist` | `symbolId` | `search_symbols` / `find_symbol_at_line` |
| `find_impact_files`, `get_file_summary`, `link_tests_to_source`, `find_symbol_at_line` | **`filePath`** (repo-relative). `find_impact_files` is file-scoped, not symbol-scoped | the symbol's `filePath` in a search result |
| `get_file_context` | `filePath` or `filePaths[]` (≤ 50) | — |
| `get_folder_summary` | `folderPath` | — |
| `index_repository`, `watch_repo` | `repoId` + **exact** `repoPath` | `list_repositories` |
| `detect_changes`, `change_impact` | `baseRef` / `headRef` (git refs) | — |

## Chains that avoid a wasted call

- **Symbol impact:** first `search_symbols(repoId: "codebase-index-mcp", query: "indexRepository", strategy: "name", limit: 5)`.
  Take `filePath` and `symbolId` from the result. Then run
  `find_impact_files(repoId: "codebase-index-mcp", filePath: "<filePath>", view: "surface")`, and
  call `get_symbol_source` only for the callers you will actually cite.
- **One-call context:** `get_symbol_context_pack(repoId: "codebase-index-mcp", name: "indexRepository", callerDepth: 1, calleeDepth: 1)`
  covers what search plus change-context would. Use it when the name is unambiguous.
- **Business phrase, no identifier yet:** run
  `search_regex(repoId: "codebase-index-mcp", pattern: "<literal fragment>", filePathPrefix: "src/", limit: 20)`,
  then `search_symbols` with the identifier it reveals.
- **Re-index:** follow the Re-index flow in the rules file. `health_check` already returns
  `actionHints[0].arguments` with the right `repoPath` and `mode`, so reuse them verbatim.
  `mode: "dirty"` is the cheap refresh after edits, but it never prunes. Use `mode: "full"` after a
  branch switch.
- **Risk triage:** run `detect_changes(repoId: "codebase-index-mcp", policy: "release-gate", sortBy: "risk")`.
  For each high-risk file, run `find_impact_files(view: "surface")`, then
  `link_tests_to_source(repoId: "codebase-index-mcp", filePath: "<file>", minScore: 0.7)`.
  Docs-only diffs score 0, so review them by reading.
- **Rename:** run `rename_assist(repoId: "codebase-index-mcp", symbolId: "<id>", newName: "<new>", emitPreview: true)`,
  then `refactor_replace_apply(previewId: "<id>", approvalToken: "<token>", includeLowConfidence: true)`.
  The scan is repo-wide; pass `scopePaths` only to narrow it on purpose.

## When `orient` disagrees with this file

Trust `orient` for routing; `orient.test.ts` pins its recommendations.
If it ever contradicts the registry again, the registry
(`docs/mcp-codebase-index-issue-registry.md`) wins, and `orient.ts` is the thing to fix.

One condition `orient` cannot see: `query_docs(mode: "search")` matches body text only on an index
built after MCP-ISSUE-061 Stage 4. On an older index, re-index with
`index_repository(mode: "full", docsMode: "on")`.

## Profile choice

| Profile | When |
|---|---|
| `nano` | routing only, or past ~15 calls in a session. Refactor previews give match count + files, no hunks |
| `compact` | default for every read tool |
| `standard` | one deep query where you need every field, e.g. full names in `get_call_chain` |
| `verbose` | debugging unexpected output; the only pretty-printed profile |

## Repo targets

Use `codebase-index-mcp` and `mcp-local` for work in this workspace. Use `wec.communication-hub`
only for benchmark/reference comparison, and for C# fidelity checks, where its graph is the
measured baseline.

## Authoritative reference

`.claude/rules/mcp-hard-mode.md` governs. `contracts/codebase-index.json` is authoritative for tool
names and parameters. Tool behaviour history is in
`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.
