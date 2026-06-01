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
| `search_symbols` | Find symbols by name or intent (`strategy: name\|intent`). Start here. |
| `get_symbol_detail` | Full detail for a known symbolId |
| `get_symbol_context_pack` | Symbol + neighbors + callers/callees in one call. Prefer over `get_change_context` when not doing deep caller traversal. |
| `get_symbol_blame` | Git blame metadata for a symbol |
| `find_symbol_at_line` | Resolve symbol at a specific file/line |
| `find_implementations` | Find classes that implement a given interface/type |
| `rename_assist` | Suggest all sites requiring a rename and flag risks |

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
| `get_change_context` | Callers and callees for a symbol (BFS). Use when you need deep caller traversal; otherwise prefer `get_symbol_context_pack`. |
| `find_impact_files` | Files impacted by changing a symbol. Use before `refactor_replace_preview` to scope blast radius. |
| `get_dependency_graph` | Graph edges for a file or symbol |
| `get_call_chain` | Call path between two symbols. Shows path, not caller list. |
| `get_cross_repo_impact` | Impact across multiple indexed repos |
| `trace_execution_flow` | Trace execution path through entry points |

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
| `refactor_replace_preview` | Preview bulk symbol replacement with HMAC-signed approval token |
| `refactor_replace_apply` | Apply a previewed replacement (requires token from preview) |
| `refactor_replace_rollback` | Roll back an applied replacement |
| `refactor_symbol_migration` | Migrate symbol references with optional C# initializer rewrite |

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

**Confidence scores**: Values are `0.0–1.0`. Below `0.7` means low confidence — verify with a file read before acting on it.

**Stable IDs**: SHA-256 of `repoId:filePath:symbolName` truncated to 24 hex chars. All tables scoped by `repoId`.

## Response Profiles

All read tools that return symbol or edge lists support `profile`:

| Profile | Payload | When to use |
|---------|---------|-------------|
| `nano` | Top-N (10) items, minimal fields, minified JSON | >15 MCP calls per session, Plan mode orientation, quick routing |
| `compact` | All items, reduced fields, minified JSON | **Default for most tasks** |
| `standard` | All items, full fields, pretty-printed | Single deep query, need full field detail |
| `verbose` | All items + debug/summary fields, pretty-printed | Debugging, edge case inspection |

Tools with profile support: `search_symbols`, `get_file_context`, `get_change_context`, `get_symbol_context_pack`, `get_file_summary`, `find_impact_files`, `get_dependency_graph`, `get_call_chain`, `list_repositories`, `dead_code_scan`, `detect_circular_dependencies`, `detect_changes`, `link_tests_to_source`, `trace_execution_flow`, `rename_assist`, `route_map`.

Refactor tools: `refactor_replace_preview` and `refactor_replace_apply` support `nano` (summary only, no hunk content) and `compact` (hunks without before/after text). Use `nano` to check match count and affected files before requesting hunk detail.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `CODEBASE_INDEX_ALLOWED_ROOTS` | Comma-separated absolute paths allowed for indexing |

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEBASE_INDEX_DB_PATH` | `./codebase-index.db` | SQLite database path. Use an absolute path outside the project. |
| `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` | — | HMAC secret for refactor approval tokens. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CODEBASE_INDEX_TELEMETRY_ENABLED` | `false` | Enable per-tool telemetry to stderr |

### Common Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEBASE_INDEX_DOCS_INDEXING_ENABLED` | `false` | Index markdown/docs lane |
| `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` | `false` | Enable `query_docs`, `find_stale_docs`, `find_doc_coverage` |
| `CODEBASE_INDEX_MAX_FILES_PER_RUN` | `20000` | Hard cap per index run |
| `CODEBASE_INDEX_LARGE_REPO_PROFILE` | `auto` | `auto\|standard\|large\|very-large` |
| `CODEBASE_INDEX_WATCH_AUTO_START` | `false` | Auto-start watchers on startup. Keep `false`; use `watch_repo` manually. |
| `CODEBASE_INDEX_LLM_ENABLED` | `false` | When `true`, startup is rejected — LLM runtime is prohibited by policy. |

### Refactor Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL` | `false` | Reject startup if approval secret is not set |
| `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS` | `1800000` | Preview token TTL (30 min) |

### Watch Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEBASE_INDEX_WATCH_DEBOUNCE_MS` | `1200` | File change debounce |
| `CODEBASE_INDEX_WATCH_MAX_FILES_PER_RUN` | `4000` | Max files per incremental watch run |
| `CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS` | `900000` | Idle watcher auto-stop TTL (15 min) |

### Advanced Tuning

| Variable | Description |
|----------|-------------|
| `CODEBASE_INDEX_BATCH_BYTE_BUDGET` | Per-batch byte budget in pipeline |
| `CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE` | CALLS edge cap per file |
| `CODEBASE_INDEX_MIN_EDGE_CONFIDENCE` | Minimum edge confidence filter in extractor |
| `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS` | Force enable/disable post-phase type-ref resolution |

## MCP Host Configuration

### Profile A — Workspace-local (portable)

```json
{
  "mcpServers": {
    "codebase-index-local": {
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
npm run benchmark:plan:check       # quality gate: compact savings must be ≥ 40%
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
- **Staleness**: incremental index fast-skips when indexed commit equals `HEAD` and working tree is clean.
- **Windows native build**: `better-sqlite3` requires Visual Studio C++ Build Tools. If build fails, install VS Build Tools.
- **Docs lane**: disabled by default (`CODEBASE_INDEX_DOCS_INDEXING_ENABLED=false`). Use `docsMode: "off"` per run for fastest indexing.
- **Watch**: keep `CODEBASE_INDEX_WATCH_AUTO_START=false`. Start watchers manually only during active debug sessions, stop immediately after.
