# codebase-index-mcp

Internal MCP server for repository indexing and lightweight graph queries.

## ✨ What's New in v0.3.0 (2026-05-04)

**Plan/Agent pipeline enhancements:**
- ✅ **Docs lane isolation**: code-first by default with `CODEBASE_INDEX_DOCS_INDEXING_ENABLED=false` and `CODEBASE_INDEX_DOCS_TOOLS_ENABLED=false`.
- ✅ **Per-run docs control**: `index_repository` now supports `docsMode` = `auto | on | off`.
- ✅ **Benchmark quality gate**: `benchmark:plan:check` enforces compact-mode savings thresholds and per-scenario checks.
- ✅ **Expanded smoke coverage**: validates by-name tools and profile behavior (`compact <= standard <= verbose`).
- ✅ **Integration playbook**: README now includes concrete setup and call flows for Plan mode and Agent mode.

See `../ENHANCEMENTS_IMPLEMENTED.md` for technical details and `../QUICK_START.md` for usage guide.

---

Current integration:
- Binary sniff + extension-based file filtering (fast, zero overhead)
- Real AST extraction via `tree-sitter` for: JavaScript, TypeScript, C#
- .NET project parser for `.csproj` / `.sln` (NuGet + ProjectReference edges)

## Features

- `health_check`
- `index_repository` - **Enhanced with ETA & language tracking**
- `get_dependency_graph`
- `get_call_chain`
- `list_repositories`
- `search_symbols` (`profile: nano|compact|standard|verbose`; `strategy: "name" | "intent"`)
- `get_file_context` (`profile: nano|compact|standard|verbose`)
- `get_symbol_detail`
- `find_impact_files`
- `get_change_context`
- `get_file_summary`
- `get_symbol_context_pack`
- `query_docs` (requires `CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true`)
- `watch_repo` (`action`: `start` | `stop` | `status`)
- `find_symbol_at_line`
- `detect_changes` (includes deterministic `riskScore`/`riskLevel`, supports filter knobs `minRiskScore`/`riskLevels`/`maxResults`/`sortBy`, and policy presets: `quick-triage`, `strict-review`, `release-gate`, `custom`)
- `get_folder_summary`
- `find_entry_points` (returns `runtimeEntryPoints` + `graphEntryPoints` groups)
- `find_implementations`
- `route_map`
- `query_graph`
- `rename_assist`
- `refactor_replace_preview`
- `refactor_replace_apply`
- `refactor_replace_rollback`
- `refactor_symbol_migration`
- `trace_execution_flow`
- `dead_code_scan`
- `detect_circular_dependencies`
- `get_cross_repo_impact`
- `get_symbol_blame`
- `link_tests_to_source`
- Batch commit indexing (partial progress persisted per batch)
- Progress output in terminal (`[index-progress] ...`)

## Security defaults

- Internal storage only (SQLite via `better-sqlite3`)
- Path allowlist required by `CODEBASE_INDEX_ALLOWED_ROOTS`
- Bounded input params (`maxFiles`, `limit`)
- Basic sensitive pattern redaction before storage
- Classifier+path layered filtering to reduce binary/noisy ingestion
- Deterministic no-LLM runtime policy for refactor engine (`decisionSource=rule_engine`, `llmInvolved=false`)

## Environment variables

- `CODEBASE_INDEX_ALLOWED_ROOTS` (required): comma-separated absolute paths allowed for indexing.
- `CODEBASE_INDEX_DB_PATH` (optional): defaults to `./codebase-index.db`.
- `CODEBASE_INDEX_MAX_FILES_PER_RUN` (optional): defaults to `20000`.
- `CODEBASE_INDEX_LARGE_REPO_PROFILE` (optional): `auto | standard | large | very-large` (also accepts legacy `off | balanced | aggressive`). Defaults to `auto`.
- `CODEBASE_INDEX_MAX_RESULT_LIMIT` (optional): defaults to `500`.
- `CODEBASE_INDEX_MAX_DEPTH` (optional): defaults to `5`.
- `CODEBASE_INDEX_TELEMETRY_ENABLED` (optional): defaults to `false`; enables per-tool telemetry logs to stderr.
- `CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE` (optional): defaults to `1`; range `0..1` for telemetry sampling.
- `CODEBASE_INDEX_DOCS_INDEXING_ENABLED` (optional): defaults to `false`; controls whether docs lane is indexed by default.
- `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` (optional): defaults to `false`; controls whether docs tools (`search_docs`, `find_stale_docs`, `find_doc_coverage`) are callable.
- `CODEBASE_INDEX_LLM_ENABLED` (optional): defaults to `false`; when `true`, server startup is rejected because runtime LLM invocation is prohibited by policy.
- `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` (optional but recommended): HMAC secret used to sign/verify `refactor_replace_apply` approval tokens.
- `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL` (optional): defaults to `false`; when `true`, startup is rejected unless `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` is set.
- `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS` (optional): defaults to `1800000` (30 minutes); expiration window for preview/apply approval.
- `CODEBASE_INDEX_WATCH_AUTO_START` (optional): defaults to `false`; when `true`, the server may auto-start/auto-activate watchers.
- `CODEBASE_INDEX_AUTO_WATCH_REPOS` (optional): explicit startup watch targets formatted as `repoId=absPath,repo2=absPath2`.
- `CODEBASE_INDEX_WATCH_ACTIVE_ONLY` (optional): defaults to `true`; keeps one active watcher at a time and rotates by last interaction.
- `CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS` (optional): defaults to `900000` (15 minutes); idle active watcher is auto-stopped after TTL.
- `CODEBASE_INDEX_WATCH_DEBOUNCE_MS` (optional): defaults to `1200`.
- `CODEBASE_INDEX_WATCH_MAX_QUEUED_EVENTS` (optional): defaults to `2000`.
- `CODEBASE_INDEX_WATCH_MAX_FILES_PER_RUN` (optional): defaults to `4000`.
- `CODEBASE_INDEX_WATCH_BATCH_SIZE` (optional): defaults to `200`. 

