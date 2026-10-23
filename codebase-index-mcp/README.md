# codebase-index-mcp

MCP server for repository indexing and code graph queries. Provides symbol search, dependency analysis, impact tracing, and rule-based refactoring — no LLM at runtime.

## Quick Start

```bash
cd codebase-index-mcp
npm run setup        # install, build, detect agents, configure, smoke-test
```

Or manually:
```bash
npm install && npm run build
# Set CODEBASE_INDEX_ALLOWED_ROOTS in your agent config, then restart the agent
```

## Tool Catalog

<!-- BEGIN GENERATED: tool-list -->

43 tools, namespaced `mcp__codebase-index__<tool>`:

- `change_impact`
- `change_value_representation`
- `dead_code_scan`
- `detect_changes`
- `detect_circular_dependencies`
- `find_entry_points`
- `find_field_accesses`
- `find_impact_files`
- `find_implementations`
- `find_package_consumers`
- `find_symbol_at_line`
- `get_call_chain`
- `get_change_context`
- `get_cross_repo_impact`
- `get_dependency_graph`
- `get_feature_bundle`
- `get_file_context`
- `get_file_summary`
- `get_folder_summary`
- `get_persistence_mapping`
- `get_symbol_blame`
- `get_symbol_context_pack`
- `get_symbol_detail`
- `get_symbol_source`
- `get_value_contract_impact`
- `health_check`
- `index_repository`
- `link_tests_to_source`
- `list_repositories`
- `orient`
- `query_docs`
- `query_graph`
- `refactor_replace_apply`
- `refactor_replace_preview`
- `refactor_replace_rollback`
- `refactor_symbol_migration`
- `rename_assist`
- `route_map`
- `search_literals`
- `search_regex`
- `search_symbols`
- `trace_execution_flow`
- `watch_repo`

<!-- END GENERATED: tool-list -->

### Indexing & Health
| Tool | Description |
|------|-------------|
| `health_check` | Check server state, staleness, and actionable `shouldReindex`/`shouldEnableWatch` hints |
| `index_repository` | Index or re-index a repo (`mode: full\|incremental`, `docsMode: auto\|on\|off`) |
| `list_repositories` | List all indexed repos with file/symbol counts and last-run status |
| `watch_repo` | Manage real-time file watching (`action: start\|stop\|status`) |

### Symbol Search & Navigation
| Tool | Description |
|------|-------------|
| `search_symbols` | Find symbols by name or intent (`strategy: name\|intent`). `ranked=true` scores candidates and honors `strategy` (intent tokenizes multi-word queries) + filters. Start here. |
| `search_regex` | Grep repo source by **regex**, returning matches with context lines + the enclosing symbol. Use instead of baseline grep for pattern searches (TODO/FIXME sweeps, API-usage hunts, config keys). Scans indexed files by default; `scanAll=true` also walks non-code text files (json/yaml). Flags limited to `[ims]` (`g` implicit); `filePathPrefix`/`language`/`excludeTests` narrow scope. Caps at `limit` + per-file cap with `truncated`/`truncationReason`. |
| `get_symbol_detail` | Full detail for a known symbolId |
| `get_symbol_source` | Raw source text span of a symbol read from disk (by symbolId or name) — read exact code without a separate file read. Uses persisted end-line (re-index to populate) or estimates it. |
| `get_symbol_context_pack` | Symbol + neighbors + callers/callees in one call. Prefer over `get_change_context` when not doing deep caller traversal. `excludeTests=true` drops test-path candidates *and* callers. |
| `get_symbol_blame` | Git blame metadata for a symbol |
| `find_symbol_at_line` | Resolve symbol at a specific file/line |
| `find_implementations` | Find classes that implement a given interface/type. `excludeTests=true` drops test doubles, which are often the majority of the result. |
| `rename_assist` | Suggest all sites requiring a rename and flag risks. `emitPreview=true` returns an applyable refactor preview (previewId + approvalToken) to execute the rename directly. |

### File & Folder Context
| Tool | Description |
|------|-------------|
| `get_folder_summary` | List files under a folder with per-file stats. Use at session start to orient — cheaper than reading individual files. |
| `get_file_summary` | Symbol count, top symbols, language for a file |
| `get_file_context` | All symbols + edges for one file. Use after `get_file_summary` when deeper context is needed. |
| `find_entry_points` | Locate runtime and graph entry points in a repo |
| `route_map` | Map HTTP routes for web API projects. `excludeTests=true` drops test-only endpoints. |

