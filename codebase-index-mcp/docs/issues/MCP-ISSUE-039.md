## MCP-ISSUE-039 — the vector fallback cost 30s per run and resolved nothing

- **Status:** **FIXED** 2026-07-30 (`edgeResolverCalls.ts`, `edgeResolverRefs.ts`, `vectorStore.ts`).
  A regression introduced by MCP-ISSUE-035's own fix, found while measuring MCP-ISSUE-037.
- **How it was caused:** before MCP-ISSUE-035, 35% of vector queries returned zero rows because `k` was
  consumed by other repos in the shared table, and finding nothing is fast. Making the lane CORRECT made it
  do real work, and the work turned out to be worthless on this data.
- **Evidence:** 968 distinct tokens reach the lane on `wec.communication-hub`, each KNN costs ~31ms, and
  **zero** clear the `distance < 0.35` gate. Confirmed by differencing a full run with
  `CODEBASE_INDEX_VECTOR_ENABLED` on and off: the CALLS `reason` breakdown is **byte-identical**, 11331 rows
  tagged `external boundary` either way. Draining those rows took 27860ms with vectors on against 226ms with
  them off — 123x for no edges.
- **Fix — the lane measures itself.** Neither disabled (it can pay where unresolved tokens are in-repo
  near-misses) nor unbounded. After 100 lookups with no hit it stops, and says so via `indexWarn`: a
  capability switching itself off silently is exactly what produced MCP-ISSUE-038. `vectorSearchSymbols` is
  also memoized, cleared on any vector write.
- **Measured:** `callResolveMs` 30023 -> **4485**, below the 4953 pre-regression baseline. Full-run wall on
  `wec.communication-hub` 62s -> **29.5s**, all nine edge types identical across three runs.
- **Note on the over-fetch:** MCP-ISSUE-035's deterministic tie-break raises k from 3 to 16, and raw KNN cost
  is roughly linear in k (11.7ms at k=3, 28.4ms at k=16, 95ms at k=64). That multiplier stands — it is the
  price of a reproducible cut — but is now paid 100 times per repo instead of once per token.

---

