import type Database from "better-sqlite3";
import type {
  RefactorApplyChangeRecord,
  RefactorApplyHunkRecord,
  RefactorApplyRecord,
  RefactorPreviewHunkRecord,
  RefactorPreviewRecord,
  RefactorRollbackRecord
} from "./types.js";

// ── parseRiskFlags ─────────────────────────────────────────────────────

export function parseRiskFlags(raw: string): ("ambiguous_target" | "cross_type" | "generated_file")[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is "ambiguous_target" | "cross_type" | "generated_file" => {
      return item === "ambiguous_target" || item === "cross_type" || item === "generated_file";
    });
  } catch {
    return [];
  }
}

// ── Save refactor preview ──────────────────────────────────────────────

export function saveRefactorPreviewImpl(
  db: Database.Database,
  preview: RefactorPreviewRecord,
  hunks: RefactorPreviewHunkRecord[]
): void {
  const tx = db.transaction((previewRow: RefactorPreviewRecord, hunkRows: RefactorPreviewHunkRecord[]) => {
    db.prepare(
      `
      insert into refactor_previews (
        preview_id, repo_id, find_pattern, replace_expression, mode,
        ambiguity_threshold_percent, created_at, expires_at, digest, status,
        total_matches, affected_file_count, risk_ambiguous_count, risk_cross_type_count, risk_generated_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(preview_id) do update set
        repo_id = excluded.repo_id,
        find_pattern = excluded.find_pattern,
        replace_expression = excluded.replace_expression,
        mode = excluded.mode,
        ambiguity_threshold_percent = excluded.ambiguity_threshold_percent,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        digest = excluded.digest,
        status = excluded.status,
        total_matches = excluded.total_matches,
        affected_file_count = excluded.affected_file_count,
        risk_ambiguous_count = excluded.risk_ambiguous_count,
        risk_cross_type_count = excluded.risk_cross_type_count,
        risk_generated_count = excluded.risk_generated_count
      `
    ).run(
      previewRow.previewId,
      previewRow.repoId,
      previewRow.findPattern,
      previewRow.replaceExpression,
      previewRow.mode,
      previewRow.ambiguityThresholdPercent,
      previewRow.createdAt,
      previewRow.expiresAt,
      previewRow.digest,
      previewRow.status,
      previewRow.totalMatches,
      previewRow.affectedFileCount,
      previewRow.riskAmbiguousCount,
      previewRow.riskCrossTypeCount,
      previewRow.riskGeneratedCount
    );

    db.prepare(`delete from refactor_preview_hunks where preview_id = ?`).run(previewRow.previewId);

    const insertHunk = db.prepare(
      `
      insert into refactor_preview_hunks (
        preview_id, hunk_id, file_path, line, start_offset, end_offset,
        before_text, after_text, replacement_text, owner_type, symbol_kind,
        confidence, risk_flags, file_hash_before
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    for (const hunk of hunkRows) {
      insertHunk.run(
        hunk.previewId,
        hunk.hunkId,
        hunk.filePath,
        hunk.line,
        hunk.startOffset,
        hunk.endOffset,
        hunk.beforeText,
        hunk.afterText,
        hunk.replacementText,
        hunk.ownerType,
        hunk.symbolKind,
        hunk.confidence,
        JSON.stringify(hunk.riskFlags),
        hunk.fileHashBefore
      );
    }
  });

  tx(preview, hunks);
}

// ── Get refactor preview ───────────────────────────────────────────────

export function getRefactorPreviewImpl(
  db: Database.Database,
  previewId: string
): { preview: RefactorPreviewRecord; hunks: RefactorPreviewHunkRecord[] } | null {
  const preview = db
    .prepare(
      `
      select
        preview_id as previewId,
        repo_id as repoId,
        find_pattern as findPattern,
        replace_expression as replaceExpression,
        mode,
        ambiguity_threshold_percent as ambiguityThresholdPercent,
        created_at as createdAt,
        expires_at as expiresAt,
        digest,
        status,
        total_matches as totalMatches,
        affected_file_count as affectedFileCount,
        risk_ambiguous_count as riskAmbiguousCount,
        risk_cross_type_count as riskCrossTypeCount,
        risk_generated_count as riskGeneratedCount
      from refactor_previews
      where preview_id = ?
      limit 1
      `
    )
    .get(previewId) as RefactorPreviewRecord | undefined;

  if (!preview) {
    return null;
  }

  const rows = db
    .prepare(
      `
      select
        preview_id as previewId,
        hunk_id as hunkId,
        file_path as filePath,
        line,
        start_offset as startOffset,
        end_offset as endOffset,
        before_text as beforeText,
        after_text as afterText,
        replacement_text as replacementText,
        owner_type as ownerType,
        symbol_kind as symbolKind,
        confidence,
        risk_flags as riskFlags,
        file_hash_before as fileHashBefore
      from refactor_preview_hunks
      where preview_id = ?
      order by file_path asc, start_offset asc, hunk_id asc
      `
    )
    .all(previewId) as Array<Omit<RefactorPreviewHunkRecord, "riskFlags"> & { riskFlags: string }>;

  const hunks: RefactorPreviewHunkRecord[] = rows.map((row) => ({
    ...row,
    riskFlags: parseRiskFlags(row.riskFlags)
  }));

  return { preview, hunks };
}

// ── Mark preview status ────────────────────────────────────────────────

export function markRefactorPreviewStatusImpl(
  db: Database.Database,
  previewId: string,
  status: RefactorPreviewRecord["status"]
): void {
  db.prepare(
    `
    update refactor_previews
    set status = ?
    where preview_id = ?
    `
  ).run(status, previewId);
}

// ── Record refactor apply ──────────────────────────────────────────────

export function recordRefactorApplyImpl(
  db: Database.Database,
  apply: RefactorApplyRecord,
  changes: RefactorApplyChangeRecord[],
  hunks: RefactorApplyHunkRecord[]
): void {
  const tx = db.transaction((applyRow: RefactorApplyRecord, changeRows: RefactorApplyChangeRecord[], hunkRows: RefactorApplyHunkRecord[]) => {
    db.prepare(
      `
      insert into refactor_applies (
        apply_id, rollback_id, preview_id, repo_id, status,
        created_at, completed_at, total_files, total_replacements, conflict_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      applyRow.applyId,
      applyRow.rollbackId,
      applyRow.previewId,
      applyRow.repoId,
      applyRow.status,
      applyRow.createdAt,
      applyRow.completedAt,
      applyRow.totalFiles,
      applyRow.totalReplacements,
      applyRow.conflictCount
    );

    const insertChange = db.prepare(
      `
      insert into refactor_apply_changes (
        apply_id, file_path, replacement_count, status, reason,
        file_hash_before, file_hash_after, before_content, after_content
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    for (const row of changeRows) {
      const APPLY_CONTENT_STORE_MAX_BYTES = 256 * 1024;
      const beforeContentStored =
        row.beforeContent != null && Buffer.byteLength(row.beforeContent, "utf8") <= APPLY_CONTENT_STORE_MAX_BYTES
          ? row.beforeContent
          : null;
      const afterContentStored =
        row.afterContent != null && Buffer.byteLength(row.afterContent, "utf8") <= APPLY_CONTENT_STORE_MAX_BYTES
          ? row.afterContent
          : null;
      insertChange.run(
        row.applyId,
        row.filePath,
        row.replacementCount,
        row.status,
        row.reason,
        row.fileHashBefore,
        row.fileHashAfter,
        beforeContentStored,
        afterContentStored
      );
    }

    const insertHunk = db.prepare(
      `
      insert into refactor_apply_hunks (
        apply_id, file_path, hunk_id, start_offset_applied, end_offset_applied, before_text, after_text
      ) values (?, ?, ?, ?, ?, ?, ?)
      `
    );

    for (const hunk of hunkRows) {
      insertHunk.run(
        hunk.applyId,
        hunk.filePath,
        hunk.hunkId,
        hunk.startOffsetApplied,
        hunk.endOffsetApplied,
        hunk.beforeText,
        hunk.afterText
      );
    }
  });

  tx(apply, changes, hunks);
}

// ── Get apply by rollback ID ───────────────────────────────────────────

export function getApplyByRollbackIdImpl(
  db: Database.Database,
  rollbackId: string
): {
  apply: RefactorApplyRecord;
  changes: RefactorApplyChangeRecord[];
  hunks: RefactorApplyHunkRecord[];
} | null {
  const apply = db
    .prepare(
      `
      select
        apply_id as applyId,
        rollback_id as rollbackId,
        preview_id as previewId,
        repo_id as repoId,
        status,
        created_at as createdAt,
        completed_at as completedAt,
        total_files as totalFiles,
        total_replacements as totalReplacements,
        conflict_count as conflictCount
      from refactor_applies
      where rollback_id = ?
      limit 1
      `
    )
    .get(rollbackId) as RefactorApplyRecord | undefined;

  if (!apply) {
    return null;
  }

  const changes = db
    .prepare(
      `
      select
        apply_id as applyId,
        file_path as filePath,
        replacement_count as replacementCount,
        status,
        reason,
        file_hash_before as fileHashBefore,
        file_hash_after as fileHashAfter,
        before_content as beforeContent,
        after_content as afterContent
      from refactor_apply_changes
      where apply_id = ?
      order by file_path asc
      `
    )
    .all(apply.applyId) as RefactorApplyChangeRecord[];

  const hunks = db
    .prepare(
      `
      select
        apply_id as applyId,
        file_path as filePath,
        hunk_id as hunkId,
        start_offset_applied as startOffsetApplied,
        end_offset_applied as endOffsetApplied,
        before_text as beforeText,
        after_text as afterText
      from refactor_apply_hunks
      where apply_id = ?
      order by file_path asc, start_offset_applied desc, hunk_id asc
      `
    )
    .all(apply.applyId) as RefactorApplyHunkRecord[];

  return { apply, changes, hunks };
}

// ── Record rollback ────────────────────────────────────────────────────

export function recordRefactorRollbackImpl(
  db: Database.Database,
  rollback: RefactorRollbackRecord
): void {
  db.prepare(
    `
    insert into refactor_rollbacks (
      rollback_id, apply_id, status, created_at, completed_at, restored_files, conflict_count
    ) values (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    rollback.rollbackId,
    rollback.applyId,
    rollback.status,
    rollback.createdAt,
    rollback.completedAt,
    rollback.restoredFiles,
    rollback.conflictCount
  );
}
