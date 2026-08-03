---
description: "Use when building or updating MCP tools for codebase indexing, dependency analysis, call-chain tracing, or architecture flow mapping. Covers parser strategy, graph modeling, and internal-storage guardrails."
---
> Scope: `codebase-index-mcp/**` (TS + docs + config).

# Codebase Index MCP Rules

- Design for **incremental indexing** first; avoid full re-index on every run.
- Prefer parser-based extraction (`tree-sitter`) over regex for symbols/imports/call edges.
- Use binary sniff (null-byte check) + extension allowlist to skip binary/noisy/non-source files before parse.
- Keep index schema explicit: nodes (repo/file/symbol/module) and edges (imports/calls/contains/depends_on).
- Record index run metadata (version, commit SHA, startedAt, finishedAt, status, counters).

## MCP Tool Contract
- Keep tools focused and composable. The core traversal set, as actually declared in
  `contracts/codebase-index.json`:
  - `index_repository`
  - `get_dependency_graph`
  - `get_call_chain`
  - `trace_execution_flow` — execution sub-graph from a callable entry symbol
  - `find_impact_files` with `view: "surface"` — the caller surface per symbol
- Validate all inputs with schema and enforce hard bounds (`depth`, `limit`, `timeoutMs`).
- Return deterministic error codes for unsupported language/parser/index state.
- `contracts/codebase-index.json` is authoritative for names and parameters. Verify against it before
  citing a tool here — this list previously named `get_module_flow` and `find_impact_surface`, neither
  of which ever existed.

## Internal Security & Storage
- Internal-only deployment; no external data exfiltration paths by default.
- Enforce tenant/repo isolation in storage and query paths.
- Do not store secrets in index payloads; redact obvious credential patterns.
- Do not log raw sensitive source blocks when unnecessary; prefer hashes and metadata.

## Operability
- Add health/status endpoints or MCP health tool for index freshness.
- Track performance metrics: files scanned, parse failures, edge count, elapsed time.
- Document runbooks for full reindex, incremental reindex, and recovery from partial failure.
