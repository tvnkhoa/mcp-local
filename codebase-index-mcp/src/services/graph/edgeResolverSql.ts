/**
 * The SQL lane's post-phase (MCP-ISSUE-082): bind `sql<kind>:<name>` tokens to the SQL symbols that
 * define those names, repo-wide, and write the migration-order edges.
 *
 * ## By name, labelled as such
 *
 * A SQL object is found by its name — an `ALTER TABLE audit_events` in `0042` names the table
 * `0001` created; `client.query('select … from audit_events')` names it from TypeScript. Nothing
 * proves the name means that object (a search_path, a same-named table in another database, a
 * string that only looks like SQL), so a bound edge is NEVER labelled exact or high:
 *
 * - reason `name_resolved: <clause> | <token>`, confidence 0.6 (medium) — the read side
 *   (`isNameOnlyEdgeReason`) counts it as name-only, which keeps a traversal standing on it at
 *   `coverage: medium` at most;
 * - `name_resolved (current of N definitions): …` when the name is defined at N sites;
 * - `name_resolved (search_path): …`, 0.5, when an UNQUALIFIED name has no definition in the default
 *   schema but exactly one in another schema — plausible through a search_path, never certain.
 *
 * ## One current definition per name (release I3)
 *
 * A reference binds to ONE site: the current definition (`sqlDefinitions.ts` — latest in migration
 * order, `archive/` superseded by the baseline, `.down.sql` never current). Release H fanned it out
 * to every site, so `usage_in_period` (4 sites) gave each grant and each TS caller 4 identical rows
 * and `audit_events` (2 sites) doubled every ALTER. The other sites are reported as `alsoDefinedAt`
 * at read time. Outbound edges are untouched: each `CREATE OR REPLACE` version keeps what its own
 * body reads, so `0043`'s `usage_in_period` reads `turn_quality` and the baseline's does not.
 *
 * ## Schema rules — a qualified name never merges with an unqualified one of another schema
 *
 * `public.x` and `x` are the same group (the default schema). `conversation_store.x` matches only
 * definitions in `conversation_store` — never a `public` / unqualified `x`. An unqualified `x` matches
 * the default group first; only when that is empty and exactly ONE other schema defines `x` does it
 * bind (labelled `search_path`). Two or more other schemas: ambiguous, kept as a token labelled
 * `unresolved sql token (ambiguous: a.x, b.x): …`.
 *
 * ## Schema-wide grants
 *
 * `GRANT … ON ALL TABLES IN SCHEMA s` and `ALTER DEFAULT PRIVILEGES IN SCHEMA s … ON TABLES` name no
 * table, but they are how a schema-owning service (wec.aria's ConversationStore) gets its rights. The
 * `sqlschema:s` token also fans out to every CURRENT table (sequence, function, type — as the clause
 * says) the index has in `s`, labelled `schema-wide, N objects`. Migration order is not modelled: a
 * default privilege reaches tables created after it, an `ON ALL TABLES` grant those existing before it.
 *
 * ## Imported query consts (release I4)
 *
 * `client.query(INSERT_X)` with `INSERT_X` imported is an anchor token `sqlconst:<specifier>#<name>`
 * from the calling symbol (`jsSqlQueries.ts`). Here the specifier is resolved from the caller's file
 * (`resolveModuleSpecifier`, tsconfig aliases included) to the declaring module; the exported const is
 * the `variable` symbol of that name there — or, one hop, in a module that file imports (a barrel's
 * `import { A } from './x'; export { A }` / `export { A } from './x'`). If that const carries its own
 * SQL scan (`ts sql const A …`), the anchor binds caller → const (`name_resolved`), and the caller gets
 * the const's table/column/function tokens as its own, clause `ts query imported const B via A
 * (file:line) …`, bound like any other token. A const that is not SQL-shaped, not found, or not in the
 * repo leaves the anchor as a labelled token — no SQL target, ever. The derived edges are deleted
 * and rebuilt from the anchors every run, so a changed const reaches unchanged callers.
 *
 * ## Full = incremental
 *
 * The bound set is a pure function of (tokens, anchors, definitions). Every run rebuilds it: the
 * token edges AND the edges bound on earlier runs (whose reason carries the token back) are
 * collected, deleted, and bound again — so a definition added in an unchanged position moves every
 * existing user to it, as a full run would. A token that stops resolving is restored as a labelled
 * token, never dropped.
 *
 * ## Migration order
 *
 * `SQL_MIGRATION_ORDER`: within one directory, every `.sql` file whose name starts with a number
 * (`0042-x.sql`) → the previous one in (number, name) order; a `NNNN-x.down.sql` → its `NNNN-x.sql`.
 * Recomputed whole each run from the files table. Confidence 0.9: the filename sequence is the
 * convention of migration runners, not something the graph can prove.
 */

