# Tool Decision Tree

Quick guide for AI agents: which tool to use, in what order, with which profile.

---

## Step 0: Always Start With Index Health

```
health_check(repoId)
  → shouldReindex: true  → index_repository(mode: "incremental", docsMode: "off")
  → shouldReindex: false → proceed
```

---

## Task-Oriented Flowchart

### Goal: Understand callers/callees of a symbol

```
search_symbols(query: "<identifier>", strategy: "name", profile: "nano")
  → got symbolId
      → get_symbol_context_pack(symbolId, profile: "compact")   ← use for quick overview
      → get_change_context(symbolId, callerDepth: 2, profile: "compact")  ← use for deep caller list
```

### Goal: Orient in an unfamiliar module or file

```
get_folder_summary(repoId, folderPath, profile: "compact")
  → identify the key files
      → get_file_summary(repoId, filePath, profile: "compact")  ← per file
      → get_file_context(repoId, filePath, profile: "compact")  ← if you need all symbols+edges
```

### Goal: Assess blast radius before a change

```
search_symbols(query: "<symbol>", strategy: "name", profile: "nano")
  → symbolId
      → find_impact_files(symbolId, view: "files", profile: "nano")   ← file count + top files
      → find_impact_files(symbolId, view: "surface", profile: "compact")  ← caller surface per symbol
```

### Goal: Safe refactoring

```
find_impact_files(symbolId, view: "files", profile: "nano")  ← scope check
  → affectedFileCount acceptable?
      YES → refactor_replace_preview(searchPattern, replacePattern, profile: "nano")
              → check totalMatches + affectedFileCount
              → if acceptable → refactor_replace_preview(..., profile: "compact")  ← get hunk detail
              → review hunks → refactor_replace_apply(previewId, approvalToken)
              → if rollback needed → refactor_replace_rollback(applyId)
      NO  → narrow scope before proceeding
```

### Goal: Risk triage before commit/merge

```
detect_changes(repoId, policyPreset: "strict-review", profile: "compact")
  → high-risk files identified
      → find_impact_files(symbolId, view: "surface", profile: "compact")  ← caller blast radius
      → link_tests_to_source(repoId, minScore: 0.7)  ← verify test coverage
```

### Goal: Find HTTP routes

```
route_map(repoId, profile: "compact")
  → verb + path + handler symbol
      → get_symbol_context_pack(symbolId)  ← understand handler internals
```

### Goal: Find circular dependencies

```
detect_circular_dependencies(repoId, profile: "compact")
  → cycles found → get_dependency_graph(symbolId) ← trace the cycle path
```

### Goal: Cross-repo impact

```
# Ensure both repos are indexed in the same DB
list_repositories(profile: "nano")
  → both repos present → get_cross_repo_impact(symbolId, direction: "outbound")
```

---

## Profile Selection Guide

| Profile | When to use |
|---------|-------------|
| `nano` | >15 MCP calls this session; Plan mode orientation; quick routing; just need count/top-N |
| `compact` | **Default** — most analysis. All items, minimal fields, minified JSON |
| `standard` | Single targeted query where you need all fields; not in a tight token budget |
| `verbose` | Debugging unexpected results; edge case inspection |

**Refactor tools specifically**: use `nano` first (returns only `previewId`, `totalMatches`, `affectedFiles` — no hunk content). Escalate to `compact` or `standard` only when you need hunk detail.

---

## Search Strategy Guide

| Situation | Strategy |
|-----------|----------|
| You have the exact identifier name | `strategy: "name"` |
| You have a partial token or camelCase fragment | `strategy: "name"` (still works with tokens) |
| You have a business description or prose | Extract the identifier token first, then use `"name"` |
| `"name"` returns 0 results after 1 retry | `strategy: "intent"` with shorter token |
| Both return 0 results after 2 attempts | Log issue in issue registry, fall back to grep |

---

## Fallback Escalation

```
MCP tool returns empty or confidence < 0.7
  → rewrite query with different token, retry once
  → still insufficient → log to mcp-codebase-index-issue-registry.md
  → then fall back to grep/read_file for this turn
```

Max rewrites: 2 per symbol intent. After that, mandatory fallback + issue log.

---

## Call Budget

| Budget | Behavior |
|--------|----------|
| Soft cap: 5 calls/question | Default — stay within for normal questions |
| Hard cap: 8 calls/question | Only when fallback + issue logging is required |

---

## Top 5 Tools for Any New Session

1. `health_check` → verify index is fresh
2. `search_symbols` → find any symbol
3. `get_symbol_context_pack` → understand a symbol
4. `find_impact_files` → scope any change
5. `detect_changes` → risk triage before commit

For docs: see `README.md` for full tool catalog and edge type semantics. For enforcement rules: see `.github/instructions/mcp-hard-mode.instructions.md`.
