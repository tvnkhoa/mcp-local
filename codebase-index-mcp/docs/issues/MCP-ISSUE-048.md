## MCP-ISSUE-048 — index-run counters contradict the database and each other

- **Status:** **FIXED** 2026-08-04 — all five; see below. The internal contradictions were first observed 2026-08-03, the DB mismatch was **new** when filed.
- **Scenario:** one `index_repository{ mode:"full" }` on `wec.communication-hub` (run `f4119319`), then reading the same numbers back from the graph.

  | claim | run report | `query_graph` / resource |
  |---|---|---|
  | edges | `edgesUpserted: 49582` | **47998** (sum of `SELECT type, COUNT(*) FROM edges GROUP BY type`, and `repo://…/schema` `edgeCount`) |
  | wall clock vs phase | `elapsedMs: 15924` | `resolvePhaseMs: 22270` — a phase longer than the run that contains it (dirty run: **1055** vs **22241**) |
  | call coverage | `resolveCallsCoverage: 1.0446` | a ratio above 1.0 |
  | unresolved calls | `callEdgesUnresolved: 0` | `unresolvedCallsTotal: 14420` in the same object |
  | cross-repo | `crossRepoResolved: 8` (full, 521 files) | **459** (dirty, 3 files) — fewer files, 57× more links |

- **Impact:** these are the numbers a reviewer uses to decide whether an index run is trustworthy, and MCP-ISSUE-040's fix (`degraded` when a run produces symbols but zero edges) is built on the edge counter. A counter that disagrees with the table it wrote cannot support that gate. `symbolsUpserted` (4457) and `filesIndexed` (521) do match the DB, so the problem is specific.
- **Workaround:** treat `query_graph` / the `schema` resource as the source of truth for graph size; ignore `elapsedMs`, `resolveCallsCoverage` and the cross-repo counters entirely.
- **Enhancement proposal:** name each counter for what it counts — `edgeUpsertAttempts` vs `edgesStored` (the delta is presumably deduped/replaced rows, which is fine, but not what `edgesUpserted` reads as); make `elapsedMs` span the resolve phase or rename it `extractionMs`; clamp/rebase `resolveCallsCoverage` on the same denominator as `callEdgesAttempted`; and make `callEdgesUnresolved` agree with `unresolvedCallsTotal` or explain the difference in the field name. The cross-repo full-vs-dirty inversion is probably a scoping bug worth its own investigation (see MCP-ISSUE-045, which suggests the links themselves are unsound).

### What shipped 2026-08-04 — new fields alongside the old names, nothing renamed

Renaming would have changed the `index_repository` response contract, so each misleading number keeps
its name and gains an honest neighbour. Per-claim:

| claim | fix |
|---|---|
| edges 49582 vs 47998 | `edgesUpserted` counts `extracted.edges.length` at **extraction** time, so it can never equal the table. Added `symbolsInGraph`/`edgesInGraph` (read back after the run), plus `edgesDeduplicated`, `edgesPruned` and `filesPruned` — which were already computed, logged, and thrown away. Those two deletions are what made the delta unaccountable. |
| `elapsedMs` < `resolvePhaseMs` | `elapsedMs` came from the pipeline and stopped before the post-phase; `indexRunner` copied it through. It now spans the whole run (`runStartedMs`, already in scope), and the pipeline's figure is preserved as `extractPhaseMs`. Containment now holds: measured `elapsedMs 1411 > extractPhaseMs 1151 > resolvePhaseMs 136`. The near-equality of the full and dirty figures was **not** a shared counter — the post-phase is repo-wide in every mode, so a 3-file dirty run pays the same resolve bill. |
| `resolveCallsCoverage` 1.0446 | Root cause was the **numerator**, not the ratio: `resolveCallEdgesBatch` returned `result.changes` (rows — and `edges` has no unique index, so one pair can be several rows) **plus** `+1` per newly inserted interface-dispatch edge, while the denominator was `select distinct from_id, to_id`. It now returns **pairs**; rows and dispatch inserts are reported separately as `callRowsUpdated`/`dispatchEdgesInserted`. The ratio is clamped as a backstop only. |
| `callEdgesUnresolved: 0` vs `unresolvedCallsTotal: 14420` | A consequence of the numerator above: `max(0, attempted − resolved)` went negative and clamped. With a pair-level numerator the partition holds arithmetically. The measured remainder is reported separately as **`callEdgesUnresolvedInGraph`** — deliberately a different name, because it is *not* a partition of `attempted`: on the smoke repo it is 2082 against 236 attempted, since most `callee:` placeholders are external/BCL targets that were never resolution candidates. (An earlier attempt redefined `callEdgesUnresolved` to this measured value; `scripts/smoke-test.mjs` caught it by asserting the partition, which is why the invariant is worth keeping.) |
| crossRepo 8 (full, 521 files) vs 459 (dirty, 3 files) | Two causes, both fixed. The population query excluded only `import:`/`callee:`, so `type:`/`iface:`/`property:`/`base:` placeholders flooded its `limit 5000` window — on a full run the graph is full of freshly extracted ones, so the sample was spent on tokens that cannot cross a repo boundary. All four are now excluded. And `safeCrossRepoResolve` ran **before** the call/type/implements resolvers; it now runs last, so its population is what genuinely could not be resolved locally — which is the only population where a cross-repo bridge is the right answer. |

**Persistence gaps** (the "contradict each other" half): counters the response reported and `index_runs`
never stored, so `health_check.latestRun` disagreed with the run's own report — `parse_timeouts`,
`edges_dropped_by_confidence`/`_call_cap`/`_type_ref_cap`, `health_reasons`, `skip_reason`, and
`index_version` now have columns and are written. `vector_symbols_indexed` had a column that `recordRun`
never wrote. `getLatestRun` stops aliasing one column to two names and re-deriving the unresolved count
with the same broken subtraction; a pre-fix row falls back to the legacy alias. Pinned in
`src/repositories/runStore.test.ts`.

`index_version` turned out to be a **separate live defect**, filed as MCP-ISSUE-050.

---

