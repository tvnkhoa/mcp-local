## MCP-ISSUE-120 — search_regex times out while an incremental re-index of mcp-local runs

- **Status:** OPEN 2026-11-05 — logged by member lock-fifo (row H-5) for its one fallback; not reproduced on purpose.
- Scenario: member lock-fifo, 2026-11-05 ~10:0x, repoId mcp-local (index 5 commits behind, freshness state "refreshing").
- Tool/query: search_regex pattern `importClosure|deployHash|DEPLOY_RECORD|...`, filePathPrefix `scripts/` then `scripts/serve-http.mjs`, profile compact, limit 30-40.
- Expected vs actual: an answer from the previous index (as the two earlier calls did, with freshness.reason "an incremental re-index is still running after the 5000 ms query budget"); actual "The operation timed out." three times in a row. Then the server disconnected (ECONNREFUSED), likely the leader's row-1 deploy restart.
- Impact: one narrow fallback.
- Workaround: one `grep -n` over scripts/serve-http.mjs (exact terms).
- Enhancement: search_regex should keep to the query budget during a refresh, like query_docs did in the same minute.
