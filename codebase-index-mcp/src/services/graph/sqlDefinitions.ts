/**
 * Which definition of a SQL name is the CURRENT one (MCP-ISSUE-082 follow-up, release I3).
 *
 * The SQL lane keeps one symbol per DEFINITION SITE: a table created in `archive/0004` and again in
 * the `0001-baseline`, a function replaced by `CREATE OR REPLACE` in `0043` and restored by
 * `0043….down.sql`. Release H bound every by-name reference to every site, so a name defined four
 * times gave each grant and each TS caller four identical rows. Since I3 an INBOUND reference binds to
 * exactly one site — the current definition — and the others are reported as `alsoDefinedAt`.
 *
 * ## The order (latest wins)
 *
 * A definition's rank is `(tier, number, file name, path, line)`, compared left to right:
 *
 * | tier | files | why |
 * |---|---|---|
 * | 0 | `*.down.sql` | a rollback restores an OLDER shape; it is never the schema going forward |
 * | 1 | a `.sql` file whose name has no leading number (seed, check fixture, `schema.sql`) | not part of the migration history |
 * | 2 | a numbered file under an `archive/` path segment | superseded: the baseline was cut from these |
 * | 3 | a numbered migration anywhere else (`0001-baseline.sql`, `0043-x.sql`) | the history that is applied |
 * | 4 | an EF Core `<Context>ModelSnapshot.cs` (release L3) | the current model, restated after every migration |
 *
 * So `0001-baseline` beats every `archive/` file whatever its number, `0043` beats `0001`, and a
 * later `CREATE OR REPLACE` in the same file beats an earlier one (line). Within a tier the number is
 * the `SQL_MIGRATION_ORDER` sequence; the rest is a deterministic tie-break, so two runs — and a full
 * and an incremental run — always pick the same site.
 *
 * ## Inbound vs outbound
 *
 * Only references INTO a name are narrowed. What a definition's own body reads stays on that
 * definition's symbol: `usage_in_period` in `0043` reads `turn_quality`, the baseline version does
 * not, and each version's outbound edges say exactly that (they bind, in turn, to the current
 * definition of what they read). A grant, a policy, an ALTER, a TS query — anything that names the
 * function — reaches the current version only.
 *
 * ## Derived, not stored
 *
 * `alsoDefinedAt` is not persisted. It is this same pure function of the `symbols` table, applied at
 * read time by `get_call_chain`, `search_symbols` and `get_symbol_detail` — the resolver binds with
 * it at the end of every run, so the two cannot disagree and there is nothing to migrate or go stale.
 */

import type Database from "better-sqlite3";

import { SQL_SIGNATURE_SEPARATOR, type SqlTokenKind } from "../extractors/sqlExtractor.js";

/** Which symbol kinds define a name of each token kind. */
export const DEFINING_KINDS: Record<SqlTokenKind, string[]> = {
  table: ["sql_table", "sql_view"],
  column: ["sql_column"],
  function: ["sql_function"],
  role: ["sql_role"],
  type: ["sql_type"],
  schema: ["sql_schema"],
  index: ["sql_index"],
  sequence: ["sql_sequence"],
  policy: ["sql_policy"],
  trigger: ["sql_trigger"]
};

const TOKEN_KIND_BY_SYMBOL_KIND = new Map<string, SqlTokenKind>(
  (Object.entries(DEFINING_KINDS) as [SqlTokenKind, string[]][]).flatMap(([tokenKind, kinds]) => kinds.map((k) => [k, tokenKind] as [string, SqlTokenKind]))
);

/** Kinds whose qualified name is `[schema.]table.name` rather than `[schema.]name`. */
const TABLE_SCOPED: ReadonlySet<SqlTokenKind> = new Set<SqlTokenKind>(["column", "policy", "trigger"]);
/** Kinds with no schema at all. */
const UNSCHEMED: ReadonlySet<SqlTokenKind> = new Set<SqlTokenKind>(["role", "schema"]);

export type SqlNameKey = { schema: string | null; rest: string };

/** Split a dotted name into (schema, rest) for `kind`. `public` is the default schema: null. */
export function sqlNameKey(kind: SqlTokenKind, name: string): SqlNameKey | null {
  const parts = name.split(".");
  if (UNSCHEMED.has(kind)) return { schema: null, rest: name };
  const scopedLength = TABLE_SCOPED.has(kind) ? 2 : 1;
  if (parts.length < scopedLength) return null;
  if (parts.length === scopedLength) return { schema: null, rest: name };
  const schema = parts.slice(0, parts.length - scopedLength).join(".");
  return { schema: schema === "public" ? null : schema, rest: parts.slice(parts.length - scopedLength).join(".") };
}

