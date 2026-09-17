import { statSync } from "node:fs";
import nodePath from "node:path";

import type Database from "better-sqlite3";
import type { DocRecord, DocMentionRecord } from "../types/index.js";
import { indexLog, indexWarn } from "../services/indexing/indexProgress.js";

/**
 * MCP-ISSUE-061(c): `findStaleDocsImpl` and `findDocCoverageImpl` each hardcoded `limit 200` while
 * `query_docs` advertises `limit` up to 500, and neither reported that it had truncated — so `count`
 * in the envelope was a page length presented as a total. Measured live: this repo's graph holds 381
 * non-module symbols, so `mode:"coverage"` was silently dropping a third of them.
 *
 * Both now take the caller's limit and return `{ rows, total }`, the shape MCP-ISSUE-060 settled for
 * `detect_changes.changedFileCount`. This constant is only the fallback for a caller that passes
 * none; it is not a ceiling.
 */
const DOCS_PAGE_LIMIT = 200;

type StaleDocRow = {
  docId: string;
  filePath: string;
  headingPath: string;
  text: string | null;
  mentionText: string;
  mentionType: string;
  symbolName: string | null;
};

type DocCoverageRow = {
  symbolId: string;
  name: string;
  kind: string;
  line: number;
  signature: string | null;
  hasDocs: boolean;
  mentionCount: number;
};

// ── Docs CRUD ──────────────────────────────────────────────────────────

export function upsertDocsImpl(db: Database.Database, docs: DocRecord[]): void {
  const stmt = db.prepare(
    `
    insert into docs (repo_id, doc_id, file_path, heading_path, content_type, text, level, doc_status, superseded_by, start_line, end_line)
    values (@repoId, @docId, @filePath, @headingPath, @contentType, @text, @level, @docStatus, @supersededBy, @startLine, @endLine)
    on conflict(repo_id, doc_id) do update set
      text = excluded.text,
      level = excluded.level,
      doc_status = excluded.doc_status,
      superseded_by = excluded.superseded_by,
      start_line = excluded.start_line,
      end_line = excluded.end_line
    `
  );

  const writeRows = (rows: DocRecord[]) => {
    for (const row of rows) {
      const normalized = { ...row, level: row.level ?? undefined, docStatus: row.docStatus ?? null, supersededBy: row.supersededBy ?? null, startLine: row.startLine ?? null, endLine: row.endLine ?? null };
      stmt.run(normalized);
    }
  };

  if (db.inTransaction) {
    writeRows(docs);
    return;
  }

  db.transaction((rows: DocRecord[]) => {
    writeRows(rows);
  })(docs);
}

/**
 * Replace one file's docs *and* its mentions — the docs lane's equivalent of
 * `replaceSymbolsForFile`, and the reason it exists.
 *
 * MCP-ISSUE-049: `doc_mentions` was written by upsert alone and deleted by nothing, in a table whose
 * primary key includes `mention_type`. So when the parser was corrected to label a fenced-code
 * identifier `code_call` instead of `backtick`, re-indexing did not *relabel* the row — it inserted a
 * second one beside a legacy row that outlives every re-index, including `mode:"full"`. `findStaleDocs`
 * excludes `code_call` and therefore kept matching the legacy row, so the fix verified clean on a
 * throwaway DB and reproduced unchanged on every real one. A relabelling fix in an append-only table
 * is not a fix; the clearing is the fix.
 *
 * Mentions are deleted first: they are reachable only by joining `docs` on `file_path`.
 */
export function replaceDocsForFileImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  docs: DocRecord[],
  mentions: DocMentionRecord[]
): void {
  const run = () => {
    db.prepare(
      `
      delete from doc_mentions
      where repo_id = ?
        and doc_id in (select doc_id from docs where repo_id = ? and file_path = ?)
      `
    ).run(repoId, repoId, filePath);
    db.prepare(`delete from docs where repo_id = ? and file_path = ?`).run(repoId, filePath);
    upsertDocsImpl(db, docs);
    upsertDocMentionsImpl(db, mentions);
  };

  if (db.inTransaction) {
    run();
    return;
  }
  db.transaction(run)();
}

export function upsertDocMentionsImpl(db: Database.Database, mentions: DocMentionRecord[]): void {
  const stmt = db.prepare(
    `
    insert into doc_mentions (repo_id, doc_id, symbol_id, mention_type, confidence, mention_text)
    values (@repoId, @docId, @symbolId, @mentionType, @confidence, @mentionText)
    on conflict(repo_id, doc_id, symbol_id, mention_type, mention_text) do update set
      confidence = excluded.confidence
    `
  );

  const writeRows = (rows: DocMentionRecord[]) => {
    for (const row of rows) {
      stmt.run(row);
    }
  };

  if (db.inTransaction) {
    writeRows(mentions);
    return;
  }

  db.transaction((rows: DocMentionRecord[]) => {
    writeRows(rows);
  })(mentions);
}

// ── Docs FTS rebuild ───────────────────────────────────────────────────

