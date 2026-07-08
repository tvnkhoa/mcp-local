---
name: {{KEY}}
description: "Use the {{DISPLAY_NAME}} for code structure analysis: index repos, search symbols, trace call chains, find change blast radius, and run safe rule-based refactors. MCP-first — query the graph before reading files. Triggers on: find symbol/function/class, who calls X, impact of changing X, rename/refactor, dead code, circular deps."
---

# {{DISPLAY_NAME}}

{{TAGLINE}}

Use this whenever you analyze code structure, locate symbols, trace dependencies, assess change impact, or run safe refactors. The server keeps a live SQLite graph of symbols and edges — **always query it before reading files directly**. Tools are exposed as `{{TOOL_NAMESPACE}}`.

## Step 0 — Resolve repoId

Run `list_repositories` to get registered repos and their exact `repoPath` strings. Copy the path **verbatim** — never rewrite drive-letter casing or slash style (mismatches hit the path allowlist).

## Step 1 — Health check

```
health_check(repoId: "<repoId>")
```

If `shouldReindex: true` or the repo is unknown:

```
index_repository(repoId, repoPath: "<exact path>", mode: "incremental", docsMode: "off", profile: "compact")
```

## Core workflows

**Find a symbol**
```
search_symbols(repoId, query: "ExactIdentifier", strategy: "name", profile: "compact")
→ get_symbol_context_pack(repoId, name: "ExactIdentifier")   // callers + callees + change context in one call
```
Use `strategy:"name"` first; fall back to `strategy:"intent"` only if it returns 0. Max 2 rewrites.

**Analyze change impact**
```
find_impact_files(repoId, changedFiles: ["src/foo.ts"], depth: 2, profile: "compact")
link_tests_to_source(repoId, filePath: "src/foo.ts", minScore: 0.7)
```

**Trace execution**
```
search_symbols → callable symbolId
trace_execution_flow(repoId, entrySymbolId: "<id>", maxDepth: 4)
get_call_chain(repoId, symbolId: "<id>", direction: "callers", depth: 3)
```
Use a **callable** symbolId (function/method), not a class/module id.

**Regex / pattern search** — prefer `search_regex` (matches + context + enclosing symbol; `scanAll:true` for non-code text) over baseline grep.

**Read a symbol's source** — prefer `get_symbol_source` (by symbolId or name) over `read_file`; fall back to `read_file` only for non-symbol regions.

## Safe refactor (preview → apply → rollback)

```
refactor_replace_preview(repoId, searchPattern, replacePattern, scope: { filePaths: ["src/**/*.ts"] })
// returns previewId, approvalToken, hunks, riskFlags — review before applying
refactor_replace_apply(previewId, approvalToken, includeLowConfidence: false)
refactor_replace_rollback(applyId)   // if needed
```
For renames use `rename_assist(emitPreview:true)` then `refactor_replace_apply` (`includeLowConfidence:true` for top-level identifiers). Approval tokens expire in 30 min — re-run preview if expired. Refactors are rule-based only (`llmInvolved:false`).

## Guardrails

- **No-LLM policy (hard):** no runtime LLM calls; `CODEBASE_INDEX_LLM_ENABLED=true` aborts startup. Do not attempt to relax it.
- **Path allowlist:** only paths under `CODEBASE_INDEX_ALLOWED_ROOTS` are indexable. Reuse exact `repoPath` from `list_repositories`.
- **Watch policy:** keep `watch_repo` off except during active implementation/debug; stop immediately after.
- **Profiles:** `compact` (default) for most calls, `nano` for high-volume, `standard`/`verbose` only when you need full fields.
- **Budget:** soft cap 5 MCP calls/question, hard cap 8, then baseline grep/read fallback. Max 2 query rewrites.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
