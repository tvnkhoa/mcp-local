## MCP-ISSUE-063 — incremental re-index left resolved edges pointing at symbols that no longer exist; the size/mtime quick check never fired

- **Status:** ✅ FIXED 2026-10-01 (P1).
- **Scenario:** edit a callee file so its declarations shift lines, or delete it, and run
  `index_repository(mode: "incremental")`.
- **Expected vs actual:** a symbol id includes the row (`makeSymbolId` → `repoId:filePath:kind:name:row`).
  `replaceSymbolsForFile` deleted only the changed file's **outbound** edges, and `pruneOrphanedEdges`
  checked `from_id` only. Resolved edges from **unchanged** files kept their old `to_id`.
  - Reproduced: shifting `callee.ts` down 3 lines left 2 dangling CALLS edges; deleting it left 3.
  - A full index produced 0.
- **Impact:** `get_call_chain`, `find_impact_files` and every traversal silently lost the caller → callee
  link until the next full run. No error was raised and health still reported `ok`.
- **Fix:** files that hold a resolved edge whose target is missing (or is about to be pruned) are
  re-extracted in the same run, so incremental matches full by construction.
  - `writeStore.findDanglingEdgeSourceFiles` finds those files, and `indexPipeline` queues them
    (`queueDependentFiles`).
  - A non-full safety net, `pruneDanglingResolvedEdges`, removes any leftover and counts it in
    `edgesPruned`.
  - `INDEX_VERSION` is unchanged; older dangling edges heal on the next incremental run.
- **Second defect, same pass:** the size/mtime quick check in `indexPipeline.ts` compared
  `"<size>-<mtime>"` as a prefix of a sha256 hex digest, so it could never match and only cost one
  `stat()` per file. It was removed; the content-hash skip below it is the real check.
- **Guarded:** `src/services/indexing/incrementalInboundEdges.test.ts` covers the line shift and the
  callee deletion. Each asserts 0 dangling `to_id` and an edge set equal to a fresh full index.
- **Verified live** on `codebase-index-mcp`:
  - incremental run `3f780a44`: 0 dangling.
  - full run `4a60c6d6`: symbols 2035 = 2035, edges 5187 = 5187, unresolved-in-graph 942 = 942.
- **Residual:** the other repos in the central DB heal on their next incremental run; none was
  re-indexed for this fix.

