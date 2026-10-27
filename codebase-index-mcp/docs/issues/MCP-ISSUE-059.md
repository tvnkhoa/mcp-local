## MCP-ISSUE-059 — advertised descriptions understate or contradict actual behaviour (4 items)

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P4**). Doc-only; no code behaviour to change except item 3.
1. **`route_map`** — says it extracts `[Route]`/`[HttpGet]` attributes; it reads minimal-API
   `MapGroup`/`MapGet` routes. Understates a working feature badly enough that a consumer would skip
   the tool on a minimal-API repo. (See also `MCP-ISSUE-055`.)
2. **`query_graph`** — documents edge types as `CALLS, IMPORTS, TYPE_REF, DEPENDS_ON, PROPERTY_REF,
   PROPERTY_WRITE`. **`CONSUMES`** also exists (handler → command; surfaced by `get_dependency_graph`
   on `ProcessOutboundSentConfirm.cs`) but is not listed, so a consumer writing SQL against the edge
   table cannot know to query it.
3. **`get_symbol_detail`** — promises "edges with resolved names"; see `MCP-ISSUE-053`. This one is a
   behaviour fix, not a doc fix.
4. **`find_package_consumers`** — description says `nuget:<name>`; the bare name works identically
   (both normalize to `nuget:<lowercased>`, verified A/B). Harmless, but the doc implies the prefix is
   required, and a consumer who assumed the prefix was the fix for `MCP-ISSUE-046` would draw the
   wrong conclusion about what changed.

**Fixed 2026-08-10.** Items 1, 2 and 4 are description changes; item 3 was a behaviour fix and shipped
with `MCP-ISSUE-053`. `route_map` now states that it reads BOTH dialects and leads with minimal-API,
since that is what this codebase uses. `query_graph`'s edge-type list was missing four types, not one —
`IMPLEMENTS`, `EXTENDS`, `PUBLISHES` and `CONSUMES` are all real and all now listed.
`find_package_consumers` says the `nuget:` prefix is optional. Snapshots in
`contracts/codebase-index.json` regenerated; `generate:check` and `docs:check` are clean.

---

