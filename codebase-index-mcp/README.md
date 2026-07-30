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
| `get_symbol_context_pack` | Symbol + neighbors + callers/callees in one call. Prefer over `get_change_context` when not doing deep caller traversal. |
| `get_symbol_blame` | Git blame metadata for a symbol |
| `find_symbol_at_line` | Resolve symbol at a specific file/line |
| `find_implementations` | Find classes that implement a given interface/type |
| `rename_assist` | Suggest all sites requiring a rename and flag risks. `emitPreview=true` returns an applyable refactor preview (previewId + approvalToken) to execute the rename directly. |

### File & Folder Context
| Tool | Description |
|------|-------------|
| `get_folder_summary` | List files under a folder with per-file stats. Use at session start to orient — cheaper than reading individual files. |
| `get_file_summary` | Symbol count, top symbols, language for a file |
| `get_file_context` | All symbols + edges for one file. Use after `get_file_summary` when deeper context is needed. |
| `find_entry_points` | Locate runtime and graph entry points in a repo |
| `route_map` | Map HTTP routes for web API projects |

### Dependency & Impact Analysis
| Tool | Description |
|------|-------------|
| `get_change_context` | Callers and callees for a symbol (BFS); crosses MassTransit-style message-bus hops (`PUBLISHES`). Use when you need deep caller traversal; otherwise prefer `get_symbol_context_pack`. |
| `find_impact_files` | Files impacted by changing a symbol. Use before `refactor_replace_preview` to scope blast radius. A stale index returns a non-fatal `staleWarning` field, not an error. |
| `find_field_accesses` | Read/write callsites of a property (field) with their enclosing symbol — the "who reads vs writes this field" audit. Partitions `reads`/`writes`, `mode=read\|write\|all`. Accepts a property `symbolId` or resolvable `name`. Prefer over grepping a field name. |
| `get_dependency_graph` | Graph edges for a file or symbol |
| `get_call_chain` | Call path between two symbols. Shows path, not caller list. Crosses MassTransit-style message-bus hops (`PUBLISHES`). |
| `get_cross_repo_impact` | Impact across multiple indexed repos |
| `trace_execution_flow` | Trace execution path through entry points. Follows `CALLS` and crosses message-bus `PUBLISHES` hops into the matched consumer. |

### Code Quality
| Tool | Description |
|------|-------------|
| `dead_code_scan` | Find symbols with no callers. Note: runtime-wired symbols may appear dead. |
| `detect_circular_dependencies` | Find import cycles |
| `detect_changes` | Risk-scored change analysis with policy presets (`quick-triage`, `strict-review`, `release-gate`) |
| `link_tests_to_source` | Map test files to source symbols (use `minScore >= 0.7`) |

### Refactoring
| Tool | Description |
|------|-------------|
| `refactor_replace_preview` | Preview bulk symbol replacement with HMAC-signed approval token. `findMode='regex'` enables pattern matching + backreference substitution in `replaceExpression`: numbered (`$1`..`$99`), whole-match (`$&`), named (`$<name>`/`${name}`), and literal `$` via `$$`. A backreference to a group that did not match is flagged `unsubstituted_backreference` and blocked at apply (never silently written). |
| `refactor_replace_apply` | Apply a previewed replacement (requires token from preview) |
| `refactor_replace_rollback` | Roll back an applied replacement |
| `refactor_symbol_migration` | Migrate symbol references with optional C# initializer rewrite |
| `change_value_representation` | Promote a property's string literals to enum members (C# AST, no regex backreference) across assignments, initializers, `==`/`!=` comparisons, and assertion arguments; preview-gated, cross-type sites skipped |
| `get_persistence_mapping` | EF mapping for a property (column, converter, max length, CHECK) + `DB_TRANSLATED_PROJECTION` warning when a converted property is projected in an un-materialized `.Select()`/`.Where()` |
| `get_value_contract_impact` | Trace a stored/wire value across all registered repos; groups exact-value hits per repo and classifies producer (write) vs consumer (read) — the data-contract gate for a storage-format migration |

### Docs & Advanced
| Tool | Description |
|------|-------------|
| `query_docs` | Search indexed docs (requires `CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true`) |
| `query_graph` | Raw SQL against the graph database. For advanced use only; prefer structured tools. |

## Graph Model

**Symbol kinds**: `function`, `class`, `method`, `variable`, `module`, `interface`, `property`, `constructor`, `type`, `struct`

