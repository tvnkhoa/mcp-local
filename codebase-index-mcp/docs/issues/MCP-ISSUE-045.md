## MCP-ISSUE-045 — cross-repo resolution matches bare type names, so `Task` links every repo to one unrelated class

- **Status:** **FIXED** 2026-08-04 — see below. **New** when filed; not previously reported.
- **Scenario:** `query_graph{ sql:"SELECT from_symbol_id, to_repo_id, to_symbol_id, type FROM cross_repo_deps WHERE from_repo_id=:repoId LIMIT 10" }` on `wec.communication-hub` → 7 of 10 rows point at the same `to_symbol_id` (`2e1d3ffff6aa4656e787707d`). Resolving it: `get_cross_repo_impact{ symbolId:"00031af4f1504af45a0e4c0a", direction:"outbound" }` → `relatedName:"Task"`, `relatedFilePath:"src\\SSNet.QueueManagement\\Domain\\Model\\Task.cs"`, `relatedSignature:"public class Task"`, `contractType:"symbol"`, **`resolutionReason:"symbol_id_exact_match"`**.
- **Expected vs actual:** the consuming symbol is a Hub integration test using `System.Threading.Tasks.Task`. Expected: no cross-repo edge (a BCL type is not an ssnet contract). Actual: an edge to an unrelated domain class in `SSNet.QueueManagement`, presented with the highest-confidence reason string the tool has.
- **Impact:** cross-repo counts are noise. `crossRepoLinked: 8` on the full run is mostly this one false target, and the number moves with run mode (`crossRepoResolved` 8 on `full` vs **459** on `dirty` over 3 files — see MCP-ISSUE-048), so it cannot be used as a coverage signal or a data-contract gate. `get_cross_repo_impact` inherits the falsehood.
- **Workaround:** for contract questions use `get_value_contract_impact` (literal-based, verified correct on `"call_log"` across hub+ssnet) or `find_package_consumers` + the `nuget:` edge query, and ignore `cross_repo_deps` type rows whose name is a BCL type.
- **Enhancement proposal:** require more than a name match to cross a repo boundary — namespace agreement (the consumer must `using` a namespace the provider repo actually declares), exclusion of BCL/framework type names, or a provider-side `module` symbol carrying the package contract id (the bridge ISSUE-CR-001 describes). Whatever the rule, `resolutionReason` should distinguish "matched by symbol id" from "matched by bare name", because those are not the same claim.

### What shipped 2026-08-04 — the denylist, plus honest provenance

- **Framework types no longer cross a repo boundary.** `edgeResolverRefs.ts` gates the
  `findProviderSymbolByName` fallback on a new `isKnownExternalTypeName`, which reuses the existing
  `KNOWN_EXTERNAL_TYPE_RECEIVERS` set (it already contained `Task`, `CancellationToken`, `ILogger`,
  `IServiceCollection`). A namespace-qualified raw token is also checked, so
  `System.Text.Json.JsonSerializerOptions` is excluded on its namespace rather than its last segment.
  The gate runs **after** same-repo `pickBestNamedCandidate` has failed, so it cannot affect resolution
  within a repo — and a cross-repo link to a framework type is never correct anyway. The function's own
  doc comment already said the intent was to avoid "cross-repo links to framework types that do not
  exist"; the code did the opposite in a multi-repo DB.
- **Deliberately NOT done: widening `isKnownExternalToken` itself.** The CALLS lane calls it on bare
  *method* names, and that set contains `Log`, `Is`, `Has`, `Type`, `String` and `Mock` — accepting bare
  names there would silently suppress real call edges. Hence a separate, narrowly-scoped export.
- **`resolutionReason` tells the truth.** `get_cross_repo_impact` derived its reason from the related
  symbol's *signature*, so a bare-name guess at confidence 0.65 was reported as
  `symbol_id_exact_match` — the strongest reason string the tool has. The originating edge's `reason` is
  the only place that distinction survives (`cross_repo_deps` has no `reason` column), so the query now
  reads it via a scalar subquery and reports `cross_repo_bare_name_match`. No migration needed.
- **Namespace agreement remains the durable rule** and is not implemented here; the denylist is what
  closes the reported falsehood. See also the phase-ordering fix in MCP-ISSUE-048, which addresses the
  full-vs-dirty count inversion this entry points at.

### Second defect, found by verifying the first: `cross_repo_deps` was append-only

The denylist shipped, a full re-index ran — and `Task` still had **408** links (worse than the
7-of-10 this entry reported, because the sweep sampled only 10 rows). The gate was working; the table
was not being rebuilt.

`cross_repo_deps` is written with `insert … on conflict do nothing` and **had no delete path anywhere
in `src/`**. It was append-only for the lifetime of the database, so every link created by an earlier,
wronger rule survived indefinitely. The run that "fixed" it resolved 123 links while the table held
522 — the arithmetic alone shows it was never rebuilt.

A resolution rule that cannot heal the rows it already wrote is not a fix. A **full** run now clears
this repo's outbound links before re-resolving (`clearOutboundCrossRepoDeps`, called from
`indexRunner`). Scoped two ways on purpose: `from_repo_id = this repo`, because rows pointing *into*
this repo belong to the other repo's run; and full runs only, because a dirty/incremental run
re-extracts a subset and would drop links whose source files it never examined.

**Generalizable lesson:** the same shape exists wherever a derived table is written with
`on conflict do nothing` and no delete — the graph can only ever accumulate, so corrections do not
propagate and no amount of re-indexing heals it. `edges` and `symbols` are rebuilt per file and
`pruneOrphanedEdges`/`pruneStaleFiles` cover the rest; `cross_repo_deps` was the one that had neither.

---