### Dependency & Impact Analysis
| Tool | Description |
|------|-------------|
| `get_change_context` | Callers and callees for a symbol (BFS); crosses MassTransit-style message-bus hops (`PUBLISHES`). Use when you need deep caller traversal; otherwise prefer `get_symbol_context_pack`. |
| `find_impact_files` | Files impacted by changing a symbol. Use before `refactor_replace_preview` to scope blast radius. A stale index returns a non-fatal `staleWarning` field, not an error. `view="surface"` returns one row per caller→symbol pair with `edgeTypes[]` (an array, not a scalar `edgeType`) and honors `groupBy`. |
| `find_field_accesses` | Read/write callsites of a property (field) with their enclosing symbol — the "who reads vs writes this field" audit. Partitions `reads`/`writes`, `mode=read\|write\|all`. Accepts a property `symbolId` or resolvable `name`. C# from the graph; **TS/JS fields (Zod keys, field bags, interface/class properties) from a TypeScript LanguageService** — coverage `exact`, `X.parse({...})` writes included, **Vue SFC script and template sites through Volar** (pinned `@vue/language-core`; a repo on another Vue major, or without `vue` installed, keeps `.vue` as named gaps), unattributable sites listed by file (dynamic `obj[key]`, unfollowable parse arguments); same-name keys of untyped object literals are `nonMatches` of kind `untyped-object-key`; same-named declarations come back as `candidates` (pick with `declarationFile`/`declarationLine` or `ownerName`); a time/memory cap breach is coverage `gap` with no list. The programs are built and queried in a worker thread, so a cold build (10-20 s on a large monorepo) never blocks other tools; a field call made while it runs waits at most `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS`, then answers coverage `gap` ("type program still building") with no list, and a later call answers exact. Prefer over grepping a field name. |
| `get_dependency_graph` | Graph edges for a file or symbol |
| `get_call_chain` | Call path between two symbols. Shows path, not caller list. Crosses MassTransit-style message-bus hops (`PUBLISHES`). Every profile carries hop identity (`symbolId`/name/file), so no follow-up call is needed to resolve an id. |
| `get_cross_repo_impact` | Impact across multiple indexed repos, for a `symbolId`/`name` or every symbol of a `filePath`. On a controller action (or its file) with `direction: "inbound"` it lists the HTTP consumers in other repos — consumer file:line, route, tool and `endpoint.matchKind` (`"exact"` / `"wildcard"` / `"gateway_prefix"`). |
| `trace_execution_flow` | Trace execution path through entry points. Follows `CALLS` and crosses message-bus `PUBLISHES` hops into the matched consumer. |

### Code Quality
| Tool | Description |
|------|-------------|
| `dead_code_scan` | Find symbols with no callers. Note: runtime-wired symbols may appear dead. |
| `detect_circular_dependencies` | Find import cycles |
| `detect_changes` | Risk-scored change analysis with policy presets (`quick-triage`, `strict-review`, `release-gate`) |
| `link_tests_to_source` | Map test files to source symbols (use `minScore >= 0.7`). `forWorkingTreeDiff: true` answers "which tests does my uncommitted change need": dirty files → reverse import/component/workspace-package closure → tests (each with `why`), plus one vitest command per package from its config read lexically. Nothing is executed. |

### Refactoring
| Tool | Description |
|------|-------------|
| `refactor_replace_preview` | Preview bulk symbol replacement with HMAC-signed approval token. `findMode='regex'` enables pattern matching + backreference substitution in `replaceExpression`: numbered (`$1`..`$99`), whole-match (`$&`), named (`$<name>`/`${name}`), and literal `$` via `$$`. A backreference to a group that did not match is flagged `unsubstituted_backreference` and blocked at apply (never silently written). |
| `refactor_replace_apply` | Apply a previewed replacement (requires token from preview) |
| `refactor_replace_rollback` | Roll back an applied replacement |
| `refactor_symbol_migration` | Migrate symbol references with optional C# initializer rewrite |
| `change_value_representation` | Promote a property's string literals to enum members (C# AST, no regex backreference) across assignments, initializers, `==`/`!=` comparisons, and assertion arguments; preview-gated, cross-type sites skipped |
| `get_persistence_mapping` | EF mapping for a property (column, converter, max length, CHECK) + `DB_TRANSLATED_PROJECTION` warning when a converted property is projected in an un-materialized `.Select()`/`.Where()` |
| `get_value_contract_impact` | Trace a stored/wire value across all registered repos; groups exact-value hits per repo and classifies producer (write) vs consumer (read) — the data-contract gate for a storage-format migration. `excludeTests=true` keeps fixtures and assertions out of the producer/consumer counts. |

### Docs & Advanced
| Tool | Description |
|------|-------------|
| `query_docs` | Search indexed docs (requires `CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true`). All three modes (`search`/`stale`/`coverage`) return the same envelope: `{ repoId, mode, count, results }`. `includeSymbols=true` (mode=search only) also returns matching code symbols — **off** by default. `mode=stale` counts prose mentions only; `includeCodeMentions=true` also counts identifiers inside fenced code samples (needs a re-index to populate the distinction). |
| `query_graph` | Raw SQL against the graph database. For advanced use only; prefer structured tools. |

## Graph Model

**Edge types and semantics** (13, from the `EdgeType` union in `src/types/index.ts`):

