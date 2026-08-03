---
name: incremental-indexing
description: "Implement hash-based incremental indexing for codebase intelligence MCP to avoid full re-index and keep graph data fresh efficiently."
---

# Incremental Indexing

## When to Use
- Re-index repositories frequently with minimal cost.

## Procedure
1. Detect changed files by commit SHA and content hash.
2. Recompute entities/edges only for impacted files.
3. Re-link affected transitive edges (imports/calls) safely.
4. Mark stale nodes/edges and clean up in controlled phase.
5. Store run stats and diff summary.

## Correctness Checks
- No orphan edges after incremental run.
- Deterministic results between full vs incremental for same revision.
- Safe rollback strategy on partial failure.

## Authoritative reference

As built: `codebase-index-mcp/CLAUDE.md` §"Data flow" and `src/services/indexing/`. Known defects and their fixes: `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.
