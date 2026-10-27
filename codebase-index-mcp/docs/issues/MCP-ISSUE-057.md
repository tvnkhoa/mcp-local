## MCP-ISSUE-057 — `get_feature_bundle`: the `endpoint` role misses endpoints that live in a shared file, and every role lists the class and its constructor separately

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P2**).
- **Scenario:** `get_feature_bundle(repoId, seedSymbol:"ConversationNote", excludeTests:true)` returns
  `endpoint: []`, `unresolvedRoles: ["endpoint"]`, `rolesEmpty: ["endpoint"]`, with
  `coverage.knownGaps: ["roles not found by name convention: endpoint — they may live in
  differently-named files."]`.
- **Actual:** five note endpoints exist, found with `search_regex`:
  ```
  Web/Endpoints/Customers.cs:38  MapGet    {customerId:int}/notes
  Web/Endpoints/Customers.cs:41  MapPost   {customerId:int}/notes
  Web/Endpoints/Customers.cs:44  MapPatch  {customerId:int}/notes/{noteId:guid}
  Web/Endpoints/Customers.cs:47  MapPatch  {customerId:int}/notes/{noteId:guid}/pin-state
  Web/Endpoints/Customers.cs:50  MapDelete {customerId:int}/notes/{noteId:guid}
  ```
  The walk looks for `{E}Endpoints`; a nested resource legitimately lives under its parent's endpoint
  file. The `knownGaps` string is honest, which is good — but the data is available.
- **Enhancement proposal:** fall back to the `routes` table and match a `routeTemplate` **segment**
  against the pluralized entity name (`ConversationNote` → `/notes`). `route_map` already extracts
  these five correctly, so this is a join, not new analysis. (Note `handlerName` on those rows is
  affected by `MCP-ISSUE-055`; `routeTemplate` is not.)
- **Fix (2026-08-10).** Step 2d in `bundleHandler.ts` joins the `routes` table when the `endpoint` role
  is still empty, matching the pluralized last PascalCase word of the entity against a route-template
  **segment** (`ConversationNote` → `Note` → `notes` → `/notes`). Reuses `pluralize` from
  `conventions.ts`; the five endpoints were already indexed, so this is a join and not new analysis.
- **Second issue, same call:** every role lists the class **and** its constructor as separate members —
  `CreateConversationNoteCommandHandler` twice, `UpdateConversationNoteCommandHandler` twice, all four
  validators twice. `stats.membersResolved: 23` for roughly 12 distinct symbols, doubling the payload
  of a tool whose purpose is to fit a whole vertical slice into one call. `get_dependency_graph`
  already ships a `collapsed: {selfReferences, duplicateEndpoints}` block — the same collapse (and the
  same disclosure) applied here would halve this response.
- **Fix (2026-08-10).** Members are collapsed on `(name, filePath)`, keeping the substantive kind via a
  rank table that mirrors the SQL `kindPriorityOrder` used by symbol search, so the two agree on which
  namesake wins. Disclosed as `stats.collapsed: { duplicateDeclarations, rule }` rather than performed
  silently — a quieter response that does not say what it dropped is how a "missing" symbol becomes the
  next bug report.
- **Follow-up 2026-08-10 (code review): the collapse key held a RAW NUL byte**, written as a literal
  `\x00` character in the template literal rather than as an escape sequence. Git classifies a file
  containing a NUL as binary, so this whole file's diff read `Binary files a/… and b/… differ` — the
  ~120 lines of this fix were invisible to review, `git blame` and 3-way merge. Now `\u0000`, an
  escape. A repo-wide sweep found three more, all pre-existing and all in dedupe keys of the same
  shape: `repositories/graphQueries.ts`, `repositories/vectorStore.ts`,
  `services/impact/impactSurface.ts`. All four are escapes now; no source file contains a raw NUL.

---