| Edge | Meaning | Note |
|------|---------|------|
| `CALLS` | Direct function invocation | Highest confidence |
| `IMPORTS` | File-level import / using statement; also an HTML page's `<script src>` / `<link href>` / `<img src>`, a Vue template's `src` of an `.svg`, and a tsconfig's `extends` / `references` / `paths` | Resolved to the target file's module by the shared import resolver |
| `TYPE_REF` | Usage as a type annotation | Does NOT mean direct call |
| `PROPERTY_REF` | Read of a property or field | |
| `PROPERTY_WRITE` | Assignment to a property or field | |
| `DEPENDS_ON` | Project-level dependency: `.csproj` → `nuget:<pkg>`, `package.json` → `npm:<pkg>`; an HTTP consumer → `endpoint:METHOD:/path` (C# `HttpClient` calls, and JS/TS route literals declaring `source: '<scheme>:METHOD /path'`) | Package tokens are kept and labelled with section and range; a dependency on a package of the same repo also gets a `workspace package` edge to that `package.json`. Endpoint tokens link cross-repo to the controller action's endpoint contract, or stay labelled tokens |
| `IMPLEMENTS` | Class implements interface | |
| `EXTENDS` | Class or interface inheritance | |
| `PUBLISHES` | A `Publish<T>`/`Send<T>` callsite for message contract T | Resolved to the consumer of T (heuristic, by contract name); crosses the bus in trace/call-chain |
| `CONSUMES` | An `IConsumer<T>`/handler of message contract T | Resolved to the in-repo contract type when present |
| `USES_CSS_VAR` | A `var(--x)` reference → every `css_variable` definition of `--x` | Resolved by name repo-wide (one edge per definition); traversed by `get_call_chain` / `find_impact_files` |
| `USES_CSS_CLASS` | A markup use of a class (Vue template `class` / `:class`) → the `css_class` symbols | Emitted by the Vue lane; resolved like `USES_CSS_VAR` |
| `USES_COMPONENT` | A Vue template renders a component (`<AppCard>`, `<app-card>`, each imported `<component :is>` branch) → that file's `component` symbol | Resolved through the script's import specifier; traversed by `get_call_chain` / `find_impact_files`; un-imported tags and dynamic `:is` branches are kept as labelled `component:` gaps |

**Confidence scores**: Values are `0.0–1.0`. Below `0.7` means low confidence — verify with a file read before acting on it.

**Symbol kinds, stable IDs and the schema guardrails** are in
[`CLAUDE.md`](CLAUDE.md) §"Graph model", which cites `src/types/index.ts` as authoritative. The table
above is the consumer-facing reading of each edge type.

## Response Profiles

All read tools that return symbol or edge lists support `profile`:

| Profile | Payload | When to use |
|---------|---------|-------------|
| `nano` | Top-N (10) items, minimal fields, minified JSON | >15 MCP calls per session, Plan mode orientation, quick routing |
| `compact` | All items, reduced fields, minified JSON, `null` fields dropped | **Default for all read tools** |
| `standard` | All items, full fields, minified JSON | Single deep query, need full field detail |
| `verbose` | All items + debug/summary fields, **pretty-printed** | Debugging, edge case inspection (only profile that is indented) |

All paths in responses are normalized to forward slashes (`src/foo.ts`) regardless of host OS. `compact` is the default for every read tool that accepts `profile`. Only `verbose` is pretty-printed; all other profiles emit minified JSON.

**Which tools accept `profile`** — 34 of 43. The list is not maintained by hand here, because a
hand-maintained copy of it was wrong in both directions (it claimed six tools that have no `profile`
parameter, and omitted fifteen that do). `contracts/codebase-index.json` is authoritative:

```bash
node -e "const d=require('./contracts/codebase-index.json');   console.log((d.tools||d).filter(t=>t.inputSchema?.properties?.profile).map(t=>t.name).join('
'))"
```

The nine without it return a fixed shape: `index_repository`, `watch_repo`, `health_check`,
`get_symbol_detail`, `find_symbol_at_line`, `get_folder_summary`, `find_entry_points`,
`refactor_replace_rollback`, `refactor_symbol_migration`. Passing `profile` to one of them is
**rejected** — the advertised input schemas are `additionalProperties: false`.

> Four of those nine — `get_symbol_detail`, `find_symbol_at_line`, `get_folder_summary`,
> `find_entry_points` — do accept `profile` in their **zod** schema while not advertising it, so a
> client that trusts `tools/list` must not send it and a client that ignores `tools/list` will find it
> works. That contradiction is **MCP-ISSUE-051**, not a documentation error. `find_implementations`
> and `query_docs` had the same gap and were corrected as part of MCP-ISSUE-049; both now advertise
> `profile` and are in the 34.

Refactor tools: `refactor_replace_preview` and `refactor_replace_apply` support `nano` (summary only, no hunk content) and `compact` (hunks without before/after text). Use `nano` to check match count and affected files before requesting hunk detail.

## Environment Variables

### Required

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CODEBASE_INDEX_ALLOWED_ROOTS` | **yes** | `<workspace-root>` | The ONLY required var. Comma-separated absolute paths the server may index. Use the exact path `list_repositories` reports — changing drive-letter casing or slash style causes allowlist rejection. |
| `CODEBASE_INDEX_DB_PATH` | no | `<workspace-root>/mcp-local-index-central.db` | Where the code graph is stored — one file holds every repo, scoped by repoId. Four names were in play before S-40; this is the one actually in use. Note that the server's own fallback when this is unset is the RELATIVE path ./codebase-index.db, which lands wherever the process was started, so leaving it set is what keeps the index in one place. |
| `CODEBASE_INDEX_DOCS_INDEXING_ENABLED` | no | `true` *(code)* | false skips markdown during indexing. On by default since MCP-ISSUE-061. |
| `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` | no | `true` *(code)* | false makes query_docs refuse with INVALID_PARAMS. On by default since MCP-ISSUE-061. |
| `CODEBASE_INDEX_TELEMETRY_ENABLED` | no | `false` | — |
| `CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE` | no | `1` *(code)* | Ratio 0–1. Only meaningful when telemetry is enabled. |
| `CODEBASE_INDEX_WATCH_AUTO_START_ENABLED` | no | `false` | renamed — still accepts `CODEBASE_INDEX_WATCH_AUTO_START` · Watchless by default, per the workspace's MCP hard-mode policy. |
| `CODEBASE_INDEX_WATCH_ACTIVE_ONLY` | no | `true` *(code)* | Defaults to TRUE — only the active repo is watched. The one boolean here whose default is not false. |
| `CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS` | no | `900000` *(code)* | Idle watcher stop timeout. Clamped to 5s–24h. |
| `CODEBASE_INDEX_WATCH_DEBOUNCE_MS` | no | `500` *(code)* | — |
| `CODEBASE_INDEX_WATCH_BATCH_SIZE` | no | — | — |
| `CODEBASE_INDEX_WATCH_MAX_FILES_PER_RUN` | no | — | — |
| `CODEBASE_INDEX_WATCH_MAX_QUEUED_EVENTS` | no | — | — |
| `CODEBASE_INDEX_WATCH_AUTO_REPOS` | no | — | renamed — still accepts `CODEBASE_INDEX_AUTO_WATCH_REPOS` · Comma-separated repoIds to auto-watch at boot. Unset = none. |
| `CODEBASE_INDEX_MAX_FILES_PER_RUN` | no | `20000` *(code)* | — |
| `CODEBASE_INDEX_MAX_FILE_SIZE_BYTES` | no | `500000` *(code)* | — |
| `CODEBASE_INDEX_QUERY_REFRESH_ENABLED` | no | `true` *(code)* | Read tools re-index a stale repo (HEAD moved or tree dirty) before answering. false = answer from the stored index with a staleness note. |
| `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS` | no | `5000` *(code)* | How long a read tool waits for that refresh (1-120000). A longer run is never aborted: it finishes in the background and later queries use it. Also how long find_field_accesses waits for the type-resolution worker: a TS/JS field asked during the cold program build answers coverage `gap` ("type program still building") with no list, and the build carries on. |
| `CODEBASE_INDEX_RESPECT_GITIGNORE` | no | `true` *(code)* | Index only files git shows (tracked + untracked not ignored), so gitignored build output stays out of the graph. No effect outside git. |
| `CODEBASE_INDEX_MAX_MARKDOWN_BYTES` | no | `4000000` *(code)* | Size cap for markdown; the docs lane splits it by section, so it is higher than the code cap. |
| `CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES` | no | `0` *(code)* | 0 = no large-file special casing. |
| `CODEBASE_INDEX_MAX_LIMIT` | no | `500` *(code)* | renamed — still accepts `CODEBASE_INDEX_MAX_RESULT_LIMIT` · Hard ceiling on any tool's `limit`. |
| `CODEBASE_INDEX_MAX_DEPTH` | no | `5` *(code)* | Hard ceiling on traversal `depth`. |
| `CODEBASE_INDEX_LARGE_REPO_PROFILE` | no | `auto` *(code)* | Performance profile: auto \| standard/off \| large/balanced \| very-large/aggressive. |
| `CODEBASE_INDEX_PARSE_WORKERS` | no | — | Worker-pool size. Unset = derived from CPU count. |
| `CODEBASE_INDEX_PARSE_TIMEOUT_MS` | no | `5000` *(code)* | Per-file parse timeout. |
| `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` | no | `20000` *(code)* | Whole-batch timeout. |
| `CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE` | no | — | Override; unset = the extractor's own limit. |
| `CODEBASE_INDEX_MAX_TYPE_REF_EDGES_PER_FILE` | no | — | Per-file TYPE_REF ceiling. Bounds this lane by volume instead of by confidence (MCP-ISSUE-038); unset = the profile default. |
| `CODEBASE_INDEX_MIN_EDGE_CONFIDENCE` | no | — | Ratio 0–1. Drops low-confidence edges at extraction time. |
| `CODEBASE_INDEX_MAX_STRING_LITERALS_PER_FILE` | no | — | — |
| `CODEBASE_INDEX_MIN_STRING_LITERAL_LENGTH` | no | — | — |
| `CODEBASE_INDEX_NUGET_NAMESPACE_MAP` | no | — | renamed — still accepts `NUGET_NAMESPACE_MAP` · Extra NuGet package → namespace mappings for .NET dependency edges. |
| `CODEBASE_INDEX_SUBTRANSACTION_FILES` | no | `20` *(code)* | renamed — still accepts `CODEBASE_INDEX_SUBTX_SIZE` · Files per SQLite sub-transaction. |
| `CODEBASE_INDEX_CHECKPOINT_EVERY_N_BATCHES` | no | `1` *(code)* | WAL checkpoint cadence. |
| `CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS` | no | — | Cap on unresolved pairs resolved after extraction. Profile-dependent when unset (0 = unlimited for standard/very-large, 120000 for large). |
| `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS_ENABLED` | no | `true` *(code)* | renamed — still accepts `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS` |
| `CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS_ENABLED` | no | `true` *(code)* | renamed — still accepts `CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS` |
| `CODEBASE_INDEX_CROSS_REPO_NAMESPACES` | no | — | Namespaces treated as shared when resolving cross-repo edges. |
| `CODEBASE_INDEX_VECTOR_ENABLED` | no | `true` *(code)* | false disables trigram vector search entirely (no in-memory fallback) — a control for isolating vector-assisted resolution. |
| `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` | no | — | **secret** · HMAC secret for refactor approval tokens. Auto-generated per process if unset; set it to keep tokens valid across restarts. |
| `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS` | no | `1800000` *(code)* | Preview/token lifetime — 30 minutes. |
| `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL_ENABLED` | no | `false` *(code)* | renamed — still accepts `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL` · When true, startup fails unless CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET is set. |
| `CODEBASE_INDEX_TS_LS_ENABLED` | no | `true` *(code)* | find_field_accesses answers TS/JS fields from a TypeScript LanguageService (coverage `exact`). Lazy: no program is built until such a query; C# fields keep the graph answer. false = the graph's lower bound. |
| `CODEBASE_INDEX_TS_LS_COLD_START_MS` | no | `60000` *(code)* | Budget for one answer inside the type-resolution worker, cold (program build) or warm. A breach returns coverage `gap` and no list; the built program stays warm for the next call. A worker still running 30 s past it is terminated. |
| `CODEBASE_INDEX_TS_LS_MAX_RSS_MB` | no | `2500` *(code)* | Memory ceiling of the type-resolution worker thread (its V8 heap, also its resourceLimits.maxOldGenerationSizeMb). A breach returns coverage `gap` with no list and discards the worker; other tools keep answering and the next field call starts a fresh one. |
| `CODEBASE_INDEX_HTTP_PORT` | no | — | Port on 127.0.0.1 for `node dist/index.js --transport http` (what `scripts/serve-http.mjs` runs): one process serves every Claude session. Read only with --transport http; a stdio server ignores it. Never binds any other address. |
| `CODEBASE_INDEX_HTTP_TOKEN` | no | — | **secret** · Bearer token every HTTP request must carry (at least 32 characters); without it the answer is 401. Generated by `install-mcp --transport http`. Read only with --transport http. |
| `CODEBASE_INDEX_LOG_MODE` | no | — | renamed — still accepts `CODEBASE_INDEX_INDEX_LOG` · Enables verbose index-progress logging on stderr. |
| `CODEBASE_INDEX_LLM_ENABLED` | no | `false` *(code)* | Runtime LLM invocation is prohibited by design. Setting this to true ABORTS STARTUP, and `guard:no-llm-runtime` statically verifies no LLM client is importable. Declared here so the constraint is documented, not so it can be turned on. |

50 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->

## MCP Host Configuration

### Profile A — Workspace-local (portable)

```json
{
  "mcpServers": {
    "codebase-index": {
      "command": "node",
      "args": ["${workspaceFolder}/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "${workspaceFolder}",
        "CODEBASE_INDEX_DB_PATH": "${workspaceFolder}/mcp-local-index.db"
      }
    }
  }
}
```

### Profile B — Central cross-repo

```json
{
  "mcpServers": {
    "codebase-index-central": {
      "command": "node",
      "args": ["D:/1.SourceCode/mcp-local/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/1.SourceCode/crm,D:/1.SourceCode/mcp-local",
        "CODEBASE_INDEX_DB_PATH": "D:/1.SourceCode/mcp-local/mcp-local-index-central.db"
      }
    }
  }
}
```

### Agent-Specific Formats

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`): use `mcpServers` key with `command`/`args`/`env` (see Profile A above).