Refactor apply notes:
- `refactor_replace_apply` supports `includeLowConfidence` (default `false`).
- With default settings, low-confidence candidates are reported but not applied.
- Apply output includes `laneBreakdown` (`highConfidenceEdits`, `lowConfidenceEdits`, `lowConfidenceSkipped`) and `scopeCheck`.
- If newly changed files after apply drift beyond expected preview scope threshold (5%), diagnostics code is `SCOPE_DRIFT_DETECTED`.
- Refactor tool outputs include `executionPolicy` with `decisionSource=rule_engine`, `llmInvolved=false`, and `approvalMode` (`strict` | `local-fallback`).
- Preview lifecycle status reflects apply outcome (`applied`, `apply_partial`, `apply_failed`) instead of always using a single applied state.
- `refactor_symbol_migration` supports optional `initializerRewrite` per migration for C# owned-state/object-initializer rewrites:

```json
{
	"fromSymbol": "CrmCustomerId",
	"toSymbol": "IdentityState.CrmCustomerId",
	"requiredOwnerType": "Conversation",
	"forbiddenOwnerTypes": [],
	"initializerRewrite": {
		"objectProperty": "IdentityState",
		"objectType": "ConversationIdentityState",
		"targetMember": "CrmCustomerId"
	}
}
```

- When `initializerRewrite` is set and the match is a C# object-initializer member assignment, preview/apply rewrites the full assignment to a guarded owned-state expression such as `IdentityState = new ConversationIdentityState { CrmCustomerId = 1 },` instead of producing an invalid dotted initializer member.
- `refactor_symbol_migration` dry-run output now includes `previewSummary` so callers can inspect the exact before/after initializer rewrite before apply.

No-config defaults:
- Keep only required config (`CODEBASE_INDEX_ALLOWED_ROOTS`) for normal usage.
- Performance profile is selected automatically from repo scale (`standard` / `large` / `very-large`).
- Post-phase resolver budget and edge extraction policies are derived from profile by default.

Advanced tuning (optional overrides):
- `CODEBASE_INDEX_BATCH_BYTE_BUDGET`: override per-batch byte budget in pipeline.
- `CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE`: override CALLS edge cap per file.
- `CODEBASE_INDEX_MIN_EDGE_CONFIDENCE`: override minimum edge confidence filter in extractor.
- `CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS`: override unresolved rows processed per resolver pass.
- `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS`: force enable/disable post-phase type-ref resolution.

GitNexus-style staleness behavior:
- Incremental index now fast-skips when indexed commit equals `HEAD` and git working tree is clean.
- The skip run is still recorded in `index_runs` with zero counters and `skipReason` in tool output.
- Watchless by default: keep auto-watch disabled for normal operation, and use `watch_repo` only for short manual debug sessions.

`health_check` now reports actionable codebase readiness:
- `serverVersion` resolves from npm runtime env or falls back to package version.
- `codebaseState.status`: `unknown | needs_index | stale | dirty | ready`.
- `codebaseState.shouldReindex`: true when first index is missing, commit is stale, or working tree is dirty.
- `codebaseState.shouldEnableWatch`: true when local edits are pending and no watcher is active for the repo.
- `watch`: includes watcher runtime status and counters for the requested repo.
- `actionHints`: machine-readable suggestions for `index_repository` and `watch_repo start` with urgency + reason.

