/**
 * MCP-ISSUE-082 — the SQL lane and name-resolved TS → SQL edges, end to end over real MCP stdio.
 *
 * Fixture (a temp repo):
 *   db/migrations/001-create.sql      — `documents`, `people`, a role created in a DO block
 *   db/migrations/002-alter.sql       — ALTER TABLE documents ADD COLUMN reviewer_id … REFERENCES people
 *   db/migrations/003-grant.sql       — GRANT on documents, an index, a view reading documents, a
 *                                       LANGUAGE sql function reading documents, a policy
 *   db/migrations/003-grant.down.sql  — its down migration
 *   db/migrations/004-gap.sql         — a statement no reader recognises (CREATE PUBLICATION)
 *   src/adapter.ts                    — pool.query / client.query<T> literals, a SQL const, a call to the
 *                                       migration-made function, a dynamic table name
 *   db/migrations/000-baseline.sql    — (I3) audit_log + usage_fn, also defined in
 *   db/migrations/archive/0004-audit.sql  … an archived migration; grants on both
 *   db/migrations/005-replace[.down].sql — usage_fn replaced with a body that also reads documents
 *   src/audit-sql.ts, src/audit-store.ts — (I4) query consts imported (one renamed) by the store; a
 *                                       non-SQL const passed to .query
 *
 * Release I3/I4 assertions: one current definition per name (baseline beats archive/, .down.sql never
 * current), each caller once, alsoDefinedAt in search_symbols / get_call_chain / get_symbol_detail,
 * each CREATE OR REPLACE version keeps its own reads, SQL_USES = distinct statement sites; an imported
 * const gives the calling function the edge "via CONST (file:line)", a non-SQL const gives nothing.
 *
 * Asserts "who touches documents" (get_call_chain callers on the table) lists the ALTER, the GRANT
 * (with its role and privileges), the index, the view, the function, the policy and the TS query
 * sites, every hop labelled name_resolved at confidence 0.6 (never exact/high); the gap is named
 * with its line in health_check; dead_code_scan reports no SQL symbol; the migration order is read;
 * and an incremental run after a row-shifting edit lands on the same graph as a full run with
 * I1 = I2 = 0.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const DEBUG = process.env.SQL_HARNESS_DEBUG === "1";
const dump = (label, v) => { if (DEBUG) console.log(`--- ${label}\n${JSON.stringify(v, null, 1)?.slice(0, 4000)}`); };

const tmpDir = makeTempDir("sql-lane-");
const repoId = `sql-lane-${Date.now()}`;
const files = {
  "db/migrations/001-create.sql": `\\set ON_ERROR_STOP on
begin;
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_reader') then
    create role app_reader nologin;
  end if;
end $$;

create table public.people (
  id text primary key,
  name text not null
);

create table public.documents (
  id text primary key,
  owner_id text not null references people (id),
  title text
);
commit;
`,
  "db/migrations/002-alter.sql": `begin;
alter table documents add column reviewer_id text references people(id);
commit;
`,
  "db/migrations/003-grant.sql": `begin;
grant select, insert on table public.documents to app_reader;
create index documents_owner on public.documents (owner_id);
create view open_documents as select d.id, d.title from documents d;
create function count_documents(p_owner text) returns bigint language sql stable as $$
  select count(*) from documents where owner_id = p_owner;
$$;
alter table documents enable row level security;
create policy documents_read on public.documents for select to app_reader using (owner_id is not null);
commit;
`,
  "db/migrations/003-grant.down.sql": `revoke select, insert on table public.documents from app_reader;
`,
  "db/migrations/004-gap.sql": `create publication all_docs for table documents;
`,
  // Release I3: audit_log and usage_fn are defined in the baseline AND in an archived migration;
  // usage_fn is replaced in 005 with a different body (it also reads documents) and restored by the
  // down file. References bind to ONE current definition; each version keeps its own reads.
  "db/migrations/000-baseline.sql": `create table public.audit_log (
  id text primary key,
  tenant_id integer,
  note text
);
create function public.usage_fn(p integer) returns bigint language sql stable as $$
  select count(*) from audit_log
$$;
revoke all on function public.usage_fn from public;
grant execute on function public.usage_fn to app_reader;
`,
  "db/migrations/archive/0004-audit.sql": `create table audit_log (
  id text primary key,
  tenant_id integer
);
alter table audit_log add column note text;
grant insert on audit_log to app_reader;
create function usage_fn(p integer) returns bigint language sql as $$
  select count(*) from audit_log
$$;
grant execute on function usage_fn to app_reader;
`,
  "db/migrations/005-replace.sql": `create or replace function public.usage_fn(p integer) returns bigint language sql stable as $$
  select count(*) from audit_log a join documents d on d.id = a.id
$$;
alter table public.audit_log enable row level security;
`,
  "db/migrations/005-replace.down.sql": `create or replace function public.usage_fn(p integer) returns bigint language sql stable as $$
  select count(*) from audit_log
$$;
`,
  // Release I4: query consts kept in one module and imported (one renamed) by the store.
  "src/audit-sql.ts": `export const INSERT_AUDIT_LOG = \`insert into audit_log (id, tenant_id) values ($1, $2)\`
export const SELECT_USAGE = \`select usage_fn($1) as n\`
export const PAGE_SIZE = 50
`,
  "src/audit-store.ts": `import { INSERT_AUDIT_LOG as INSERT_ROW, PAGE_SIZE, SELECT_USAGE } from './audit-sql.js'

export async function recordAudit(client: any, id: string) {
  await client.query(INSERT_ROW, [id, 1])
}

export async function pageSize(client: any) {
  return client.query(PAGE_SIZE)
}

export async function usage(client: any) {
  return client.query<{ n: number }>(SELECT_USAGE, [1])
}
`,
  "src/adapter.ts": `import { Pool } from 'pg'
const pool = new Pool()

export const SELECT_DOCUMENTS = \`select id, title from documents where owner_id = $1\`

export async function loadDocuments(owner: string) {
  return pool.query(SELECT_DOCUMENTS, [owner])
}

export async function insertDocument(client: any, id: string) {
  await client.query<{ id: string }>(\`insert into documents (id, owner_id) values ($1, $2)\`, [id, 'x'])
}

export async function countFor(client: any, owner: string) {
  return client.query('select count_documents($1) as n', [owner])
}

export async function readAny(client: any, table: string) {
  return client.query(\`select * from \${table}\`)
}
`
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(tmpDir, rel)), { recursive: true });
  writeFileSync(join(tmpDir, rel), text, "utf8");
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "sql-lane", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-sql-lane");
const call = async (name, args) => js(await client.callTool({ name, arguments: { repoId, ...args } }));
const q = async (sql, limit = 500) => (await call("query_graph", { sql, limit }))?.rows ?? [];

const integrity = async () => ({
  i1: (await q("select count(*) as n from edges where repo_id = :repoId and from_id not like 'callee:%' and from_id not in (select symbol_id from symbols where repo_id = :repoId)"))[0]?.n,
  i2: (await q("select count(*) as n from edges where repo_id = :repoId and to_id not like '%:%' and to_id not in (select symbol_id from symbols where repo_id = :repoId)"))[0]?.n
});
// Endpoint-identity snapshot of every SQL edge (ids hash rows, so compare by name + line + kind).
const sqlGraph = async () => JSON.stringify(await q(
  "select e.type, s1.kind as fk, s1.name as fn, s1.file_path as ff, s1.line as fl, coalesce(s2.kind, e.to_id) as tk, s2.name as tn, s2.file_path as tf, s2.line as tl, e.confidence, e.reason from edges e left join symbols s1 on s1.repo_id = e.repo_id and s1.symbol_id = e.from_id left join symbols s2 on s2.repo_id = e.repo_id and s2.symbol_id = e.to_id where e.repo_id = :repoId and e.type like 'SQL%' order by 1,2,3,4,5,6,7,8,9,10,11",
  2000
));

try {
  const indexed = await call("index_repository", { repoPath: tmpDir, mode: "full" });
  dump("index", indexed);
  assert(indexed && !indexed.error, "index_repository (full)", JSON.stringify(indexed)?.slice(0, 300));
  assert((indexed?.parseFailures ?? 0) === 0, "no parse failures", JSON.stringify(indexed)?.slice(0, 300));

  // ── search ──────────────────────────────────────────────────────────────────────────────
  const search = await call("search_symbols", { query: "documents", strategy: "name", limit: 20, profile: "verbose" });
  dump("search documents", search);
  const tables = (search?.results ?? search?.symbols ?? []).filter((r) => r.name === "documents" && r.kind === "sql_table");
  assert(tables.length === 1, "search_symbols('documents') finds the sql_table", JSON.stringify(search)?.slice(0, 600));
  const table = tables[0];
  const colSearch = await call("search_symbols", { query: "reviewer_id", strategy: "name", limit: 10, profile: "verbose" });
  const col = (colSearch?.results ?? colSearch?.symbols ?? []).find((r) => r.name === "reviewer_id");
  assert(col?.kind === "sql_column" && col?.filePath === "db/migrations/002-alter.sql", "the ALTER-added column is defined at the ALTER site", JSON.stringify(colSearch)?.slice(0, 400));

  // ── who touches documents ───────────────────────────────────────────────────────────────
  const chain = await call("get_call_chain", { symbolId: table?.symbolId, direction: "callers", depth: 1, limit: 100 });
  dump("callers of documents", chain);
  const hops = chain?.edges ?? [];
  const has = (pred, label) => {
    const hit = hops.find(pred);
    assert(Boolean(hit), label, JSON.stringify(hops.map((h) => [h.fromName, h.fromFilePath, h.fromLine, h.type])).slice(0, 900));
    return hit;
  };
  has((h) => h.fromKind === "sql_statement" && h.fromName === "alter table documents" && h.fromFilePath === "db/migrations/002-alter.sql" && h.fromLine === 2, "the ALTER in 002 (file:line) touches documents");
  const grant = has((h) => h.type === "SQL_GRANT" && /grant select, insert on table public\.documents to app_reader/.test(h.fromName ?? ""), "the GRANT in 003 is listed, naming role and privileges");
  assert(/grant select,insert to app_reader/.test(grant?.reason ?? ""), "the GRANT hop's reason carries the privileges and the role", grant?.reason);
  has((h) => h.type === "SQL_GRANT" && /^revoke select, insert/.test(h.fromName ?? "") && h.fromFilePath === "db/migrations/003-grant.down.sql", "the REVOKE in the down migration is listed");
  has((h) => h.fromKind === "sql_index" && h.fromName === "documents_owner", "the index on documents is listed");
  has((h) => h.fromKind === "sql_view" && h.fromName === "open_documents", "the view reading documents is listed");
  has((h) => h.fromKind === "sql_function" && h.fromName === "count_documents", "the LANGUAGE sql function reading documents is listed");
  has((h) => h.fromKind === "sql_policy" && h.fromName === "documents_read", "the policy on documents is listed");
  has((h) => h.type === "SQL_REFERENCES" || h.type === "SQL_QUERY", "at least one FK or TS hop");
  const tsHops = hops.filter((h) => h.type === "SQL_QUERY");
  const tsNames = new Set(tsHops.map((h) => h.fromName));
  assert(tsNames.has("SELECT_DOCUMENTS") && tsNames.has("loadDocuments") && tsNames.has("insertDocument"),
    "the TS sites are listed: the SQL const, the function passing it to pool.query, the client.query<T> literal", JSON.stringify([...tsNames]));
  assert(tsHops.every((h) => h.fromFilePath === "src/adapter.ts" && typeof h.fromLine === "number"), "each TS site carries file and line");
  assert(/ts query const SELECT_DOCUMENTS via SELECT_DOCUMENTS \(src\/adapter\.ts:4\)/.test(tsHops.find((h) => h.fromName === "loadDocuments")?.reason ?? ""),
    "a same-file const at .query( says via CONST (file:line)", tsHops.find((h) => h.fromName === "loadDocuments")?.reason);
  const sqlHops = hops.filter((h) => String(h.type).startsWith("SQL_"));
  assert(sqlHops.length > 0 && sqlHops.every((h) => h.provenance === "name_resolved" && /^name_resolved/.test(h.reason ?? "") && h.confidence === 0.6),
    "every SQL hop is labelled name_resolved at 0.6 — never exact or high", JSON.stringify(sqlHops.map((h) => [h.provenance, h.confidence])).slice(0, 400));
  assert(chain?.coverage?.confidence !== "high", "a traversal standing on name_resolved hops is not reported as high coverage", JSON.stringify(chain?.coverage));

  // The function's callers include the TS call through a query literal.
  const fn = hops.find((h) => h.fromKind === "sql_function" && h.fromName === "count_documents");
  const fnCallers = await call("get_call_chain", { symbolId: fn?.fromId, direction: "callers", depth: 1 });
  dump("callers of count_documents", fnCallers);
  assert((fnCallers?.edges ?? []).some((h) => h.fromName === "countFor" && h.type === "SQL_QUERY"), "count_documents is called from TS countFor via a query literal", JSON.stringify(fnCallers)?.slice(0, 500));

  // find_impact_files on the migration that creates the table reaches the adapter.
  const impact = await call("find_impact_files", { filePath: "db/migrations/001-create.sql", view: "files", profile: "verbose" });
  dump("impact 001", impact);
  assert(JSON.stringify(impact).includes("src/adapter.ts"), "find_impact_files(001-create.sql) lists the TS adapter", JSON.stringify(impact)?.slice(0, 500));

  // ── gaps, tokens, migration order, columns ──────────────────────────────────────────────
  const health = await call("health_check", {});
  dump("health", health);
  const lane = health?.sqlLane;
  assert(lane?.sqlFiles === 9, "health_check reports 9 indexed .sql files", JSON.stringify(lane));
  const gaps = lane?.gapSamples ?? [];
  assert(gaps.some((g) => g.filePath === "db/migrations/004-gap.sql" && g.line === 1 && /create publication/.test(g.name)), "the unparseable statement is a named gap with file:line", JSON.stringify(gaps));
  assert(gaps.some((g) => g.filePath === "src/adapter.ts" && /dynamic table name/.test(g.name)), "the dynamic TS table name is a named gap", JSON.stringify(gaps));
  assert(!JSON.stringify(health?.latestRun?.skippedByReason ?? []).includes(".sql"), "no .sql file is skipped as unknown_extension", JSON.stringify(health?.latestRun?.skippedByReason));

  const order = await q("select s1.file_path as fromFile, s2.file_path as toFile, e.reason from edges e join symbols s1 on s1.symbol_id = e.from_id and s1.repo_id = e.repo_id join symbols s2 on s2.symbol_id = e.to_id and s2.repo_id = e.repo_id where e.repo_id = :repoId and e.type = 'SQL_MIGRATION_ORDER' order by 1");
  dump("order", order);
  const pairs = order.map((r) => `${r.fromFile}>${r.toFile}`);
  assert(pairs.includes("db/migrations/002-alter.sql>db/migrations/001-create.sql") && pairs.includes("db/migrations/004-gap.sql>db/migrations/003-grant.sql")
    && pairs.includes("db/migrations/003-grant.down.sql>db/migrations/003-grant.sql") && pairs.includes("db/migrations/001-create.sql>db/migrations/000-baseline.sql")
    && pairs.includes("db/migrations/005-replace.down.sql>db/migrations/005-replace.sql") && order.length === 7, "migration order follows the filename sequence; the down file points at its up file", JSON.stringify(pairs));

  const colEdges = await q("select e.to_id as toId, s.name as col from edges e left join symbols s on s.symbol_id = e.to_id and s.repo_id = e.repo_id where e.repo_id = :repoId and e.type = 'SQL_QUERY' and (e.to_id like 'sqlcolumn:%' or s.kind = 'sql_column')");
  assert(colEdges.some((r) => r.col === "owner_id") && colEdges.some((r) => r.col === "title"), "single-table query columns resolve to sql_column symbols", JSON.stringify(colEdges));

  const dead = await call("dead_code_scan", { limit: 200, profile: "verbose" });
  assert(!/sql_(table|column|view|index|function|policy|statement|role)/.test(JSON.stringify(dead)), "dead_code_scan reports no SQL symbol", JSON.stringify(dead)?.slice(0, 400));

  // ── release I3: one current definition per name ────────────────────────────────────────
  const auditSearch = await call("search_symbols", { query: "audit_log", strategy: "name", limit: 20 });
  dump("search audit_log", auditSearch);
  const auditRows = (auditSearch?.symbols ?? []).filter((r) => r.name === "audit_log" && r.kind === "sql_table");
  const auditCurrent = auditRows.find((r) => r.sqlDefinition?.current === true);
  const auditArchive = auditRows.find((r) => r.sqlDefinition?.current === false);
  assert(auditRows.length === 2 && auditCurrent?.filePath === "db/migrations/000-baseline.sql" && auditArchive?.filePath === "db/migrations/archive/0004-audit.sql",
    "search_symbols: the baseline audit_log is current, the archive one superseded (a baseline beats archive/ whatever the number)", JSON.stringify(auditRows));
  assert(JSON.stringify(auditCurrent?.sqlDefinition?.alsoDefinedAt) === JSON.stringify(["db/migrations/archive/0004-audit.sql:1"]) && auditCurrent?.sqlDefinition?.definitions === 2,
    "search_symbols carries alsoDefinedAt (file:line) on the current definition", JSON.stringify(auditCurrent?.sqlDefinition));

  const auditChain = await call("get_call_chain", { symbolId: auditCurrent?.symbolId, direction: "callers", depth: 1, limit: 200 });
  dump("callers of audit_log", auditChain);
  const auditHops = auditChain?.edges ?? [];
  assert(auditChain?.sqlDefinition?.current === true && auditChain?.sqlDefinition?.alsoDefinedAt?.[0] === "db/migrations/archive/0004-audit.sql:1",
    "get_call_chain on the current definition shows sqlDefinition.alsoDefinedAt", JSON.stringify(auditChain?.sqlDefinition));
  const hopKeys = auditHops.map((h) => `${h.fromId}|${h.type}`);
  assert(hopKeys.length > 0 && new Set(hopKeys).size === hopKeys.length, "every caller of audit_log appears ONCE (no per-definition-site copies)", JSON.stringify(hopKeys));
  const fromAt = (file, line) => auditHops.filter((h) => h.fromFilePath === file && h.fromLine === line);
  assert(fromAt("db/migrations/archive/0004-audit.sql", 6).length === 1 && fromAt("db/migrations/archive/0004-audit.sql", 6)[0].type === "SQL_GRANT",
    "the archive GRANT on audit_log binds once, to the current (baseline) table");
  assert(fromAt("db/migrations/archive/0004-audit.sql", 5).length === 1, "the archive ALTER binds once to the current table");
  assert(fromAt("db/migrations/005-replace.sql", 4).length === 1, "the 005 ALTER binds once");
  const fnReaders = auditHops.filter((h) => h.fromKind === "sql_function" && h.fromName === "usage_fn").map((h) => `${h.fromFilePath}:${h.fromLine}`).sort();
  assert(JSON.stringify(fnReaders) === JSON.stringify(["db/migrations/000-baseline.sql:6", "db/migrations/005-replace.down.sql:1", "db/migrations/005-replace.sql:1", "db/migrations/archive/0004-audit.sql:7"]),
    "each usage_fn version that reads audit_log is listed once (outbound reads stay per version)", JSON.stringify(fnReaders));
  assert(auditHops.every((h) => h.provenance === "name_resolved" && h.confidence === 0.6), "audit_log hops stay name_resolved at 0.6",
    JSON.stringify(auditHops.map((h) => [h.provenance, h.confidence])));
  // "Who touches X" counts statements: the SQL_USES edges equal the distinct (file, line) of their sources.
  const usesCount = await q(`select count(*) as n, count(distinct s.file_path || ':' || s.line) as sites from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id where e.repo_id = :repoId and e.type = 'SQL_USES' and e.to_id = '${auditCurrent?.symbolId}'`);
  assert(usesCount[0]?.n > 0 && usesCount[0]?.n === usesCount[0]?.sites, "SQL_USES into audit_log = distinct (file, line) of the touching statements", JSON.stringify(usesCount));
  const archiveChain = await call("get_call_chain", { symbolId: auditArchive?.symbolId, direction: "callers", depth: 1 });
  assert((archiveChain?.edges ?? archiveChain?.path ?? []).length === 0 && archiveChain?.sqlDefinition?.current === false
    && archiveChain?.sqlDefinition?.currentDefinition === "db/migrations/000-baseline.sql:1",
    "the superseded archive table has no callers and says which definition is current", JSON.stringify(archiveChain)?.slice(0, 500));

  // usage_fn: current = the 005 replacement (not its .down.sql); grants and the TS caller bind to it once.
  const fnSearch = await call("search_symbols", { query: "usage_fn", strategy: "name", limit: 20, kind: "sql_function" });
  const fnRows = (fnSearch?.symbols ?? []).filter((r) => r.name === "usage_fn");
  const fnCurrent = fnRows.find((r) => r.sqlDefinition?.current === true);
  assert(fnRows.length === 4 && fnCurrent?.filePath === "db/migrations/005-replace.sql", "usage_fn: 4 definition sites, the 005 replacement is current (a .down.sql never is)", JSON.stringify(fnRows));
  const fnDetail = await call("get_symbol_detail", { symbolId: fnCurrent?.symbolId });
  assert(JSON.stringify([...(fnDetail?.sqlDefinition?.alsoDefinedAt ?? [])].sort()) === JSON.stringify(["db/migrations/000-baseline.sql:6", "db/migrations/005-replace.down.sql:1", "db/migrations/archive/0004-audit.sql:7"]),
    "get_symbol_detail lists the other 3 definition sites as alsoDefinedAt", JSON.stringify(fnDetail?.sqlDefinition));
  const fnChain = await call("get_call_chain", { symbolId: fnCurrent?.symbolId, direction: "callers", depth: 1, limit: 100 });
  dump("callers of usage_fn", fnChain);
  const fnHops = fnChain?.edges ?? [];
  const fnKeys = fnHops.map((h) => `${h.fromFilePath}:${h.fromLine}|${h.fromName}`).sort();
  assert(new Set(fnKeys).size === fnKeys.length, "each usage_fn caller appears once", JSON.stringify(fnKeys));
  assert(fnHops.filter((h) => h.type === "SQL_GRANT").length === 3, "3 grant/revoke statements (baseline revoke + grant, archive grant), one row each", JSON.stringify(fnKeys));
  assert(fnHops.some((h) => h.fromName === "SELECT_USAGE") && fnHops.filter((h) => h.fromName === "usage").length === 1
    && /via SELECT_USAGE \(src\/audit-sql\.ts:2\)/.test(fnHops.find((h) => h.fromName === "usage")?.reason ?? ""),
    "the TS const and its importing caller appear once each; the caller's hop says via SELECT_USAGE (file:line)", JSON.stringify(fnHops.map((h) => [h.fromName, h.reason])));
  const fnCallees = await call("get_call_chain", { symbolId: fnCurrent?.symbolId, direction: "callees", depth: 1 });
  const baseFn = fnRows.find((r) => r.filePath === "db/migrations/000-baseline.sql");
  const baseCallees = await call("get_call_chain", { symbolId: baseFn?.symbolId, direction: "callees", depth: 1 });
  const calleeNames = (c) => (c?.edges ?? []).map((h) => h.toName).sort();
  assert(JSON.stringify(calleeNames(fnCallees)) === JSON.stringify(["audit_log", "documents"]) && JSON.stringify(calleeNames(baseCallees)) === JSON.stringify(["audit_log"]),
    "CREATE OR REPLACE: the 005 body reads documents + audit_log, the baseline body only audit_log", `${JSON.stringify(calleeNames(fnCallees))} / ${JSON.stringify(calleeNames(baseCallees))}`);

  // ── release I4: imported query consts are followed to the calling symbol ────────────────────
  const recordHop = auditHops.find((h) => h.fromName === "recordAudit");
  assert(recordHop?.type === "SQL_QUERY" && recordHop.fromFilePath === "src/audit-store.ts" && recordHop.provenance === "name_resolved" && recordHop.confidence === 0.6
    && /^name_resolved[^:]*: ts query imported const INSERT_ROW via INSERT_AUDIT_LOG \(src\/audit-sql\.ts:1\) insert into \(line 4\) \| sqltable:audit_log$/.test(recordHop.reason ?? ""),
    "recordAudit (renamed import) touches audit_log via INSERT_AUDIT_LOG (file:line), name_resolved 0.6", JSON.stringify(recordHop));
  assert(auditHops.some((h) => h.fromName === "INSERT_AUDIT_LOG"), "the const's own declaration still touches audit_log");
  const pageEdges = await q("select e.to_id as t, e.reason from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id where e.repo_id = :repoId and s.name = 'pageSize' and e.type like 'SQL%'");
  assert(pageEdges.length === 1 && pageEdges[0].t === "sqlconst:./audit-sql.js#PAGE_SIZE" && /^unresolved sql token \(not a sql const\)/.test(pageEdges[0].reason),
    "an imported const that is not SQL produces no SQL target (only its labelled anchor)", JSON.stringify(pageEdges));

  let ints = await integrity();
  assert(ints.i1 === 0 && ints.i2 === 0, "I1 = I2 = 0 after the full run", JSON.stringify(ints));

  // ── full = incremental after a row-shifting edit of the defining migration ──────────────
  const path001 = join(tmpDir, "db/migrations/001-create.sql");
  writeFileSync(path001, "-- shifted\n\n\n" + readFileSync(path001, "utf8"), "utf8");
  // I4: shift the const module too — the importing caller is unchanged, its derived edges must follow.
  const pathConsts = join(tmpDir, "src/audit-sql.ts");
  writeFileSync(pathConsts, "// shifted\n\n" + readFileSync(pathConsts, "utf8"), "utf8");
  // I3: and the baseline, so the current definition's id moves under unchanged referrers.
  const pathBase = join(tmpDir, "db/migrations/000-baseline.sql");
  writeFileSync(pathBase, "-- shifted\n" + readFileSync(pathBase, "utf8"), "utf8");
  const inc = await call("index_repository", { repoPath: tmpDir, mode: "incremental" });
  assert(inc && !inc.error, "index_repository (incremental) after the edit", JSON.stringify(inc)?.slice(0, 300));
  ints = await integrity();
  assert(ints.i1 === 0 && ints.i2 === 0, "I1 = I2 = 0 after the incremental run", JSON.stringify(ints));
  const incGraph = await sqlGraph();
  const moved = await q("select count(*) as n from edges where repo_id = :repoId and type = 'SQL_QUERY' and reason like '%via INSERT_AUDIT_LOG (src/audit-sql.ts:3)%'");
  assert(moved[0]?.n >= 1, "after the incremental run the unchanged caller's edge names the const's NEW line", JSON.stringify(moved));
  const full = await call("index_repository", { repoPath: tmpDir, mode: "full" });
  assert(full && !full.error, "index_repository (full) on the same tree");
  ints = await integrity();
  assert(ints.i1 === 0 && ints.i2 === 0, "I1 = I2 = 0 after the reference full run", JSON.stringify(ints));
  const fullGraph = await sqlGraph();
  assert(incGraph === fullGraph, "incremental and full runs produce the same SQL edge set", `${incGraph.length} vs ${fullGraph.length}`);
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
