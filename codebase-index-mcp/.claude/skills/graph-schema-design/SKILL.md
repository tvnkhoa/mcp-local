---
name: graph-schema-design
description: "Design graph schema for code intelligence storage (dependencies, call chain, flow) with internal DB constraints. Use when modeling nodes/edges for codebase indexing MCP."
---

# Graph Schema Design

## When to Use
- Define or evolve storage model for code intelligence.
- Add new edge types or query capabilities.

## Schema Baseline
- Nodes: `Repository`, `Revision`, `File`, `Module`, `Symbol`, `IndexRun`
- Edges: `CONTAINS`, `IMPORTS`, `EXPORTS`, `CALLS`, `DEPENDS_ON`, `CHANGED_IN`

## Procedure
1. Define node identity keys and versioning strategy.
2. Define edge semantics and direction conventions.
3. Add query-oriented indexes for hot paths.
4. Document migration strategy and backward compatibility.
5. Add sample queries for dependency graph and call chain.

## Guardrails
- Keep tenant/repo boundaries explicit in every primary index/query path.
- Do not store raw sensitive code snippets unless justified.
- Track provenance: parser version, rule version, run id.
