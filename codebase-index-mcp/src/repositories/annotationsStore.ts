import type Database from "better-sqlite3";
import { minimatch } from "minimatch";

import type { CitationHit, CommentChunk } from "../services/docs/annotationScanner.js";
import { indexLog } from "../services/indexing/indexProgress.js";

/**
 * Release C storage: `citations` (a repo's shorthand references, from markdown prose and code
 * comments) and `code_comments` (+ `comments_fts`). Replace-per-file like the literals lane, and
 * deliberately NOT in `symbols` or `docs`: neither may change symbol ranking or the docs modes that
 * assume a markdown file.
 */

export type FileAnnotations = { citations: CitationHit[]; comments: CommentChunk[]; language: string | null };

export function replaceAnnotationsForFileImpl(db: Database.Database, repoId: string, filePath: string, a: FileAnnotations): void {
  const write = () => {
    db.prepare(`delete from citations where repo_id = ? and file_path = ?`).run(repoId, filePath);
    db.prepare(`delete from code_comments where repo_id = ? and file_path = ?`).run(repoId, filePath);
    const insC = db.prepare(
      `insert into citations (repo_id, file_path, line, pattern_id, raw_text, target_spec, anchor_kind, anchor_value, anchor_column)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of a.citations) {
      insC.run(repoId, filePath, c.line, c.patternId, c.raw, c.targetSpec, c.anchorKind, c.anchorValue, c.anchorColumn);
    }
    const insK = db.prepare(
      `insert into code_comments (repo_id, file_path, start_line, end_line, text, language) values (?, ?, ?, ?, ?, ?)`
    );
    for (const k of a.comments) insK.run(repoId, filePath, k.startLine, k.endLine, k.text, a.language);
  };
  if (db.inTransaction) write();
  else db.transaction(write)();
}

export function deleteAnnotationsForFileImpl(db: Database.Database, repoId: string, filePath: string): void {
  db.prepare(`delete from citations where repo_id = ? and file_path = ?`).run(repoId, filePath);
  db.prepare(`delete from code_comments where repo_id = ? and file_path = ?`).run(repoId, filePath);
}

/** Rebuild `comments_fts` from `code_comments` (external content), as the literals lane does. */
export function rebuildCommentsFtsImpl(db: Database.Database): void {
  const start = Date.now();
  try {
    db.prepare(`insert into comments_fts(comments_fts) values('rebuild')`).run();
  } catch {
    indexLog(`[index-comments-fts] comments_fts malformed, recreating...`);
    db.exec(`drop table if exists comments_fts`);
    db.exec(`create virtual table if not exists comments_fts using fts5(text, content='code_comments', content_rowid='rowid')`);
    db.prepare(`insert into comments_fts(comments_fts) values('rebuild')`).run();
  }
  indexLog(`[index-comments-fts] rebuilt in ${String(Date.now() - start)}ms`);
}

export function getAnnotationKeyImpl(db: Database.Database, repoId: string): string | null {
  const row = db.prepare(`select annotation_key as k from repositories where repo_id = ?`).get(repoId) as { k: string | null } | undefined;
  return row?.k ?? null;
}

export function setAnnotationKeyImpl(db: Database.Database, repoId: string, key: string): void {
  db.prepare(`update repositories set annotation_key = ? where repo_id = ?`).run(key, repoId);
}

export type CitationRow = {
  filePath: string;
  line: number;
  patternId: string;
  raw: string;
  targetSpec: string;
  anchorKind: string;
  anchorValue: string | null;
  anchorColumn: number;
};

const CITATION_COLS = `file_path as filePath, line, pattern_id as patternId, raw_text as raw, target_spec as targetSpec,
  anchor_kind as anchorKind, anchor_value as anchorValue, anchor_column as anchorColumn`;

/** Citations made BY a file. */
export function citationsFromImpl(db: Database.Database, repoId: string, filePath: string, limit: number): CitationRow[] {
  return db
    .prepare(`select ${CITATION_COLS} from citations where repo_id = ? and replace(file_path, char(92), '/') = ? order by line limit ?`)
    .all(repoId, filePath.replace(/\\/g, "/"), limit) as CitationRow[];
}

/**
 * Citations that point AT a target: the same spec (and anchor value, when one is given), or — for a
 * concrete file path — any spec whose glob matches it. Returns the total before `limit`.
 */
export function citationsToImpl(
  db: Database.Database,
  repoId: string,
  target: { specs?: { targetSpec: string; anchorValue: string | null }[]; filePath?: string },
  limit: number
): { rows: CitationRow[]; total: number } {
  const rows: CitationRow[] = [];
  if (target.specs && target.specs.length > 0) {
    for (const s of target.specs) {
      rows.push(
        ...((s.anchorValue === null
          ? db.prepare(`select ${CITATION_COLS} from citations where repo_id = ? and target_spec = ?`).all(repoId, s.targetSpec)
          : db
              .prepare(`select ${CITATION_COLS} from citations where repo_id = ? and target_spec = ? and anchor_value = ? collate nocase`)
              .all(repoId, s.targetSpec, s.anchorValue)) as CitationRow[])
      );
    }
  }
  if (target.filePath) {
    const file = target.filePath.replace(/\\/g, "/");
    const specs = db.prepare(`select distinct target_spec as s from citations where repo_id = ?`).all(repoId) as { s: string }[];
    const matching = specs.map((x) => x.s).filter((s) => s === file || minimatch(file, s, { dot: true }));
    for (const s of matching) {
      rows.push(...(db.prepare(`select ${CITATION_COLS} from citations where repo_id = ? and target_spec = ?`).all(repoId, s) as CitationRow[]));
    }
  }
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.filePath}:${String(r.line)}:${r.patternId}:${r.raw}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.line - b.line));
  return { rows: unique.slice(0, limit), total: unique.length };
}

export type CommentHit = { filePath: string; startLine: number; endLine: number; text: string; language: string | null };

/** Full-text search over code comments; a query that FTS cannot parse falls back to LIKE. */
export function searchCommentsImpl(db: Database.Database, repoId: string, query: string, limit: number): CommentHit[] {
  const cols = `c.file_path as filePath, c.start_line as startLine, c.end_line as endLine, c.text, c.language`;
  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length > 0) {
    try {
      const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
      return db
        .prepare(`select ${cols} from comments_fts f join code_comments c on c.rowid = f.rowid where comments_fts match ? and c.repo_id = ? order by bm25(comments_fts) limit ?`)
        .all(match, repoId, limit) as CommentHit[];
    } catch {
      // fall through to LIKE
    }
  }
  return db
    .prepare(`select ${cols} from code_comments c where c.repo_id = ? and c.text like ? limit ?`)
    .all(repoId, `%${query}%`, limit) as CommentHit[];
}

export function annotationCountsImpl(db: Database.Database, repoId: string): { citationsByPattern: Record<string, number>; comments: number } {
  const rows = db.prepare(`select pattern_id as p, count(*) as n from citations where repo_id = ? group by pattern_id`).all(repoId) as { p: string; n: number }[];
  const comments = (db.prepare(`select count(*) as n from code_comments where repo_id = ?`).get(repoId) as { n: number }).n;
  return { citationsByPattern: Object.fromEntries(rows.map((r) => [r.p, r.n])), comments };
}

/** Doc sections whose prose mentions this file path (docs-lane `filepath` mentions). */
export function docSectionsMentioningImpl(db: Database.Database, repoId: string, filePath: string, limit: number): { filePath: string; line: number | null; headingPath: string }[] {
  return db
    .prepare(
      `select distinct d.file_path as filePath, d.start_line as line, d.heading_path as headingPath
       from doc_mentions dm join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
       where dm.repo_id = ? and dm.mention_type = 'filepath' and replace(dm.mention_text, char(92), '/') = ?
       order by d.file_path, d.start_line limit ?`
    )
    .all(repoId, filePath.replace(/\\/g, "/"), limit) as { filePath: string; line: number | null; headingPath: string }[];
}