export function rebuildDocsFtsImpl(db: Database.Database): void {
  const start = Date.now();
  try {
    const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM docs WHERE text IS NOT NULL`);
    const { cnt: totalDocs } = countStmt.get() as { cnt: number };

    if (totalDocs === 0) {
      indexLog(`[index-docs-fts] no docs to index`);
      return;
    }

    try {
      db.prepare(`DELETE FROM docs_fts`).run();
    } catch (e) {
      indexLog(`[index-docs-fts] docs_fts malformed, recreating table...`);
      db.exec(`DROP TABLE IF EXISTS docs_fts`);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
          text,
          doc_id UNINDEXED,
          repo_id UNINDEXED,
          content='docs',
          content_rowid='rowid'
        )
      `);
    }

    const chunkSize = 5000;
    const chunks = Math.ceil(totalDocs / chunkSize);

    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const offset = chunk * chunkSize;
      db.prepare(
        `INSERT INTO docs_fts(rowid, text, doc_id, repo_id)
         SELECT rowid, text, doc_id, repo_id FROM docs
         WHERE text IS NOT NULL
         ORDER BY rowid
         LIMIT ? OFFSET ?`
      ).run(chunkSize, offset);

      if ((chunk + 1) % 2 === 0 || chunk === chunks - 1) {
        const pct = Math.round(((chunk + 1) / chunks) * 100);
        const elapsed = Date.now() - start;
        indexLog(`[index-docs-fts] ${pct}% | ${Math.min((chunk + 1) * chunkSize, totalDocs)}/${totalDocs} docs | ${elapsed}ms`);
      }
    }

    db.prepare(`INSERT INTO docs_fts(docs_fts) VALUES('optimize')`).run();

    const elapsed = Date.now() - start;
    indexLog(`[index-docs-fts] completed ${totalDocs} docs in ${elapsed}ms`);
  } catch (e) {
    indexWarn(`[index-docs-fts-error] rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Resolve doc mentions ───────────────────────────────────────────────

export function resolveMentionsImpl(db: Database.Database, repoId: string): number {
  const unresolved = db
    .prepare(
      `
      select doc_id, symbol_id, mention_type, mention_text
      from doc_mentions
      where repo_id = ? and symbol_id is null
      `
    )
    .all(repoId) as {
    doc_id: string;
    symbol_id: string | null;
    mention_type: string;
    mention_text: string;
  }[];

  if (unresolved.length === 0) return 0;

  const kindRank = (kind: string): number => {
    switch (kind) {
      case "class": return 0;
      case "interface": return 1;
      case "function": return 2;
      case "method": return 3;
      case "variable": return 4;
      default: return 5;
    }
  };

  const allSymbols = db
    .prepare(`select symbol_id, name, kind, file_path from symbols where repo_id = ?`)
    .all(repoId) as { symbol_id: string; name: string; kind: string; file_path: string }[];

  const nameMap = new Map<string, string>();
  const nameMapRank = new Map<string, number>();
  const nameLowerMap = new Map<string, string>();
  const nameLowerMapRank = new Map<string, number>();
  const nameSuffixMap = new Map<string, string>();
  const namePrefixMap = new Map<string, string>();
  const filePathMap = new Map<string, string>();
  const filePathSuffixMap = new Map<string, string>();
  /**
   * MCP-ISSUE-049: how many DISTINCT dotted symbols share each unqualified suffix.
   *
   * The suffix map below is what let a bare `` `Parse` `` in a doc resolve to
   * `ConversationLoopCorrelationCodec.Parse` — and `query_docs{ mode:"stale" }` then reported five
   * archived docs as stale references to a symbol they never mention, because the word `Parse`
   * appeared inside a quoted C# snippet. A suffix that several symbols share cannot identify one of
   * them, so ambiguity is now tracked and an ambiguous bare suffix resolves to nothing.
   */
  const nameSuffixCount = new Map<string, Set<string>>();

  for (const sym of allSymbols) {
    const rank = kindRank(sym.kind);

    const existingRank = nameMapRank.get(sym.name) ?? Infinity;
    if (rank < existingRank) {
      nameMap.set(sym.name, sym.symbol_id);
      nameMapRank.set(sym.name, rank);
    }

    const nameLower = sym.name.toLowerCase();
    const existingLowerRank = nameLowerMapRank.get(nameLower) ?? Infinity;
    if (rank < existingLowerRank) {
      nameLowerMap.set(nameLower, sym.symbol_id);
      nameLowerMapRank.set(nameLower, rank);
    }
    const dotIdx = nameLower.lastIndexOf(".");
    if (dotIdx >= 0) {
      const suffix = nameLower.slice(dotIdx + 1);
      if (!nameSuffixMap.has(suffix)) nameSuffixMap.set(suffix, sym.symbol_id);
      if (!nameSuffixCount.has(suffix)) nameSuffixCount.set(suffix, new Set());
      nameSuffixCount.get(suffix)!.add(nameLower);
      const prefix = nameLower.slice(0, dotIdx);
      if (!namePrefixMap.has(prefix)) namePrefixMap.set(prefix, sym.symbol_id);
    }

    const normalizedPath = sym.file_path
      .replace(/\\/g, "/")
      .replace(/\.(ts|js|tsx|jsx|cs)$/, "")
      .toLowerCase();
    if (!filePathMap.has(normalizedPath) || sym.kind === "module") {
      filePathMap.set(normalizedPath, sym.symbol_id);
    }
    const parts = normalizedPath.split("/");
    for (let i = parts.length - 1; i >= 0; i--) {
      const key = parts.slice(i).join("/");
      if (!filePathSuffixMap.has(key)) filePathSuffixMap.set(key, sym.symbol_id);
      if (parts.length - i >= 3) break;
    }
  }

  const updateStmt = db.prepare(
    `update or replace doc_mentions set symbol_id = ? where repo_id = ? and doc_id = ? and mention_type = ? and mention_text = ? and symbol_id is null`
  );

  let count = 0;
  const updates: Array<[string, string, string, string, string]> = [];

  for (const mention of unresolved) {
    let resolvedSymbolId: string | undefined;

    if (mention.mention_type === "backtick" || mention.mention_type === "code_call") {
      const lower = mention.mention_text.toLowerCase();
      // Exact name (case-sensitive, then insensitive): the mention names the symbol.
      resolvedSymbolId = nameMap.get(mention.mention_text) ?? nameLowerMap.get(lower);

      // An UNQUALIFIED suffix can only identify a symbol if exactly one dotted symbol carries it.
      // Picking `nameSuffixMap`'s arbitrary first entry when several share the suffix is a guess
      // reported as a fact. (This is a correctness guard in its own right; it is not what caused
      // MCP-ISSUE-049's false positives — those resolved by exact name, because C# members are
      // stored under their bare name. The cause was mentions harvested from fenced code blocks;
      // see `extractMentionsFromCode` and the `code_call` type.)
      if (resolvedSymbolId === undefined) {
        const sharing = nameSuffixCount.get(lower);
        if (sharing?.size === 1) resolvedSymbolId = nameSuffixMap.get(lower);
      }
      resolvedSymbolId ??= namePrefixMap.get(lower);
    } else if (mention.mention_type === "filepath") {
      const normalizedMention = mention.mention_text
        .replace(/\\/g, "/")
        .replace(/\.(ts|js|tsx|jsx|cs)$/, "")
        .replace(/^src\//, "")
        .toLowerCase();

      resolvedSymbolId = filePathMap.get(normalizedMention);

      if (!resolvedSymbolId) {
        resolvedSymbolId = filePathSuffixMap.get(normalizedMention);
      }
    }

    if (resolvedSymbolId) {
      updates.push([resolvedSymbolId, repoId, mention.doc_id, mention.mention_type, mention.mention_text]);
    }
  }

  if (updates.length > 0) {
    const tx = db.transaction(() => {
      for (const args of updates) {
        updateStmt.run(...args);
        count += 1;
      }
    });
    tx();
  }

  return count;
}

// ── Search docs ────────────────────────────────────────────────────────

/**
 * `query_docs{ mode:"search" }`.
 *
 * MCP-ISSUE-049: when the doc lane returned fewer rows than `limit`, this padded the remainder from
 * `symbols_fts` — so a docs search returned code symbols labelled `contentType:"symbol"` whose `text`
 * was a synthesized file pointer (`"0004-autoreply-confidence-threshold.md @ line 1"`, a *module*
 * pseudo-symbol standing in for a doc file) rather than any documentation. The padding is now
 * opt-in via `includeSymbols`, and when requested it excludes module pseudo-symbols, which were the
 * rows that read as nonsense.
 */
export function searchDocsImpl(
  db: Database.Database,
  repoId: string,
  query: string,
  limit: number,
  buildFtsQuery: (q: string) => string,
  buildIntentFtsQuery: (q: string) => string,
  includeSymbols = false,
  /**
   * MCP-ISSUE-058(d): which section kinds may answer. The filed case returned exactly one hit for
   * "ConversationNote" — a mermaid flowchart matching only the words "pinned note" — while
   * `search_regex` over the same 53 doc files correctly returned 0.
   *
   * MCP-ISSUE-061: that fix set the default to `["heading","prose"]`, and **no code path writes
   * `prose`** — `parseMarkdownFile` emits `heading` and `code_block` only, scraping prose lines for
   * mentions and discarding the text. So the default named one kind that does not exist and dropped
   * one that does: the searchable corpus fell from 4069 rows to 2259 rows of heading text averaging
   * 35 characters, and a phrase search against real document bodies returned 0. The LIKE fallback
   * does not rescue it — it applies this same filter.
   *
   * Stage 4 landed the prose writer, and the default stays at all three. See the zod schema for why
   * it did not revert to 058(d)'s pair once prose existed.
   */
  contentTypes: readonly string[] | null = null,
  /**
   * MCP-ISSUE-061 Stage 3. `CLAUDE.md` warns in prose that nothing under `docs/archive/` is
   * maintained and that a current state must not be read out of it. That warning exists because
   * agents keep doing exactly that, so the default now EXCLUDES archived and superseded documents
   * and this flag opts them back in for history questions.
   */
  includeArchived = false,
  /**
   * MCP-ISSUE-061 Stage 5. "auto" runs the strict AND tier then tops up from the broad OR tier;
   * "strict" keeps the pre-Stage-5 behaviour for a caller that wants precision only; "phrase"
   * requires the words adjacent and in order, for a caller who knows the exact wording.
   */
  matchMode: "auto" | "strict" | "phrase" = "auto",
  /**
   * MCP-ISSUE-061 Stage 6b: at most this many chunks from any one file. 0 disables the cap.
   *
   * 1 by default, and the default is measured rather than chosen. Across the 20-query harness at
   * `limit: 5` — 100 slots in total:
   *
   *     uncapped   83 distinct files (17 slots duplicated)
   *     cap 2      84 distinct files (16 duplicated)  — almost nothing
   *     cap 1      97 distinct files ( 3 duplicated)
   *
   * Recall is 18/20 in all three, so the cap costs nothing and returns 14 of 100 slots to documents
   * that had been crowded out. The failure that prompted it: "which database environment is always
   * read only" spent five of eight slots on two sqlserver files.
   */
  maxPerFile = 1
): {
  docId: string;
  filePath: string;
  headingPath: string;
  contentType: string;
  text: string | null;
  level: number | null;
  startLine: number | null;
  endLine: number | null;
  /** "strict" = matched the AND query; "broad" = came from the OR top-up tier (Stage 5). */
  matchTier: "strict" | "broad";
  resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
}[] {
  const ftsQuery = buildFtsQuery(query);
  let docIds: string[] = [];
  let usedFts = false;
  // How many of `docIds` came from the strict tier — everything past this index is broad.
  let strictCount = 0;
  const desiredLimit = Math.max(1, limit);
  const allowedTypes =
    contentTypes && contentTypes.length > 0 ? contentTypes : ["heading", "prose", "code_block"];
  const typePlaceholders = allowedTypes.map(() => "?").join(", ");
  // `doc_status` lives on the FILE-LEVEL row only, so a heading inside an archived file carries
  // none — the filter has to go by file, not by row.
  const archiveFilter = includeArchived
    ? ""
    : `and docs.file_path not in (select file_path from docs where repo_id = ? and doc_status in ('archived','superseded'))`;
  const archiveParams: string[] = includeArchived ? [] : [repoId];

  /**
   * MCP-ISSUE-061 Stage 5: two FTS tiers, strict then broad.
   *
   * `buildFtsQuery` joins its prefix terms with an implicit AND, so a nine-word question demanded
   * all nine tokens inside one chunk. The Stage 0 harness put a number on what that costs: across
   * ten natural-language questions the strict query scored **0/10, and seven of them returned no
   * rows at all**, while the OR form of the same queries scored **7/10**. `buildIntentFtsQuery` —
   * the OR builder — already existed for symbol search and had never been wired to docs.
   *
   * So the strict tier runs first and keeps its precision, and the broad tier tops up whatever is
   * missing. Broad rows are LABELLED `matchTier: "broad"`, which is the rule MCP-ISSUE-058(b)
   * settled: padded results that look identical to direct hits are how a confident wrong answer gets
   * reported at `confidence: "high"`.
   */
  /**
   * MCP-ISSUE-061 Stage 6b — **tried, measured, removed.** Do not re-propose without new evidence.
   *
   * The Stage 3 link graph knows which documents this workspace points at most (`conventions.md`,
   * `folder-convention.md` and `workflow.md` at 12 inbound each, ADR 0001 at 9), and bm25 cannot see
   * that: it scores text, not standing. Blending it into the rank as a tie-break was the obvious
   * cheap win before reaching for embeddings.
   *
   * It did nothing. At weight 0.15 the recall harness read 18/20 and result diversity 84 distinct
   * files of 100 slots; at weight 0 — the term removed entirely — both numbers were IDENTICAL. The
   * one query it was supposed to rescue ("why are the servers not part of the npm workspace", where
   * ADR 0001 sits at rank 6) needed more than a tie-break's worth of push, and raising the weight
   * until the test passed would have been fitting the metric rather than improving retrieval.
   *
   * What did work was the per-file cap below, which came out of looking at the same failure.
   */

  const runFts = (matchExpr: string, want: number): string[] => {
    const rows = db
      .prepare(
        `
        select docs_fts.doc_id as docId, replace(docs.file_path, char(92), '/') as filePath, rank as score
        from docs_fts
        inner join docs on docs.doc_id = docs_fts.doc_id and docs.repo_id = ?
        where docs_fts match ? and docs.content_type in (${typePlaceholders}) ${archiveFilter}
        order by rank
        limit ?
        `
      )
      .all(repoId, matchExpr, ...allowedTypes, ...archiveParams, want) as {
      docId: string;
      filePath: string;
      score: number;
    }[];

    /**
     * At most `maxPerFile` chunks from any one file.
     *
     * Measured need, not taste: on "which database environment is always read only", five of the
     * eight returned slots were two files — `.claude/skills/sqlserver-mcp/SKILL.md` three times and
     * `sqlserver-mcp/skill/SKILL.md` twice — which crowded out every other document that had an
     * answer. A caller with a five-row budget learns more from five files than from one file five
     * times, and the runner-up chunks of a file it has already been shown add almost nothing.
     */
    const perFile = new Map<string, number>();
    const cap = maxPerFile > 0 ? maxPerFile : Number.MAX_SAFE_INTEGER;
    return rows
      .map((r) => ({
        docId: r.docId,
        filePath: r.filePath,
        score: r.score
      }))
      .sort((a, b) => a.score - b.score)
      .filter((r) => {
        const seen = perFile.get(r.filePath) ?? 0;
        if (seen >= cap) return false;
        perFile.set(r.filePath, seen + 1);
        return true;
      })
      .map((r) => r.docId);
  };

  try {
    db.prepare("select * from docs_fts limit 0").all();
    if (matchMode === "phrase") {
      // FTS5 phrase syntax: the quoted tokens must appear adjacent, in order. The narrowest
      // possible match, for a caller who knows the exact wording.
      docIds = runFts(`"${query.replace(/"/g, "")}"`, desiredLimit);
    } else {
      docIds = runFts(ftsQuery, desiredLimit);
      strictCount = docIds.length;
      if (matchMode !== "strict" && docIds.length < desiredLimit) {
        const seen = new Set(docIds);
        for (const id of runFts(buildIntentFtsQuery(query), desiredLimit * 2)) {
          if (docIds.length >= desiredLimit) break;
          if (seen.has(id)) continue;
          seen.add(id);
          docIds.push(id);
        }
      }
    }
    usedFts = true;
  } catch {
    // FTS unavailable
  }

  /**
   * LIKE is now a fallback for FTS being UNAVAILABLE, not for it matching nothing — the broad tier
   * above covers that case far better. It also no longer orders by `rowid`, which is insertion
   * order and no relevance at all; shortest text first is a crude proxy, but a crude proxy beats
   * "whichever section happened to be parsed first".
   */
  if (!usedFts) {
    docIds = db
      .prepare(
        `select doc_id as docId from docs where repo_id = ? and text like ? and content_type in (${typePlaceholders}) ${archiveFilter} order by length(text) limit ?`
      )
      .all(repoId, `%${query}%`, ...allowedTypes, ...archiveParams, desiredLimit)
      .map((r) => (r as { docId: string }).docId);
  }

  const docResults: {
    docId: string;
    filePath: string;
    headingPath: string;
    contentType: string;
    text: string | null;
    level: number | null;
    startLine: number | null;
    endLine: number | null;
    matchTier: "strict" | "broad";
    resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
  }[] = [];

  if (docIds.length > 0) {
    const ph = docIds.map(() => "?").join(",");
    const docs = db
      .prepare(
        `select doc_id as docId, file_path as filePath, heading_path as headingPath,
                content_type as contentType, text, level,
                start_line as startLine, end_line as endLine
         from docs where repo_id = ? and doc_id in (${ph})`
      )
      .all(repoId, ...docIds) as {
      docId: string;
      filePath: string;
      headingPath: string;
      contentType: string;
      text: string | null;
      level: number | null;
      startLine: number | null;
      endLine: number | null;
    }[];

    const mentionRows = db
      .prepare(
        `select dm.doc_id as docId, dm.symbol_id as symbolId,
                dm.mention_text as mentionText, s.name as symbolName
         from doc_mentions dm
         left join symbols s on s.repo_id = ? and s.symbol_id = dm.symbol_id
         where dm.repo_id = ? and dm.doc_id in (${ph}) and dm.symbol_id is not null`
      )
      .all(repoId, repoId, ...docIds) as {
      docId: string;
      symbolId: string;
      mentionText: string;
      symbolName: string | null;
    }[];

    const mentionsByDoc = new Map<
      string,
      { symbolId: string; symbolName: string | null; mentionText: string }[]
    >();
    for (const row of mentionRows) {
      if (!mentionsByDoc.has(row.docId)) mentionsByDoc.set(row.docId, []);
      mentionsByDoc
        .get(row.docId)!
        .push({ symbolId: row.symbolId, symbolName: row.symbolName, mentionText: row.mentionText });
    }

    // MCP-ISSUE-061(h): missing ids used to get sort key 99, which silently mis-ordered any result
    // set larger than 99. An id not in the ranked list sorts last, whatever the list's length.
    const orderMap = new Map(docIds.map((id, i) => [id, i]));
    const rankOf = (id: string) => orderMap.get(id) ?? Number.MAX_SAFE_INTEGER;
    docResults.push(
      ...docs
        .sort((a, b) => rankOf(a.docId) - rankOf(b.docId))
        .map((doc) => ({
          ...doc,
          matchTier: (rankOf(doc.docId) < strictCount ? "strict" : "broad") as "strict" | "broad",
          resolvedMentions: mentionsByDoc.get(doc.docId) ?? []
        }))
    );
  }

  if (includeSymbols && docResults.length < desiredLimit) {
    const symbolSlots = desiredLimit - docResults.length;
    try {
      db.prepare("select * from symbols_fts limit 0").all();
      const symbolRows = db
        .prepare(
          `
          select
            s.symbol_id as symbolId,
            s.name as symbolName,
            s.file_path as filePath,
            s.signature as signature,
            s.line as line
          from symbols_fts sf
          inner join symbols s on s.repo_id = ? and s.symbol_id = sf.symbol_id
          where symbols_fts match ? and s.kind != 'module'
          order by rank
          limit ?
          `
        )
        .all(repoId, buildIntentFtsQuery(query), symbolSlots) as {
        symbolId: string;
        symbolName: string;
        filePath: string;
        signature: string | null;
        line: number;
      }[];

      for (const row of symbolRows) {
        docResults.push({
          docId: `symbol:${row.symbolId}`,
          filePath: row.filePath,
          headingPath: row.filePath,
          contentType: "symbol",
          text: row.signature ?? `${row.symbolName} @ line ${row.line}`,
          level: null,
          startLine: row.line,
          endLine: row.line,
          matchTier: "broad" as const,
          resolvedMentions: [{ symbolId: row.symbolId, symbolName: row.symbolName, mentionText: row.symbolName }]
        });
      }
    } catch {
      // symbols_fts unavailable
    }
  }

  return docResults.slice(0, desiredLimit);
}

