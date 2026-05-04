# codebase-index-mcp

Internal MCP server for repository indexing and lightweight graph queries.

## ✨ What's New in v0.2.0 (2026-04-23)

**Performance & UX Enhancements:**
- ⚡ **30-50% faster** file discovery with smart glob ignore patterns
- ⚡ **2-3x faster** database writes with SQLite WAL mode
- 🎯 **ETA display** - Real-time estimated time remaining
- 📊 **Language breakdown** - See top 5 languages being indexed
- 🔄 **Auto-refresh** - Graph loads automatically after indexing

See `ENHANCEMENTS_IMPLEMENTED.md` for technical details and `QUICK_START.md` for usage guide.

---

Current integration:
- Real content classification via `magika` (portable runtime)
- Real AST extraction for JS/TS via `tree-sitter`

## Features

- `health_check`
- `index_repository` - **Enhanced with ETA & language tracking**
- `get_dependency_graph`
- `get_call_chain`
- `get_module_flow`
- `find_impact_surface`
- Batch commit indexing (partial progress persisted per batch)
- Progress output in terminal (`[index-progress] ...`)
- **NEW**: Real-time progress with ETA and language breakdown via WebSocket

## Security defaults

- Internal storage only (SQLite via `better-sqlite3`)
- Path allowlist required by `CODEBASE_INDEX_ALLOWED_ROOTS`
- Bounded input params (`maxFiles`, `limit`)
- Basic sensitive pattern redaction before storage
- Classifier+path layered filtering to reduce binary/noisy ingestion

## Environment variables

- `CODEBASE_INDEX_ALLOWED_ROOTS` (required): comma-separated absolute paths allowed for indexing.
- `CODEBASE_INDEX_DB_PATH` (optional): defaults to `./codebase-index.db`.
- `CODEBASE_INDEX_HTTP_HOST` (optional): defaults to `127.0.0.1`.
- `CODEBASE_INDEX_HTTP_PORT` (optional): defaults to `4310`.
- `CODEBASE_INDEX_HTTP_API_KEY` (optional): if set, clients must send matching `x-api-key`.
- `CODEBASE_INDEX_MAX_FILES_PER_RUN` (optional): defaults to `20000`.
- `CODEBASE_INDEX_MAX_RESULT_LIMIT` (optional): defaults to `500`.
- `CODEBASE_INDEX_MAX_DEPTH` (optional): defaults to `5`.

> If `better-sqlite3` native build fails on Windows environments without build tools, install Visual Studio C++ Build Tools or switch temporarily to a JS-only SQLite backend in a follow-up patch.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev
npm run dev:http
```

Run HTTP bridge (for local UI):

```bash
npm run start:http
```

## Smoke test

```bash
node scripts/smoke-test.mjs
```

Smoke test now validates more than startup:
- MCP handshake + tool listing
- `health_check`
- `index_repository` on current workspace (bounded sample)
- `get_module_flow` for `src/index.ts` in the indexed repo

## Sample tool inputs

`index_repository`

```json
{
	"repoId": "mcp-local",
	"repoPath": "d:/1.SourceCode/mcp-local",
	"mode": "incremental",
	"maxFiles": 5000,
	"batchSize": 200
}
```

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

## Runbook

- Full re-index: call `index_repository` with `mode: "full"`.
- Incremental re-index: call `index_repository` with `mode: "incremental"` (unchanged files are skipped by hash).
- Recovery from partial failures: re-run `index_repository` for same `repoId`; upserts make reruns idempotent.

## Notes

This is v1 integration scope. JS/TS AST extraction is implemented; other languages currently remain fallback/no-op for parser-level symbol extraction.

Magika is loaded lazily. If classifier runtime fails to initialize in a target environment, the server stays up and falls back to extension-based filtering for supported source types.

## Local HTTP API (read-only bridge)

This package now includes a localhost API bridge for UI visualization use-cases.

- `GET /health?repoId=<id>`
- `POST /index` (supports `batchSize`)
- `GET /index/progress?repoId=<id>`
- `POST /index/cancel` with body `{ "repoId": "..." }`
- `GET /graph/module-flow?repoId=<id>&filePath=<path>&limit=<n>`
- `GET /graph/view?repoId=<id>&view=module-flow|dependency|call-chain&...`
- `GET /graph/dependency?repoId=<id>&symbolId=<id>&depth=<n>&limit=<n>`
- `GET /graph/call-chain?repoId=<id>&symbolId=<id>&direction=callers|callees&depth=<n>&limit=<n>`
- `GET /graph/impact?repoId=<id>&filePath=<path>&limit=<n>`
- `POST /graph/resolve-nodes`

The HTTP server binds to loopback by default and reuses existing guardrails and bounds.
