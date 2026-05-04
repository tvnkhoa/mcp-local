# codebase-index-ui

Local visualization UI for `codebase-index-mcp`.

## ✨ What's New in v0.2.0 (2026-04-23)

**Enhanced User Experience:**
- 🎯 **ETA Display** - See estimated time remaining during indexing (e.g., "ETA: 2m 30s")
- 📊 **Language Breakdown** - Visual badges showing top 5 languages being indexed
- 🔄 **Auto-refresh Graph** - Graph loads automatically when indexing completes
- 🎨 **Improved Progress Panel** - Rich real-time stats with language-specific counts

See `../QUICK_START.md` for usage guide.

---

## Prerequisites

- `codebase-index-mcp` HTTP bridge running on localhost (default `http://127.0.0.1:4310`).
- Indexed repo data available in the backend DB.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173/` in your browser.

## Build

```bash
npm run typecheck
npm run build
npm run preview
```

## Features

- Health check against backend API.
- Start index run from UI (`POST /index`) with `repoPath`, `mode`, `maxFiles`, `batchSize`.
- **NEW**: Live progress with ETA and language breakdown via WebSocket.
- **NEW**: Auto-refresh graph when indexing completes.
- Cancel active run from UI (`POST /index/cancel`).
- Graph visualization for:
	- `module-flow` by `filePath`
	- `dependency` by `symbolId`
	- `call-chain` by `symbolId` + `direction`
- Impact surface panel by `filePath`.
- Uses unified backend route `GET /graph/view` and impact route `GET /graph/impact`.

## Enhanced Progress Panel

The progress panel now shows:
- Progress bar with percentage
- **ETA**: Estimated time remaining (e.g., "ETA: 1m 45s")
- **Language breakdown**: Top 5 languages with indexed/scanned counts
- Batch progress, indexed/skipped/failed counts
- Real-time updates via WebSocket

Example:
```
Index progress                    1234/5000 files
[████████████░░░░░░░░░░░░░░░░] 45%

RUNNING • batch 9/25 • indexed 1100 • skipped 134 • parseFailures 0 • ETA: 1m 45s

┌─────────────────────────────────────────┐
│ typescript: 450/500                     │
│ javascript: 280/300                     │
│ json: 240/250                           │
└─────────────────────────────────────────┘
```

## Notes

- This is local/internal UI scope.
- The graph is module/file-centric in current backend model.
- State is persisted in localStorage for convenience.
