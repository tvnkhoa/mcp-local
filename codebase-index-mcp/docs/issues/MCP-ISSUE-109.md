## MCP-ISSUE-109 — a 0-line apply minted an applyId / rollbackId and stored a rollback row

- **Status:** ✅ FIXED 2026-10-28 (row 4, reported by wec.aria).
- **Scenario:** `refactor_replace_apply` (and `refactor_symbol_migration` / `change_value_representation` with
  `dryRun:false`) on a preview whose hunks were all skipped (risk flag, low confidence, no effective change) or that
  had no hunks wrote nothing, yet returned an `applyId` / `rollbackId` and stored an apply record. A rollback of it
  restores 0 files.
- **Fix:** `applyPreviewExclusively` (`refactorApplyGate.ts`) is the one path all three tools share. An apply with no
  `applied` file and no `conflict` is a no-op: no `recordRefactorApply` (so no rollback row) and `applyId` /
  `rollbackId` come back `null`. The preview is still marked consumed, as before. A conflict is not a no-op: it keeps
  its record and ids.
  - `refactor_replace_apply` (all profiles): omits `applyId` / `rollbackId`, adds optional `changed: 0`,
    `noop: true`, `note`; `diagnostics.code` is `APPLY_NOOP`; nano `success` is true.
  - The other two tools: omit the ids, add optional `noop` / `note`.
  - All new fields are optional; no schema or tool description changed, so the contract snapshot is untouched.
- **Guarded:** `refactorApplyGate.test.ts` — a no-hunk apply and an all-skipped apply return null ids, store no record
  and write nothing; a normal apply still returns ids, stores the record and writes the file.
- **Limits:** a conflict-only apply still mints ids and a record (nothing to restore, kept for audit).