**VS Code / Cursor / Windsurf** (`settings.json`): use `mcp.servers` key with same `command`/`args`/`env` structure.

**OpenCode** (`~/.config/opencode/opencode.json`): use `mcp` key; `command` must be an **array** (`["node", "path/to/dist/index.js"]`); use `environment` (not `env`); add `"type": "local"` and `"enabled": true`.

**Claude Code** (project-scoped): place `.mcp.json` at the workspace root with `mcpServers` key (see `../.mcp.json`).

## Development Workflow

```bash
npm run typecheck                  # type check only
npm run build                      # compile TypeScript → dist/
npm run dev                        # run with tsx (no build needed)
npm run guard:no-llm-runtime       # verify no LLM imports in src/ (policy enforcement)
node scripts/smoke-test.mjs        # full integration test (requires build first)
npm run test:profile-responses     # verify profile behavior for impact/list tools
npm run test:refactor-profiles     # verify refactor preview/apply profile behavior
npm run benchmark:plan:check       # quality gate: compact savings ≥ 40% (vs verbose) + per-tool byte-snapshot regression
```

**Pre-commit sequence:**
```bash
npm run typecheck && npm run build && npm run guard:no-llm-runtime && node scripts/smoke-test.mjs && npm run benchmark:plan:check
```

## Refactor Engine

