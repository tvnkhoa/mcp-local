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
- Keep tools focused and composable:
  - `index_repository`
  - `get_dependency_graph`
  - `get_call_chain`
  - `get_module_flow`
  - `find_impact_surface`
- Validate all inputs with schema and enforce hard bounds (`depth`, `limit`, `timeoutMs`).
- Return deterministic error codes for unsupported language/parser/index state.

## Internal Security & Storage
- Internal-only deployment; no external data exfiltration paths by default.
- Enforce tenant/repo isolation in storage and query paths.
- Do not store secrets in index payloads; redact obvious credential patterns.
- Do not log raw sensitive source blocks when unnecessary; prefer hashes and metadata.

## Operability
- Add health/status endpoints or MCP health tool for index freshness.
- Track performance metrics: files scanned, parse failures, edge count, elapsed time.
- Document runbooks for full reindex, incremental reindex, and recovery from partial failure.