import type Database from "better-sqlite3";

import {
  SQL_CONST_DECLARATION_CLAUSE,
  SQL_CONST_TOKEN_PREFIX,
  SQL_IMPORTED_CONST_CLAUSE,
  SQL_TOKEN_CONFIDENCE,
  SQL_TOKEN_PREFIX,
  SQL_UNRESOLVED_REASON_PREFIX,
  type SqlTokenKind
} from "../extractors/sqlExtractor.js";
import { EMPTY_ALIASES, loadIndexedFilePaths, loadRepoPath, readTsconfigAliases, resolveModuleSpecifier, type PathAliases } from "./moduleResolution.js";
import { DEFINING_KINDS, pickCurrentSqlDefinition, siteLabel, sqlNameKey, sqlQualifiedName } from "./sqlDefinitions.js";

export { sqlNameKey } from "./sqlDefinitions.js";

/** Confidence of a by-name SQL binding: medium, by policy (MCP-ISSUE-052 / 067 / 073). */
export const SQL_NAME_RESOLVED_CONFIDENCE = 0.6;
/** An unqualified name bound to the only other schema that defines it. */
export const SQL_SEARCH_PATH_CONFIDENCE = 0.5;
export const SQL_MIGRATION_ORDER_CONFIDENCE = 0.9;

/** Edge types the resolver owns (all but the migration order, which it writes separately). */
const RESOLVED_TYPES = ["SQL_USES", "SQL_REFERENCES", "SQL_GRANT", "SQL_QUERY"] as const;

const TOKEN_KIND_BY_PREFIX = new Map<string, SqlTokenKind>(
  (Object.entries(SQL_TOKEN_PREFIX) as [SqlTokenKind, string][]).map(([kind, prefix]) => [prefix, kind])
);

export type SqlResolutionStats = {
  tokensResolved: number;
  tokensUnresolved: number;
  tokensAmbiguous: number;
  edgesWritten: number;
  migrationOrderEdges: number;
  /** Release I4: imported-const anchors followed to a SQL const / left as labelled tokens. */
  constAnchorsFollowed: number;
  constAnchorsUnfollowed: number;
};

function tokenKind(toId: string): { kind: SqlTokenKind; name: string } | null {
  const colon = toId.indexOf(":");
  if (colon < 0) return null;
  const kind = TOKEN_KIND_BY_PREFIX.get(toId.slice(0, colon + 1));
  return kind ? { kind, name: toId.slice(colon + 1) } : null;
}

const SCHEMA_WIDE = /\bon (?:all )?(tables|sequences|functions|routines|procedures|types)\b/;
const SCHEMA_WIDE_KINDS: Record<string, SqlTokenKind[]> = {
  tables: ["table"],
  sequences: ["sequence"],
  functions: ["function"],
  routines: ["function"],
  procedures: ["function"],
  types: ["type"]
};

const RESOLVED_REASON = /^name_resolved(?: \([^)]*\))?: (.*) \| (\S+)$/;
const UNRESOLVED_REASON = /^unresolved sql token(?: \([^)]*\))?: (.*)$/;

/** (clause, token) of a SQL-lane edge in either state, or null. */
function parseSqlEdge(toId: string, reason: string | null): { clause: string; token: string } | null {
  if (toId.includes(":")) return { token: toId, clause: UNRESOLVED_REASON.exec(reason ?? "")?.[1] ?? (reason ?? "") };
  const m = RESOLVED_REASON.exec(reason ?? "");
  return m ? { clause: m[1]!, token: m[2]! } : null;
}

