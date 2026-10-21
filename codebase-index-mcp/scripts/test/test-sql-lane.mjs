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
  const sqlHops = hops.filter((h) => String(h.type).startsWith("SQL_"));
  assert(sqlHops.length > 0 && sqlHops.every((h) => h.provenance === "name_resolved" && /^name_resolved/.test(h.reason ?? "") && h.confidence === 0.6),
    "every SQL hop is labelled name_resolved at 0.6 — never exact or high", JSON.stringify(sqlHops.map((h) => [h.provenance, h.confidence])).slice(0, 400));
  assert(chain?.coverage?.confidence !== "high", "a traversal standing on name_resolved hops is not reported as high coverage", JSON.stringify(chain?.coverage));

  // The function's callers include the TS call through a query literal.
  const fn = hops.find((h) => h.fromKind === "sql_function");
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
  assert(lane?.sqlFiles === 5, "health_check reports 5 indexed .sql files", JSON.stringify(lane));
  const gaps = lane?.gapSamples ?? [];
  assert(gaps.some((g) => g.filePath === "db/migrations/004-gap.sql" && g.line === 1 && /create publication/.test(g.name)), "the unparseable statement is a named gap with file:line", JSON.stringify(gaps));
  assert(gaps.some((g) => g.filePath === "src/adapter.ts" && /dynamic table name/.test(g.name)), "the dynamic TS table name is a named gap", JSON.stringify(gaps));
  assert(!JSON.stringify(health?.latestRun?.skippedByReason ?? []).includes(".sql"), "no .sql file is skipped as unknown_extension", JSON.stringify(health?.latestRun?.skippedByReason));

  const order = await q("select s1.file_path as fromFile, s2.file_path as toFile, e.reason from edges e join symbols s1 on s1.symbol_id = e.from_id and s1.repo_id = e.repo_id join symbols s2 on s2.symbol_id = e.to_id and s2.repo_id = e.repo_id where e.repo_id = :repoId and e.type = 'SQL_MIGRATION_ORDER' order by 1");
  dump("order", order);
  const pairs = order.map((r) => `${r.fromFile}>${r.toFile}`);
  assert(pairs.includes("db/migrations/002-alter.sql>db/migrations/001-create.sql") && pairs.includes("db/migrations/004-gap.sql>db/migrations/003-grant.sql")
    && pairs.includes("db/migrations/003-grant.down.sql>db/migrations/003-grant.sql") && order.length === 4, "migration order follows the filename sequence; the down file points at its up file", JSON.stringify(pairs));

  const colEdges = await q("select e.to_id as toId, s.name as col from edges e left join symbols s on s.symbol_id = e.to_id and s.repo_id = e.repo_id where e.repo_id = :repoId and e.type = 'SQL_QUERY' and (e.to_id like 'sqlcolumn:%' or s.kind = 'sql_column')");
  assert(colEdges.some((r) => r.col === "owner_id") && colEdges.some((r) => r.col === "title"), "single-table query columns resolve to sql_column symbols", JSON.stringify(colEdges));

  const dead = await call("dead_code_scan", { limit: 200, profile: "verbose" });
  assert(!/sql_(table|column|view|index|function|policy|statement|role)/.test(JSON.stringify(dead)), "dead_code_scan reports no SQL symbol", JSON.stringify(dead)?.slice(0, 400));

  let ints = await integrity();
  assert(ints.i1 === 0 && ints.i2 === 0, "I1 = I2 = 0 after the full run", JSON.stringify(ints));

  // ── full = incremental after a row-shifting edit of the defining migration ──────────────
  const path001 = join(tmpDir, "db/migrations/001-create.sql");
  writeFileSync(path001, "-- shifted\n\n\n" + readFileSync(path001, "utf8"), "utf8");
  const inc = await call("index_repository", { repoPath: tmpDir, mode: "incremental" });
  assert(inc && !inc.error, "index_repository (incremental) after the edit", JSON.stringify(inc)?.slice(0, 300));
  ints = await integrity();
  assert(ints.i1 === 0 && ints.i2 === 0, "I1 = I2 = 0 after the incremental run", JSON.stringify(ints));
  const incGraph = await sqlGraph();
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
