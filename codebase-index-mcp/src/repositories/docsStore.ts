import type Database from "better-sqlite3";
import type { DocRecord, DocMentionRecord } from "../types.js";
import { indexLog, indexWarn } from "../indexing/indexProgress.js";

// ── Docs CRUD ──────────────────────────────────────────────────────────

export function upsertDocsImpl(db: Database.Database, docs: DocRecord[]): void {
  const stmt = db.prepare(
    `
    insert into docs (repo_id, doc_id, file_path, heading_path, content_type, text, level)
    values (@repoId, @docId, @filePath, @headingPath, @contentType, @text, @level)
    on conflict(repo_id, doc_id) do update set
      text = excluded.text,
      level = excluded.level
    `
  );

  const writeRows = (rows: DocRecord[]) => {
    for (const row of rows) {
      const normalized = { ...row, level: row.level ?? undefined };
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

    if (mention.mention_type === "backtick") {
      const lower = mention.mention_text.toLowerCase();
      resolvedSymbolId =
        nameMap.get(mention.mention_text) ??
        nameLowerMap.get(lower) ??
        nameSuffixMap.get(lower) ??
        namePrefixMap.get(lower);
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

export function searchDocsImpl(
  db: Database.Database,
  repoId: string,
  query: string,
  limit: number,
  buildFtsQuery: (q: string) => string,
  buildIntentFtsQuery: (q: string) => string
): {
  docId: string;
  filePath: string;
  headingPath: string;
  contentType: string;
  text: string | null;
  level: number | null;
  resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
}[] {
  const ftsQuery = buildFtsQuery(query);
  let docIds: string[] = [];
  let usedFts = false;
  const desiredLimit = Math.max(1, limit);

  try {
    db.prepare("select * from docs_fts limit 0").all();
    const ftsRows = db
      .prepare(
        `
        select docs_fts.doc_id as docId
        from docs_fts
        inner join docs on docs.doc_id = docs_fts.doc_id and docs.repo_id = ?
        where docs_fts match ?
        order by rank
        limit ?
        `
      )
      .all(repoId, ftsQuery, desiredLimit) as { docId: string }[];
    docIds = ftsRows.map((r) => r.docId);
    usedFts = true;
  } catch {
    // FTS unavailable
  }

  if (!usedFts || docIds.length === 0) {
    const likeRows = db
      .prepare(
        `select doc_id as docId from docs where repo_id = ? and text like ? order by rowid limit ?`
      )
      .all(repoId, `%${query}%`, desiredLimit) as { docId: string }[];
    docIds = likeRows.map((r) => r.docId);
  }

  const docResults: {
    docId: string;
    filePath: string;
    headingPath: string;
    contentType: string;
    text: string | null;
    level: number | null;
    resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
  }[] = [];

  if (docIds.length > 0) {
    const ph = docIds.map(() => "?").join(",");
    const docs = db
      .prepare(
        `select doc_id as docId, file_path as filePath, heading_path as headingPath,
                content_type as contentType, text, level
         from docs where repo_id = ? and doc_id in (${ph})`
      )
      .all(repoId, ...docIds) as {
      docId: string;
      filePath: string;
      headingPath: string;
      contentType: string;
      text: string | null;
      level: number | null;
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

  if (docResults.length < desiredLimit) {
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
          where symbols_fts match ?
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

export function findStaleDocsImpl(
  db: Database.Database,
  repoId: string,
  symbolIds: string[]
): {
  docId: string;
  filePath: string;
  headingPath: string;
  text: string | null;
  mentionText: string;
  symbolName: string | null;
}[] {
  if (symbolIds.length === 0) return [];
  const ph = symbolIds.map(() => "?").join(",");
  return db
    .prepare(
      `
      select dm.doc_id as docId, d.file_path as filePath, d.heading_path as headingPath,
             d.text, dm.mention_text as mentionText, s.name as symbolName
      from doc_mentions dm
      inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
      left join symbols s on s.repo_id = dm.repo_id and s.symbol_id = dm.symbol_id
      where dm.repo_id = ? and dm.symbol_id in (${ph})
      order by d.file_path, d.heading_path
      limit 200
      `
    )
    .all(repoId, ...symbolIds) as {
    docId: string;
    filePath: string;
    headingPath: string;
    text: string | null;
    mentionText: string;
    symbolName: string | null;
  }[];
}

// ── Find doc coverage ──────────────────────────────────────────────────

export function findDocCoverageImpl(
  db: Database.Database,
  repoId: string,
  filePath: string
): {
  symbolId: string;
  name: string;
  kind: string;
  line: number;
  signature: string | null;
  hasDocs: boolean;
  mentionCount: number;
}[] {
  return db
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
      where s.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/') and s.kind != 'module'
      group by s.symbol_id, s.name, s.kind, s.line, s.signature
      order by s.line
      limit 200
      `
    )
    .all(repoId, filePath) as {
    symbolId: string;
    name: string;
    kind: string;
    line: number;
    signature: string | null;
    hasDocs: boolean;
    mentionCount: number;
  }[];
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
