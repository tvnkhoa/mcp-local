## MCP-ISSUE-041 — `get_call_chain` stopped seeing through DI when a fix was orphaned by a file move

- **Status:** **FIXED** 2026-08-03. Sibling of MCP-ISSUE-022, found during the same review.
- **Scenario:** `get_call_chain(direction:"callers")` on an implementation method missed every caller
  that dispatches through the interface — i.e. all production callers, since only tests construct
  the concrete class. That is the exact symptom ISSUE-022 was filed and fixed for.
- **Root cause:** ISSUE-022 has two defences — resolution-time `interface-dispatch` CALLS edges, and
  query-time interface-sibling frontier seeding. The second lived in
  `services/graph/graphTraversal.ts`. S-41 (`a1d992c`) re-homed the loose `src/` files, inlined the
  traversal into `tools/handlers/impactHandler.ts` **without** the seeding, and left the fixed module
  orphaned and imported by nothing. `store.expandInterfaceSiblings` had exactly one call site in the
  codebase, in that dead file.
- **Why no test caught it:** `test-interface-dispatch.mjs` asserts the resolution-layer half, and
  reaches the query layer only through `getChangeContext`. No harness drove `get_call_chain` across
  an interface, so 35 harnesses stayed green for four commits.
- **Fixed by:** restoring the seeding into `impactHandler.traverseCallGraph` (with a comment naming
  this entry), deleting the dead module, and adding `scripts/test/test-call-chain-interface.mjs` on a
  fixture where *only* sibling seeding can succeed — the CALLS edge lands on the interface method and
  no dispatch edges exist. Proven to fail without the fix: `got 0 edge(s)`.
- **General lesson worth keeping:** when a file move inlines a function, the copy that survives is
  whichever the author had in front of them, not necessarily the fixed one. A dead module that still
  compiles is where a fix goes to die.

---