**Edge types and semantics**:

| Edge | Meaning | Note |
|------|---------|------|
| `CALLS` | Direct function invocation | Highest confidence |
| `IMPORTS` | File-level import / using statement | |
| `TYPE_REF` | Usage as a type annotation | Does NOT mean direct call |
| `PROPERTY_REF` | Read of a property or field | |
| `PROPERTY_WRITE` | Assignment to a property or field | |
| `DEPENDS_ON` | Project-level dependency (NuGet, npm) | |
| `IMPLEMENTS` | Class implements interface | |
| `PUBLISHES` | A `Publish<T>`/`Send<T>` callsite for message contract T | Resolved to the consumer of T (heuristic, by contract name); crosses the bus in trace/call-chain |
| `CONSUMES` | An `IConsumer<T>`/handler of message contract T | Resolved to the in-repo contract type when present |

**Confidence scores**: Values are `0.0–1.0`. Below `0.7` means low confidence — verify with a file read before acting on it.

**Stable IDs**: SHA-256 of `repoId:filePath:symbolName` truncated to 24 hex chars. All tables scoped by `repoId`.

## Response Profiles

All read tools that return symbol or edge lists support `profile`:

| Profile | Payload | When to use |
|---------|---------|-------------|
| `nano` | Top-N (10) items, minimal fields, minified JSON | >15 MCP calls per session, Plan mode orientation, quick routing |
| `compact` | All items, reduced fields, minified JSON, `null` fields dropped | **Default for all read tools** |
| `standard` | All items, full fields, minified JSON | Single deep query, need full field detail |
| `verbose` | All items + debug/summary fields, **pretty-printed** | Debugging, edge case inspection (only profile that is indented) |

All paths in responses are normalized to forward slashes (`src/foo.ts`) regardless of host OS. `compact` is now the default for every read tool, including `get_symbol_detail`, `get_folder_summary`, `query_docs`, `find_entry_points`, `find_implementations`, and `find_symbol_at_line` (previously fixed-format). Only `verbose` is pretty-printed; all other profiles emit minified JSON.

Tools with profile support: `search_symbols`, `get_file_context`, `get_change_context`, `get_symbol_context_pack`, `get_file_summary`, `get_symbol_detail`, `get_symbol_source`, `find_symbol_at_line`, `find_impact_files`, `get_dependency_graph`, `get_call_chain`, `list_repositories`, `dead_code_scan`, `detect_circular_dependencies`, `detect_changes`, `link_tests_to_source`, `trace_execution_flow`, `rename_assist`, `route_map`, `get_folder_summary`, `query_docs`, `find_entry_points`, `find_implementations`.

Refactor tools: `refactor_replace_preview` and `refactor_replace_apply` support `nano` (summary only, no hunk content) and `compact` (hunks without before/after text). Use `nano` to check match count and affected files before requesting hunk detail.

## Environment Variables