// ── Find stale docs ────────────────────────────────────────────────────

/**
 * "Which docs mention these symbols, and so may now be stale."
 *
 * MCP-ISSUE-049: `code_call` mentions are excluded by default. They are identifiers scraped from
 * inside fenced code blocks, and they were the whole of the reported false positive: a symbolId for
 * `ConversationLoopCorrelationCodec.Parse` returned five hits in `docs/02-flows/_archive/**`, every
 * one of them a `Parse(` inside a pasted C# snippet in a document about something else. A doc that
 * merely *contains* a call is not a doc that *documents* the callee, and "this doc is now stale"
 * is a claim strong enough that it needs the prose-level signal.
 *
 * `includeCodeMentions` opts them back in for "where is this symbol illustrated" questions.
 */
export function findStaleDocsImpl(
  db: Database.Database,
  repoId: string,
  symbolIds: string[],
  includeCodeMentions = false,
  limit = DOCS_PAGE_LIMIT
): { rows: StaleDocRow[]; total: number } {
  if (symbolIds.length === 0) return { rows: [], total: 0 };
  const ph = symbolIds.map(() => "?").join(",");
  const typeFilter = includeCodeMentions ? "" : "and dm.mention_type != 'code_call'";
  const where = `where dm.repo_id = ? and dm.symbol_id in (${ph}) ${typeFilter}`;

  const { total } = db
    .prepare(
      `
      select count(*) as total
      from doc_mentions dm
      inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
      ${where}
      `
    )
    .get(repoId, ...symbolIds) as { total: number };

  const rows = db
    .prepare(
      `
      select dm.doc_id as docId, d.file_path as filePath, d.heading_path as headingPath,
             d.text, dm.mention_text as mentionText, dm.mention_type as mentionType, s.name as symbolName
      from doc_mentions dm
      inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
      left join symbols s on s.repo_id = dm.repo_id and s.symbol_id = dm.symbol_id
      ${where}
      order by d.file_path, d.heading_path
      limit ?
      `
    )
    .all(repoId, ...symbolIds, Math.max(1, limit)) as StaleDocRow[];

  return { rows, total };
}