> If `better-sqlite3` native build fails on Windows environments without build tools, install Visual Studio C++ Build Tools or switch temporarily to a JS-only SQLite backend in a follow-up patch.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run guard:no-llm-runtime
npm run dev
npm run benchmark:plan
npm run benchmark:plan:check
```

Benchmark gate environment knobs:
- `BENCH_MIN_COMPACT_SAVINGS_PERCENT` (optional): minimum compact saving percentage required for `benchmark:plan:check` (default `40`).
- `BENCH_REQUIRE_COMPACT_LOWER_PER_SCENARIO` (optional): when `true`, each scenario must satisfy `compact <= standard` response bytes (default `true`).

## Smoke test

```bash
node scripts/smoke-test.mjs
```

Smoke test now validates more than startup:
- MCP handshake + tool listing
- `health_check`
- `index_repository` on current workspace (bounded sample)
- `get_dependency_graph` / `find_impact_files` for `src/index.ts` in the indexed repo
- `get_symbol_context_pack` output validity
- `detect_changes` output validity

## Integrate MCP into Plan/Agent pipeline

This server is designed for **code-first reasoning** in Plan mode and Agent mode, with docs lane isolated by default.

### 1) Register MCP server in host

Choose one config profile depending on your usage.

Profile A - workspace-local (portable, isolated per workspace):

```json
{
	"servers": {
		"codebase-index-local": {
			"command": "node",
			"args": [
				"${workspaceFolder}/codebase-index-mcp/dist/index.js"
			],
			"env": {
				"CODEBASE_INDEX_ALLOWED_ROOTS": "${workspaceFolder}",
				"CODEBASE_INDEX_DB_PATH": "${workspaceFolder}/mcp-local-index.db"
			}
		}
	}
}
```

Profile B - central cross-repo (recommended for bridge package impact across many repos):

```json
{
	"servers": {
		"codebase-index-central": {
			"command": "node",
			"args": [
				"D:/1.SourceCode/mcp-local/codebase-index-mcp/dist/index.js"
			],
			"env": {
				"CODEBASE_INDEX_ALLOWED_ROOTS": "D:/1.SourceCode/crm",
				"CODEBASE_INDEX_DB_PATH": "D:/1.SourceCode/mcp-local/mcp-local-index-central.db"
			}
		}
	}
}
```

Notes:
- Profile A avoids manual path edits and is best for per-repo development.
- Profile B is better for cross-repo class in/out mapping and impact tracing.
- For multi-root workspace, use `${workspaceFolder:<folderName>}` to target a specific root.
- If you use central DB, keep it out of git and back it up periodically.

Recommended default for token efficiency:
- Keep no-config defaults unless you need docs lane.
- Use `profile: "nano"` on read tools in Plan flow when you only need quick routing context.
- Use `profile: "compact"` when you still need lightweight field-level details.

### 2) Warm-up indexing stage

Run this once before planning loop (or on file changes):

```json
{
	"name": "index_repository",
	"arguments": {
		"repoId": "wec.be",
		"repoPath": "d:/1.SourceCode/crm/wec.be",
		"mode": "incremental",
		"docsMode": "off",
		"batchSize": 200
	}
}
```

Notes:
- If `maxFiles` is omitted, the tool now uses the current hard cap from `CODEBASE_INDEX_MAX_FILES_PER_RUN`.
- If a repo exceeds that cap, stderr will print an explicit `[index-cap] ...` message instead of silently stopping at the limit.

Use `docsMode` per run:
- `off`: fastest code-only lane (recommended for Plan/Agent by default)
- `on`: include docs extraction for docs maintenance tasks
- `auto`: follow `CODEBASE_INDEX_DOCS_INDEXING_ENABLED`

### 3) Plan mode retrieval pipeline (token-saving)

Suggested call sequence:
1. `search_symbols` with `profile: "nano"` to locate candidate symbols (`strategy: "intent"` for natural-language-like queries).
2. `get_context_by_name` with `profile: "nano"` for single-symbol package.
3. `get_change_context_by_name` with `profile: "nano"` for callers/callees impact.
4. `get_file_context` only for selected files that need deeper context.

Why this order works:
- Early calls keep payload small.
- By-name tools reduce multi-hop lookups.
- Deep context is requested only when needed.

### 4) Agent mode execution pipeline (implement safely)

Suggested execution loop:
1. Discover target symbol/file: `search_symbols` or `get_symbol_candidates`.
2. Build impact map: `get_change_context_by_name`.
3. Inspect exact files: `get_file_context` / `get_batch_context`.
4. Apply code edits.
5. Re-index incrementally: `index_repository` with `mode: "incremental"`.
6. Re-check impact/refs with `get_change_context_by_name`.

Optional docs sync stage:
- Enable docs lane (`docsMode: "on"` or env flags), then call:
	- `find_doc_coverage`
	- `find_stale_docs`
	- `search_docs`

### 5) Guardrails and quality gates

For CI or pre-merge checks:
- `npm run build`
- `node scripts/smoke-test.mjs`
- `npm run benchmark:plan:check`

The benchmark gate fails with non-zero exit code when compact-mode savings regress below threshold.

### 6) Quick Start Cross-Repo (central DB)

Use this when you need cross-repo impact analysis between a large monorepo and a smaller bridge repo.

Step 1: index the first repo.

```json
{
	"name": "index_repository",
	"arguments": {
		"repoId": "crm-mono",
		"repoPath": "d:/1.SourceCode/crm/wec.be",
		"mode": "incremental",
		"docsMode": "off",
		"maxFiles": 12000,
		"batchSize": 300
	}
}
```

Step 2: index the second repo (bridge/adapter).

```json
{
	"name": "index_repository",
	"arguments": {
		"repoId": "crm-bridge",
		"repoPath": "d:/1.SourceCode/crm/wec.communication-hub",
		"mode": "incremental",
		"docsMode": "off",
		"maxFiles": 5000,
		"batchSize": 200
	}
}
```

Step 3: run a fast impact check by symbol name.

```json
{
	"name": "get_change_context_by_name",
	"arguments": {
		"repoId": "crm-bridge",
		"name": "YourBridgeClassName",
		"callerDepth": 2,
		"calleeDepth": 1,
		"limit": 30,
		"profile": "compact"
	}
}
```

Tips:
- Keep `repoId` stable across runs so historical context stays consistent.
- Use `profile: "compact"` first, then escalate to `standard` only when needed.
- Re-run `index_repository` incrementally after each bridge change before re-checking impact.

## Sample tool inputs

`index_repository`

```json
{
	"repoId": "<repo-id>",
	"repoPath": "<absolute-path-under-allowed-roots>",
	"mode": "incremental",
	"docsMode": "auto",
	"maxFiles": 5000,
	"batchSize": 200
}
```

`docsMode` options:
- `auto`: follow server default from `CODEBASE_INDEX_DOCS_INDEXING_ENABLED`
- `on`: force docs indexing for this run
- `off`: skip docs indexing for this run

`get_call_chain`

```json
{
	"repoId": "mcp-local",
	"symbolId": "<symbol-id>",
	"direction": "callees",
	"depth": 2,
	"limit": 100
}
```

`get_context_by_name` (token-friendly)

```json
{
	"repoId": "mcp-local",
	"name": "GraphStore",
	"limit": 20,
	"profile": "compact"
}
```

## Response Profiles

These read tools support `profile` with values `compact`, `standard`, `verbose`:
- `search_symbols`
- `get_file_context`
- `get_batch_context`
- `get_change_context`
- `get_context_by_name`
- `get_change_context_by_name`
- `get_symbol_candidates`

Behavior:
- `compact`: smallest payload for Plan mode (also serialized as minified JSON)
- `standard`: default balanced payload
- `verbose`: includes extra summary/debug fields

Backward compatibility:
- `search_symbols`, `get_file_context`, and `get_batch_context` still accept `compact: true`.
- `search_symbols` supports `strategy: "name" | "intent"` (`name` default for backward compatibility).
- If both `compact: true` and `profile` are provided, `compact` takes precedence.

## Runbook

- Full re-index: call `index_repository` with `mode: "full"`.
- Incremental re-index: call `index_repository` with `mode: "incremental"` (unchanged files are skipped by hash).
- Recovery from partial failures: re-run `index_repository` for same `repoId`; upserts make reruns idempotent.
- Default operation: keep `CODEBASE_INDEX_WATCH_AUTO_START=false` and refresh index via `index_repository` + staleness checks.
- Optional auto watch startup: set `CODEBASE_INDEX_AUTO_WATCH_REPOS` and `CODEBASE_INDEX_WATCH_AUTO_START=true` when continuous watching is explicitly required.
- Runtime watch control: use `watch_repo`.
	- Start: `{ "action": "start", "repoId": "<id>", "repoPath": "<abs-path>" }`
	- Stop: `{ "action": "stop", "repoId": "<id>" }`
	- Status (one repo): `{ "action": "status", "repoId": "<id>" }`
	- Status (all repos): `{ "action": "status" }`
- Manual-watch practice: start only during debug, then stop immediately after diagnostics to avoid background contention.

## Notes

AST extraction is implemented for JavaScript/TypeScript/C# via tree-sitter. `.csproj`/`.sln` files are parsed with a dedicated parser to extract NuGet and ProjectReference dependencies.

Binary files are rejected via null-byte sniff on the first 512 bytes — no external classifier needed.
