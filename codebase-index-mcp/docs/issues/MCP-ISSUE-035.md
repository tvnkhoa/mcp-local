## MCP-ISSUE-035 — vector KNN applied `k` across all repos, then filtered, so resolution lost its fallback

- **Status:** **FIXED** 2026-07-30 (`src/store/vectorStore.ts`). Found while building the control run for
  MCP-ISSUE-032 — the hypothesis was wrong, but looking for it surfaced this.
- **Scenario:** any repo sharing the central DB with others; worse the smaller its share.
- **Root cause:** `vec_symbols` had no repo column, so the query filtered `m.repo_id` on the *joined map
  table* while `k` was evaluated by vec0 against the **entire** table. It asked for the 3 nearest symbols
  in the world, then kept whichever happened to belong to the repo being resolved.
- **Evidence:** 34709 vectors across 7 repos; `wec.communication-hub` is 7.7% of them. Of 40 real
  unresolved type names from that repo:

  | | before | after |
  |---|---|---|
  | returned fewer than the 3 rows requested | **34 / 40** | **0 / 40** |
  | returned ZERO rows | **14 / 40** | **0 / 40** |
  | zero despite the repo holding candidates | 14 (one had 332) | 0 |

- **Second defect, same query:** vec0 assigns rowids on insert and `deleteVectorsByRepo` re-inserts on
  every rebuild, so distance ties broke by rowid — 7 of those 40 queries were tie-affected. `ORDER BY
  distance, symbol_id` is **not** enough: vec0 picks its k rows first, breaking ties internally, and only
  then does SQL sort them. The ORDER BY can reorder the chosen k, not change which k were chosen. Fixed
  by over-fetching and widening until the farthest row returned is strictly beyond the k-th, at which
  point the whole tie group is provably in hand.
- **Fix:** `repo_id TEXT partition key` on `vec_symbols`, so vec0 evaluates k within the repo; plus the
  deterministic cut above. A pre-partition table is detected via `pragma_table_info` and rebuilt — vectors
  are derived data (trigram hashes of `symbols.name`), so dropping beats migrating. 2664 vectors rebuild
  in 319ms.
- **Also added:** `CODEBASE_INDEX_VECTOR_ENABLED=false` disables vector search outright — not "fall back
  to the in-memory index", genuinely off. The distinction is the point: it exists to be a control, and a
  switch that quietly re-routed to another vector implementation would answer a different question.
- **Covered by:** `src/store/vectorStore.test.ts`, 5 cases, built on a deliberately multi-repo fixture. A
  single-repo fixture passes either way and would have caught nothing.

---

