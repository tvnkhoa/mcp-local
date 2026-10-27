## MCP-ISSUE-053 — unresolved edges surface as nameless rows and synthetic ids, inflating counts and consuming the `limit` budget

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P1**).
- **`get_symbol_detail` breaks its own contract.** The description promises *"the symbol record plus
  all outgoing and incoming edges **with resolved names**"*. For
  `symbolId:"48209250031266423408eb5d"`, 6 of 12 `edgesOut` carry **no `toName`** and a synthetic id:
  ```json
  {"toId":"callee:Contains"}, {"toId":"callee:string?.Trim"},
  {"toId":"callee:IsNullOrWhiteSpace"}, {"toId":"callee:StartsWith"},
  {"toId":"property:IsSuccess"}, {"toId":"property:Separator"}
  ```
- **`get_change_context` is worse.** Same symbol, `profile:"nano"`, `limit:8`: `topCallees` contains
  six entries that are literally `{"confidence":0.1}` — no name, no path, no id at all — and
  `calleeCount: 8` where only **2** callees are real. Because they occupy 6 of the 8 `limit` slots,
  raising `limit` is the only way to see real callees, and `calleeCount` cannot be used to decide
  whether that is necessary.
- **The information is already reported correctly elsewhere in the same responses:**
  `get_change_context` returns `unresolved: {calls: 6, imports: 0, typeRefs: 0}`, and
  `get_file_summary` on the same file returns
  `graphHealth: {unresolvedCalls: 6, unresolvedProperties: 2}`. So the counts are known; only the
  edge lists disagree with them.
- **Impact:** callers that trust `calleeCount` or iterate `edgesOut` get BCL noise mixed into real
  graph data with no field to filter on. It also makes the two tools disagree about how many callees
  a symbol has.
- **Enhancement proposal:** exclude unresolved BCL members from `edgesOut` / `topCallees` and let the
  existing `unresolved` / `graphHealth` blocks carry them; or give them a stable resolvable label
  (`System.String.Contains`) plus an `unresolved: true` marker so they can be filtered. Either way,
  `calleeCount` should count what the array contains.
- **Fix (2026-08-10).** The first option, filtered **in SQL** rather than after it so the `limit` budget
  is spent on edges that have something to say. `UNRESOLVED_SYMBOL_TOKEN_PREFIXES` in `types/index.ts`
  lists the placeholder prefixes (`callee:`, `property:`, `type:`, `iface:`, `base:`, `import:`) and
  `RESOLVED_TARGET_SQL_PREDICATE` is its query form, applied in `getSymbolDetailImpl` (edgesOut) and
  `getChangeContextImpl` (callees). `calleeCount` is derived from the filtered array, so the two agree.
  `nuget:`, `endpoint:` and `contract:` are deliberately NOT in that list — they are unresolved by
  design and name something outside the repo a consumer legitimately queries. This also closes
  `MCP-ISSUE-059` item 3, which was the same defect stated as a doc mismatch.

---

