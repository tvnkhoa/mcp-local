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

/** The symbol id a {@link symbolRowKey} starts with. */
export function symbolIdOfRowKey(key: string): string {
  const cut = key.indexOf("\u0001");
  return cut < 0 ? key : key.slice(0, cut);
}

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

/** Release K3: the name-bound lanes whose post-phase pass a scoped run may skip (see `ScopeInputs`). */
export type LaneFlags = { sql: boolean; css: boolean };

const SQL_FILE = /\.sql$/i;
const CSS_FILE = /\.(css|scss|sass|less)$/i;
const CSS_EDGE_TYPES = new Set(["USES_CSS_VAR", "USES_CSS_CLASS"]);
const CSS_SYMBOL_KINDS = new Set(["css_variable", "css_class"]);

/** What `paths` hold NOW in the index: SQL or CSS edges from their symbols, or SQL / CSS symbols. */
export function laneRowsForFiles(db: Database.Database, repoId: string, paths: readonly string[]): LaneFlags {
  const flags: LaneFlags = {
    sql: paths.some((p) => SQL_FILE.test(p)),
    css: paths.some((p) => CSS_FILE.test(p))
  };
  if (paths.length === 0 || (flags.sql && flags.css)) return flags;
  const json = JSON.stringify(paths);
  const row = db
    .prepare(
      `select
         exists(select 1 from symbols s join edges e on e.repo_id = s.repo_id and e.from_id = s.symbol_id
                where s.repo_id = ? and s.file_path in (select value from json_each(?)) and e.type like 'SQL\\_%' escape '\\') as sqlEdge,
         exists(select 1 from symbols where repo_id = ? and file_path in (select value from json_each(?)) and kind like 'sql\\_%' escape '\\') as sqlSymbol,
         exists(select 1 from symbols s join edges e on e.repo_id = s.repo_id and e.from_id = s.symbol_id
                where s.repo_id = ? and s.file_path in (select value from json_each(?)) and e.type in ('USES_CSS_VAR', 'USES_CSS_CLASS')) as cssEdge,
         exists(select 1 from symbols where repo_id = ? and file_path in (select value from json_each(?)) and kind in ('css_variable', 'css_class')) as cssSymbol`
    )
    .get(repoId, json, repoId, json, repoId, json, repoId, json) as { sqlEdge: number; sqlSymbol: number; cssEdge: number; cssSymbol: number };
  return { sql: flags.sql || row.sqlEdge === 1 || row.sqlSymbol === 1, css: flags.css || row.cssEdge === 1 || row.cssSymbol === 1 };
}

/** The same question of a file's freshly extracted rows (the "has, after the write" side). */
export function laneRowsOfExtraction(
  filePath: string,
  symbols: readonly { kind: string }[],
  edges: readonly { type: string }[]
): LaneFlags {
  return {
    sql: SQL_FILE.test(filePath) || symbols.some((x) => x.kind.startsWith("sql_")) || edges.some((e) => e.type.startsWith("SQL_")),
    css: CSS_FILE.test(filePath) || symbols.some((x) => CSS_SYMBOL_KINDS.has(x.kind)) || edges.some((e) => CSS_EDGE_TYPES.has(e.type))
  };
}

/**
 * The token parts of every `sqlconst:<specifier>#<name>` anchor (MCP-ISSUE-082 I4): still a token, or bound
 * with the token kept in its reason. The SQL pass follows an anchor through the module its specifier
 * names (and one barrel hop), so a file whose path keys or symbol names meet these parts can change a
 * binding without holding a SQL row itself.
 */
export function sqlAnchorTokenParts(db: Database.Database, repoId: string): Set<string> {
  const parts = new Set<string>();
  const rows = db
    .prepare(
      `select to_id as toId, reason from edges
       where repo_id = ? and type = 'SQL_QUERY' and (to_id like 'sqlconst:%' or reason like '%sqlconst:%')`
    )
    .all(repoId) as { toId: string; reason: string | null }[];
  for (const r of rows) {
    const token = r.toId.startsWith("sqlconst:") ? r.toId : /sqlconst:\S+/.exec(r.reason ?? "")?.[0];
    if (token) for (const p of tokenParts(token)) parts.add(p);
  }
  return parts;
}

/**
 * Release K3 (b) / K4: on a scoped run, unbind only the BOUND mentions whose answer can have changed;
 * unbound and ambiguous rows are re-decided by every `resolveMentions` anyway. A bound mention can
 * change when its target was one of the re-extracted or removed files' symbols (`oldIds`, re-minted ids
 * included), when its text meets a changed name in any form the resolver keys on (exact, lower-case, a
 * dotted name's last segment or leading part), or — a filepath mention — when a file with one of its
 * path keys appeared or vanished. Returns how many rows were unbound.
 */
export function mentionNameForms(names: readonly string[]): Set<string> {
  const forms = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    forms.add(lower);
    const dot = lower.lastIndexOf(".");
    if (dot >= 0) {
      forms.add(lower.slice(dot + 1));
      forms.add(lower.slice(0, dot));
    }
  }
  return forms;
}

export function resetMentionsForScope(
  db: Database.Database,
  repoId: string,
  scope: { names: readonly string[]; oldIds: readonly string[]; pathKeys: readonly string[] }
): Set<string> {
  const forms = mentionNameForms(scope.names);
  const oldIds = new Set(scope.oldIds);
  const pathKeys = new Set(scope.pathKeys.map((k) => k.toLowerCase()));
  if (forms.size === 0 && oldIds.size === 0 && pathKeys.size === 0) return new Set();
  // Narrowed in SQL (an unchanged refresh used to read every bound row); filepath rows are checked below.
  const bound = db
    .prepare(
      `select doc_id as docId, mention_type as type, mention_text as text, symbol_id as symbolId from doc_mentions
       where repo_id = ? and symbol_id is not null
         and (symbol_id in (select value from json_each(?)) or lower(mention_text) in (select value from json_each(?))${pathKeys.size > 0 ? " or mention_type = 'filepath'" : ""})`
    )
    .all(repoId, JSON.stringify([...oldIds]), JSON.stringify([...forms])) as { docId: string; type: string; text: string; symbolId: string }[];
  const unbind = db.prepare(
    `update or replace doc_mentions set symbol_id = null where repo_id = ? and doc_id = ? and mention_type = ? and mention_text = ? and symbol_id = ?`
  );
  const reset = new Set<string>();
  const tx = db.transaction(() => {
    for (const m of bound) {
      const hit =
        oldIds.has(m.symbolId) ||
        ((m.type === "backtick" || m.type === "code_call") && forms.has(m.text.toLowerCase())) ||
        (m.type === "filepath" && pathKeysFor(m.text.replace(/\\/g, "/")).some((k) => pathKeys.has(k.toLowerCase())));
      if (!hit) continue;
      unbind.run(repoId, m.docId, m.type, m.text, m.symbolId);
      reset.add(`${m.docId}\u0001${m.type}\u0001${m.text}`);
    }
  });
  tx();
  return reset;
}
