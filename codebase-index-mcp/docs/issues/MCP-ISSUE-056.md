## MCP-ISSUE-056 — `excludeTests` is still missing on the seven call-graph tools, where interface dispatch fans hardest into test doubles

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P2**). Follow-up to the "no test filter" sub-item of
  `MCP-ISSUE-049` (FIXED 2026-08-04).
- **What shipped and works:** `excludeTests` is now a real, honored parameter on `search_symbols`,
  `search_regex`, `search_literals`, `find_implementations`, `get_feature_bundle`,
  `get_symbol_context_pack`, `route_map`, `get_value_contract_impact`. Verified on each.
- **Still missing:** `get_call_chain` · `get_change_context` · `get_symbol_detail` ·
  `trace_execution_flow` · `find_impact_files` · `find_field_accesses` · `link_tests_to_source`.
- **Why these are the ones that need it most — interface dispatch over-fans.**
  `get_call_chain(symbolId:"a1b8b39fb653bf31e72822c5" /* Reply endpoint */, direction:"callees",
  profile:"standard", limit:8)` resolves `ISender.Send` to **six different test doubles** —
  `DispatchDomainEventsInterceptorSyncTests`, `AutomationSentConsumerIntegrationTests`,
  `InboundMessageConsumerIntegrationTests`, `EndpointContractIntegrationTests` (×2),
  `CampaignSentConsumerIntegrationTests` — all `reason:"interface-dispatch"`, confidence 0.7. That is
  **6 of 8** returned callees, so the real production path is crowded out of the default `limit`.
  Same pattern elsewhere: `find_impact_files(view:"surface")` returned 9 of 15 callers from a single
  test file; `find_field_accesses("HandledBy")` returned 5 of 7 reads from tests.
- **Enhancement proposal:** add `excludeTests` to the seven tools above. Additionally consider ranking
  `interface-dispatch` edges below resolved ones so that a `limit` truncation drops test doubles
  before production callers — a filter alone still leaves the fan-out dominating unbounded queries.
- **Fix (2026-08-10).** Both halves. `excludeTests` is declared, advertised and honored on all seven,
  filtering on the FAR end of each row (`tools/handlers/testFilter.ts`, using the same `isTestPath`
  classifier the other eight tools use so the two families cannot drift). `trace_execution_flow` drops
  the edges of dropped nodes too, and always keeps the entry symbol — tracing outward from a test is a
  legitimate question. Separately, `traverseCallGraph` now sorts `interface-dispatch` edges last within
  each frontier, so a `limit` truncation drops the speculative fan-out before the production hop.
- **Follow-up 2026-08-10 (code review): both halves of that fix ran AFTER the `LIMIT`, so neither did
  what it says.**
  1. *The filter.* Every one of the seven filtered in JS over a page SQL had already truncated. A
     symbol with 30 callers whose first 20 rows happen to be test files answered `callers: []` —
     indistinguishable from "nothing calls this", and the opposite of what the parameter promises.
     `get_call_chain` compounded it: `truncated: rows.length >= limit` was computed on the
     post-filter array, so a truncated chain reported `truncated: false`. The predicate is now inside
     the query on all of them — `find_impact_files` (both views), `get_change_context`,
     `get_symbol_detail`, `get_call_chain`, `find_field_accesses` — via a SQLite UDF `is_test_path()`
     registered in `initGraphSchema`. A UDF rather than a hand-written `like` chain because
     `TEST_PATH_REGEX` is deliberately kept as ONE regex so its callers cannot drift (ISSUE-024), and
     a SQL copy of it would be exactly that drift. `link_tests_to_source` keeps its post-filter: its
     candidate `sourceFiles` set is already `!isTestPath(x)`, so the filter can never remove a row.
  2. *The ordering.* `traverseCallGraph` sorted the array `getCallEdges` returned — but `getCallEdges`
     was `... limit ?` with **no `ORDER BY`**, so SQLite had already chosen which rows survived, in an
     arbitrary order, before the sort ran. Every fetched edge was then pushed unconditionally. The
     reported failure — six `ISender.Send` dispatch edges crowding the production hop out of
     `limit: 8` — was completely unchanged by it. The `order by case when e.reason =
     'interface-dispatch' then 1 else 0 end, e.rowid` now lives in the SQL, before the `limit`.

---

