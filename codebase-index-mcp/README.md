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
- Binary sniff + extension-based file filtering (fast, zero overhead)
- Real AST extraction via `tree-sitter` for: JavaScript, TypeScript, C#, Python, Go, Java, Ruby, Rust, PHP
- .NET project parser for `.csproj` / `.sln` (NuGet + ProjectReference edges)

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

AST extraction implemented for 9 languages via tree-sitter. .csproj/.sln files are parsed with a dedicated regex-based parser to extract NuGet and ProjectReference dependencies.

Binary files are rejected via null-byte sniff on the first 512 bytes — no external classifier needed.
- `GET /graph/dependency?repoId=<id>&symbolId=<id>&depth=<n>&limit=<n>`
- `GET /graph/call-chain?repoId=<id>&symbolId=<id>&direction=callers|callees&depth=<n>&limit=<n>`
- `GET /graph/impact?repoId=<id>&filePath=<path>&limit=<n>`
- `POST /graph/resolve-nodes`

The HTTP server binds to loopback by default and reuses existing guardrails and bounds.
