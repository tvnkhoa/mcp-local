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

/** A {@link symbolRowKey} read back into its columns. */
export function parseSymbolRowKey(key: string): SymbolRowShape & { line: number | null } {
  const [symbolId = "", kind = "", name = "", filePath = "", parent = "", signature = "", line = ""] = key.split("\u0001");
  return { symbolId, kind, name, filePath, parentSymbolId: parent || null, signature: signature || null, line: line === "" ? null : Number(line) };
}

/** A declaration an edit only moved: same parent chain, kind, name and signature, new row, so a new id. */
export type ShiftedSymbol = { oldId: string; newId: string; name: string };

export type SymbolShift = {
  /** Every declaration that kept its identity, including those whose id did not change. */
  pairs: ShiftedSymbol[];
  /** Guard (b): the paired declarations keep their (line, id) order within the file. */
  orderKept: boolean;
  /** The rows of each side no pair accounts for — what K is computed from, as before. */
  unpairedBefore: Map<string, string>;
  unpairedAfter: Map<string, string>;
};

/**
 * MCP-ISSUE-101 part 3: pair one file's symbol rows before and after an edit that only moved them.
 *
 * A row's logical key is its parent chain plus its own kind, name and signature; equal keys pair in
 * (line, id) order. Two equal keys on one line, a different count on each side, or a parent that does
 * not map to the pair's parent leave the rows unpaired (they stay in K). Everything a resolver reads
 * off a paired row is then unchanged except the id and the line. The caller re-points the old ids, and
 * under guards (a) and (b) the row needs no dependent re-extracted.
 */
export function pairShiftedSymbols(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): SymbolShift {
  const parse = (rows: ReadonlyMap<string, string>) => [...rows.keys()].map((key) => ({ key, ...parseSymbolRowKey(key) }));
  type Row = ReturnType<typeof parse>[number];
  const logicalKeys = (rows: Row[]): Map<string, string | null> => {
    const byId = new Map(rows.map((r) => [r.symbolId, r]));
    const memo = new Map<string, string | null>();
    const keyOf = (r: Row, depth: number): string | null => {
      const known = memo.get(r.symbolId);
      if (known !== undefined) return known;
      let parentKey = "";
      if (r.parentSymbolId) {
        const parent = byId.get(r.parentSymbolId);
        parentKey = parent && depth < 64 ? (keyOf(parent, depth + 1) ?? "\u0000") : "\u0000";
      }
      const k = parentKey.includes("\u0000") ? null : `${parentKey}\u0002${r.kind}\u0001${r.name}\u0001${r.signature ?? ""}`;
      memo.set(r.symbolId, k);
      return k;
    };
    for (const r of rows) keyOf(r, 0);
    return memo;
  };
  const groups = (rows: Row[]): Map<string, Row[]> => {
    const lk = logicalKeys(rows);
    const out = new Map<string, Row[]>();
    for (const r of rows) {
      const k = lk.get(r.symbolId);
      if (k == null) continue;
      const g = out.get(k) ?? [];
      g.push(r);
      out.set(k, g);
    }
    for (const g of out.values()) g.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0));
    return out;
  };
  const beforeRows = parse(before);
  const afterRows = parse(after);
  const beforeGroups = groups(beforeRows);
  const afterGroups = groups(afterRows);
  const sameLine = (g: Row[]): boolean => g.some((r, i) => i > 0 && r.line === g[i - 1]!.line);

  let pairs: Array<{ o: Row; n: Row }> = [];
  for (const [k, og] of beforeGroups) {
    const ng = afterGroups.get(k);
    if (!ng || ng.length !== og.length || sameLine(og) || sameLine(ng)) continue;
    og.forEach((o, i) => pairs.push({ o, n: ng[i]! }));
  }
  // A child pairs only if its parent pairs with the new row's parent; dropping a parent can drop its children.
  for (let changed = true; changed; ) {
    const map = new Map(pairs.map((p) => [p.o.symbolId, p.n.symbolId]));
    const kept = pairs.filter((p) => (p.o.parentSymbolId ? map.get(p.o.parentSymbolId) === p.n.parentSymbolId : !p.n.parentSymbolId));
    changed = kept.length !== pairs.length;
    pairs = kept;
  }

  // Guard (b): within one file, resolvers take the first in (line, id) order among the same name
  // (EF members, overrides, the canonical (file_path, line, id) lists) and among a file's component /
  // module symbols (the component owner). Different names on one line may swap ids freely.
  const orderGroups = new Map<string, Array<{ o: Row; n: Row }>>();
  for (const p of pairs) {
    for (const g of [`name:${p.o.name}`, ...(p.o.kind === "component" || p.o.kind === "module" ? ["kind:owner"] : [])]) {
      const list = orderGroups.get(g) ?? [];
      list.push(p);
      orderGroups.set(g, list);
    }
  }
  const lineIdLess = (x: Row, y: Row): boolean => (x.line ?? 0) < (y.line ?? 0) || ((x.line ?? 0) === (y.line ?? 0) && x.symbolId < y.symbolId);
  const orderKept = [...orderGroups.values()].every((group) => {
    const byOld = [...group].sort((x, y) => (lineIdLess(x.o, y.o) ? -1 : 1));
    return byOld.every((p, i) => i === 0 || lineIdLess(byOld[i - 1]!.n, p.n));
  });

  const pairedOld = new Set(pairs.map((p) => p.o.key));
  const pairedNew = new Set(pairs.map((p) => p.n.key));
  return {
    pairs: pairs.map((p) => ({ oldId: p.o.symbolId, newId: p.n.symbolId, name: p.o.name })),
    orderKept,
    unpairedBefore: new Map([...before].filter(([k]) => !pairedOld.has(k))),
    unpairedAfter: new Map([...after].filter(([k]) => !pairedNew.has(k)))
  };
}

