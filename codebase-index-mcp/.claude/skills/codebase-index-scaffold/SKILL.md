---
name: codebase-index-scaffold
description: "Scaffold an internal MCP server for intelligent codebase indexing and graph queries. Use for creating index_repository/dependency/call-chain analysis capabilities backed by DB storage."
---

# Codebase Index Scaffold

## When to Use
- Create a new MCP package for code intelligence.
- Bootstrap index/query pipeline for internal repositories.

## Procedure
1. Create package skeleton (`src/index.ts`, config, scripts, README).
2. Define core tool schemas with strict limits and clear errors.
3. Add index pipeline phases:
   - file discovery
   - binary sniff + extension allowlist filtering
   - parser extraction (tree-sitter)
   - graph persistence
4. Add query layer for dependency/call chain/impact analysis.
5. Add index-run metadata + idempotent incremental mode.
6. Document operational steps and recovery procedures.

## Output Requirements
- Minimal, safe defaults.
- Internal-only posture.
- Clear MCP tool contracts and examples.

## Authoritative reference

**This server already exists.** To add a *new* server, use `npm run new:server` and follow `docs/servers/server-development.md` §1–2 — do not hand-build one. This skill is kept for the design reasoning only.
