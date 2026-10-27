## MCP-ISSUE-064 — every `McpError` reached the wire as `MCP_ERROR`, so a caller's bad input read like a server fault

- **Status:** ✅ FIXED 2026-10-01 (P3; found while verifying MCP-ISSUE-062 live).
- **Expected vs actual:** a `query_graph` scope refusal is thrown as `McpError(InvalidParams)`, yet the
  client received `code: "MCP_ERROR"`. `mapError` (`src/middleware/errors.ts`) collapsed every JSON-RPC
  code into that one string. This affected about 36 `InvalidParams` sites, plus `InternalError` and
  `InvalidRequest`.
- **Fix:** the wire code now follows the JSON-RPC code:
  - `InvalidParams` → `VALIDATION_ERROR` (the code zod failures already used);
  - `InternalError` → `INTERNAL_ERROR`;
  - any other code → `MCP_ERROR`.
  Also fixed the refusal text `"...is not allowed Allowed tables: ..."`, which now has its full stop.
- **Behaviour change:** callers matching on `MCP_ERROR` for bad input now see `VALIDATION_ERROR`.
  `test:server-envelopes` updated accordingly: a bad `previewId` on `refactor_replace_apply` now
  expects `VALIDATION_ERROR`.
- **Guarded:** `src/middleware/errors.test.ts` asserts all three mappings.

