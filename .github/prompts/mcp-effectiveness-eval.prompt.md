---
tools:
  - codebase-index-central
description: >
  Portable evaluation prompt for any workspace to compare code analysis without MCP vs with MCP.
  Designed for deterministic environments with no LLM model available.
  Uses only file search/read and MCP graph tools, then reports accuracy, effort, and token estimate.
---

# MCP Codebase-Index Effectiveness Evaluation (No LLM Mode)

## Scope

This prompt is workspace-agnostic and can run on any repository.

- Baseline track: only structural tools (`file_search`, `grep_search`, `list_dir`, `read_file`).
- MCP track: only `codebase-index-central` deterministic tools.
- No semantic inference from LLM is allowed in either track.

Inputs:

- `${repoId}`: repository id in index DB.
- `${repoPath}`: absolute path of repository root.

---

## Rules For No-LLM Execution

1. Do not guess symbols by meaning.
2. Do not use natural-language semantic expansion outside MCP `strategy: "intent"`.
3. Every claim must come from tool output.
4. If evidence is insufficient, mark `unknown` instead of inferring.

---

## Preflight

Run health first:

```json
{
  "tool": "health_check",
  "arguments": { "repoId": "${repoId}" }
}
```

If repo is stale or missing, run full re-index before Q1-Q5:

```json
{
  "tool": "index_repository",
  "arguments": {
    "repoId": "${repoId}",
    "repoPath": "${repoPath}",
    "mode": "full",
    "docsMode": "off",
    "maxFiles": 10000,
    "batchSize": 300
  }
}
```

Confirm freshness again:

```json
{
  "tool": "health_check",
  "arguments": { "repoId": "${repoId}" }
}
```

---

## Evaluation Questions (Q1-Q5)

Run in order. For each question, execute Baseline first, then MCP.

### Q1 - Identify Main Entry Points

Baseline:

- `file_search` with patterns: `**/Program.cs`, `**/Startup.cs`, `**/main.*`, `**/index.*`, `**/app.*`.
- `read_file` only for top candidates to validate true bootstrap role.

MCP:

```json
{
  "tool": "find_entry_points",
  "arguments": {
    "repoId": "${repoId}",
    "limit": 20
  }
}
```

Record:

- step count
- files opened
- correctness (`correct`, `partial`, `incorrect`, `unknown`)

Notes:

- Prefer `runtimeEntryPoints` for bootstrap files.
- Use `graphEntryPoints` as supplemental signal.

---

### Q2 - Find Callers/Impact Surface Of A Key Symbol

Pick one key symbol discovered in Q1 or a top-level handler/service in the same layer.

Baseline:

- `grep_search` by symbol name.
- `read_file` each hit to confirm actual caller/reference, not just mention.

MCP:

```json
{
  "tool": "find_impact_files",
  "arguments": {
    "repoId": "${repoId}",
    "filePath": "<key-file-path>",
    "view": "surface",
    "limit": 30
  }
}
```

Optional MCP cross-check:

```json
{
  "tool": "get_change_context",
  "arguments": {
    "repoId": "${repoId}",
    "name": "<key-symbol-name>",
    "callerDepth": 2,
    "calleeDepth": 1,
    "profile": "compact",
    "limit": 100
  }
}
```

Record baseline false positives and MCP unresolved warnings.

---

### Q3 - Blast Radius Of One Important File

Choose one domain model/DTO/config file that is reused broadly.

Baseline:

- `read_file` to extract exported symbols.
- `grep_search` usages/imports.
- manually deduplicate file list.

MCP:

```json
{
  "tool": "find_impact_files",
  "arguments": {
    "repoId": "${repoId}",
    "filePath": "<target-file>",
    "view": "files",
    "groupBy": "module",
    "limit": 50
  }
}
```

Record coverage and effort.

---

### Q4 - Understand An Unfamiliar Module Quickly

Choose one folder not previously explored.

Baseline:

- `list_dir` recursively at that folder.
- open key files with `read_file` and summarize manually.

MCP:

```json
{
  "tool": "get_folder_summary",
  "arguments": {
    "repoId": "${repoId}",
    "folderPath": "<folder-path>",
    "maxFiles": 80
  }
}
```

Then inspect one key file:

```json
{
  "tool": "get_file_summary",
  "arguments": {
    "repoId": "${repoId}",
    "filePath": "<key-file-path>"
  }
}
```

Record number of files opened vs tool calls.

---

### Q5 - Find Symbol From Business-Like Description

Example query (English-like tokens): `ConversationAssignedAI handler`.

Baseline:

- brainstorm 2-4 likely identifiers.
- run multiple `grep_search` attempts.
- verify by opening matches.

MCP step 1 (`name`):

```json
{
  "tool": "search_symbols",
  "arguments": {
    "repoId": "${repoId}",
    "query": "<query>",
    "strategy": "name",
    "profile": "compact",
    "ranked": true,
    "limit": 10
  }
}
```

MCP step 2 (`intent`) only if step 1 is empty/low confidence:

```json
{
  "tool": "search_symbols",
  "arguments": {
    "repoId": "${repoId}",
    "query": "<query>",
    "strategy": "intent",
    "profile": "compact",
    "ranked": true,
    "limit": 10
  }
}
```

MCP step 3 retry once with top suggestion if still empty.

No-LLM note:

- prefer English identifier tokens
- Vietnamese free-text queries are expected to perform weaker

---

## Scoring Table

| # | Question | Baseline Steps | MCP Steps | Baseline Files Opened | MCP Files Opened | Baseline Accuracy | MCP Accuracy | Notes |
|---|----------|----------------|----------|-----------------------|------------------|-------------------|--------------|-------|
| Q1 | Entry points | | | | | | | |
| Q2 | Caller / surface | | | | | | | |
| Q3 | Blast radius | | | | | | | |
| Q4 | Module understanding | | | | | | | |
| Q5 | Symbol by description | | | | | | | |
| Total | | | | | | | | |

Accuracy legend:

- `correct`: no critical miss
- `partial`: at least one important miss
- `incorrect`: mostly wrong mapping
- `unknown`: insufficient evidence

---

## Final Report Template

After Q1-Q5, write:

1. Token saving estimate (%):
2. Step reduction (%):
3. Accuracy delta (Baseline vs MCP):
4. Best-fit question types for MCP:
5. Cases where direct file reading is still required:
6. Recommended hybrid workflow:

Suggested hybrid workflow (no LLM):

1. `health_check`
2. `find_entry_points` or `get_folder_summary`
3. `search_symbols` (`name` then `intent` if needed)
4. `get_file_summary` / `get_change_context`
5. `find_impact_files`
6. targeted `read_file` for final verification

---

## Known Constraints

1. Graph quality depends on fresh index.
2. Some dynamic runtime patterns may not be fully captured.
3. `strategy: "intent"` is lexical/token-based, not semantic understanding.
4. If result confidence is low, verify with direct file reads.
