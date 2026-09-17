---
name: {{KEY}}
description: "Use the {{DISPLAY_NAME}} for code structure AND documentation analysis: index repos, search symbols, trace call chains, find change blast radius, run safe rule-based refactors, and search/audit the docs corpus. MCP-first — query the graph before reading files. Triggers on: find symbol/function/class, who calls X, impact of changing X, rename/refactor, dead code, circular deps, search the docs, where is X documented, broken doc links, which docs are stale or out of date."
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
index_repository(repoId, repoPath: "<exact path>", mode: "incremental", docsMode: "on")
```

`docsMode: "on"` is the default since 2026-09-17. Prose sections, doc-to-doc links and document
status are written **at index time**, so an index built before that date has none of them and the
docs modes below will answer empty — a `mode: "full"` run populates them.

## Core workflows

**Find a symbol**
```
search_symbols(repoId, query: "ExactIdentifier", strategy: "name", profile: "compact")
→ get_symbol_context_pack(repoId, name: "ExactIdentifier")   // callers + callees + change context in one call
```
Use `strategy:"name"` first; fall back to `strategy:"intent"` only if it returns 0. Max 2 rewrites.

**Analyze change impact**
```
find_impact_files(repoId, filePath: "src/foo.ts", view: "files", groupBy: "module", profile: "compact")
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

## Documentation

One tool, six modes. `search` is the one you want most of the time.

```
query_docs(repoId, mode: "search", query: "read-only transaction mode")
```
Matches heading, prose and fenced-code sections. Each row carries `filePath`, `startLine`/`endLine`,
a `headingPath` breadcrumb (`file.md#H1>H2`) and `matchTier`: `strict` means it matched every query
token, `broad` means it came from the widened OR pass — treat a page of `broad` rows as "things a bit
like it", not as the answer. Archived and superseded documents are excluded; pass
`includeArchived: true` for history. `maxTokens` bounds the payload, `matchMode: "phrase"` requires
the words adjacent, `maxPerFile` (default 1) keeps one file from taking every slot.

The other five answer questions a text search cannot:

| Mode | Answers |
|---|---|
| `links` | broken doc-to-doc links, orphan documents, the most-linked hubs |
| `behind` | documents whose last commit predates the code they mention, from git, worst first |
| `drift` | documents naming an identifier the graph no longer has, paired with the nearest real symbol — **candidates to review**, not findings |
| `coverage` | which exported symbols of a file are documented |
| `language` | documents not yet normalized to English, by non-ASCII letter share per chunk |

## Safe refactor (preview → apply → rollback)

```
refactor_replace_preview(repoId, find: "oldName", replaceExpression: "newName",
                         findMode: "literal", scope: { includePaths: ["src"] })
// returns previewId, approvalToken, hunks, riskFlags — review before applying
refactor_replace_apply(previewId, approvalToken, includeLowConfidence: false)
refactor_replace_rollback(rollbackId)   // if needed
```
For renames use `rename_assist(emitPreview:true)` then `refactor_replace_apply` (`includeLowConfidence:true` for top-level identifiers). `refactor_symbol_migration` and `change_value_representation` also require approval now: run them with `dryRun: true` (the default), then pass the `previewId` and `approvalToken` back with `dryRun: false`. Approval tokens expire in 30 min — re-run preview if expired. Refactors are rule-based only (`llmInvolved:false`).

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
