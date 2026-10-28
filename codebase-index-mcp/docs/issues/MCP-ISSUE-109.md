## MCP-ISSUE-109 — a 0-line apply minted an applyId / rollbackId and stored a rollback row

- **Status:** ✅ FIXED 2026-10-28 (row 4, reported by wec.aria).
- **Scenario:** `refactor_replace_apply` (and `refactor_symbol_migration` / `change_value_representation` with
  `dryRun:false`) on a preview whose hunks were all skipped (risk flag, low confidence, no effective change) or that
  had no hunks wrote nothing, yet returned an `applyId` / `rollbackId` and stored an apply record. A rollback of it
  restores 0 files.
- **Fix:** `applyPreviewExclusively` (`refactorApplyGate.ts`) is the one path all three tools share. Two concerns:
  1. **Ids / rollback row:** an apply that writes no file (`appliedFiles` 0 — any reason) stores no apply record, so no
     rollback row, and `applyId` / `rollbackId` come back `null` / omitted. The preview is still marked consumed.
  2. **Benign vs refused:** `noop` is true only when nothing was written AND nothing was refused (no hunks, or every
     skip is `NO_EFFECTIVE_CHANGES`). A `RISK_FLAG_BLOCKED` / `LOW_CONFIDENCE_BLOCKED` skip or a conflict is a refusal.
  - `refactor_replace_apply`: nothing written adds optional `changed: 0` and `note`. Benign: `noop: true`,
    `diagnostics.code APPLY_NOOP`, nano `success: true`. Refused without conflict: `blocked: true`,
    `APPLY_BLOCKED`, `success: false`. Conflict: unchanged `APPLY_PARTIAL_OR_CONFLICT`, `success: false`.
  - `refactor_symbol_migration` / `change_value_representation`: same, as optional `changed`, `noop`, `blocked`,
    `note`, plus `applyStatus` on each migration row.
  - All new fields are optional; no schema or tool description changed, so the contract snapshot is untouched.
- **Guarded:** `refactorApplyGate.test.ts` — a no-hunk apply is a benign no-op; an all-risk-flagged apply and a
  stale-file conflict write nothing, store no record, return null ids and are NOT a no-op; a normal apply still returns
  ids, stores the record and writes the file. `test:refactor-engine`: no-match apply → `APPLY_NOOP`; a blocked
  migration → no ids, `blocked: true`, not `noop`, `applyStatus` not `applied`.
- **Limits:** a conflict-only apply no longer stores a record either (nothing to restore).
