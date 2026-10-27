## MCP-ISSUE-055 — `route_map` takes `handlerName` from `.WithName()`, so a string-literal endpoint name collapses every route onto the group method

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P2**). Follow-up to `MCP-ISSUE-044` (FIXED 2026-08-04) —
  the fix works, but only for one of the two `.WithName()` styles in this repo, and 044's
  re-verification sampled only the working one.
- **Scenario:** two endpoint files, same minimal-API shape, handler passed as the 2nd argument of
  `MapX`:

  | file | `.WithName(...)` | `handlerName` returned |
  |---|---|---|
  | `Web/Endpoints/Conversations.cs` | `.WithName(nameof(Reply))` | `Reply`, `RetryReply`, `OsbReply`, `CallLogReply`, `GetSuggest`, … — **correct** |
  | `Web/Endpoints/Customers.cs` | `.WithName("GetCustomerNotes")` | **`Map` for all 13 routes** |

  Repro: `route_map(repoId, filePathPrefix:".../Web/Endpoints/Customers.cs", excludeTests:true)` →
  13 routes, correct `routeTemplate` on every one (full `MapGroup` prefix included), and
  `handlerName:"Map"` on every one. Source confirmed with `search_regex`: line 38 is
  `MapGet("{customerId:int}/notes", GetNotes)` followed by `.WithName("GetCustomerNotes")`.
- **Impact:** on `Customers.cs` all 13 routes share one name and one enclosing symbolId, so the API
  surface is not addressable per handler there — which is what 044 set out to fix.
  `find_entry_points(kind:"route_handler")` inherits it (its `Customers.cs` row is `name:"Map"`).
- **Correction — `.WithName()` is not the cause (2026-08-10).** The two files differ in a second,
  decisive way: `Customers` is a **`partial class`** (`Customers.cs:8`) whose handlers are declared in
  sibling files — `GetNotes` lives in `Customers.Notes.cs:16`, registered from `Customers.cs:38`.
  `resolveDelegateHandlerSymbolId` (`csharpRoutes.ts`) looked the delegate up in **the current file's**
  symbols, missed, and fell back to the enclosing method `Map`. `Conversations.cs` works because it is a
  single non-partial class with every handler in-file; that it also uses `nameof(...)` is coincidence.
  A fix aimed at `.WithName()` would have changed nothing.
- **Fix.** Two parts. (1) The registration-site delegate name is now persisted in a new
  `routes.handler_name` column and preferred over the joined symbol's name, so `route_map` is correct
  even when the symbol cannot be bound. (2) `services/graph/routeHandlerResolver.ts` runs after
  indexing — when every file IS in the graph — and rebinds `handler_symbol_id` by joining the delegate
  name to a method whose declaring type name matches the route's controller, which is what identifies a
  partial-class member. It only touches rows that are currently wrong and only when a replacement
  exists, so it is idempotent and never nulls out a genuinely unresolvable lambda.
  Verified on the real repo: `Customers.cs` returns **13 routes with 13 distinct handler names**, and
  `GET /notes` binds to `Customers.Notes.cs`.
- **Original proposal (kept for the record):** resolve the handler from the `MapX` delegate argument, which is present in
  the AST in both styles, and treat `.WithName()` as a display alias only.
- **Doc note, same tool:** `route_map`'s description still says it extracts *"route attributes
  (`[Route]`, `[HttpGet]`, …)"*. It reads minimal-API `MapGroup`/`MapGet` routes — the description
  understates a working feature, and a consumer reading it would not try the tool on this repo at all.
- **Follow-up 2026-08-10 (code review): the rebind matched the declaring type by SIMPLE name.**
  `p.name = c.name` alone, unscoped by namespace, assembly or path — so two same-named endpoint groups
  in different projects of one solution cross-bind, and `order by m.file_path, m.line limit 1` made the
  wrong pick deterministic rather than correct. There is no namespace column on `symbols`, and SQLite
  has no `reverse`, so `resolveRouteHandlersImpl` is now a per-route loop in JS: among the namesake
  candidates it takes the one sharing the LONGEST directory prefix with the file that registered the
  route (parts of a partial class live in one project — `Customers.Notes.cs` beside `Customers.cs`
  shares its whole directory). When nothing but the repo root is shared and more than one namesake
  exists, the row is left alone: guessing would cross-bind, and `handler_name` already carries the
  answer. Route counts are in the hundreds, so the per-route query is not a cost worth contorting SQL
  to avoid.

---

