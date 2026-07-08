---
name: index-conformance-full-vs-incremental
description: "Verify correctness parity between full and incremental indexing for the same revision."
---

# Index Conformance: Full vs Incremental

## When to Use
- Update incremental logic, hashing, or edge replacement.
- Before release for index-heavy MCP changes.

## Procedure
1. Select fixed repository revision.
2. Run full index and capture summary snapshots.
3. Reset state and run incremental from same revision baseline.
4. Compare outputs
   - Symbol counts
   - Edge counts
   - Query results for dependency/call chain/module flow
5. Validate invariants
   - No orphan edges
   - Deterministic results for unchanged files

## Output Format
- `ready` or `blocked`
- Diff report and likely root causes