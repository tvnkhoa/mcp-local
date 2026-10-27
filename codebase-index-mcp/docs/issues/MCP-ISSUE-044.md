## MCP-ISSUE-044 — `find_entry_points(kind:"route_handler")` returns a count with empty arrays; `route_map` names the endpoint group, not the handler

- **Status:** **FIXED** 2026-08-04 — all three proposals shipped; see below. First observed 2026-08-03, unchanged until then.
- **Scenario:** `find_entry_points{ repoId:"wec.communication-hub", kind:"route_handler", limit:5 }` → `{"total":5,"runtimeEntryPoints":[],"graphEntryPoints":[]}`. A total of 5 with nothing to show it in; the documented fast-path ("surface C# ASP.NET route handlers from the routes table") returns no rows through this tool.
- **Scenario (second half):** `route_map` and the `repo://wec.communication-hub/routes` resource both return all 34 routes with `handlerSymbolId == controllerSymbolId` — the endpoint **group** class (`Conversations`, `Customers`, `Inbox`), never the delegate that handles the route. `routeTemplate` omits the `MapGroup` prefix (`{conversationId}/reply`, not `/api/conversations/{conversationId}/reply`), and normalization is inconsistent inside one payload: `Conversations.cs` templates have no leading slash while `Inbox.cs` templates do (`/conversations`).
- **Also:** 6 of the 34 routes come from test files (`AuthPolicyIntegrationTests.cs`, `MyAuthTestSupport.cs`, `PlaybookAlignmentIntegrationTests.cs`) with no way to exclude them — see MCP-ISSUE-049.
- **Impact:** "what is this service's API surface" cannot be answered from the index. Every route resolves to the same handful of group symbols, so route → handler → call-graph is a dead end, and the templates cannot be matched against real request paths or against `docs/04-api/ch2-fe-api-contract.md`.
- **Workaround:** `route_map` for the file/line, then `find_symbol_at_line` on that line to get the actual delegate; reconstruct the prefix by reading the `MapGroup` call at the top of the endpoint file.
- **Enhancement proposal:** (1) make `find_entry_points` put the route rows it counted into `runtimeEntryPoints` (a `total` that matches no returned array is worse than an error — nothing downstream can act on it); (2) attribute minimal-API routes to the lambda/method passed to `MapGet`/`MapPost` rather than the enclosing group class; (3) resolve `routeTemplate` against the enclosing `MapGroup` and emit one normalized absolute path.

### What shipped 2026-08-04

1. **The count and the arrays can no longer disagree.** The route fast-path stamps a *third*
   `entryReason` (`"route_handler"`) and returns early, while the handler partitioned on only two
   values — so every route row was counted and none emitted. Route rows now get their own
   `routeEntryPoints` array, and **`total` is derived from what is actually emitted**, with an
   `unclassifiedEntryPoints` catch-all, so a fourth reason cannot reintroduce the same hole.
2. **Handlers are resolved from the delegate argument.** `csharpRoutes.ts` set
   `handlerSymbolId = classSymbolId` for minimal API inside a class. The hub's endpoint files pass
   **method groups** (`groupBuilder.MapPost("{conversationId}/reply", Reply)`), so the delegate resolves
   to a real method symbol for all 34 routes; a lambda falls back to the enclosing registration method,
   and only then to the group class. The top-level lane's `module:<filePath>` placeholder — a literal
   string that could never join `symbols`, hence `handlerName: null` — is replaced by the file's real
   module symbol id.
3. **The group prefix is resolved by convention.** `resolveMapGroupPrefix` only reads a *local*
   `var g = app.MapGroup(...)` declarator, and the hub receives an already-grouped `RouteGroupBuilder`
   **as a parameter**, which has no declarator — hence `{conversationId}/reply` instead of the real path.
   A parameter-typed builder now falls back to the class's declared `RoutePrefix` property
   (`IEndpointGroup`), giving `/api/v1/conversations/{conversationId}/reply`.
4. **Templates are normalized, case-preserved.** A new `normalizeRouteTemplate` collapses separators and
   guarantees one leading slash — deliberately *not* `normalizeEndpointPath`, which lowercases (right for
   a contract id, wrong here: it would turn `{conversationId}` into `{conversationid}`). Applied only
   when the result is genuinely absolute, so a template whose prefix could not be resolved stays
   relative rather than masquerading as a real path.

Route rows are extraction-time, so this needs a re-index to take effect. The test-file routes noted
above remain — that is the MCP-ISSUE-049 test-filter item.

---

