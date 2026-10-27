## MCP-ISSUE-090 — a superseded SQL definition stayed a doc-mention candidate beside the current one

- **Status:** ✅ FIXED 2026-10-22 (release L1, fb9ae6b).
- **Scenario:** after K4, `tenant_profile` (38 prose mentions on wec.aria) was ambiguous between `0001-baseline.sql` and `archive/0012-tenant-profile.sql`. Those are two definition sites of one name, and the SQL lane already knows which is current (MCP-ISSUE-082 I3).
- **Tool/query attempted:**
  - `query_docs` search and stale on wec.aria;
  - a replay of `resolveMentions` over the stored mentions (`l1measure.mjs`, work file).
- **Expected vs actual:** expected the mention to bind to the current definition; got "ambiguous, 2".
- **Fix:**
  - **Rule:** in the mention resolver's deciding step, after the test-path filter and before kind rank, a superseded SQL definition is dropped when its name's current definition (the same `tokenKind|schema|rest` key as I3) is also a candidate AND wins **decisively**. Decisive means it wins:
    - on tier: `.down.sql` < unnumbered < `archive/` < numbered < EF snapshot;
    - or, within one tier, on the migration number.
  - **Not decisive:** a win decided only by the tie-break (file name, path, line) drops nothing.
  - **Only superseded sites match:** all of them are kept, like the all-test rule.
  - **Unknown layout → no change:** a repo with no numbered `.sql` migration drops nothing.
  - `SqlDefinitionInfo` gains `decisive`. The new functions `supersededSqlDefinitions`, `isDecisiveCurrent` and `hasNumberedSqlLayout` are in `graph/sqlDefinitions.ts`.
  - `INDEX_VERSION` → `v13-release-l` (stored mention rows change).
  - **Deferred by the owner,** because no indexed repo uses them:
    - Flyway `V<n>__` / `U<n>__`;
    - 14-digit timestamps;
    - `old/`, `legacy/` and `deprecated/` segments;
    - a per-repo `sql.json`.
- **Measured.** On a scratch copy of the central DB, every backtick / `code_call` mention was re-decided from scratch with the L1 build and compared with the stored K rows.
  - **wec.aria:** 286 superseded definitions recognised.
    - Bound 8 286 → 9 536; ambiguous 6 813 → 5 563 (1 250 moved to bound).
    - 2 796 are still ambiguous, with shorter lists.
    - 0 re-pointed, 0 other changes.
  - **Spot checks:**

    | name | mentions | binds to |
    |---|---|---|
    | `tenant_profile` | 38 | `0001-baseline.sql:1042` |
    | `usage_events` | 80 | `0001:1064` |
    | `aria_ingest` (role) | 72 | `0001:62` |
    | `audit_events` | 69 | `0001:562` |
    | `identity_level` | 52 | `sql_column 0001:569` |
    | `usage_in_period` (decided by number) | | `0043:20` |
    | `aria_notify_change` (decided by number) | | `0042:84` |
    | `usage_dashboard_rows` (decided by number) | | `0043:44` |

  - **Every other indexed repo:** 0 superseded definitions recognised, so 0 mentions and 0 SQL edges changed. wec.be has 90 `sql_*` symbols, all in unnumbered files.
  - **Ground truth:** checked by the reviewer through postgres-mcp `aria_dev`, read-only, applied through 0045. All 28 multi-site names match the index's current site: 6 functions by `prosrc` md5, 22 tables by columns after later ALTERs.
- **Guarded:**
  - `mentionAmbiguity.test.ts`: baseline vs archive; number vs `.down`; same-number and same-file tie-breaks stay ambiguous; only-superseded keeps all; unnumbered-only drops nothing.
  - `edgeResolverSql.test.ts`: `decisive`.
  - `runPolicy.test.ts`: generation 13.
  - Conformance scenario `sql-supersede`: a new migration re-creates a mentioned table, then is deleted; scoped = full at each step.
- **Open item, not in L:** a table or column DROPped by a later migration still binds as a definition (for example `tenant_opening_hours`, dropped at 0018:102). It should be labelled.

