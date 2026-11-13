## MCP-ISSUE-129 — tool descriptions and `orient` routed plain caller questions to a near-miss tool or to the fallback

- **Status:** FIXED 2026-11-13 (row #2, branch `wt/tool-desc`) for the description text and the `orient` keyword table;
  live ToolSearch acceptance needs a session started after the served build is restarted.
- **Scenario:** owner, 12 Nov: leaders and members picked the wrong codebase-index tool from its description ("who imports
  this file" → get_file_summary / get_file_context; "callers of X" → fallback). Measured with a fixed list of 26 caller
  questions (`~/.claude/handover/briefs/2026-11-13-mcp-local-tool-descriptions-questions.json`).
- **Tool/query attempted:** Claude Code `ToolSearch` (keyword query = the question, max_results 3) against the live server;
  `orient(intent)` = `classifyIntent` of the build; an offline BM25 proxy of the keyword ranking over the 46
  codebase-index descriptions (name tokens ×3 + description).
- **Expected vs actual (before):** live ToolSearch top-1 right for 11/26 (Q01 "who imports this file" → a browser
  `file_upload` tool, then get_file_summary; find_impact_files not in the top 3); `orient` right for 14/26 — 9 of the 12
  misses were the fallback (callers, read source, field reads/writes, folder listing, implementations, index progress,
  blame, doc section), "who imports" routed to get_file_summary, "where is this documented" to search_symbols, "call path
  between two methods" to trace_execution_flow; BM25 proxy 17/26.
- **Cause:** descriptions opened with the mechanism ("Scope blast radius for a file change", "Get callers (BFS…)",
  "Link tests to likely source files…"), not the question a caller types; sibling tools were not named for the near
  miss; profile omissions were not stated (get_file_context nano has no edges; change_impact nano has no dependents).
  `orient` had no rule for eight common questions and sent "who imports" to the file-overview rule.
- **Fix:** 22 descriptions now open with the caller's question and name the sibling for the near miss and what each
  profile omits; `orient` gains rules call-path, callers, read-source, field-access, implementations, folder,
  literal-text, doc-section, blame, index-progress, and "who imports / importers" moves to blast-radius
  (`orient.test.ts` pins all 14 phrasings and three neighbouring phrasings the new rules must not take). Text only — no tool or parameter renamed, no schema shape changed.
- **After:** `orient` 26/26; BM25 proxy 23/26; description bytes 30,135 → 30,146 (+11, +0.04%); parameter descriptions
  unchanged (6,968). Live ToolSearch after: pending the new-session acceptance.
- **Impact:** a wrong first pick costs a call and pushes callers back to grep/read.
- **Workaround used:** none (no baseline fallback in this row).
- **Enhancement proposal:** ToolSearch weighs tool NAME tokens heavily ("file" in `file_upload` beat every description
  for Q01) — a description cannot fully outrank a name; the five other servers' descriptions are a later row.
