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
 * - `name_resolved (N definitions): …` when the name is defined at N sites (a table in `archive/`
 *   and in the baseline) — the edge fans out to every site, like a CSS variable;
 * - `name_resolved (search_path): …`, 0.5, when an UNQUALIFIED name has no definition in the default
 *   schema but exactly one in another schema — plausible through a search_path, never certain.
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
 * `sqlschema:s` token also fans out to every table (sequence, function, type — as the clause says) the
 * index has in `s`, labelled `schema-wide, N objects`. Migration order is not modelled: a default
 * privilege reaches tables created after it, an `ON ALL TABLES` grant those existing before it.
 *
 * ## Full = incremental
 *
 * The bound set is a pure function of (tokens, definitions). Every run rebuilds it: the token edges
 * AND the edges bound on earlier runs (whose reason carries the token back) are collected, deleted,
 * and bound again — so a definition added in an unchanged position re-fans every existing user, as a
 * full run would. A token that stops resolving is restored as a labelled token, never dropped.
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
  SQL_SIGNATURE_SEPARATOR,
  SQL_TOKEN_CONFIDENCE,
  SQL_TOKEN_PREFIX,
  SQL_UNRESOLVED_REASON_PREFIX,
  type SqlTokenKind
} from "../extractors/sqlExtractor.js";

/** Confidence of a by-name SQL binding: medium, by policy (MCP-ISSUE-052 / 067 / 073). */
export const SQL_NAME_RESOLVED_CONFIDENCE = 0.6;
/** An unqualified name bound to the only other schema that defines it. */
export const SQL_SEARCH_PATH_CONFIDENCE = 0.5;
export const SQL_MIGRATION_ORDER_CONFIDENCE = 0.9;

/** Edge types the resolver owns (all but the migration order, which it writes separately). */
const RESOLVED_TYPES = ["SQL_USES", "SQL_REFERENCES", "SQL_GRANT", "SQL_QUERY"] as const;