/**
 * Guard (a): resolvers keep the first of several equal candidates in `symbol_id` order
 * (`pickBestNamedCandidate`'s tie-break, the first-row lookups by name), so a re-minted id that moves
 * past another same-named symbol's id can change a full run's answer — and does: wec.aria's
 * `usage-period.ts` `get` against `theme.ts` `get` decides 199 "by name (ambiguous)" calls. A tie is only
 * possible within one kind family: the pick ranks each allowed kind apart, and the first-row lookups span
 * the type kinds (class, struct, record, interface, type).
 *
 * Returns the ids (as they are now) whose incoming resolved edges can change: a shifted symbol whose order
 * against some same-family namesake flipped, and that namesake. An edge into any other candidate keeps its
 * winner — the winner's order against every rival is unchanged. Unresolved tokens are not at risk: the
 * candidate sets are unchanged, so order cannot turn "no pick" into a pick. `freshIds` are the written
 * files' ids now; one that no pair accounts for is skipped (its name is in K already).
 */
const TYPE_KIND_FAMILY = new Set(["class", "struct", "record", "record struct", "interface", "type"]);

export function idsAtRiskFromIdOrder(
  db: Database.Database,
  repoId: string,
  shifted: readonly ShiftedSymbol[],
  freshIds: ReadonlySet<string>
): Set<string> {
  const oldOf = new Map(shifted.map((s) => [s.newId, s.oldId]));
  const names = [...new Set(shifted.map((s) => s.name))];
  const atRisk = new Set<string>();
  if (names.length === 0) return atRisk;
  const rows = db
    .prepare(`select name, kind, symbol_id as symbolId from symbols where repo_id = ? and name in (select value from json_each(?))`)
    .all(repoId, JSON.stringify(names)) as { name: string; kind: string; symbolId: string }[];
  const byGroup = new Map<string, string[]>();
  for (const r of rows) {
    if (freshIds.has(r.symbolId) && !oldOf.has(r.symbolId)) continue;
    const key = `${r.name}:${TYPE_KIND_FAMILY.has(r.kind) ? "type" : r.kind}`;
    const g = byGroup.get(key) ?? [];
    g.push(r.symbolId);
    byGroup.set(key, g);
  }
  for (const ids of byGroup.values()) {
    for (const s of ids) {
      const sOld = oldOf.get(s);
      if (sOld === undefined) continue;
      for (const t of ids) {
        if (t === s) continue;
        const tOld = oldOf.get(t) ?? t;
        if (tOld < sOld !== t < s) {
          atRisk.add(s);
          atRisk.add(t);
        }
      }
    }
  }
  return atRisk;
}

/** Files (other than `exclude`) holding a resolved edge into one of `ids`. */
export function findFilesWithEdgesInto(db: Database.Database, repoId: string, ids: ReadonlySet<string>, exclude: ReadonlySet<string>): string[] {
  if (ids.size === 0) return [];
  const rows = db
    .prepare(
      `select distinct src.file_path as filePath from edges e
       join symbols src on src.repo_id = e.repo_id and src.symbol_id = e.from_id
       where e.repo_id = ? and e.to_id in (select value from json_each(?))`
    )
    .all(repoId, JSON.stringify([...ids])) as { filePath: string }[];
  return rows.map((r) => r.filePath).filter((p) => !exclude.has(p)).sort();
}

/**
 * Every column that can hold a symbol id, and what a shift does to it. `remapSymbolIds` re-points the
 * REMAPPED ones; an EXEMPT column needs no re-point, for the reason given. `scopedRunStore.test.ts`
 * fails on a symbol-id column of the schema that is in neither list, so a new table cannot miss it.
 */
export const SYMBOL_ID_COLUMNS_REMAPPED = [
  "edges.to_id",
  "edges.from_id",
  "symbols.parent_symbol_id",
  "routes.controller_symbol_id",
  "routes.handler_symbol_id",
  "string_literals.enclosing_symbol_id",
  "cross_repo_deps.from_symbol_id",
  "cross_repo_deps.to_symbol_id",
  "doc_mentions.candidate_ids"
] as const;