/** The token kind a SQL definition symbol answers to, or null for `sql_statement` / `sql_gap` / non-SQL. */
export function sqlTokenKindOfSymbol(kind: string): SqlTokenKind | null {
  return TOKEN_KIND_BY_SYMBOL_KIND.get(kind) ?? null;
}

/** The qualified name at the head of a definition's signature (`public.x — table (3 columns)`). */
export function sqlQualifiedName(name: string, signature: string | null | undefined): string {
  return signature && signature.includes(SQL_SIGNATURE_SEPARATOR) ? signature.split(SQL_SIGNATURE_SEPARATOR)[0]! : name;
}

const MIGRATION_NUMBER = /^(\d+)[-_.]/;
const DOWN_FILE = /\.down\.sql$/i;

export type SqlDefinitionSite = { symbolId: string; filePath: string; line: number };
type Rank = [tier: number, seq: number, base: string, path: string, line: number];

export function sqlDefinitionRank(filePath: string, line: number): Rank {
  const path = filePath.replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  const base = path.slice(slash + 1);
  const dirs = slash < 0 ? [] : path.slice(0, slash).toLowerCase().split("/");
  const m = MIGRATION_NUMBER.exec(base);
  const seq = m ? Number(m[1]) : -1;
  // Release L3: a definition outside a `.sql` file comes from the EF snapshot lane — the model itself, tier 4.
  if (!/\.sql$/i.test(base)) return [4, -1, base, path, line];
  const tier = DOWN_FILE.test(base) ? 0 : !m ? 1 : dirs.includes("archive") ? 2 : 3;
  return [tier, seq, base, path, line];
}