The refactor flow is: `refactor_replace_preview` → `refactor_replace_apply` → `refactor_replace_rollback`.

- Rule-based only (`decisionSource=rule_engine`, `llmInvolved=false`). Never invokes an LLM.
- Preview generates an HMAC-signed approval token (TTL: 30 min via `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET`).
- Apply requires the exact `previewId` and `approvalToken` from the preview response.
- Rollback requires the `rollbackId` from the apply response.
- Low-confidence candidates: reported but not applied by default (`includeLowConfidence: false`).
- Scope drift: if newly changed files after apply exceed 5% of preview scope, diagnostics code is `SCOPE_DRIFT_DETECTED`.

**C# object initializer rewrites** (`refactor_symbol_migration`): when `toSymbol` is a dotted path (e.g., `IdentityState.CrmCustomerId`) inside an initializer body, provide `initializerRewrite` metadata or the preview blocks as `ambiguous_target`:

```json
{
  "fromSymbol": "CrmCustomerId",
  "toSymbol": "IdentityState.CrmCustomerId",
  "initializerRewrite": {
    "objectProperty": "IdentityState",
    "objectType": "ConversationIdentityState",
    "targetMember": "CrmCustomerId"
  }
}
```

## Notes

- **No-LLM policy**: `CODEBASE_INDEX_LLM_ENABLED=true` causes startup rejection. `npm run guard:no-llm-runtime` statically enforces this.
- **Staleness**: incremental index fast-skips when indexed commit equals `HEAD` and working tree is clean. Read tools degrade gracefully on a stale index — `find_impact_files`/`get_change_context` embed a non-fatal `staleWarning` rather than erroring.
- **Query-triggered refresh** (R1): a read tool on a repo whose HEAD moved or whose tree is dirty first starts an `incremental` / `dirty` run and waits up to `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS`; a longer run carries on and the answer says `freshness: "refreshing"` with coverage capped. That run executes in a worker thread on its own SQLite connection (release I1b), so other tool calls — on this repo or any other — keep answering while it writes. `index_repository` and the watcher still run on the server thread. A `dirty` / `incremental` run is **scoped** (MCP-ISSUE-085, release J): it re-extracts the changed files plus every file whose resolution can depend on the names they added, removed or altered, and lands on the graph a full run builds; a `tsconfig*` / `jsconfig*` / `package.json` / `citations.json` edit or more than 600 dependent files runs a full run instead. `index_runs.scope` says which happened.
- **Windows native build**: `better-sqlite3` requires Visual Studio C++ Build Tools. If build fails, install VS Build Tools.
- **CSS lane** (MCP-ISSUE-075): `.css` files are parsed with `postcss`, not tree-sitter. Custom properties become `css_variable` symbols (one per definition site, named `--x`), class selectors `css_class` symbols (one per name per file, named `.x`); `var(--x)` is a `USES_CSS_VAR` edge, so `search_symbols("--text-tertiary")` plus `get_call_chain(direction:"callers")` answers "who uses this token". `dead_code_scan` never reports CSS symbols. SCSS/Less are not indexed.
- **SQL lane** (MCP-ISSUE-082): `.sql` files (PostgreSQL) are indexed as language `sql`. A SQL-aware splitter (dollar quotes, nested comments, strings, psql `\set` meta-commands, `COPY … FROM stdin`, `BEGIN ATOMIC`) cuts each file into statements; each goes to `pgsql-ast-parser` (12.0.2, pure JS), then to a token reader for what that parser does not read (`GRANT`/`REVOKE`, `CREATE POLICY`, `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION … SECURITY DEFINER`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `ALTER DEFAULT PRIVILEGES`, `COMMENT ON COLUMN`, partition DDL, DDL inside `DO` blocks); a statement neither recognises is a `sql_gap` symbol named by its first words at its line, listed with file:line in `health_check.sqlLane`. Symbols, one per definition site (signature starts with the qualified name): `sql_table`, `sql_column` (also at an `ALTER TABLE … ADD COLUMN`), `sql_view`, `sql_index`, `sql_function`, `sql_type`, `sql_role`, `sql_schema`, `sql_sequence`, `sql_policy`, `sql_trigger`; `sql_statement` for a statement that touches without defining (ALTER, GRANT/REVOKE — named with privileges and roles —, DROP, top-level DML). Edges: `SQL_USES` (view/function/policy/index/trigger/ALTER → object; a `LANGUAGE sql` body is parsed, a PL/pgSQL body tokenized and labelled so), `SQL_REFERENCES` (foreign keys), `SQL_GRANT` (object and grantee; `ON ALL TABLES IN SCHEMA s` and default privileges fan out to the schema's tables, labelled `schema-wide`), `SQL_MIGRATION_ORDER` (a numbered migration → its predecessor in its directory; `NNNN-x.down.sql` → `NNNN-x.sql`). **TS → SQL:** the first argument of `<x>.query(…)` / `.query<T>(…)` (string, template, `+` concatenation, or a same-file const), every SQL-shaped `const` (`select…`, `insert into…`), and a function naming such a const of its own file emit `SQL_QUERY` edges to the tables, functions (`from usage_in_period($1)`) and — only when unambiguous: insert list, update set, single-table select list — columns they name; `${CONST}` of a same-file string const is inlined, any other `${…}` in a table position is a `sql_gap`. Every SQL edge is bound **by name** after the run: reason `name_resolved…`, confidence 0.6 (0.5 when an unqualified name is bound to the only other schema that defines it), never exact or high, and a qualified `schema.t` never binds to another schema's `t`. "Who touches table X" is `get_call_chain(symbolId: <table>, direction: "callers")`: each SQL hop carries `fromKind`, `fromLine`, `provenance: "name_resolved"` and the `reason` (clause, privileges, line). `dead_code_scan` never reports SQL symbols.
  - **One current definition per name** (release I3): a name defined at several sites binds every reference to ONE of them — the latest numbered migration; a file under an `archive/` path segment is superseded by any non-archive migration (so `0001-baseline` beats `archive/0034`); a `.down.sql` is never current while an up file defines the name; a later `CREATE OR REPLACE` in the same file beats an earlier one. Each caller appears once, labelled `name_resolved (current of N definitions)`. The other sites are `alsoDefinedAt` (file:line) — `search_symbols`, `get_symbol_detail` and `get_call_chain` return a `sqlDefinition` block (`current`, `definitions`, `currentDefinition`, `alsoDefinedAt`), derived at read time by the same rule. Outbound edges stay per version: each `CREATE OR REPLACE` body keeps what IT reads.
  - **Imported query consts** (release I4): `client.query(INSERT_X)` with `INSERT_X` imported (`import { INSERT_X }`, renamed `import { A as B }`, `ns.INSERT_X` via `import * as ns`; one re-export hop through a barrel) gives the CALLING symbol the const's tables/columns/functions, reason `ts query imported const B via A (file:line) …`, still `name_resolved` at 0.6. A same-file const or `read.statement` (a member of a same-file const object literal) says `via NAME (file:line)` too. An imported const that is not SQL-shaped (`BEGIN`, a `SET` statement, a number) produces no SQL target — only a labelled `sqlconst:` anchor.
- **Vue lane** (MCP-ISSUE-074): `.vue` files are indexed as language `vue`. `@vue/compiler-sfc` (3.5.44, pure JS) splits the blocks; `<script>` / `<script setup>` go through the TypeScript lane at their real `.vue` lines; each file gets one `component` symbol whose `defineProps` / `defineModel` props and `defineEmits` events (as `onX` listener members) are its `property` children. Templates give `USES_COMPONENT` (child components, per `:is` branch), `PROPERTY_WRITE` for `:prop` / `@event` / `v-model` bindings on a child (bound expression in `assignedExpression`), `CALLS` for `@event` handlers, inline expressions (`@click="save(x)"`, `{{ fmt(x) }}`) and `$emit`, `PROPERTY_REF` for own-prop reads — the template line is in the edge `reason`. `<style>` blocks go through the CSS lane; `class` / literal `:class` names become `USES_CSS_CLASS`. `dead_code_scan` counts template use as use; `find_implementations` on a component says it is not applicable.
- **Text and JSON lanes** (MCP-ISSUE-076): YAML, Dockerfiles, Makefiles, shell, nginx `.conf` / `.template`, `.txt`, `.example`, `.code-workspace`, dotfile configs and JSONL are indexed as language `text`; `.json` as `json`. Each is a `module` symbol and nothing else, so `search_regex` finds them without `scanAll`, and their string values (JSON/JSONL values, quoted strings, YAML plain scalars) are in the literal lane for `search_literals` — identifier-shaped values first when a file has more than the per-file cap. `package.json` adds `DEPENDS_ON npm:<pkg>` and workspace edges; `tsconfig*.json` adds `IMPORTS` for `extends` / `references` / `paths` (JSONC tolerated). One-line JSON/JSONL is not treated as minified. Secret-bearing files (`.env`, `.env.*` but not `.env.example`, `.npmrc`, `*.session`, keys) are never read and are reported as `secret_file`.
- **HTML and SVG** (MCP-ISSUE-077): `.html` pages are language `html` with `IMPORTS` edges for what they load; `.svg` files are module-only asset nodes (also under `assets/`, `public/`, `static/`), reached by TS/JS imports (`?raw` / `?url` queries ignored) and Vue template `src` / `href` — so "who uses icon.svg" is `find_impact_files(filePath: "…/icon.svg")`. Binary assets (png, jpg, pdf, fonts, …) are skipped as `binary_asset`.
- **Build-named folders** (MCP-ISSUE-078): in a git repo, `bin/`, `obj/`, `build/`, `out/` and `target/` defer to git — a tracked (or untracked, not ignored) source file under one is indexed; everything else under them stays out. `node_modules`, `dist` and `.git` are always excluded.
- **Paths** (MCP-ISSUE-079): every stored path uses forward slashes on every platform; a database written by an older build on Windows is migrated once at start-up and its files are re-extracted by the next run.
- **Tests for a diff** (MCP-ISSUE-080): `link_tests_to_source(repoId, forWorkingTreeDiff: true)` takes the dirty files (staged, unstaged, untracked — the same `git status` read as the freshness gate), walks back over `IMPORTS`, `USES_COMPONENT` and bare imports of the repo's own workspace packages (mapped through that package's `package.json` `exports`) up to `maxDepth` (6) hops and `maxFiles` (2000) files, and lists the test files reached, every changed test file itself (`why: "changed itself"`) and name links with score ≥ `minScore` (0.7 in this mode; the rest are counted in `belowMinScore`). For each package it finds the vitest/vite config vitest would load, reads `include` / `exclude` / `root` / `test.projects` lexically (never executes it; an unreadable value is named and the package dir is used) and emits e.g. `cd packages/core && ./node_modules/.bin/vitest run test/audit.test.ts` — the package's own binary, never a package manager (one can rewrite tracked config or create a store in a shared worktree). A test no config admits goes to `excluded` with the reason; a `node:test` file gets runner `unknown` and a `node --test` hint. Nothing is run.
- **Declared HTTP consumers** (MCP-ISSUE-081, R9): in TS/JS, an object literal with a string-literal `source: '<scheme>:<METHOD> /<path>'` (e.g. wec.aria's `source: 'wecrm:GET /dealer/customers/{id}/history'`) emits `DEPENDS_ON endpoint:METHOD:/path` from the route const (or the table that holds the row), reason `http consumer (<scheme>) route=<name> tool=<name>`. The id is minted by the same function as the C# controller lane, so the format is unchanged; tolerance lives in the cross-repo matcher, tried in order: `"exact"`; `"wildcard"` — a `{id}` segment matches any parameter segment (`{customerId}`, `{id:int}`), never a literal, and a trailing slash or ASP.NET `~/` is normalised; `"gateway_prefix"` — for declared consumers only, the first one or two literal segments may be a gateway route the provider does not declare (Ocelot `/dealer/{everything}`), linked only when exactly one provider endpoint matches. Unmatched or ambiguous endpoints stay labelled tokens, counted in `index_runs.unresolved_no_candidate` / `index_runs.unresolved_ambiguous`. Links are written by the **consumer's** run: index the provider repo first (or re-index the consumer after it). When the route literal names no tool, `get_cross_repo_impact` finds `<tool>: <routeConst>` in the files that import the route (`toolSource: "routing_table"`, with the file:line).
- **Literal cap** (MCP-ISSUE-076 follow-up, release I6b): every performance profile stores at most 200 literal rows per file (one per distinct value; `CODEBASE_INDEX_MAX_STRING_LITERALS_PER_FILE` overrides it for all profiles alike). It used to be 100 under `large` and 50 under `very-large`, so a cold-start full run (`auto` → `large`) and a later run (`auto` → `standard`) stored different rows for the same file. An index built before `v10-literal-cap` needs one `mode: "full"` run to pick this up.
- **`orient` routing** (MCP-ISSUE-083): besides its keyword table, `orient` has compound rules that need one signal from each group and rank first — tests + a working-tree word → `link_tests_to_source(forWorkingTreeDiff: true)`; a citation verb + a decision number / ADR / `.md` file → `query_docs(mode: "cites")`; a definition word + a numbered doc (`docs/10`) or registry → `query_docs(mode: "term")`; an endpoint / controller / route path + a consumer or other-repo word → `get_cross_repo_impact(direction: "inbound")`. The seed it finds (action name, snake_case term, citation target or file) is put into the first tool's arguments. Vietnamese matches with or without diacritics.
- **Docs lane**: disabled by default (`CODEBASE_INDEX_DOCS_INDEXING_ENABLED=false`). Use `docsMode: "off"` per run for fastest indexing.
- **Watch**: keep `CODEBASE_INDEX_WATCH_AUTO_START_ENABLED=false`. Start watchers manually only during active debug sessions, stop immediately after.

## Further reading

| | |
|---|---|
| [`docs/decision-tree.md`](docs/decision-tree.md) | Which tool to use, in what order, with which profile |
| [`docs/examples.md`](docs/examples.md) | Five worked end-to-end workflows |
| [`docs/mcp-codebase-index-issue-registry.md`](docs/mcp-codebase-index-issue-registry.md) | Known server-side defects, with a status index |
| [`CLAUDE.md`](CLAUDE.md) | Internals: the `src/` folder-ownership table, the graph model, the refactor engine |
| [`../.claude/rules/mcp-hard-mode.md`](../.claude/rules/mcp-hard-mode.md) | The MCP-first operating policy and its one-page runbook index |
