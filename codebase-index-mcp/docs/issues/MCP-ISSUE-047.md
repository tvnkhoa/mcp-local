## MCP-ISSUE-047 — `get_persistence_mapping` dumps every CHECK constraint in the repo, ignores `profile`, and disagrees with `find_field_accesses` about "owner"

- **Status:** **FIXED** 2026-08-04 — all three; see below. Constraint dump first observed 2026-08-03; the `profile` and owner-semantics halves were **new** when filed.
- **Scenario A — unfiltered constraints:** `get_persistence_mapping{ property:"HandledBy", ownerType:"Conversation" }` returns the correct mapping (`handled_by`, `hasConverter true`, `maxLength 16`) **and all 24 `HasCheckConstraint` rows in the repository** — `ck_tenant_configs_timeout_hours`, `ck_outbox_status`, `ck_customer_inbox_status_logs_*`, … — none of which involve `HandledBy` or `Conversation`. This is the largest single token payload of the 43-tool sweep, and it is the same list for every property queried.
- **Scenario B — `profile` ignored:** the same call with `profile:"nano"` returns the identical full payload. Every other profile-aware tool trims; this one does not.
- **Scenario C — two tools, two definitions of "owner":** `find_field_accesses{ name:"HandledBy" }` reports `declaringType:"ConversationAssignmentState"` (correct: the property is declared on the owned type). Passing that value back in — `get_persistence_mapping{ property:"HandledBy", ownerType:"ConversationAssignmentState" }` — returns `mappings: []` while still dumping all 24 constraints. Only `ownerType:"Conversation"` (the EF-configured owner) yields the mapping. An agent chaining the two tools, which is the natural workflow, gets an empty answer that looks like "not persisted".
- **Impact:** A: token waste plus a real risk of misreading an unrelated constraint as the property's. C: silent false negative on the exact question the tool exists to answer, and the same owner-semantics split is a candidate root cause for MCP-ISSUE-043.
- **What still works well (not a regression):** the projection-trap detector — `DB_TRANSLATED_PROJECTION` at `GetCustomerConversationDetail.cs:89` with the correct explanation. Keep it.
- **Enhancement proposal:** (1) filter `checkConstraints` to constraints whose expression names the mapped column (or the owner's table), and put the repo-wide list behind `profile:"verbose"`; (2) honour `profile`; (3) accept either the declaring type or the EF owner for `ownerType`, resolving owned-entity relationships, and when a requested owner yields no mapping say which owners *do* have one instead of returning `[]`.

### What shipped 2026-08-04 — all three proposals

**A — constraints.** Three compounding defects in `efPersistence.ts`, all fixed:
`columns` was derived from the property matches *without* the owner filter (the mappings right beside it
*were* owner-filtered); an empty set meant **"surface all"**, so a property with no explicit
`HasColumnName` returned every constraint in the file — which for a single large `DbContext` is every
constraint in the repository, identical for every property queried; and matching was
`expression.includes(column)`, so `status` matched inside `inbox_status_logs`. Now: owner-filtered
columns, the property name as EF's *implicit* column instead of a wildcard, and a word-boundary
case-insensitive test. Non-matching constraints appear as `unrelatedCheckConstraints` at
`profile:"verbose"` only.

**B — `profile`.** This was the only read handler in `tools/handlers/` with no `nano`/`compact` branch,
so `nano` returned the full payload including every 160-char snippet and prose `detail`. Both branches
added, modelled on `find_field_accesses`.

**C — owner semantics.** The two tools disagreed because `find_field_accesses` resolves a name through
`getSymbolCandidates` (case-insensitive **substring** LIKE) while this one matched exactly and
case-sensitively, twice. Now: case-insensitive property matching with `resolvedProperty` echoed, and
`ownersWithMapping` listing every owner that maps the property. When a requested owner yields nothing but
others do, the response says so explicitly rather than returning `mappings: []` — which read as "not
persisted" and is the failure an agent chaining the two tools hits. `find_field_accesses` also now echoes
`nameResolution` when the name it resolved differs from the one asked for, so a substitution
(`owner` → `Owner`/`OwnerId`) is visible.

**Kept:** the projection-trap detector, unchanged, per the entry's note.

---

