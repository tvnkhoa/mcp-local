/**
 * Release J: what a scoped run (`dirty` / `incremental`) needs from the store to land on exactly the
 * graph a full run would build from the same tree (MCP-ISSUE-085).
 *
 * The problem it answers: a resolver overwrites an edge's `callee:` / `type:` / `import:` … token with
 * the target's id, so once resolved, an edge in an unchanged file can never be re-decided — and only
 * re-deciding it gives a full run's answer when another file adds, removes or moves a same-named
 * declaration (a second `foo` makes `foo` ambiguous; a shifted row re-mints an id). A scoped run
 * therefore re-EXTRACTS the files whose resolution can change, which gives their tokens back:
 *
 *   - K: the names of the symbols a changed file added, removed or altered — every column a resolver
 *     reads off a symbol is in the row key, so an identical row cannot change anyone's resolution;
 *   - path keys: the basename of a file that appeared or disappeared (and its directory for an
 *     `index.*`), for the module resolver;
 *   - a dependent is a file with an edge into a symbol named in K, or a token with a part in K or in
 *     the path keys. Edges into a vanished id are `findDanglingEdgeSourceFiles`' job.
 *
 * And it keeps the derived full-text indexes in step per file instead of rebuilding them, which today
 * re-reads every repo in the shared DB.
 */

import type Database from "better-sqlite3";

/** `path → (row key → name)` for the indexed symbols of each file. */
export type SymbolRowsByFile = Map<string, Map<string, string>>;

export function symbolRowKeysForFiles(db: Database.Database, repoId: string, filePaths: readonly string[]): SymbolRowsByFile {
  const out: SymbolRowsByFile = new Map(filePaths.map((p) => [p, new Map<string, string>()]));
  if (filePaths.length === 0) return out;
  const rows = db
    .prepare(
      `select file_path as filePath, symbol_id as symbolId, kind, name, parent_symbol_id as parentSymbolId, signature, line
       from symbols where repo_id = ? and file_path in (select value from json_each(?))`
    )
    .all(repoId, JSON.stringify(filePaths)) as SymbolRowShape[];
  for (const r of rows) out.get(r.filePath)?.set(symbolRowKey(r), r.name);
  return out;
}

export type SymbolRowShape = {
  filePath: string;
  symbolId: string;
  kind: string;
  name: string;
  parentSymbolId?: string | null;
  signature?: string | null;
  line?: number | null;
};

/** Everything a resolver reads off a symbol row (id, kind, name, file, parent, signature, line). */
export function symbolRowKey(r: SymbolRowShape): string {
  return [r.symbolId, r.kind, r.name, r.filePath, r.parentSymbolId ?? "", r.signature ?? "", String(r.line ?? "")].join("\u0001");
}

/** Names of the rows present on one side only: what K gains from one file's before/after. */
export function changedSymbolNames(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const names: string[] = [];
  for (const [key, name] of before) if (!after.has(key)) names.push(name);
  for (const [key, name] of after) if (!before.has(key)) names.push(name);
  return names;
}

/** The module-resolution keys of a file that appeared or disappeared: its basename, and its directory for an index file. */
export function pathKeysFor(filePath: string): string[] {
  const segments = filePath.split("/");
  const base = (segments[segments.length - 1] ?? "").replace(/\.[^.]+$/, "");
  const keys = base ? [base] : [];
  if (base === "index" && segments.length > 1) keys.push(segments[segments.length - 2]!);
  return keys;
}

