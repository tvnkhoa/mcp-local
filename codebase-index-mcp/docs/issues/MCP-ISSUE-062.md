## MCP-ISSUE-062 — `query_graph` repo isolation was a text check: `OR 1=1`, a UNION arm or a second table read every other repo

- **Status:** ✅ FIXED 2026-10-01 (found the same day by the skills review, **P0 — security**).
- **Scenario:** one central SQLite DB holds 11 repos. `query_graph` is documented as repo-scoped.
- **Expected vs actual:** `validateReadOnlyGraphSql` only regex-tested that `:repoId` appeared in the
  SQL, and the runner executed `select * from (<sql>) limit` with no scoping. The following all returned
  rows from other repos: `... where repo_id = :repoId or 1=1`, a UNION arm, a comma join or a subquery
  on a second table. Three more holes sat beside it:
  - the `from|join <ident>` allowlist regex missed comma joins and `"main".symbols`, `[main].symbols`
    and `'main'.symbols`;
  - `pragma_database_list` and `pragma_table_info` slipped past the `\bpragma\b` token check;
  - a trailing `-- comment` broke the wrapper's closing paren.
- **Impact:** any caller could read the symbols, edges, refactor hunks and source excerpts of any
  indexed repo, which breaks the "tenant/repo isolation" rule in `.claude/rules/codebase-index.md`.
- **Fix (three layers):**
  1. **Shadowing CTEs.** The SQL is wrapped so that each allowed table name resolves to a CTE
     filtered on a bound `@__scope_repo_id`. That parameter is bound last, so caller params cannot
     override it.
     - Child tables without `repo_id` are scoped through their parent.
     - `cross_repo_deps` matches on either side.
     - Table scopes live in `QUERY_GRAPH_TABLE_SCOPES` (`src/middleware/sqliteGuardrails.ts`).
  2. **Schema qualifiers banned.** A SQLite-aware tokenizer rejects `main.`, `temp.` and
     `temporary.` in every quoting style.
  3. **Bytecode audit.** better-sqlite3 has no authorizer, so the wrapped statement is `EXPLAIN`ed
     first. Every `OpenRead`/`ReopenIdx` must target a root page of an allowed table or index;
     `OpenWrite` and `VOpen` are refused. This also closes `sqlite_master`, `docs`, `symbols_fts`
     and the `pragma_*` functions.
- **Contract:** unchanged. The `:repoId` requirement is kept for compatibility and is documented in
  source as *not* the isolation mechanism.
- **Guarded:** `src/services/impact/queryGraphIsolation.test.ts` (10 tests, two repos, real schema).
  Each test fails against the pre-fix code.
- **Verified live** on the central index (11 repos):
  - `select repo_id, count(*) from symbols where repo_id = :repoId or 1=1 group by repo_id` →
    one row, `codebase-index-mcp`, 2035.
  - `"main".symbols` → refused.
  - `union ... from sqlite_master` → refused.