// ── Find doc coverage ──────────────────────────────────────────────────

export function findDocCoverageImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit = DOCS_PAGE_LIMIT
): { rows: DocCoverageRow[]; total: number } {
  const scope = `where s.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/') and s.kind != 'module'`;

  const { total } = db
    .prepare(`select count(*) as total from symbols s ${scope}`)
    .get(repoId, filePath) as { total: number };

  const rows = db
    .prepare(
      `
      select
        s.symbol_id as symbolId,
        s.name,
        s.kind,
        s.line,
        s.signature,
        case when count(dm.doc_id) > 0 then 1 else 0 end as hasDocs,
        count(dm.doc_id) as mentionCount
      from symbols s
      left join doc_mentions dm on dm.repo_id = s.repo_id and dm.symbol_id = s.symbol_id
      ${scope}
      group by s.symbol_id, s.name, s.kind, s.line, s.signature
      order by s.line
      limit ?
      `
    )
    .all(repoId, filePath, Math.max(1, limit)) as {
    symbolId: string;
    name: string;
    kind: string;
    line: number;
    signature: string | null;
    hasDocs: boolean;
    mentionCount: number;
  }[];

  return { rows, total };
}

// ── Language coverage ──────────────────────────────────────────────────

export type LanguageRow = {
  filePath: string;
  docStatus: string | null;
  chunks: number;
  flaggedChunks: number;
  nonAsciiLetters: number;
  /** Non-ASCII letters as a percentage of the file's indexed text. */
  ratioPercent: number;
  /** The worst chunk, so a reviewer can start somewhere concrete. */
  worstChunk: { startLine: number | null; ratioPercent: number; sample: string } | null;
};