export const SYMBOL_ID_COLUMNS_EXEMPT: Readonly<Record<string, string>> = {
  "symbols.symbol_id": "the id itself: the written file's rows were replaced with the new ids",
  "symbols_fts.symbol_id": "kept per file: ftsForgetFile / ftsIndexFile re-index the written file, and no other file's FTS row names its ids",
  "vec_symbol_map.symbol_id": "rebuildVectorIndex re-embeds the written files and sweeps map rows whose symbol is gone",
  "doc_mentions.symbol_id": "a scoped run unbinds every mention bound to a written file's old id (resetMentionsForScope, oldIds) and re-resolves it"
};

/**
 * Re-point every reference to a shifted symbol's old id at its new id, outside the written files, whose
 * rows already carry the new ids. One statement per column, through a temp map, so a swap (old A = new B)
 * is applied once per row. `cross_repo_deps` has a primary key, so it goes through a sentinel.
 */
export function remapSymbolIds(db: Database.Database, repoId: string, shifted: readonly ShiftedSymbol[], writtenPaths: readonly string[]): number {
  const moved = shifted.filter((s) => s.oldId !== s.newId);
  if (moved.length === 0) return 0;
  db.exec(`create temp table if not exists symbol_id_remap (old_id text primary key, new_id text not null)`);
  db.exec(`delete from symbol_id_remap`);
  const insert = db.prepare(`insert into symbol_id_remap (old_id, new_id) values (?, ?)`);
  for (const s of moved) insert.run(s.oldId, s.newId);
  const written = JSON.stringify(writtenPaths);
  const newOf = (col: string): string => `(select new_id from symbol_id_remap where old_id = ${col})`;
  const isOld = (col: string): string => `${col} in (select old_id from symbol_id_remap)`;
  const notWrittenFile = `file_path not in (select value from json_each(?))`;
  const writtenSymbols = `(select symbol_id from symbols where repo_id = ? and file_path in (select value from json_each(?)))`;
  let changes = 0;
  for (const col of ["to_id", "from_id"]) {
    changes += db
      .prepare(`update edges set ${col} = ${newOf(`edges.${col}`)} where repo_id = ? and ${isOld(col)} and from_id not in ${writtenSymbols}`)
      .run(repoId, repoId, written).changes;
  }
  changes += db
    .prepare(`update symbols set parent_symbol_id = ${newOf("symbols.parent_symbol_id")} where repo_id = ? and ${isOld("parent_symbol_id")} and ${notWrittenFile}`)
    .run(repoId, written).changes;
  for (const col of ["controller_symbol_id", "handler_symbol_id"]) {
    changes += db.prepare(`update routes set ${col} = ${newOf(`routes.${col}`)} where repo_id = ? and ${isOld(col)} and ${notWrittenFile}`).run(repoId, written).changes;
  }
  changes += db
    .prepare(
      `update string_literals set enclosing_symbol_id = ${newOf("string_literals.enclosing_symbol_id")} where repo_id = ? and ${isOld("enclosing_symbol_id")} and ${notWrittenFile}`
    )
    .run(repoId, written).changes;
  for (const [col, repoCol] of [["from_symbol_id", "from_repo_id"], ["to_symbol_id", "to_repo_id"]] as const) {
    const marked = db
      .prepare(`update or ignore cross_repo_deps set ${col} = 'remap\u0001' || ${newOf(`cross_repo_deps.${col}`)} where ${repoCol} = ? and ${isOld(col)}`)
      .run(repoId).changes;
    // A row the sentinel step ignored, or one already holding the new id, is the same link: one stays.
    db.prepare(`delete from cross_repo_deps where ${repoCol} = ? and ${isOld(col)}`).run(repoId);
    db.prepare(`update or replace cross_repo_deps set ${col} = substr(${col}, 7) where ${repoCol} = ? and ${col} like 'remap\u0001%'`).run(repoId);
    changes += marked;
  }
  // An ambiguous mention keeps its candidates as a JSON array of ids; a scoped run does not re-decide it.
  const remap = new Map(moved.map((s) => [s.oldId, s.newId]));
  const ambiguous = db
    .prepare(
      `select rowid, candidate_ids as ids from doc_mentions
       where repo_id = ? and candidate_ids is not null
         and exists (select 1 from json_each(doc_mentions.candidate_ids) where value in (select old_id from symbol_id_remap))`
    )
    .all(repoId) as { rowid: number; ids: string }[];
  const setIds = db.prepare(`update doc_mentions set candidate_ids = ? where rowid = ?`);
  for (const m of ambiguous) {
    setIds.run(JSON.stringify((JSON.parse(m.ids) as string[]).map((id) => remap.get(id) ?? id)), m.rowid);
    changes += 1;
  }
  db.exec(`delete from symbol_id_remap`);
  return changes;
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