type WorkItem = { fromId: string; type: string; token: string; clause: string };
type Anchor = { fromId: string; token: string; clause: string };
type Def = { symbolId: string; schema: string | null; filePath: string; line: number };
/** The current definition of one (kind, schema, rest) group and how many sites the group has. */
type Current = { symbolId: string; count: number };

export function resolveSqlEdges(db: Database.Database, repoId: string): SqlResolutionStats {
  const stats: SqlResolutionStats = {
    tokensResolved: 0, tokensUnresolved: 0, tokensAmbiguous: 0, edgesWritten: 0, migrationOrderEdges: 0,
    constAnchorsFollowed: 0, constAnchorsUnfollowed: 0
  };
  const typeList = RESOLVED_TYPES.map((t) => `'${t}'`).join(", ");

  // Work items: one per (from, type, token), from token edges and earlier bindings alike. Anchors
  // (imported consts) are collected apart; edges DERIVED from an anchor are not work items — they are
  // rebuilt below from the anchor and the const's current text.
  const rows = db
    .prepare(
      `select from_id as fromId, to_id as toId, type, reason, rowid as rid from edges
       where repo_id = ? and type in (${typeList})
         and (to_id like 'sql%:%' or reason like 'name_resolved%')`
    )
    .all(repoId) as { fromId: string; toId: string; type: string; reason: string | null; rid: number }[];
  if (rows.length === 0) {
    stats.migrationOrderEdges = writeMigrationOrder(db, repoId);
    return stats;
  }

  // Ordered by the TOKEN, not `to_id` (release J, MCP-ISSUE-085). The maps below are first-wins, and
  // `to_id` is the token only until the edge is bound: a run that found an unchanged file's edges
  // already bound ordered them by target id instead, so two imported consts feeding one column swapped
  // which one named the edge. A full run sees every edge as a token, so this is the order it always had.
  const parsedRows = rows
    .map((row) => ({ row, parsed: parseSqlEdge(row.toId, row.reason) }))
    .filter((x): x is { row: (typeof rows)[number]; parsed: { clause: string; token: string } } => x.parsed !== null)
    .sort((a, b) =>
      a.row.fromId < b.row.fromId ? -1 : a.row.fromId > b.row.fromId ? 1
        : a.row.type < b.row.type ? -1 : a.row.type > b.row.type ? 1
          : a.parsed.token < b.parsed.token ? -1 : a.parsed.token > b.parsed.token ? 1
            : a.row.rid - b.row.rid
    );
  const items = new Map<string, WorkItem>();
  const anchors = new Map<string, Anchor>();
  for (const { row, parsed } of parsedRows) {
    if (parsed.token.startsWith(SQL_CONST_TOKEN_PREFIX)) {
      if (row.type === "SQL_QUERY") anchors.set(`${row.fromId}\u0000${parsed.token}`, { fromId: row.fromId, token: parsed.token, clause: parsed.clause });
      continue;
    }
    if (parsed.clause.startsWith(SQL_IMPORTED_CONST_CLAUSE)) continue; // derived: rebuilt from its anchor
    if (!tokenKind(parsed.token)) continue;
    const key = `${row.fromId}\u0000${row.type}\u0000${parsed.token}`;
    if (!items.has(key)) items.set(key, { fromId: row.fromId, type: row.type, token: parsed.token, clause: parsed.clause });
  }

  // Definitions, keyed by the qualified name at the head of their signature, then the CURRENT one of
  // each (kind, schema, rest) group — the only site a reference binds to.
  const defs = new Map<SqlTokenKind, Map<string, Def[]>>();
  const defRows = db
    .prepare(
      `select symbol_id as symbolId, kind, name, signature, file_path as filePath, line from symbols
       where repo_id = ? and kind like 'sql\\_%' escape '\\' and kind not in ('sql_statement', 'sql_gap')
       order by symbol_id`
    )
    .all(repoId) as { symbolId: string; kind: string; name: string; signature: string | null; filePath: string; line: number }[];
  for (const row of defRows) {
    const qualified = sqlQualifiedName(row.name, row.signature);
    for (const [tokenKindName, kinds] of Object.entries(DEFINING_KINDS) as [SqlTokenKind, string[]][]) {
      if (!kinds.includes(row.kind)) continue;
      const key = sqlNameKey(tokenKindName, qualified);
      if (!key) continue;
      let byRest = defs.get(tokenKindName);
      if (!byRest) defs.set(tokenKindName, (byRest = new Map()));
      const list = byRest.get(key.rest) ?? [];
      list.push({ symbolId: row.symbolId, schema: key.schema, filePath: row.filePath, line: row.line });
      byRest.set(key.rest, list);
    }
  }
  /** kind → rest → schema → current. */
  const current = new Map<SqlTokenKind, Map<string, Map<string | null, Current>>>();
  /** Every CURRENT definition of a kind in a schema (null = default), for schema-wide grants. */
  const bySchema = new Map<SqlTokenKind, Map<string | null, string[]>>();
  for (const [kind, byRest] of defs) {
    const perRest = new Map<string, Map<string | null, Current>>();
    current.set(kind, perRest);
    let schemas = bySchema.get(kind);
    if (!schemas) bySchema.set(kind, (schemas = new Map()));
    for (const [rest, list] of byRest) {
      const groups = new Map<string | null, Def[]>();
      for (const d of list) groups.set(d.schema, [...(groups.get(d.schema) ?? []), d]);
      const perSchema = new Map<string | null, Current>();
      for (const [schema, group] of groups) {
        const pick = pickCurrentSqlDefinition(group)!;
        perSchema.set(schema, { symbolId: pick.symbolId, count: group.length });
        schemas.set(schema, [...(schemas.get(schema) ?? []), pick.symbolId]);
      }
      perRest.set(rest, perSchema);
    }
  }

  // Imported query consts: follow each anchor to the const's own scan, and add its targets to the
  // caller's work items.
  const followed = followConstAnchors(db, repoId, [...anchors.values()]);
  for (const anchor of anchors.values()) {
    const result = followed.get(`${anchor.fromId}\u0000${anchor.token}`);
    if (!result || result.kind !== "followed") continue;
    for (const target of result.targets) {
      const key = `${anchor.fromId}\u0000SQL_QUERY\u0000${target.token}`;
      if (!items.has(key)) items.set(key, { fromId: anchor.fromId, type: "SQL_QUERY", token: target.token, clause: target.clause });
    }
  }

  const deleteToken = db.prepare(`delete from edges where repo_id = ? and from_id = ? and type = ? and to_id like 'sql%:%'`);
  const deleteResolved = db.prepare(`delete from edges where repo_id = ? and from_id = ? and type = ? and reason like 'name_resolved%'`);
  const insertEdge = db.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    // Every edge derived from an anchor goes, wherever its caller is; the anchors rebuild them.
    db.prepare(
      `delete from edges where repo_id = ? and type = 'SQL_QUERY' and to_id not like '${SQL_CONST_TOKEN_PREFIX}%'
         and (reason like 'name_resolved%: ${SQL_IMPORTED_CONST_CLAUSE}%' or reason like 'unresolved sql token%: ${SQL_IMPORTED_CONST_CLAUSE}%')`
    ).run(repoId);
    const cleared = new Set<string>();
    const clear = (fromId: string, type: string): void => {
      const clearKey = `${fromId}\u0000${type}`;
      if (cleared.has(clearKey)) return;
      deleteToken.run(repoId, fromId, type);
      deleteResolved.run(repoId, fromId, type);
      cleared.add(clearKey);
    };
    for (const item of items.values()) clear(item.fromId, item.type);
    for (const anchor of anchors.values()) clear(anchor.fromId, "SQL_QUERY");

    const written = new Set<string>();
    const write = (fromId: string, toId: string, type: string, confidence: number, reason: string): boolean => {
      const k = `${fromId}\u0000${toId}\u0000${type}`;
      if (written.has(k)) return false;
      written.add(k);
      insertEdge.run(repoId, fromId, toId, type, confidence, reason);
      return true;
    };

    for (const anchor of anchors.values()) {
      const result = followed.get(`${anchor.fromId}\u0000${anchor.token}`);
      if (result?.kind === "followed") {
        stats.constAnchorsFollowed += 1;
        write(anchor.fromId, result.constSymbolId, "SQL_QUERY", SQL_NAME_RESOLVED_CONFIDENCE, `name_resolved: ${anchor.clause} | ${anchor.token}`);
      } else {
        stats.constAnchorsUnfollowed += 1;
        write(anchor.fromId, anchor.token, "SQL_QUERY", SQL_TOKEN_CONFIDENCE, `unresolved sql token (${result?.why ?? "not followed"}): ${anchor.clause}`);
      }
    }

    for (const item of items.values()) {
      const parsed = tokenKind(item.token)!;
      const key = sqlNameKey(parsed.kind, parsed.name);
      const groups = key ? current.get(parsed.kind)?.get(key.rest) : undefined;
      let match: Current | null = key ? groups?.get(key.schema) ?? null : null;
      let mode: "exact-schema" | "search_path" = "exact-schema";
      let ambiguous: string[] = [];
      if (key && !match && key.schema === null && groups) {
        const otherSchemas = [...groups.keys()].filter((s): s is string => s !== null);
        if (otherSchemas.length === 1) {
          match = groups.get(otherSchemas[0]!)!;
          mode = "search_path";
        } else if (otherSchemas.length > 1) {
          ambiguous = otherSchemas.sort().map((s) => `${s}.${key.rest}`);
        }
      }
      // A schema-wide grant (`on all tables in schema s`, default privileges `on tables`) reaches
      // every current object of that kind the index has in s — at whatever point in the history.
      let wide: string[] = [];
      const wideKind = parsed.kind === "schema" ? SCHEMA_WIDE.exec(item.clause)?.[1] : undefined;
      if (wideKind) {
        const schemaKey = parsed.name === "public" ? null : parsed.name;
        for (const k of SCHEMA_WIDE_KINDS[wideKind] ?? []) wide = wide.concat(bySchema.get(k)?.get(schemaKey) ?? []);
      }
      // A definition naming itself (a recursive function) is not a reference to bind.
      if (match && match.symbolId === item.fromId) match = null;
      wide = wide.filter((id) => id !== item.fromId);
      if (!match && wide.length === 0) {
        if (ambiguous.length > 0) stats.tokensAmbiguous += 1;
        else stats.tokensUnresolved += 1;
        const label = ambiguous.length > 0 ? `unresolved sql token (ambiguous: ${ambiguous.join(", ")}): ` : SQL_UNRESOLVED_REASON_PREFIX;
        write(item.fromId, item.token, item.type, SQL_TOKEN_CONFIDENCE, `${label}${item.clause}`);
        continue;
      }
      stats.tokensResolved += 1;
      const notes: string[] = [];
      if (mode === "search_path") notes.push("search_path");
      if (match && match.count > 1) notes.push(`current of ${String(match.count)} definitions`);
      if (wide.length > 0) notes.push(`schema-wide, ${String(wide.length)} objects`);
      const reason = `name_resolved${notes.length > 0 ? ` (${notes.join(", ")})` : ""}: ${item.clause} | ${item.token}`;
      const confidence = mode === "search_path" ? SQL_SEARCH_PATH_CONFIDENCE : SQL_NAME_RESOLVED_CONFIDENCE;
      for (const id of [...(match ? [match.symbolId] : []), ...wide]) {
        if (write(item.fromId, id, item.type, confidence, reason)) stats.edgesWritten += 1;
      }
    }
  });
  tx();

  stats.migrationOrderEdges = writeMigrationOrder(db, repoId);
  return stats;
}

