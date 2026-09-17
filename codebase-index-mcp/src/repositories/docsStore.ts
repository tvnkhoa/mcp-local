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
  includeArchived = false
): {
  docId: string;
  filePath: string;
  headingPath: string;
  contentType: string;
  text: string | null;
  level: number | null;
  startLine: number | null;
  endLine: number | null;
  resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
}[] {
  const ftsQuery = buildFtsQuery(query);
  let docIds: string[] = [];
  let usedFts = false;
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

  try {
    db.prepare("select * from docs_fts limit 0").all();
    const ftsRows = db
      .prepare(
        `
        select docs_fts.doc_id as docId
        from docs_fts
        inner join docs on docs.doc_id = docs_fts.doc_id and docs.repo_id = ?
        where docs_fts match ? and docs.content_type in (${typePlaceholders}) ${archiveFilter}
        order by rank
        limit ?
        `
      )
      .all(repoId, ftsQuery, ...allowedTypes, ...archiveParams, desiredLimit) as { docId: string }[];
    docIds = ftsRows.map((r) => r.docId);
    usedFts = true;
  } catch {
    // FTS unavailable
  }

  if (!usedFts || docIds.length === 0) {
    const likeRows = db
      .prepare(
        `select doc_id as docId from docs where repo_id = ? and text like ? and content_type in (${typePlaceholders}) ${archiveFilter} order by rowid limit ?`
      )
      .all(repoId, `%${query}%`, ...allowedTypes, ...archiveParams, desiredLimit) as { docId: string }[];
    docIds = likeRows.map((r) => r.docId);
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

    const orderMap = new Map(docIds.map((id, i) => [id, i]));
    docResults.push(
      ...docs
        .sort((a, b) => (orderMap.get(a.docId) ?? 99) - (orderMap.get(b.docId) ?? 99))
        .map((doc) => ({ ...doc, resolvedMentions: mentionsByDoc.get(doc.docId) ?? [] }))
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
  repoId: string
): { docFilePath: string; symbolName: string; symbolFilePath: string }[] {
  return db
    .prepare(
      `
      select distinct d.file_path as docFilePath, s.name as symbolName, s.file_path as symbolFilePath
      from doc_mentions dm
      inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
      inner join symbols s on s.repo_id = dm.repo_id and s.symbol_id = dm.symbol_id
      where dm.repo_id = ? and dm.symbol_id is not null and dm.mention_type != 'code_call'
      `
    )
    .all(repoId) as { docFilePath: string; symbolName: string; symbolFilePath: string }[];
}

// ── Doc → doc link graph ───────────────────────────────────────────────

export type DocLinkReport = {
  linkCount: number;
  docFileCount: number;
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

  for (const link of links) {
    if (link.target === link.fromFilePath) continue; // a self-link is not an edge
    if (known.has(link.target)) {
      inbound.set(link.target, (inbound.get(link.target) ?? 0) + 1);
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

  const docsFor = db.prepare(
    `
    select distinct d.doc_id as docId, d.file_path as filePath, d.heading_path as headingPath
    from doc_mentions dm
    inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
    where dm.repo_id = ? and dm.mention_text = ? and dm.symbol_id is null
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