/**
 * Non-ASCII **letters** — `\p{L}` outside Basic Latin.
 *
 * MCP-ISSUE-061 Stage 6. The naive signal is "any non-ASCII codepoint", and it is worthless here:
 * it flags **100 of 107 files**, because this workspace's prose is full of em-dashes (3 246), arrows
 * (748), middots (578), box-drawing (~670) and check marks (317). Restricting to characters that are
 * alphabetic flags **8 files**, and the top two are exactly the two Vietnamese READMEs — 573 and 415
 * letters, about 5% of their text — while `— → ─ ✅ ·` all score zero.
 *
 * It is also general rather than Vietnamese-specific: Cyrillic, Greek and CJK are alphabetic too, so
 * this stays correct if the corpus ever gains another language, which a diacritic range would not.
 */
function countNonAsciiLetters(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) continue;
    if (/\p{L}/u.test(ch)) n += 1;
  }
  return n;
}

/**
 * `query_docs{ mode:"language" }` — which documents are not yet normalized to English.
 *
 * Stage 6's plan is to normalize every document to English and then index cross-repo, which removes
 * the multilingual requirement from retrieval. But that is **content work outside this codebase**,
 * and until it is finished the index holds both languages. So this is two things at once: a guard a
 * retrieval caller can consult, and a progress meter for the rewriting — the only way to know the
 * normalization is done is to be able to count what is left.
 *
 * Computed on read rather than stored. The corpus is small enough that the scan is free, and it
 * means the report works on an index built before this feature existed — no migration, no re-index.
 * If it ever needs to filter inside SQL it becomes a column; today that would be a cost with no
 * buyer.
 */