/** Which symbol kinds define a name of each token kind. */
const DEFINING_KINDS: Record<SqlTokenKind, string[]> = {
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

/** Kinds whose qualified name is `[schema.]table.name` rather than `[schema.]name`. */
const TABLE_SCOPED: ReadonlySet<SqlTokenKind> = new Set<SqlTokenKind>(["column", "policy", "trigger"]);
/** Kinds with no schema at all. */
const UNSCHEMED: ReadonlySet<SqlTokenKind> = new Set<SqlTokenKind>(["role", "schema"]);

const TOKEN_KIND_BY_PREFIX = new Map<string, SqlTokenKind>(
  (Object.entries(SQL_TOKEN_PREFIX) as [SqlTokenKind, string][]).map(([kind, prefix]) => [prefix, kind])
);

export type SqlResolutionStats = {
  tokensResolved: number;
  tokensUnresolved: number;
  tokensAmbiguous: number;
  edgesWritten: number;
  migrationOrderEdges: number;
};

type Key = { schema: string | null; rest: string };

/** Split a dotted name into (schema, rest) for `kind`. `public` is the default schema: null. */
export function sqlNameKey(kind: SqlTokenKind, name: string): Key | null {
  const parts = name.split(".");
  if (UNSCHEMED.has(kind)) return { schema: null, rest: name };
  const scopedLength = TABLE_SCOPED.has(kind) ? 2 : 1;
  if (parts.length < scopedLength) return null;
  if (parts.length === scopedLength) return { schema: null, rest: name };
  const schema = parts.slice(0, parts.length - scopedLength).join(".");
  return { schema: schema === "public" ? null : schema, rest: parts.slice(parts.length - scopedLength).join(".") };
}

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

export function resolveSqlEdges(db: Database.Database, repoId: string): SqlResolutionStats {
  const stats: SqlResolutionStats = { tokensResolved: 0, tokensUnresolved: 0, tokensAmbiguous: 0, edgesWritten: 0, migrationOrderEdges: 0 };
  const typeList = RESOLVED_TYPES.map((t) => `'${t}'`).join(", ");

  // Work items: one per (from, type, token), from token edges and earlier bindings alike.
  const rows = db
    .prepare(
      `select from_id as fromId, to_id as toId, type, reason from edges
       where repo_id = ? and type in (${typeList})
         and (to_id like 'sql%:%' or reason like 'name_resolved%')
       order by from_id, type, to_id`
    )
    .all(repoId) as { fromId: string; toId: string; type: string; reason: string | null }[];
  if (rows.length === 0) {
    stats.migrationOrderEdges = writeMigrationOrder(db, repoId);
    return stats;
  }

  const items = new Map<string, { fromId: string; type: string; token: string; clause: string }>();
  for (const row of rows) {
    let token: string | null = null;
    let clause = "";
    if (row.toId.includes(":")) {
      token = row.toId;
      clause = UNRESOLVED_REASON.exec(row.reason ?? "")?.[1] ?? (row.reason ?? "");
    } else {
      const m = RESOLVED_REASON.exec(row.reason ?? "");
      if (!m) continue;
      clause = m[1]!;
      token = m[2]!;
    }
    if (!tokenKind(token)) continue;
    const key = `${row.fromId}\u0000${row.type}\u0000${token}`;
    if (!items.has(key)) items.set(key, { fromId: row.fromId, type: row.type, token, clause });
  }

  // Definitions, keyed by the qualified name at the head of their signature.
  const defs = new Map<SqlTokenKind, Map<string, { symbolId: string; schema: string | null }[]>>();
  /** Every definition of a kind in a schema (null = default), for schema-wide grants. */
  const bySchema = new Map<SqlTokenKind, Map<string | null, string[]>>();
  const defRows = db
    .prepare(
      `select symbol_id as symbolId, kind, name, signature from symbols
       where repo_id = ? and kind like 'sql\\_%' escape '\\' and kind not in ('sql_statement', 'sql_gap')
       order by symbol_id`
    )
    .all(repoId) as { symbolId: string; kind: string; name: string; signature: string | null }[];
  for (const row of defRows) {
    const qualified = row.signature && row.signature.includes(SQL_SIGNATURE_SEPARATOR) ? row.signature.split(SQL_SIGNATURE_SEPARATOR)[0]! : row.name;
    for (const [tokenKindName, kinds] of Object.entries(DEFINING_KINDS) as [SqlTokenKind, string[]][]) {
      if (!kinds.includes(row.kind)) continue;
      const key = sqlNameKey(tokenKindName, qualified);
      if (!key) continue;
      let byRest = defs.get(tokenKindName);
      if (!byRest) defs.set(tokenKindName, (byRest = new Map()));
      const list = byRest.get(key.rest) ?? [];
      list.push({ symbolId: row.symbolId, schema: key.schema });
      byRest.set(key.rest, list);
      let schemas = bySchema.get(tokenKindName);
      if (!schemas) bySchema.set(tokenKindName, (schemas = new Map()));
      const inSchema = schemas.get(key.schema) ?? [];
      inSchema.push(row.symbolId);
      schemas.set(key.schema, inSchema);
    }
  }

  const deleteToken = db.prepare(`delete from edges where repo_id = ? and from_id = ? and type = ? and to_id like 'sql%:%'`);
  const deleteResolved = db.prepare(`delete from edges where repo_id = ? and from_id = ? and type = ? and reason like 'name_resolved%'`);
  const insertEdge = db.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    const cleared = new Set<string>();
    for (const item of items.values()) {
      const clearKey = `${item.fromId}\u0000${item.type}`;
      if (!cleared.has(clearKey)) {
        deleteToken.run(repoId, item.fromId, item.type);
        deleteResolved.run(repoId, item.fromId, item.type);
        cleared.add(clearKey);
      }
    }
    const written = new Set<string>();
    const write = (fromId: string, toId: string, type: string, confidence: number, reason: string): void => {
      const k = `${fromId}\u0000${toId}\u0000${type}`;
      if (written.has(k)) return;
      written.add(k);
      insertEdge.run(repoId, fromId, toId, type, confidence, reason);
    };

    for (const item of items.values()) {
      const parsed = tokenKind(item.token)!;
      const key = sqlNameKey(parsed.kind, parsed.name);
      const candidates = key ? defs.get(parsed.kind)?.get(key.rest) ?? [] : [];
      let matches = key ? candidates.filter((c) => c.schema === key.schema) : [];
      let mode: "exact-schema" | "search_path" = "exact-schema";
      let ambiguous: string[] = [];
      if (key && matches.length === 0 && key.schema === null) {
        const otherSchemas = [...new Set(candidates.map((c) => c.schema).filter((s): s is string => s !== null))];
        if (otherSchemas.length === 1) {
          matches = candidates;
          mode = "search_path";
        } else if (otherSchemas.length > 1) {
          ambiguous = otherSchemas.map((s) => `${s}.${key.rest}`);
        }
      }
      // A schema-wide grant (`on all tables in schema s`, default privileges `on tables`) reaches
      // every object of that kind the index has in s — at whatever point in the migration history.
      let wide: string[] = [];
      const wideKind = parsed.kind === "schema" ? SCHEMA_WIDE.exec(item.clause)?.[1] : undefined;
      if (wideKind) {
        const schemaKey = parsed.name === "public" ? null : parsed.name;
        for (const k of SCHEMA_WIDE_KINDS[wideKind] ?? []) wide = wide.concat(bySchema.get(k)?.get(schemaKey) ?? []);
      }
      matches = matches.filter((m) => m.symbolId !== item.fromId);
      if (matches.length === 0 && wide.length === 0) {
        if (ambiguous.length > 0) stats.tokensAmbiguous += 1;
        else stats.tokensUnresolved += 1;
        const label = ambiguous.length > 0 ? `unresolved sql token (ambiguous: ${ambiguous.join(", ")}): ` : SQL_UNRESOLVED_REASON_PREFIX;
        write(item.fromId, item.token, item.type, SQL_TOKEN_CONFIDENCE, `${label}${item.clause}`);
        continue;
      }
      stats.tokensResolved += 1;
      const notes: string[] = [];
      if (mode === "search_path") notes.push("search_path");
      if (matches.length > 1) notes.push(`${String(matches.length)} definitions`);
      if (wide.length > 0) notes.push(`schema-wide, ${String(wide.length)} objects`);
      const reason = `name_resolved${notes.length > 0 ? ` (${notes.join(", ")})` : ""}: ${item.clause} | ${item.token}`;
      const confidence = mode === "search_path" ? SQL_SEARCH_PATH_CONFIDENCE : SQL_NAME_RESOLVED_CONFIDENCE;
      for (const id of [...matches.map((m) => m.symbolId), ...wide]) {
        write(item.fromId, id, item.type, confidence, reason);
        stats.edgesWritten += 1;
      }
    }
  });
  tx();

  stats.migrationOrderEdges = writeMigrationOrder(db, repoId);
  return stats;
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