// ─── imported query consts (release I4) ─────────────────────────────────────────────────────────

type FollowResult =
  | { kind: "followed"; constSymbolId: string; targets: { token: string; clause: string }[] }
  | { kind: "unfollowed"; why: string };

const ANCHOR_CLAUSE = /^ts query imported const (\S+) \(line (\d+)\)$/;
const CONST_CLAUSE = /^ts sql const (\S+) (.*) \(line \d+\)$/;

/**
 * For each anchor `sqlconst:<specifier>#<name>`: the declaring module (resolved from the caller's
 * file), the exported const there (or one import hop on), and that const's own SQL scan.
 */
function followConstAnchors(db: Database.Database, repoId: string, anchors: Anchor[]): Map<string, FollowResult> {
  const out = new Map<string, FollowResult>();
  if (anchors.length === 0) return out;

  const knownFiles = loadIndexedFilePaths(db, repoId);
  let aliases: PathAliases = EMPTY_ALIASES;
  try {
    const repoPath = loadRepoPath(db, repoId);
    if (repoPath) aliases = readTsconfigAliases(repoPath);
  } catch {
    /* no repositories row (a bare test database): relative specifiers still resolve */
  }

  const fileOf = db.prepare(`select file_path as filePath from symbols where repo_id = ? and symbol_id = ?`);
  const variablesIn = db.prepare(
    `select symbol_id as symbolId, file_path as filePath, line from symbols where repo_id = ? and file_path = ? and name = ? and kind = 'variable' order by line`
  );
  const moduleOf = db.prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`);
  const importsOf = db.prepare(
    `select e.to_id as toId, s.file_path as filePath from edges e left join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.to_id
     where e.repo_id = ? and e.from_id = ? and e.type = 'IMPORTS'`
  );
  // In extraction order (first-wins below): a re-extracted file keeps its rows' relative order.
  const constEdges = db.prepare(`select to_id as toId, reason from edges where repo_id = ? and from_id = ? and type = 'SQL_QUERY' order by rowid`);

  const findConst = (file: string, name: string): { symbolId: string; filePath: string; line: number } | "ambiguous" | null => {
    const own = variablesIn.all(repoId, file, name) as { symbolId: string; filePath: string; line: number }[];
    if (own.length > 0) return own[0]!;
    // One hop: a module this file imports (a barrel re-export, or import-then-export).
    const moduleId = (moduleOf.get(repoId, file) as { symbolId: string } | undefined)?.symbolId;
    if (!moduleId) return null;
    const hits = new Map<string, { symbolId: string; filePath: string; line: number }>();
    for (const imp of importsOf.all(repoId, moduleId) as { toId: string; filePath: string | null }[]) {
      const target = imp.filePath ?? (imp.toId.startsWith("import:") ? resolveModuleSpecifier(file, imp.toId.slice("import:".length), knownFiles, aliases) : null);
      if (!target || target === file) continue;
      for (const v of variablesIn.all(repoId, target, name) as { symbolId: string; filePath: string; line: number }[]) hits.set(v.symbolId, v);
    }
    if (hits.size > 1) return "ambiguous";
    return hits.size === 1 ? [...hits.values()][0]! : null;
  };

  for (const anchor of anchors) {
    const key = `${anchor.fromId}\u0000${anchor.token}`;
    const body = anchor.token.slice(SQL_CONST_TOKEN_PREFIX.length);
    const hash = body.lastIndexOf("#");
    const specifier = hash < 0 ? "" : body.slice(0, hash);
    const name = hash < 0 ? "" : body.slice(hash + 1);
    const callerFile = (fileOf.get(repoId, anchor.fromId) as { filePath: string } | undefined)?.filePath;
    if (!specifier || !name || !callerFile) {
      out.set(key, { kind: "unfollowed", why: "no caller" });
      continue;
    }
    const declaringFile = resolveModuleSpecifier(callerFile, specifier, knownFiles, aliases);
    if (!declaringFile) {
      out.set(key, { kind: "unfollowed", why: "module not in the repo" });
      continue;
    }
    const constSymbol = findConst(declaringFile, name);
    if (constSymbol === "ambiguous" || !constSymbol) {
      out.set(key, { kind: "unfollowed", why: constSymbol === "ambiguous" ? "ambiguous re-export" : "no exported const" });
      continue;
    }
    const m = ANCHOR_CLAUSE.exec(anchor.clause);
    const local = m?.[1] ?? name;
    const callLine = m?.[2] ?? "?";
    const via = `${SQL_IMPORTED_CONST_CLAUSE}${local} via ${name} (${siteLabel(constSymbol)})`;
    const targets: { token: string; clause: string }[] = [];
    const seen = new Set<string>();
    for (const edge of constEdges.all(repoId, constSymbol.symbolId) as { toId: string; reason: string | null }[]) {
      const parsed = parseSqlEdge(edge.toId, edge.reason);
      if (!parsed || !tokenKind(parsed.token) || !parsed.clause.startsWith(SQL_CONST_DECLARATION_CLAUSE)) continue;
      if (seen.has(parsed.token)) continue;
      seen.add(parsed.token);
      const inner = CONST_CLAUSE.exec(parsed.clause)?.[2] ?? "";
      targets.push({ token: parsed.token, clause: `${via}${inner ? ` ${inner}` : ""} (line ${callLine})` });
    }
    out.set(key, targets.length > 0 ? { kind: "followed", constSymbolId: constSymbol.symbolId, targets } : { kind: "unfollowed", why: "not a sql const" });
  }
  return out;
}

const MIGRATION_NAME = /^(\d+)[-_.]/;

/** Rewrite every `SQL_MIGRATION_ORDER` edge of the repo from the indexed `.sql` file list. */
function writeMigrationOrder(db: Database.Database, repoId: string): number {
  const files = db
    .prepare(`select path from files where repo_id = ? and language = 'sql' order by path`)
    .all(repoId) as { path: string }[];
  const moduleIds = new Map<string, string>();
  for (const row of db
    .prepare(`select file_path as filePath, symbol_id as symbolId from symbols where repo_id = ? and kind = 'module' and file_path like '%.sql'`)
    .all(repoId) as { filePath: string; symbolId: string }[]) {
    moduleIds.set(row.filePath, row.symbolId);
  }

  const byDir = new Map<string, { path: string; base: string; seq: number }[]>();
  for (const { path } of files) {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    const base = path.slice(slash + 1);
    const m = MIGRATION_NAME.exec(base);
    if (!m) continue;
    const list = byDir.get(dir) ?? [];
    list.push({ path, base, seq: Number(m[1]) });
    byDir.set(dir, list);
  }

  const edges: { from: string; to: string; reason: string }[] = [];
  for (const list of byDir.values()) {
    const isDown = (b: string): boolean => /\.down\.sql$/i.test(b);
    const ups = list.filter((f) => !isDown(f.base)).sort((a, b) => a.seq - b.seq || (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    for (let i = 1; i < ups.length; i += 1) {
      const prev = ups[i - 1]!;
      const cur = ups[i]!;
      edges.push({ from: cur.path, to: prev.path, reason: `migration order: follows ${prev.base} (filename sequence${prev.seq === cur.seq ? ", same number" : ""})` });
    }
    const upByBase = new Map(ups.map((u) => [u.base.toLowerCase(), u]));
    for (const down of list.filter((f) => isDown(f.base))) {
      const up = upByBase.get(down.base.replace(/\.down\.sql$/i, ".sql").toLowerCase());
      if (up) edges.push({ from: down.path, to: up.path, reason: `down migration of ${up.base}` });
    }
  }

  const insert = db.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, 'SQL_MIGRATION_ORDER', ?, ?)`);
  let written = 0;
  db.transaction(() => {
    db.prepare(`delete from edges where repo_id = ? and type = 'SQL_MIGRATION_ORDER'`).run(repoId);
    for (const e of edges) {
      const from = moduleIds.get(e.from) ?? null;
      const to = moduleIds.get(e.to) ?? null;
      if (!from || !to) continue;
      insert.run(repoId, from, to, SQL_MIGRATION_ORDER_CONFIDENCE, e.reason);
      written += 1;
    }
  })();
  return written;
}