export function findNonEnglishDocsImpl(
  db: Database.Database,
  repoId: string,
  minRatioPercent = 0.5,
  limit = DOCS_PAGE_LIMIT
): { rows: LanguageRow[]; total: number; filesScanned: number; cleanFiles: number } {
  const rows = db
    .prepare(
      `
      select file_path as filePath, doc_status as docStatus, text, start_line as startLine
      from docs
      where repo_id = ? and text is not null
      `
    )
    .all(repoId) as { filePath: string; docStatus: string | null; text: string; startLine: number | null }[];

  type Acc = LanguageRow & { chars: number };
  const byFile = new Map<string, Acc>();

  for (const row of rows) {
    const key = row.filePath.replace(/\\/g, "/");
    let acc = byFile.get(key);
    if (!acc) {
      acc = {
        filePath: key,
        docStatus: row.docStatus,
        chunks: 0,
        flaggedChunks: 0,
        nonAsciiLetters: 0,
        ratioPercent: 0,
        worstChunk: null,
        chars: 0
      };
      byFile.set(key, acc);
    }
    // `doc_status` is only on the file-level row, so take it wherever it appears.
    if (row.docStatus !== null) acc.docStatus = row.docStatus;

    const letters = countNonAsciiLetters(row.text);
    acc.chunks += 1;
    acc.chars += row.text.length;
    acc.nonAsciiLetters += letters;

    if (letters === 0) continue;
    const chunkRatio = (letters / Math.max(1, row.text.length)) * 100;
    // Per chunk, not per file: this text is mixed WITHIN paragraphs — Vietnamese prose wrapping
    // English identifiers — so a file-level verdict would be too coarse to act on.
    if (chunkRatio >= minRatioPercent) acc.flaggedChunks += 1;
    if (!acc.worstChunk || chunkRatio > acc.worstChunk.ratioPercent) {
      acc.worstChunk = {
        startLine: row.startLine,
        ratioPercent: Math.round(chunkRatio * 100) / 100,
        sample: row.text.replace(/\s+/g, " ").slice(0, 120)
      };
    }
  }

  const all: LanguageRow[] = [];
  let cleanFiles = 0;
  for (const acc of byFile.values()) {
    const ratio = (acc.nonAsciiLetters / Math.max(1, acc.chars)) * 100;
    if (acc.flaggedChunks === 0) {
      cleanFiles += 1;
      continue;
    }
    const { chars, ...row } = acc;
    void chars;
    all.push({ ...row, ratioPercent: Math.round(ratio * 100) / 100 });
  }

  all.sort((a, b) => b.nonAsciiLetters - a.nonAsciiLetters);
  return {
    rows: all.slice(0, Math.max(1, limit)),
    total: all.length,
    filesScanned: byFile.size,
    cleanFiles
  };
}

// ── Doc mention targets (for git-grounded freshness) ───────────────────

/**
 * Every (document file, mentioned symbol, symbol file) triple with a RESOLVED symbol.
 *
 * `code_call` is excluded on the same ground MCP-ISSUE-049 settled for staleness: an identifier
 * scraped from inside a fenced sample is not the document describing that symbol, so a code sample
 * should not make a document look out of date.
 */
export function listDocMentionTargetsImpl(
  db: Database.Database,
  repoId: string,
  includeArchived = false
): { docFilePath: string; symbolName: string; symbolFilePath: string }[] {
  /**
   * MCP-ISSUE-061 Stage 6c: archived and superseded documents are excluded by default, matching
   * `mode:"search"`. Nothing under `docs/archive/` is maintained, so "44 days behind" there is
   * expected rather than actionable — and measured, it was 17 of 56 rows, 30% of a queue whose whole
   * purpose is to be read top-down.
   */
  const archiveFilter = includeArchived
    ? ""
    : `and d.file_path not in (select file_path from docs where repo_id = ? and doc_status in ('archived','superseded'))`;
  const params: string[] = includeArchived ? [repoId] : [repoId, repoId];

  return db
    .prepare(
      `
      select distinct d.file_path as docFilePath, s.name as symbolName, s.file_path as symbolFilePath
      from doc_mentions dm
      inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
      inner join symbols s on s.repo_id = dm.repo_id and s.symbol_id = dm.symbol_id
      where dm.repo_id = ? and dm.symbol_id is not null and dm.mention_type != 'code_call' ${archiveFilter}
      `
    )
    .all(...params) as { docFilePath: string; symbolName: string; symbolFilePath: string }[];
}