/** The parts of a token a name or path key can match: `callee:A.B.Foo` → A, B, Foo; `import:./x/y.js` → x, y, js. */
export function tokenParts(toId: string): string[] {
  const colon = toId.indexOf(":");
  return toId.slice(colon + 1).split(/[.\/\\#:<>(),\s]+/).filter((p) => p.length > 0);
}

/**
 * Files (other than `exclude`) whose resolution can change because of `names` or `pathKeys`: a resolved
 * edge into a symbol so named, or a token with a part among either set. Over-approximating is safe —
 * re-extracting an unchanged file reproduces its own rows exactly.
 */
export function findNameDependentFiles(
  db: Database.Database,
  repoId: string,
  names: ReadonlySet<string>,
  pathKeys: ReadonlySet<string>,
  exclude: ReadonlySet<string>
): string[] {
  if (names.size === 0 && pathKeys.size === 0) return [];
  const found = new Set<string>();
  if (names.size > 0) {
    const resolved = db
      .prepare(
        `select distinct src.file_path as filePath
         from symbols dst
         join edges e on e.repo_id = dst.repo_id and e.to_id = dst.symbol_id
         join symbols src on src.repo_id = e.repo_id and src.symbol_id = e.from_id
         where dst.repo_id = ? and dst.name in (select value from json_each(?))`
      )
      .all(repoId, JSON.stringify([...names])) as { filePath: string }[];
    for (const r of resolved) found.add(r.filePath);
  }
  const tokens = db
    .prepare(
      `select src.file_path as filePath, e.to_id as toId
       from edges e
       join symbols src on src.repo_id = e.repo_id and src.symbol_id = e.from_id
       where e.repo_id = ? and e.to_id like '%:%'`
    )
    .iterate(repoId) as Iterable<{ filePath: string; toId: string }>;
  for (const t of tokens) {
    if (found.has(t.filePath)) continue;
    if (tokenParts(t.toId).some((p) => names.has(p) || pathKeys.has(p))) found.add(t.filePath);
  }
  for (const p of exclude) found.delete(p);
  return [...found].sort();
}

/**
 * The external-content FTS tables and the rows of one file in each. FTS5 removes a row only when told
 * the exact values it indexed, so `forget` must run while the content rows still hold them — before the
 * file's rows are replaced or pruned — and `index` after the new rows are in.
 */
const FTS_BY_FILE = [
  { fts: "symbols_fts", table: "symbols", cols: "name, signature, symbol_id, repo_id" },
  { fts: "literals_fts", table: "string_literals", cols: "value, literal_id, repo_id" },
  { fts: "comments_fts", table: "code_comments", cols: "text" },
  { fts: "docs_fts", table: "docs", cols: "text, doc_id, repo_id" }
] as const;

export function ftsForgetFile(db: Database.Database, repoId: string, filePath: string): void {
  for (const t of FTS_BY_FILE) {
    db.prepare(
      `insert into ${t.fts}(${t.fts}, rowid, ${t.cols}) select 'delete', rowid, ${t.cols} from ${t.table} where repo_id = ? and file_path = ?`
    ).run(repoId, filePath);
  }
}

export function ftsIndexFile(db: Database.Database, repoId: string, filePath: string): void {
  for (const t of FTS_BY_FILE) {
    db.prepare(`insert into ${t.fts}(rowid, ${t.cols}) select rowid, ${t.cols} from ${t.table} where repo_id = ? and file_path = ?`).run(
      repoId,
      filePath
    );
  }
}

/** FTS5's own consistency check of every external-content table against its content; throws on a mismatch. */
export function ftsIntegrityCheck(db: Database.Database): void {
  for (const t of FTS_BY_FILE) db.prepare(`insert into ${t.fts}(${t.fts}) values('integrity-check')`).run();
}

/**
 * Doc mentions are resolved by name, lower-case name, prefix, suffix and file path, and a resolved row
 * keeps its `symbol_id` (resolveMentions only revisits null rows) — the same lossiness as call edges, but
 * with keys K cannot bound. Extraction always writes them null, so nulling every row and resolving the
 * whole repo again is exactly what a full run computes.
 */
export function resetMentionResolution(db: Database.Database, repoId: string): number {
  return db.prepare(`update doc_mentions set symbol_id = null where repo_id = ? and symbol_id is not null`).run(repoId).changes;
}
