---
name: {{KEY}}
description: "Code graph + docs index, no LLM. Use before grep/read for code structure: where is X defined, callers/callees of X, blast radius of a change, which tests to run, rename/bulk refactor with preview+rollback, dead code, cycles, HTTP routes, implementations, grep with enclosing symbol, files mentioning X, a doc section by heading, where is X documented, stale docs. Not for files outside indexed repos."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools: `{{TOOL_NAMESPACE}}`. Query the graph before reading files.

## Step 0 — repo, freshness, route

```
list_repositories()                       // repoId + exact repoPath
health_check(repoId)                      // staleness, dirty tree, shouldReindex
orient(repoId, intent: "<goal>", seed?: "<identifier>")
```

- Reuse `repoPath` **verbatim** — other drive-letter case or slashes fail the allowlist.
- `orient` is the router: recommended tools, arguments and caveats for an intent.
- No need to re-index first: read tools refresh to HEAD + working tree. `freshness.state: "refreshing"`
  = the previous index answered; ask again shortly. `mode: "full"` only after a parser upgrade.
- `index_repository` is a job: it answers `{ runId, state }`; poll `index_status(runId)` until `ok` or
  `failed` (`wait: true` blocks up to 100 s). `queued` = another run active or RAM low (`waitingFor`).
- New worktree of an indexed repo: `register_worktree(parentRepoId, repoPath, repoId)` registers it, queues
  its index job and starts its watcher (poll `index_status`).

## Pick the tool

| Question | Tool |
|---|---|
| Where is `Foo` defined | `search_symbols(query: "Foo", strategy: "name")` → `get_symbol_context_pack(repoId, name: "Foo")` |
| Its code | `get_symbol_source(repoId, symbolId \| name)` — not `read_file` |
| Grep a pattern | `search_regex(repoId, pattern, filePathPrefix?)` — with the enclosing symbol; responses carry `truncated`, plus `total` (complete) or `totalLowerBound` (capped; page with `nextAfterPath` + `skipMatches`) |
| Files mentioning X | `search_regex(repoId, pattern, outputMode: "files")` |
| One doc section | `query_docs(repoId, mode: "section", filePath, headingPrefix)` — or `headingContains` (word of the title) or `line` (section holding line N); give exactly one |
| Callers / callees | `get_call_chain(repoId, symbolId, direction: "callers" \| "callees", depth)` |
| Blast radius of a file | `find_impact_files(repoId, filePath, view: "files" \| "surface")` |
| Tests to run after an edit | `change_impact(repoId)` |
| Merge risk | `detect_changes(repoId, policy: "release-gate")` |
| Stack line → symbol | `find_symbol_at_line(repoId, filePath, line)` |
| Mirror a feature | `get_feature_bundle(repoId, seedSymbol)` |
| Anything else | `query_graph(repoId, sql)` — read-only, uses `:repoId` |

`search_symbols` is a token matcher: pass an exact identifier; with only a business phrase, find it with
`search_regex` first. `strategy: "intent"` only when `"name"` returns nothing.

## Safe refactor (preview → apply → rollback)

```
rename_assist(repoId, symbolId, newName, emitPreview: true)
refactor_replace_preview(repoId, find, replaceExpression, findMode: "literal" | "regex")
// both return previewId + approvalToken + hunks + riskFlags; show the user, then:
refactor_replace_apply(previewId, approvalToken, includeLowConfidence?)
refactor_replace_rollback(rollbackId)
```

- Top-level identifiers (no owner type) need `includeLowConfidence: true`; `ambiguous_target` sites never apply.
- `refactor_symbol_migration` / `change_value_representation`: `dryRun: true`, then `previewId` +
  `approvalToken` back with `dryRun: false`. Tokens expire in 30 min.

## Docs

`query_docs(repoId, mode, …)`: `search` (needs `query`), `section`, `cites`, `links`, `behind` / `stale`
(docs older than their code), `drift` (identifiers the graph lacks), `coverage`, `language`. `matchTier: "broad"` on every row = nothing exact. An index older than the docs lane answers
empty: re-index with `mode: "full"`.

## Guardrails

- `watch_repo` only while coding; `action: "stop"` when done. `nano` profile for big lists.
- `link_tests_to_source`: `minScore: 0.7` (0.55 = name-similarity only).
- `find_impact_files(view: "surface")` at 0.75 is a TYPE_REF, not a call.
- `dead_code_scan` misses runtime wiring (DI, reflection, routes).

Setup and env vars: see `codebase-index-mcp/README.md`.

## Tool reference

{{TOOL_LIST}}