// ── Doc → doc link graph ───────────────────────────────────────────────

export type DocLinkReport = {
  linkCount: number;
  docFileCount: number;
  /**
   * TRUE totals, not page lengths.
   *
   * The first cut of this returned only the capped arrays, and the handler reported
   * `orphanCount: report.orphans.length` — the post-cap length presented as a total. With
   * `limit: 6` it answered "6 orphans" for a repo that has 33. That is exactly MCP-ISSUE-061(c),
   * the defect this whole entry filed against `mode:"coverage"`, reintroduced in the code written to
   * fix it. Caught by running the tool against the real index rather than a fixture.
   */
  brokenTotal: number;
  orphanTotal: number;
  /**
   * Targets that EXIST on disk but are absent from the index — almost always because the file
   * exceeds `CODEBASE_INDEX_MAX_FILE_SIZE_BYTES`, which rejects a whole file rather than truncating
   * it. Reported apart from `broken` because they are a different problem with a different fix, and
   * calling them broken is simply false.
   */
  unindexedTotal: number;
  unindexed: { fromFilePath: string; target: string }[];
  broken: { fromFilePath: string; target: string }[];
  orphans: string[];
  hubs: { filePath: string; inboundCount: number }[];
};

/**
 * `query_docs{ mode:"links" }` — MCP-ISSUE-061 Stage 3.
 *
 * Three questions a text search cannot answer, from one pass over the `doclink` mentions the parser
 * now emits: which links point at a document that is not there, which documents nothing points at,
 * and which documents everything points at.
 *
 * Paths are compared after normalizing the separator, because `docs.file_path` stores the platform's
 * (backslashes on Windows) while a resolved link is always forward-slashed. `findDocCoverageImpl`
 * already had to do this; the convention is the comparison, not the storage.
 *
 * An orphan is **not** a defect on its own — a README, a skill template or an entry point is
 * legitimately unlinked. It is a list to read, which is why it is returned rather than counted.
 */
export function findDocLinksImpl(
  db: Database.Database,
  repoId: string,
  limit = DOCS_PAGE_LIMIT
): DocLinkReport {
  const norm = `replace(d.file_path, char(92), '/')`;

  const links = db
    .prepare(
      `
      select distinct ${norm} as fromFilePath, dm.mention_text as target
      from doc_mentions dm
      inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
      where dm.repo_id = ? and dm.mention_type = 'doclink'
      `
    )
    .all(repoId) as { fromFilePath: string; target: string }[];

  const docFiles = db
    .prepare(`select distinct ${norm} as filePath from docs d where d.repo_id = ?`)
    .all(repoId) as { filePath: string }[];

  const known = new Set(docFiles.map((f) => f.filePath));
  const inbound = new Map<string, number>();
  const broken: { fromFilePath: string; target: string }[] = [];
  const unindexed: { fromFilePath: string; target: string }[] = [];

  /**
   * "Not in the index" is not the same claim as "not on disk", and this reported both as broken.
   *
   * Found on `wec.aria`: four links to `docs/15-decision-log.md` came back broken. The file is
   * there — it is 941 KB, over the 500 KB `CODEBASE_INDEX_MAX_FILE_SIZE_BYTES` ceiling, which
   * rejects a whole file rather than truncating it, so nothing about it reaches `docs`. Reporting
   * that as a broken link sends a reader to fix a link that is already correct, and hides the real
   * problem: the repository's most-linked document is invisible to every docs mode.
   *
   * The filesystem check runs only for targets already missing from the index, so the normal path
   * costs nothing.
   */
  const repoRow = db
    .prepare(`select repo_path as repoPath from repositories where repo_id = ? limit 1`)
    .get(repoId) as { repoPath: string } | undefined;
  const existsOnDisk = (target: string): boolean => {
    if (!repoRow) return false;
    try {
      return statSync(nodePath.join(repoRow.repoPath, target)).isFile();
    } catch {
      return false;
    }
  };

  for (const link of links) {
    if (link.target === link.fromFilePath) continue; // a self-link is not an edge
    if (known.has(link.target)) {
      inbound.set(link.target, (inbound.get(link.target) ?? 0) + 1);
    } else if (existsOnDisk(link.target)) {
      unindexed.push(link);
    } else {
      broken.push(link);
    }
  }

  const orphans = docFiles.map((f) => f.filePath).filter((f) => !inbound.has(f));
  const hubs = [...inbound.entries()]
    .map(([filePath, inboundCount]) => ({ filePath, inboundCount }))
    .sort((a, b) => b.inboundCount - a.inboundCount)
    .slice(0, 10);

  const cap = Math.max(1, limit);
  return {
    linkCount: links.length,
    docFileCount: docFiles.length,
    brokenTotal: broken.length,
    orphanTotal: orphans.length,
    unindexedTotal: unindexed.length,
    unindexed: unindexed.slice(0, cap),
    broken: broken.slice(0, cap),
    orphans: orphans.slice(0, cap),
    hubs
  };
}

// ── Find drifting docs ─────────────────────────────────────────────────

export type DriftRow = {
  mentionText: string;
  mentionType: string;
  docCount: number;
  docs: { docId: string; filePath: string; headingPath: string }[];
  nearestSymbol: { symbolId: string; name: string; kind: string; filePath: string } | null;
  similarity: number;
};

/**
 * `query_docs{ mode:"drift" }` — MCP-ISSUE-061 Stage 3.
 *
 * A doc naming an identifier the graph does not have is the central docs-first staleness signal, and
 * the data was already on disk: `resolveMentionsImpl` leaves a mention it cannot resolve in place
 * with `symbol_id = null`. Nothing ever read those rows back. (The registry entry for 061 says they
 * are "discarded" — they are not; they are stored and unread. Corrected here.)
 *
 * Reading them raw is useless, which is why this is not a one-line query. On `mcp-local` the most
 * common unresolved mentions are **MCP tool names** — `find_impact_files` 91 times, `health_check`
 * 79 — because a doc about a tool names the tool. So are shell flags, env vars, JSON keys and any
 * English word someone put in backticks. Reporting those as drift would bury the real signal.
 *
 * What a rename actually looks like is a NEAR MISS: the doc says `getUserById` and the graph has
 * `getUserByIdAsync`. So a mention is drift when no symbol carries its name and one carries a very
 * similar name. `minSimilarity` is the dial; at 1.0 nothing qualifies (that is an exact match, which
 * would have resolved), and below ~0.7 unrelated identifiers start pairing up.
 *
 * `code_call` mentions are excluded by default for the reason MCP-ISSUE-049 settled: an identifier
 * scraped from inside a fenced sample is not the document asserting anything about that symbol.
 */
