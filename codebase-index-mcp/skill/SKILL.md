---
name: {{KEY}}
description: "Code graph and docs analysis via the {{DISPLAY_NAME}} (indexed SQLite graph, no LLM): find a symbol/function/class, who calls X, what X calls, blast radius of changing a file or symbol, which tests to run after my change, rename or bulk refactor with preview+rollback, dead code, circular deps, HTTP routes/endpoints, implementations of an interface, regex/literal search with the enclosing symbol, read a symbol's source, risk triage before merge; and search the docs, where is X documented, broken doc links, stale/outdated docs. Use before grep/read_file for any code-structure question. Not for semantic 'what does this mean' questions with no identifier (find the identifier first with search_regex) or for files outside indexed repos."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`. Query the graph before reading files.

## Step 0 — repo, freshness, route

```
list_repositories()                       // repoId + the exact repoPath string
health_check(repoId)                      // staleness, dirty tree, shouldReindex
orient(repoId, intent: "<what you are trying to do>", seed?: "<identifier>")
```

- Reuse `repoPath` **verbatim** — changing drive-letter case or slash style fails the
  `CODEBASE_INDEX_ALLOWED_ROOTS` allowlist.
- `orient` is the router: it returns the recommended tools, arguments and caveats for an intent, from
  the server's own table. Ask it rather than guessing a tool.
- `shouldReindex: true` → `index_repository(repoId, repoPath, mode: "incremental")`;
  `mode: "dirty"` re-indexes just the working-tree changes; `mode: "full"` after a parser upgrade.
  `docsMode` defaults to `auto` = the server setting (docs on). A stale index is not fatal: impact
  tools answer with a `staleWarning`.

## Pick the tool

| Question | Tool |
|---|---|
| Where is `Foo` defined / what is it | `search_symbols(query: "Foo", strategy: "name")` → `get_symbol_context_pack(repoId, name: "Foo")` |
| Show me its code | `get_symbol_source(repoId, symbolId \| name)` — not `read_file` |
| Grep a pattern | `search_regex(repoId, pattern, filePathPrefix?, language?)` — returns the enclosing symbol; `scanAll: true` adds json/yaml |
| Find user-facing text / error messages | `search_literals(repoId, query)` |
| Who calls / what does it call | `get_call_chain(repoId, symbolId, direction: "callers" \| "callees", depth)` |
| Execution flow from an entry point | `trace_execution_flow(repoId, entrySymbolId)` — a **callable** id, not a class |
| What breaks if I change this file | `find_impact_files(repoId, filePath, view: "files" \| "surface")` |
| Which tests to run after my edit | `change_impact(repoId)` — working-tree diff → ranked `testsToRun` |
| Risk triage before merge | `detect_changes(repoId, policy: "release-gate")` |
| Stack trace line → symbol | `find_symbol_at_line(repoId, filePath, line)` |
| Implementations / field reads+writes | `find_implementations(repoId, interfaceName)`, `find_field_accesses(repoId, name, mode)` |
| HTTP endpoints | `route_map(repoId, httpMethod?)` |
| Mirror an existing C# feature | `get_feature_bundle(repoId, seedSymbol: "ConversationNote")` |
| Dead code / cycles | `dead_code_scan(repoId)`, `detect_circular_dependencies(repoId)` |
| Anything else over the graph | `query_graph(repoId, sql)` — read-only, SQL must use `:repoId` |

`search_symbols` is a token matcher, not semantic search: pass an exact identifier. With only a
business phrase, discover the identifier via `search_regex` first; fall back to `strategy: "intent"`
only when `"name"` returns nothing.

## Safe refactor (preview → apply → rollback)

```
rename_assist(repoId, symbolId, newName, emitPreview: true)           // rename: repo-wide textual scan
refactor_replace_preview(repoId, find, replaceExpression, findMode: "literal" | "regex",
                         scope: { includePaths: ["src"] })            // bulk edit; $1 / $<name> backrefs in regex mode
// both return previewId + approvalToken + hunks + riskFlags — show the user, then:
refactor_replace_apply(previewId, approvalToken, includeLowConfidence?)
refactor_replace_rollback(rollbackId)
```

- Top-level identifiers have no owner type, so their hunks are low-confidence: pass
  `includeLowConfidence: true` on apply for them. `ambiguous_target` sites are never applied.
- `refactor_symbol_migration` / `change_value_representation`: run with `dryRun: true` (the default),
  then pass `previewId` + `approvalToken` back with `dryRun: false`.
- Tokens expire after `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS` (30 min) — re-run the preview, never
  reuse an old token. Refactors are rule-based (`llmInvolved: false`).

## Documentation — `query_docs(repoId, mode, …)`

| Mode | Answers | Needs |
|---|---|---|
| `search` | full-text over headings, prose and code blocks | `query` |
| `links` | broken doc-to-doc links, orphans, hubs | — |
| `behind` | docs whose last commit predates the code they mention | — |
| `stale` | docs mentioning these (changed) symbols | `symbolIds` |
| `drift` | docs naming identifiers the graph lacks + nearest real symbol — **candidates**, review them | — |
| `coverage` | which exported symbols of a file are documented | `filePath` |
| `language` | docs not yet normalized to English | — |

`search` rows carry `headingPath` and `matchTier`: `strict` matched every token, `broad` came from the
OR top-up — a page of `broad` rows means "nothing exact". `maxPerFile` defaults to 1;
`matchMode: "phrase"` requires adjacency; archived docs are excluded unless `includeArchived: true`.
An index built before the docs lane existed answers empty: re-index with `mode: "full"`.

## Guardrails

- **No-LLM policy (hard):** `CODEBASE_INDEX_LLM_ENABLED=true` aborts startup; never relax it.
- `watch_repo` is for an active coding session only — `action: "stop"` when done.
- `compact` is the default profile; `nano` for big lists, `standard`/`verbose` only for edge detail.
- `link_tests_to_source` links at score 0.55 are name-similarity only — pass `minScore: 0.7`.
- `find_impact_files(view: "surface")` confidence 0.75 is a TYPE_REF, not a direct call; say so.
- `dead_code_scan` misses runtime wiring (DI, reflection, route registration) — check before deleting.
- In this workspace the MCP-first call budget and fallback logging are in
  `.claude/rules/mcp-hard-mode.md`; follow it, do not restate it.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