function compareRank(a: Rank, b: Rank): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** The current definition among `sites` (all of one name): the highest rank. */
export function pickCurrentSqlDefinition<T extends SqlDefinitionSite>(sites: readonly T[]): T | null {
  let best: T | null = null;
  let bestRank: Rank | null = null;
  for (const site of sites) {
    const rank = sqlDefinitionRank(site.filePath, site.line);
    if (!bestRank || compareRank(rank, bestRank) > 0) {
      best = site;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Release L1: does `current` win DECISIVELY over every other site of its name — on tier, or within one tier on
 * the migration number (both numbered, numbers different)? A win decided only by the tie-break (file name, path,
 * line: two `CREATE OR REPLACE` in one file, two copies with the same number) is not decisive. I3 still binds
 * references to the tie-break winner (a total order is needed for edges); L1 only drops a superseded mention
 * candidate when the win is decisive, so a wrong "current" can never become a silent wrong binding.
 */
export function isDecisiveCurrent(current: SqlDefinitionSite, sites: readonly SqlDefinitionSite[]): boolean {
  const c = sqlDefinitionRank(current.filePath, current.line);
  for (const site of sites) {
    if (site.symbolId === current.symbolId) continue;
    const o = sqlDefinitionRank(site.filePath, site.line);
    // Release L3: the EF model (tier 4) against a `.sql` site is two lanes neither of which can prove the other
    // stale — never decisive; two snapshots (two DbContexts) mapping one table tie, and are not decisive either.
    if (c[0] !== o[0]) {
      if (c[0] === 4 || o[0] === 4) return false;
      continue;
    }
    if (c[1] >= 0 && o[1] >= 0 && c[1] !== o[1]) continue;
    return false;
  }
  return true;
}

/** Release L1: does the repo's SQL follow a numbered-migration layout at all (a `.sql` file named `NNNN-…`)? */
export function hasNumberedSqlLayout(filePaths: Iterable<string>): boolean {
  for (const p of filePaths) {
    const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
    if (/\.sql$/i.test(base) && MIGRATION_NUMBER.test(base)) return true;
  }
  return false;
}

/** The definition symbols the superseded-candidate filter needs. */
export type SqlDefinitionRow = { symbolId: string; kind: string; name: string; signature: string | null; filePath: string; line: number };

/**
 * Release L1: superseded definition id → the current definition id of its name, for every name whose current
 * definition wins decisively. Empty when the repo has no numbered-migration layout ("unknown layout → no change").
 */
export function supersededSqlDefinitions(rows: readonly SqlDefinitionRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, SqlDefinitionRow[]>();
  for (const r of rows) {
    const tokenKind = sqlTokenKindOfSymbol(r.kind);
    if (!tokenKind) continue;
    const key = sqlNameKey(tokenKind, sqlQualifiedName(r.name, r.signature));
    if (!key) continue;
    const k = `${tokenKind}|${key.schema ?? ""}|${key.rest}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  if (!hasNumberedSqlLayout([...groups.values()].flat().map((r) => r.filePath))) return out;
  for (const sites of groups.values()) {
    if (sites.length < 2) continue;
    const current = pickCurrentSqlDefinition(sites)!;
    if (!isDecisiveCurrent(current, sites)) continue;
    for (const s of sites) if (s.symbolId !== current.symbolId) out.set(s.symbolId, current.symbolId);
  }
  return out;
}

/** `file:line` — the spelling `alsoDefinedAt` and the via-clauses use. */
export function siteLabel(site: { filePath: string; line: number }): string {
  return `${site.filePath}:${String(site.line)}`;
}

export type SqlDefinitionInfo = {
  /** Is THIS symbol the current definition of its name? */
  current: boolean;
  /** Definition sites of the name, this one included. */
  definitions: number;
  /** The current definition (`file:line`) and its id. */
  currentDefinition: string;
  currentSymbolId: string;
  /** Release L1: the current definition wins on tier or migration number, not only on the tie-break (file name, path, line). */
  decisive: boolean;
  /** Every definition site but this one, `file:line`, lowest-ranked first (so the current one is last when this site is superseded). */
  alsoDefinedAt: string[];
  note: string;
};

type SymbolRow = { symbolId: string; kind: string; name: string; signature: string | null; filePath: string; line: number };

/**
 * `alsoDefinedAt` for each SQL definition symbol in `symbolIds` whose name has more than one
 * definition site. Symbols that are not SQL definitions, or are defined once, are absent from the map.
 */
export function getSqlDefinitionInfo(db: Database.Database, repoId: string, symbolIds: readonly string[]): Map<string, SqlDefinitionInfo> {
  const out = new Map<string, SqlDefinitionInfo>();
  if (symbolIds.length === 0) return out;
  const one = db.prepare(
    `select symbol_id as symbolId, kind, name, signature, file_path as filePath, line from symbols where repo_id = ? and symbol_id = ?`
  );
  // `kind in (…) and name = ?` rides idx_symbols_repo_kind_name; a `like` on kind would not.
  const siblingsByName = db.prepare(
    `select symbol_id as symbolId, kind, name, signature, file_path as filePath, line from symbols
     where repo_id = ? and kind in (select value from json_each(?)) and name = ?`
  );
  for (const symbolId of new Set(symbolIds)) {
    const row = one.get(repoId, symbolId) as SymbolRow | undefined;
    if (!row) continue;
    const tokenKind = sqlTokenKindOfSymbol(row.kind);
    if (!tokenKind) continue;
    const key = sqlNameKey(tokenKind, sqlQualifiedName(row.name, row.signature));
    if (!key) continue;
    const kinds = DEFINING_KINDS[tokenKind];
    const sites = (siblingsByName.all(repoId, JSON.stringify(kinds), row.name) as SymbolRow[]).filter((s) => {
      if (!kinds.includes(s.kind)) return false;
      const k = sqlNameKey(tokenKind, sqlQualifiedName(s.name, s.signature));
      return k !== null && k.schema === key.schema && k.rest === key.rest;
    });
    if (sites.length < 2) continue;
    const current = pickCurrentSqlDefinition(sites)!;
    const others = sites
      .filter((s) => s.symbolId !== row.symbolId)
      .sort((a, b) => compareRank(sqlDefinitionRank(a.filePath, a.line), sqlDefinitionRank(b.filePath, b.line)));
    const isCurrent = current.symbolId === row.symbolId;
    out.set(symbolId, {
      current: isCurrent,
      definitions: sites.length,
      currentDefinition: siteLabel(current),
      currentSymbolId: current.symbolId,
      decisive: isDecisiveCurrent(current, sites),
      alsoDefinedAt: others.map(siteLabel),
      note: isCurrent
        ? `current of ${String(sites.length)} definitions: references to this name bind here; the other sites keep their own outbound edges`
        : `superseded by ${siteLabel(current)}: references to this name bind to the current definition; this site keeps only its own outbound edges`
    });
  }
  return out;
}