export function findDriftingDocsImpl(
  db: Database.Database,
  repoId: string,
  minSimilarity = 0.75,
  limit = DOCS_PAGE_LIMIT,
  includeCodeMentions = false
): { rows: DriftRow[]; total: number; scanned: number } {
  const typeFilter = includeCodeMentions ? "" : "and dm.mention_type != 'code_call'";

  const unresolved = db
    .prepare(
      `
      select dm.mention_text as mentionText, dm.mention_type as mentionType,
             count(distinct dm.doc_id) as docCount
      from doc_mentions dm
      where dm.repo_id = ? and dm.symbol_id is null and length(dm.mention_text) >= 4 ${typeFilter}
      group by dm.mention_text, dm.mention_type
      order by docCount desc
      `
    )
    .all(repoId) as { mentionText: string; mentionType: string; docCount: number }[];

  if (unresolved.length === 0) return { rows: [], total: 0, scanned: 0 };

  const symbols = db
    .prepare(`select symbol_id as symbolId, name, kind, file_path as filePath from symbols where repo_id = ? and kind != 'module'`)
    .all(repoId) as { symbolId: string; name: string; kind: string; filePath: string }[];

  // Bucket by first character so each mention compares against a slice, not the whole symbol table.
  // Levenshtein over every (mention, symbol) pair on a large repo is the difference between a tool
  // that answers and one that times out.
  const byFirstChar = new Map<string, typeof symbols>();
  for (const sym of symbols) {
    const key = sym.name.charAt(0).toLowerCase();
    const bucket = byFirstChar.get(key);
    if (bucket) bucket.push(sym);
    else byFirstChar.set(key, [sym]);
  }

  /**
   * The SAME `typeFilter` as the count above.
   *
   * It was missing here, so `docCount` excluded `code_call` mentions while the `docs` array beside
   * it did not — `execute_routine` reported `docCount: 4` and then listed six citations. Worse than
   * inconsistent: `code_call` is an identifier scraped from inside a fenced sample, which
   * MCP-ISSUE-049 settled is NOT the document asserting anything about that symbol, so the evidence
   * list was padded with exactly the rows this mode's own rule rejects. A count and the list beside
   * it have to describe the same thing.
   */
  const docsFor = db.prepare(
    `
    select distinct d.doc_id as docId, d.file_path as filePath, d.heading_path as headingPath
    from doc_mentions dm
    inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
    where dm.repo_id = ? and dm.mention_text = ? and dm.symbol_id is null ${typeFilter}
    limit 10
    `
  );

  /**
   * `find_implementations` vs `findImplementations` is the SAME name in two conventions — an MCP
   * tool and the function behind it — not a rename. It scores 0.95 and was the single most common
   * result before this guard, 17 documents deep. Collapsing separators and case before comparing
   * removes that whole class, which is the difference between a drift report worth reading and a
   * list of naming conventions.
   */
  const conventionKey = (name: string) => name.replace(/[_-]/g, "").toLowerCase();
  /**
   * …and `contentTypes` vs `contentType`, or `sourceFiles` vs `sourceFile`, is a plural, which is how
   * a doc refers to a collection of a thing that exists. Also not drift. Stripping a trailing `s`
   * on top of the convention key removed three of the five highest-scoring rows on this repo.
   */
  const stem = (name: string) => conventionKey(name).replace(/s$/, "");

  const rows: DriftRow[] = [];
  for (const m of unresolved) {
    const bucket = byFirstChar.get(m.mentionText.charAt(0).toLowerCase()) ?? [];
    const mentionStem = stem(m.mentionText);
    let best: (typeof symbols)[number] | null = null;
    let bestScore = 0;
    for (const sym of bucket) {
      if (stem(sym.name) === mentionStem) {
        // Same identifier, different casing/separators. Not drift — and not a candidate either,
        // because a closer-but-genuinely-different name should not win by default.
        best = null;
        bestScore = 0;
        break;
      }
      const score = stringSimilarity(m.mentionText, sym.name);
      // 1.0 would mean an exact match, which `resolveMentions` would already have linked.
      if (score > bestScore && score < 1) {
        bestScore = score;
        best = sym;
      }
    }
    if (!best || bestScore < minSimilarity) continue;

    const docs = docsFor.all(repoId, m.mentionText) as { docId: string; filePath: string; headingPath: string }[];
    // A mention whose doc rows have been pruned cannot be cited, and an uncitable finding is not
    // one worth reporting.
    if (docs.length === 0) continue;

    rows.push({
      mentionText: m.mentionText,
      mentionType: m.mentionType,
      docCount: m.docCount,
      docs,
      nearestSymbol: { symbolId: best.symbolId, name: best.name, kind: best.kind, filePath: best.filePath },
      similarity: Math.round(bestScore * 100) / 100
    });
  }

  rows.sort((a, b) => b.similarity - a.similarity || b.docCount - a.docCount);
  return { rows: rows.slice(0, Math.max(1, limit)), total: rows.length, scanned: unresolved.length };
}

// ── String similarity helpers (used by resolveMentions) ────────────────

export function stringSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower === bLower) return 1.0;

  const longer = aLower.length > bLower.length ? aLower : bLower;
  const shorter = longer === aLower ? bLower : aLower;

  if (longer.length === 0) return 1.0;
  if (shorter.length === 0) return 0.0;

  const dist = levenshteinDistance(aLower, bLower);
  return 1.0 - dist / longer.length;
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}
