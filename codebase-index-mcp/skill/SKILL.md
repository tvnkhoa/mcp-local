---
name: {{KEY}}
description: "Code graph + docs index, no LLM. Use before grep/read for code structure: where is X defined, callers/callees of X, blast radius of a change, which tests to run, rename/bulk refactor with preview+rollback, dead code, cycles, HTTP routes, implementations, grep with enclosing symbol, files mentioning X, a doc section by heading, where is X documented, stale docs. Not for files outside indexed repos."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`. Query the graph before reading files.

## Step 0 — repo, freshness, route

```
list_repositories()                       // repoId + the exact repoPath string
health_check(repoId)                      // staleness, dirty tree, shouldReindex
orient(repoId, intent: "<what you are trying to do>", seed?: "<identifier>")
```

- Reuse `repoPath` **verbatim** — another drive-letter case or slash style fails the allowlist.
- `orient` is the router: recommended tools, arguments and caveats for an intent. Ask it rather than
  guessing.
- No need to re-index before asking: read tools refresh to HEAD + working tree first. A response with
  `freshness.state: "refreshing"` came from the previous index — ask again shortly. `mode: "full"` is
  only needed after a parser upgrade.

## Pick the tool

| Question | Tool |
|---|---|
| Where is `Foo` defined | `search_symbols(query: "Foo", strategy: "name")` → `get_symbol_context_pack(repoId, name: "Foo")` |
| Show its code | `get_symbol_source(repoId, symbolId \| name)` — not `read_file` |
| Grep a pattern | `search_regex(repoId, pattern, filePathPrefix?)` — with the enclosing symbol |
| Which files mention X | `search_regex(repoId, pattern, outputMode: "files")` |
| One doc section | `query_docs(repoId, mode: "section", filePath, headingPrefix)` — by heading, not line range |
| Who calls / what it calls | `get_call_chain(repoId, symbolId, direction: "callers" \| "callees", depth)` |
| What breaks if I change a file | `find_impact_files(repoId, filePath, view: "files" \| "surface")` |
| Tests to run after my edit | `change_impact(repoId)` |
| Risk triage before merge | `detect_changes(repoId, policy: "release-gate")` |
| Stack trace line → symbol | `find_symbol_at_line(repoId, filePath, line)` |
| Mirror an existing feature | `get_feature_bundle(repoId, seedSymbol: "<ExistingFeature>")` |
| Anything else over the graph | `query_graph(repoId, sql)` — read-only, uses `:repoId` |

`search_symbols` is a token matcher, not semantic search: pass an exact identifier. With only a
business phrase, find the identifier with `search_regex` first; `strategy: "intent"` only when
`"name"` returns nothing.

## Safe refactor (preview → apply → rollback)

```
rename_assist(repoId, symbolId, newName, emitPreview: true)        // repo-wide textual scan
refactor_replace_preview(repoId, find, replaceExpression, findMode: "literal" | "regex")
// both return previewId + approvalToken + hunks + riskFlags — show the user, then:
refactor_replace_apply(previewId, approvalToken, includeLowConfidence?)
refactor_replace_rollback(rollbackId)
```

- Top-level identifiers have no owner type, so their hunks are low-confidence: apply with
  `includeLowConfidence: true`. `ambiguous_target` sites are never applied.
- `refactor_symbol_migration` / `change_value_representation`: `dryRun: true` first, then pass
  `previewId` + `approvalToken` back with `dryRun: false`.
- Tokens expire (30 min) — re-preview, never reuse an old token.

## Docs

`query_docs(repoId, mode, …)`: `search` (needs `query`), `section`, `cites`, `links` (broken links,
orphans), `behind` / `stale` (docs older than the code they mention), `drift` (identifiers the graph
lacks — candidates to review), `coverage`, `language`. In `search` rows, `matchTier: "broad"` on every
row means "nothing exact". An index built before the docs lane answers empty: re-index with
`mode: "full"`.

## Guardrails

- No LLM, by policy — never relax it.
- `watch_repo` only during an active coding session; `action: "stop"` when done.
- `compact` is the default profile; `nano` for big lists.
- `link_tests_to_source`: pass `minScore: 0.7` (0.55 links are name-similarity only).
- `find_impact_files(view: "surface")` at confidence 0.75 is a TYPE_REF, not a direct call; say so.
- `dead_code_scan` misses runtime wiring (DI, reflection, route registration) — check before deleting.

Setup, env vars and troubleshooting: see `codebase-index-mcp/README.md`.

## Tool reference

{{TOOL_LIST}}
