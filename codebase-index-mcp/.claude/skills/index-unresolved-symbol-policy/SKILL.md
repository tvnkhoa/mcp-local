---
name: index-unresolved-symbol-policy
description: "Handle references codebase-index-mcp cannot bind to a symbol: the callee:/import:/type:/property:/iface: placeholder tokens, the edgeResolver* passes that rewrite them, the confidence/reason values they carry, 'external boundary' tagging, and how unresolvedRatio reaches health_check and impact tools. Use when editing services/graph/edgeResolver*.ts, an edge cap or MIN_EDGE_CONFIDENCE, getUnresolvedStats, or impactShared.ts warnings, or when a tool shows nameless rows or synthetic ids. Not for emitting the edges in the first place (tree-sitter-extraction)."
---

# Index Unresolved Symbol Policy

**Rule: an unresolved reference is kept and labelled. It is never dropped silently and never
dressed up as resolved.** Each way this broke is on file:

- MCP-ISSUE-038: the `very-large` profile discarded every unresolved TYPE_REF.
- MCP-ISSUE-053: unresolved rows surfaced as nameless rows and synthetic ids that ate the `limit`.
- MCP-ISSUE-052: a wrong same-named edge was reported at `confidence: "high"`.

## The lifecycle, as built

1. **Extraction** emits the target as a token in `to_id`: `callee:<name>`, `import:<spec>`,
   `type:<name>`, `property:<name>`, or `iface:<name>`. `nuget:<pkg>` is used for `DEPENDS_ON`.
2. **Default labels** are set in `runGraphMigrations` (`repositories/schema.ts`):

   | Token | Confidence | Reason |
   |---|---|---|
   | `callee:` | 0.4 | `unresolved callee token` |
   | `import:` | 0.5 | `unresolved import token` |
   | `type:` | 0.45 | `unresolved type token` |
   | `property:` | 0.5 | `unresolved property token` |
3. **Resolution** (`services/graph/`) runs `edgeResolverCalls.ts`, `edgeResolverImports.ts`,
   `edgeResolverRefs.ts` and `edgeResolverContracts.ts` (IMPLEMENTS / EXTENDS / bus). Each rewrites
   `to_id`, `confidence` and `reason` in place. A token that provably points outside the repo is
   kept and tagged `reason = 'external boundary'` with confidence 0.1. It is not deleted. The resolve
   window is bounded by `CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS`. The post-resolve passes can be
   switched off with `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS` / `_PROPERTY_REFS`.
4. **Cross-repo** resolution runs **last** (`safeCrossRepoResolve`, after MCP-ISSUE-048). Its
   failures are counted in `index_runs.unresolved_no_candidate / _ambiguous / _boundary_blocked /
   _low_confidence`. Those four columns count **cross-repo** reasons only. They are not a per-file or
   per-language breakdown.
5. **Reporting.** `getUnresolvedStats` (`repositories/graphQueries.ts`) feeds
   `health_check.codebaseState`. `impactShared.ts` computes
   `unresolvedRatio = unresolved / (resolved + unresolved)` and warns above 0.05, 0.15 and 0.3.
   Above 0.3, `.claude/rules/mcp-hard-mode.md` allows baseline fallback.

## Checklist for a resolver or cap change

- [ ] Any token you cannot bind keeps its prefix and gets a `reason`. Count it with
      `query_graph(repoId: "codebase-index-mcp", sql: "select type, reason, count(*) n from edges where repo_id = :repoId and confidence < 0.5 group by type, reason")`.
- [ ] Every new cap or drop path increments an `edges_dropped_by_*` (or new) run counter. See
      `index-metadata-governance`.
- [ ] Read tools filter placeholder rows out of names and counts instead of returning them
      (MCP-ISSUE-053), and a result is never labelled `high` confidence on a token edge.
- [ ] Unknown input returns an honest empty result, not a confident one:
      `npm run test:unknown-input-honesty`.
- [ ] Before/after: S3 (unresolved by type) and I2 (dangling `to_id`) from
      `incremental-indexing` → *Verification: full vs incremental*, on a live index.

## Harnesses

`npm run test:unit` covers `edgeResolverCalls.test.ts`, `edgeResolverShared.test.ts` and
`moduleResolution.test.ts`. The relevant integration harnesses are `test:interface-dispatch`,
`test:base-class-dispatch`, `test:call-chain-interface`, `test:issue-052-qualified-call`,
`test:csharp-type-refs`, `test:csharp-using-bridge`, `test:nuget-bridge`, `test:bus-edges`,
`test:impact-join-parity` and `test:unknown-input-honesty`. Build first.

## Authoritative reference

`services/graph/edgeResolver*.ts`, and MCP-ISSUE-034/038/045/052/053 in
`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.