### Required

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CODEBASE_INDEX_ALLOWED_ROOTS` | **yes** | `D:/1.SourceCode/mcp-local` | The ONLY required var. Comma-separated absolute paths the server may index. Use the exact path `list_repositories` reports — changing drive-letter casing or slash style causes allowlist rejection. |
| `CODEBASE_INDEX_DB_PATH` | no | `D:/1.SourceCode/mcp-local/mcp-local-index-central.db` | Where the code graph is stored — one file holds every repo, scoped by repoId. Four names were in play before S-40; this is the one actually in use. Note that the server's own fallback when this is unset is the RELATIVE path ./codebase-index.db, which lands wherever the process was started, so leaving it set is what keeps the index in one place. |
| `CODEBASE_INDEX_DOCS_INDEXING_ENABLED` | no | `false` | — |
| `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` | no | `false` | — |
| `CODEBASE_INDEX_TELEMETRY_ENABLED` | no | `false` | — |
| `CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE` | no | `1` *(code)* | Ratio 0–1. Only meaningful when telemetry is enabled. |
| `CODEBASE_INDEX_WATCH_AUTO_START` | no | `false` | Watchless by default, per the workspace's MCP hard-mode policy. |
| `CODEBASE_INDEX_WATCH_ACTIVE_ONLY` | no | `true` *(code)* | Defaults to TRUE — only the active repo is watched. The one boolean here whose default is not false. |
| `CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS` | no | `900000` *(code)* | Idle watcher stop timeout. Clamped to 5s–24h. |
| `CODEBASE_INDEX_WATCH_DEBOUNCE_MS` | no | `500` *(code)* | — |
| `CODEBASE_INDEX_WATCH_BATCH_SIZE` | no | — | — |
| `CODEBASE_INDEX_WATCH_MAX_FILES_PER_RUN` | no | — | — |
| `CODEBASE_INDEX_WATCH_MAX_QUEUED_EVENTS` | no | — | — |
| `CODEBASE_INDEX_AUTO_WATCH_REPOS` | no | — | Comma-separated repoIds to auto-watch at boot. Unset = none. |
| `CODEBASE_INDEX_MAX_FILES_PER_RUN` | no | `20000` *(code)* | — |
| `CODEBASE_INDEX_MAX_FILE_SIZE_BYTES` | no | `500000` *(code)* | — |
| `CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES` | no | `0` *(code)* | 0 = no large-file special casing. |
| `CODEBASE_INDEX_MAX_RESULT_LIMIT` | no | `500` *(code)* | Hard ceiling on any tool's `limit`. |
| `CODEBASE_INDEX_MAX_DEPTH` | no | `5` *(code)* | Hard ceiling on traversal `depth`. |
| `CODEBASE_INDEX_LARGE_REPO_PROFILE` | no | `auto` *(code)* | Performance profile: auto \| standard/off \| large/balanced \| very-large/aggressive. |
| `CODEBASE_INDEX_PARSE_WORKERS` | no | — | Worker-pool size. Unset = derived from CPU count. |
| `CODEBASE_INDEX_PARSE_TIMEOUT_MS` | no | `5000` *(code)* | Per-file parse timeout. |
| `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` | no | `20000` *(code)* | Whole-batch timeout. |
| `CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE` | no | — | Override; unset = the extractor's own limit. |
| `CODEBASE_INDEX_MIN_EDGE_CONFIDENCE` | no | — | Ratio 0–1. Drops low-confidence edges at extraction time. |
| `CODEBASE_INDEX_MAX_STRING_LITERALS_PER_FILE` | no | — | — |
| `CODEBASE_INDEX_MIN_STRING_LITERAL_LENGTH` | no | — | — |
| `NUGET_NAMESPACE_MAP` | no | — | Extra NuGet package → namespace mappings for .NET dependency edges. |
| `CODEBASE_INDEX_SUBTX_SIZE` | no | `20` *(code)* | Files per SQLite sub-transaction. |
| `CODEBASE_INDEX_CHECKPOINT_EVERY_N_BATCHES` | no | `1` *(code)* | WAL checkpoint cadence. |
| `CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS` | no | — | Cap on unresolved pairs resolved after extraction. Profile-dependent when unset (0 = unlimited for standard/very-large, 120000 for large). |
| `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS` | no | `true` *(code)* | — |
| `CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS` | no | `true` *(code)* | — |
| `CODEBASE_INDEX_CROSS_REPO_NAMESPACES` | no | — | Namespaces treated as shared when resolving cross-repo edges. |
| `CODEBASE_INDEX_VECTOR_ENABLED` | no | `true` *(code)* | false disables trigram vector search entirely (no in-memory fallback) — a control for isolating vector-assisted resolution. |
| `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` | no | — | **secret** · HMAC secret for refactor approval tokens. Auto-generated per process if unset; set it to keep tokens valid across restarts. |
| `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS` | no | `1800000` *(code)* | Preview/token lifetime — 30 minutes. |
| `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL` | no | `false` *(code)* | When true, startup fails unless CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET is set. |
| `CODEBASE_INDEX_INDEX_LOG` | no | — | Enables verbose index-progress logging on stderr. |
| `CODEBASE_INDEX_LLM_ENABLED` | no | `false` *(code)* | Runtime LLM invocation is prohibited by design. Setting this to true ABORTS STARTUP, and `guard:no-llm-runtime` statically verifies no LLM client is importable. Declared here so the constraint is documented, not so it can be turned on. |

40 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

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
- Rollback requires the `applyId` from the apply response.
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
- **Windows native build**: `better-sqlite3` requires Visual Studio C++ Build Tools. If build fails, install VS Build Tools.
- **Docs lane**: disabled by default (`CODEBASE_INDEX_DOCS_INDEXING_ENABLED=false`). Use `docsMode: "off"` per run for fastest indexing.
- **Watch**: keep `CODEBASE_INDEX_WATCH_AUTO_START=false`. Start watchers manually only during active debug sessions, stop immediately after.
