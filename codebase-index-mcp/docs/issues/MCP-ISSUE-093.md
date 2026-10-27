## MCP-ISSUE-093 — a C# namespace import's confidence depended on which rows the run resolved

- **Status:** ✅ FIXED 2026-10-22 (release L).
- **Scenario:** the first conformance on wec.communication-hub. A scoped run and a full run disagreed on `IMPORTS` "resolved csharp namespace" edges: 0.78 in one, 0.8 in the other. It happened on every scenario, including on the K build.
- **Cause:** `resolveImportEdges` cached a namespace's module id but not its confidence.
  - The first row of a namespace was written at 0.78.
  - Every cached repeat was written at 0.8.
  - Which row came first depended on the rows the run processed, and a scoped run processes a subset.
- **Fix:** the cache keeps the whole answer, `{id, confidence, reason}`.
  - An exact namespace match is 0.8.
  - A prefix or folder-path fallback is 0.78.
  - Every row of a namespace now gets the same value.
- **Effect:** stored confidences change in every C# repo (see the per-repo deltas in the release L report). `INDEX_VERSION` v13 covers the change.
- **Guarded:** CommHub conformance, every scenario EQUAL in both modes.

