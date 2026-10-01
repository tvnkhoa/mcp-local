/**
 * Live test for the raw-SQL DDL lane, over real stdio MCP against a throwaway Postgres.
 *
 * Covers the whole lane: `ddl_status` and `ddl_create` (A–G), then preview, dry run and apply
 * (H–W): drift in each of its three forms, the risk gate, lock_timeout, CONCURRENTLY outside a
 * transaction, rollback through down scripts, inline-then-adopt, the advisory lock, and DDL that
 * reaches mcp_ops at run time.
 *
 * Same posture as `write-flow-test.mjs`. It provisions a container and a temporary migrations
 * directory, removes both afterwards, and never touches a configured environment. It skips
 * (exit 0) without Docker, lives under `smoke` rather than `test` for the same reason, and needs a
 * build first because it boots `dist/index.js`.
 *
 * Two environment names point at the one container: `dev`, which is writable, and `prod`, which is
 * read-only by name. That is how the prod rules are exercised without a second server.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";

import { DDL_LOCK_KEY, HISTORY_DDL } from "../dist/services/ddl/ddlHistory.js";
import { checksumOf } from "../dist/services/ddl/ddlFiles.js";

const CONTAINER = "postgres-mcp-ddl-flow-test";
const PORT = Number(process.env.POSTGRES_DDL_FLOW_TEST_PORT ?? 55434);
const PASSWORD = "ddl_flow_test_only";
const CONN = `postgres://probe:${PASSWORD}@127.0.0.1:${String(PORT)}/probe`;

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...opts });
}

function dockerAvailable() {
  return docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
}

async function startContainer() {
  docker(["rm", "-f", CONTAINER]);
  const run = docker([
    "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_USER=probe", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", "POSTGRES_DB=probe",
    "-p", `${String(PORT)}:5432`, "postgres:17-alpine"
  ]);
  if (run.status !== 0) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  // A real connection, not pg_isready: the image restarts its server once after initdb.
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = new pg.Client({ connectionString: CONN, connectionTimeoutMillis: 2000 });
    try {
      await probe.connect();
      await probe.query("select 1");
      await probe.end();
      return;
    } catch {
      await probe.end().catch(() => undefined);
    }
  }
  throw new Error("throwaway postgres never became ready");
}

async function main() {
  if (!dockerAvailable()) {
    console.log("SKIP: Docker is not available — the DDL-flow test needs a throwaway Postgres.");
    return;
  }
  console.log(`starting throwaway postgres on port ${String(PORT)}...`);
  await startContainer();

  const dir = await mkdtemp(path.join(os.tmpdir(), "ddl-flow-"));
  const db = new pg.Client({ connectionString: CONN });
  await db.connect();

  const serverEnv = { ...process.env };
  for (const key of Object.keys(serverEnv)) {
    if (/^(POSTGRES_|PG_|CH_|MCP_DB_)/.test(key)) {
      delete serverEnv[key];
    }
  }
  Object.assign(serverEnv, {
    POSTGRES_ENV_DEV: CONN,
    POSTGRES_ENV_PROD: CONN,
    POSTGRES_WRITABLE_ENVIRONMENTS: "dev",
    POSTGRES_DEFAULT_ENVIRONMENT: "dev",
    PGSSLMODE: "disable",
    POSTGRES_DDL_ENABLED: "true",
    POSTGRES_DDL_MIGRATIONS_DIR: dir
  });

  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "pipe", env: serverEnv });
  const mcp = new McpClient({ name: "postgres-mcp-ddl-flow-test", version: "0.1.0" });
  await mcp.connect(transport);

  const callRaw = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (Array.isArray(result.content) ? result.content : []).find((x) => x.type === "text")?.text ?? "null";
    return { isError: result.isError === true, payload: JSON.parse(text), text };
  };
  const call = async (name, args) => {
    const r = await callRaw(name, args);
    if (r.isError) {
      throw new Error(`${name} failed: ${r.text}`);
    }
    return r;
  };
  const status = async (environment = "dev") => (await call("ddl_status", { environment, profile: "standard" })).payload;
  const filesOnDisk = async () => (await readdir(dir)).sort();

  try {
    // ── A. an empty lane, before anything exists ────────────────────────────
    {
      const s = await status();
      check(
        "A/status-empty",
        s.historyTablePresent === false && s.efHistoryTablePresent === false && s.migrationsDirConfigured === true && s.summary.pending === 0,
        JSON.stringify(s.summary)
      );
    }

    // ── B. ddl_create writes an LF file pair, and leaks no path ─────────────
    let first;
    {
      const r = await call("ddl_create", {
        name: "add_orders",
        up: "create table orders (id int primary key, note text);\r\n",
        down: "drop table if exists orders;",
        profile: "standard"
      });
      first = r.payload;
      const files = await filesOnDisk();
      const upText = await readFile(path.join(dir, first.files[0]), "utf8");
      const s = await status();
      check(
        "B/create-writes-files",
        files.length === 2 &&
          first.files.every((f) => files.includes(f)) &&
          !upText.includes("\r") &&
          !r.text.includes(dir) &&
          !r.text.includes(dir.replace(/\\/g, "/")) &&
          s.summary.pending === 1 &&
          s.pending[0]?.version === first.version &&
          s.pending[0]?.hasDown === true,
        `files=${JSON.stringify(files)} pending=${JSON.stringify(s.pending)} leaksDir=${String(r.text.includes(dir))}`
      );
    }

    // ── C. noTransaction is written INTO the file ───────────────────────────
    {
      const r = await call("ddl_create", {
        name: "orders_note_idx",
        up: "create index concurrently if not exists orders_note_idx on orders (note)",
        down: "drop index concurrently if exists orders_note_idx",
        noTransaction: true,
        profile: "standard"
      });
      const upText = await readFile(path.join(dir, r.payload.files[0]), "utf8");
      const downText = await readFile(path.join(dir, r.payload.files[1]), "utf8");
      check(
        "C/create-writes-directive",
        r.payload.mode === "non_transactional" &&
          upText.startsWith("-- mcp:no-transaction\n") &&
          downText.startsWith("-- mcp:no-transaction\n") &&
          r.payload.version > first.version,
        `mode=${r.payload.mode} version=${r.payload.version} up=${JSON.stringify(upText.slice(0, 40))}`
      );
    }

    // ── D. a refused migration leaves no file behind ────────────────────────
    {
      const before = await filesOnDisk();
      const codes = [];
      for (const args of [
        { name: "seed", up: "insert into orders values (1, 'x')" },
        { name: "sneak", up: "create table mcp_ops.x (a int)" },
        { name: "half", up: "create table ok_t (a int)", down: "grant all on ok_t to public" },
        { name: "oldie", up: "create table old_t (a int)", version: "20000101000000" }
      ]) {
        const r = await callRaw("ddl_create", args);
        codes.push(r.isError ? r.payload.code : "ACCEPTED");
      }
      const after = await filesOnDisk();
      check(
        "D/create-refusals-write-nothing",
        JSON.stringify(codes) === JSON.stringify(["DDL_STATEMENT_NOT_ALLOWED", "DDL_RESERVED_SCHEMA", "DDL_STATEMENT_NOT_ALLOWED", "DDL_OUT_OF_ORDER"]) &&
          JSON.stringify(after) === JSON.stringify(before),
        `codes=${JSON.stringify(codes)} filesBefore=${String(before.length)} after=${String(after.length)}`
      );
    }

    // ── E. status reads the ledger, and catches an edited applied file ──────
    {
      // Stand in for ddl_apply (phase 1.4): create the ledger and record the first migration as
      // applied with the checksum of the file on disk.
      await db.query(HISTORY_DDL);
      const upText = await readFile(path.join(dir, first.files[0]), "utf8");
      await db.query(
        `insert into mcp_ops.ddl_history (version, name, kind, direction, checksum, execution_mode, status,
           statement_count, environment, applied_by, preview_id, duration_ms)
         values ($1, $2, 'file', 'up', $3, 'transactional', 'applied', 1, 'dev', 'test', 'p', 1)`,
        [first.version, first.name, checksumOf(upText)]
      );
      const applied = await status();

      await writeFile(path.join(dir, first.files[0]), upText.replace("note text", "note varchar(10)"), "utf8");
      const edited = await status();
      await writeFile(path.join(dir, first.files[0]), upText, "utf8");

      check(
        "E/status-reads-ledger",
        applied.historyTablePresent === true &&
          applied.summary.applied === 1 &&
          applied.summary.pending === 1 &&
          applied.applied[0]?.checksumMatches === true &&
          edited.summary.checksumMismatch === 1 &&
          edited.checksumMismatch[0]?.version === first.version,
        `applied=${JSON.stringify(applied.summary)} edited=${JSON.stringify(edited.summary)}`
      );
    }

    // ── F. status works on prod, and warns about EF and stray files ────────
    {
      await db.query(`create table "__EFMigrationsHistory" ("MigrationId" text primary key, "ProductVersion" text)`);
      await writeFile(path.join(dir, "notes.sql"), "-- not a migration", "utf8");
      const prod = await callRaw("ddl_status", { environment: "prod", profile: "standard" });
      const s = prod.payload;
      check(
        "F/status-on-prod",
        !prod.isError &&
          s.environment === "prod" &&
          s.efHistoryTablePresent === true &&
          s.warnings.some((w) => w.includes("__EFMigrationsHistory")) &&
          JSON.stringify(s.ignoredFiles) === JSON.stringify(["notes.sql"]),
        `isError=${String(prod.isError)} ef=${String(s.efHistoryTablePresent)} ignored=${JSON.stringify(s.ignoredFiles)}`
      );
    }

    // ── G. ddl_status never creates the ledger ──────────────────────────────
    {
      await db.query("drop schema mcp_ops cascade");
      await status();
      const exists = (await db.query("select to_regclass('mcp_ops.ddl_history') is not null as present")).rows[0].present;
      check("G/status-is-read-only", exists === false, `ledgerCreatedByStatus=${String(exists)}`);
    }

    // ═══ phase 1.4: preview → dry run → apply ═══════════════════════════════

    const preview = async (args) => callRaw("ddl_preview", { environment: "dev", profile: "standard", ...args });
    const dryRun = async (p) => callRaw("ddl_dry_run", { previewId: p.previewId, profile: "standard" });
    const apply = async (p, acknowledgeRisks) =>
      callRaw("ddl_apply", { previewId: p.previewId, approvalToken: p.approvalToken, profile: "standard", ...(acknowledgeRisks ? { acknowledgeRisks } : {}) });
    const create = async (args) => (await call("ddl_create", { profile: "standard", ...args })).payload;
    const exists = async (regclass) => (await db.query("select to_regclass($1) is not null as present", [regclass])).rows[0].present;
    const ledger = async () =>
      (await db.query("select version, name, kind, direction, status, failed_statement, error_sqlstate from mcp_ops.ddl_history order by id")).rows;

    // ── H. the first migration: preview, dry run, apply ─────────────────────
    {
      const { payload: p } = await preview({ direction: "up", target: first.version });
      const { payload: d } = await dryRun(p);
      const afterDry = await exists("public.orders");
      const { isError, payload: a } = await apply(p);
      const rows = await ledger();
      const s = await status();
      check(
        "H/preview-dryrun-apply",
        p.steps?.length === 1 &&
          p.requiredAcknowledgements?.length === 0 &&
          d.status === "ok" &&
          afterDry === false &&
          !isError &&
          a.status === "applied" &&
          a.schemaChanged === true &&
          a.diff?.addedTables?.includes("public.orders") &&
          a.dryRun === "ok" &&
          (await exists("public.orders")) &&
          rows.length === 1 &&
          rows[0].status === "applied" &&
          s.summary.applied === 1,
        `steps=${String(p.steps?.length)} dry=${d.status} tableAfterDry=${String(afterDry)} apply=${a.status ?? a.code} ledger=${JSON.stringify(rows)}`
      );
    }

    // ── I. CREATE INDEX CONCURRENTLY: skipped by the dry run, applied outside a transaction ──
    {
      const { payload: p } = await preview({ direction: "up" });
      const { payload: d } = await dryRun(p);
      const { isError, payload: a } = await apply(p);
      const index = (await db.query("select indisvalid from pg_index where indexrelid = to_regclass('public.orders_note_idx')")).rows[0];
      check(
        "I/concurrently-non-transactional",
        p.steps?.[0]?.mode === "non_transactional" &&
          d.steps?.[0]?.status === "skipped" &&
          !isError &&
          a.status === "applied" &&
          index?.indisvalid === true,
        `mode=${String(p.steps?.[0]?.mode)} dry=${String(d.steps?.[0]?.status)} apply=${a.status ?? a.code} valid=${String(index?.indisvalid)} detail=${String(a.error?.detail ?? "")}`
      );
    }

    // ── J. the schema changed between preview and apply ─────────────────────
    const customers = await create({ name: "add_customers", up: "create table customers (id int primary key)", down: "drop table if exists customers" });
    {
      const { payload: p } = await preview({ direction: "up" });
      await db.query("create table drift_t (a int)");
      const { isError, payload: a } = await apply(p);
      await db.query("drop table drift_t");
      check(
        "J/drift-schema",
        isError && a.code === "DDL_DRIFT" && /schema changed/.test(a.message) && !(await exists("public.customers")),
        `code=${String(a.code)} message=${String(a.message)}`
      );
    }

    // ── K. a migration file changed between preview and apply ───────────────
    {
      const { payload: p } = await preview({ direction: "up" });
      const file = path.join(dir, customers.files[0]);
      const original = await readFile(file, "utf8");
      await writeFile(file, `${original}comment on table customers is 'edited';\n`, "utf8");
      const { isError, payload: a } = await apply(p);
      await writeFile(file, original, "utf8");
      check(
        "K/drift-files",
        isError && a.code === "DDL_DRIFT" && /files changed/.test(a.message) && !(await exists("public.customers")),
        `code=${String(a.code)} message=${String(a.message)}`
      );
    }

    // ── L. two previews of the same step: the second apply sees the ledger moved ──
    {
      const { payload: p1 } = await preview({ direction: "up" });
      const { payload: p2 } = await preview({ direction: "up" });
      const first1 = await apply(p1);
      const second = await apply(p2);
      check(
        "L/drift-ledger",
        !first1.isError && second.isError && second.payload.code === "DDL_DRIFT" && /ledger changed/.test(second.payload.message),
        `first=${String(first1.payload.status)} second=${String(second.payload.code)}: ${String(second.payload.message)}`
      );
    }

    // ── M. a high risk must be acknowledged ─────────────────────────────────
    const dropNote = await create({
      name: "drop_orders_note",
      up: "drop index if exists orders_note_idx; alter table orders drop column note",
      down: "alter table orders add column note text"
    });
    {
      const { payload: p } = await preview({ direction: "up" });
      const without = await apply(p);
      const withAck = await apply(p, p.requiredAcknowledgements);
      const column = (await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name = 'note'")).rows.length;
      check(
        "M/risk-acknowledgement",
        JSON.stringify(p.requiredAcknowledgements) === JSON.stringify(["DROP_COLUMN"]) &&
          without.isError &&
          without.payload.code === "DDL_RISK_NOT_ACKNOWLEDGED" &&
          !withAck.isError &&
          withAck.payload.status === "applied" &&
          column === 0,
        `required=${JSON.stringify(p.requiredAcknowledgements)} without=${String(without.payload.code)} with=${String(withAck.payload.status ?? withAck.payload.code)}`
      );
    }

    // ── N. lock_timeout at the statement: a reader blocks the ALTER, not the planning ──
    const slow = await create({
      name: "orders_add_flag",
      up: "-- mcp:lock-timeout-ms=500\nalter table orders add column flag boolean",
      down: "alter table orders drop column if exists flag"
    });
    {
      const { payload: p } = await preview({ direction: "up" });
      const holder = new pg.Client({ connectionString: CONN });
      await holder.connect();
      // ACCESS SHARE is what any SELECT takes. It does not stop the snapshot reading the catalog,
      // but ADD COLUMN needs ACCESS EXCLUSIVE, so the migration's own 500 ms wait is what fires.
      await holder.query("begin; lock table orders in access share mode");
      const started = Date.now();
      const { isError, payload: a } = await apply(p);
      const elapsed = Date.now() - started;
      await holder.query("rollback");
      await holder.end();
      const failed = (await ledger()).filter((r) => r.version === slow.version);
      const column = (await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name = 'flag'")).rows.length;
      check(
        "N/lock-timeout",
        isError &&
          a.code === "DDL_LOCK_TIMEOUT" &&
          a.status === "failed" &&
          elapsed < 3000 &&
          column === 0 &&
          failed.length === 1 &&
          failed[0].status === "failed" &&
          failed[0].error_sqlstate === "55P03",
        `code=${String(a.code)} elapsed=${String(elapsed)}ms ledger=${JSON.stringify(failed)}`
      );
    }

    // ── N2. an exclusive lock on a table the snapshot reads: refused fast, before anything runs ──
    {
      const { payload: p } = await preview({ direction: "up" });
      const holder = new pg.Client({ connectionString: CONN });
      await holder.connect();
      await holder.query("begin; lock table orders in access exclusive mode");
      const started = Date.now();
      const { isError, payload: a } = await apply(p);
      const elapsed = Date.now() - started;
      await holder.query("rollback");
      await holder.end();
      const attempts = (await ledger()).filter((r) => r.version === slow.version).length;
      check(
        "N2/lock-timeout-at-planning",
        isError && a.code === "DDL_LOCK_TIMEOUT" && elapsed < 3000 && attempts === 1,
        `code=${String(a.code)} elapsed=${String(elapsed)}ms ledgerAttempts=${String(attempts)} message=${String(a.message)}`
      );
    }

    // ── O. a failed migration can be retried, and down reverts newest first ──
    {
      const { payload: retry } = await preview({ direction: "up" });
      const retried = await apply(retry);
      const { payload: p } = await preview({ direction: "down", target: customers.version });
      const order = (p.steps ?? []).map((s) => `${s.version}:${s.action}`);
      // Reverting orders_add_flag runs its down script, `drop column`: that needs acknowledging too.
      const done = await apply(p, p.requiredAcknowledgements);
      const note = (await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name = 'note'")).rows.length;
      const flag = (await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name = 'flag'")).rows.length;
      const s = await status();
      check(
        "O/retry-then-revert",
        retried.payload.status === "applied" &&
          JSON.stringify(order) === JSON.stringify([`${slow.version}:revert`, `${dropNote.version}:revert`]) &&
          JSON.stringify(p.requiredAcknowledgements) === JSON.stringify(["DROP_COLUMN"]) &&
          done.payload.status === "applied" &&
          note === 1 &&
          flag === 0 &&
          s.applied.map((x) => x.version).at(-1) === customers.version &&
          s.summary.pending === 2,
        `retry=${String(retried.payload.status)} order=${JSON.stringify(order)} revert=${String(done.payload.status ?? done.payload.code)} note=${String(note)} flag=${String(flag)}`
      );
    }

    // ── P. a migration with no down script cannot be reverted ───────────────
    {
      const noDown = await create({ name: "comment_orders", up: "comment on table orders is 'orders'" });
      const { payload: up } = await preview({ direction: "up" });
      await apply(up, up.requiredAcknowledgements);
      const { isError, payload } = await preview({ direction: "down", target: customers.version });
      check(
        "P/no-down-script",
        isError && payload.code === "DDL_NO_DOWN_SCRIPT" && payload.message.includes(noDown.version),
        `code=${String(payload.code)} message=${String(payload.message)}`
      );
    }

    // ── Q. an inline apply, then the same SQL saved as a file, is adopted — not run twice ──
    {
      const sql = "create table inline_t (a int)";
      const { payload: p } = await preview({ sql, label: "inline_t" });
      const inline = await apply(p);
      const saved = await create({ name: "inline_t", up: sql, down: "drop table if exists inline_t" });
      const { payload: up } = await preview({ direction: "up" });
      const adopted = await apply(up);
      const rows = (await ledger()).filter((r) => r.name === "inline_t");
      const s = await status();
      check(
        "Q/inline-then-adopt",
        inline.payload.status === "applied" &&
          up.steps?.length === 1 &&
          up.steps[0].action === "adopt" &&
          adopted.payload.status === "applied" &&
          adopted.payload.steps?.[0]?.status === "adopted" &&
          JSON.stringify(rows.map((r) => r.kind)) === JSON.stringify(["inline", "adopted"]) &&
          s.summary.inlineApplied === 0 &&
          s.applied.some((x) => x.version === saved.version),
        `inline=${String(inline.payload.status)} action=${String(up.steps?.[0]?.action)} adopted=${String(adopted.payload.steps?.[0]?.status)} kinds=${JSON.stringify(rows.map((r) => r.kind))}`
      );
    }

    // ── R. prod is never writable ───────────────────────────────────────────
    {
      const r = await callRaw("ddl_preview", { environment: "prod", sql: "create table prod_t (a int)" });
      check("R/prod-refused", r.isError && r.payload.code === "ENVIRONMENT_READ_ONLY", `code=${String(r.payload.code)}`);
    }

    // ── S. another session holding the DDL lock blocks apply, without waiting ──
    {
      const { payload: p } = await preview({ sql: "create table lock_t (a int)" });
      const holder = new pg.Client({ connectionString: CONN });
      await holder.connect();
      await holder.query("select pg_advisory_lock($1, $2)", [...DDL_LOCK_KEY]);
      const blocked = await apply(p);
      await holder.query("select pg_advisory_unlock($1, $2)", [...DDL_LOCK_KEY]);
      await holder.end();
      const after = await apply(p);
      check(
        "S/advisory-lock",
        blocked.isError && blocked.payload.code === "DDL_LOCKED" && !after.isError && (await exists("public.lock_t")),
        `blocked=${String(blocked.payload.code)} retried=${String(after.payload.status ?? after.payload.code)}`
      );
    }

    // ── T. a tampered token is refused, and a preview applies once ──────────
    {
      const { payload: p } = await preview({ sql: "create table once_t (a int)" });
      const tampered = await callRaw("ddl_apply", { previewId: p.previewId, approvalToken: `${p.approvalToken.slice(0, -2)}xx` });
      const ok1 = await apply(p);
      const again = await apply(p);
      check(
        "T/token-and-reuse",
        tampered.isError &&
          /APPROVAL_TOKEN/.test(tampered.payload.code) &&
          ok1.payload.status === "applied" &&
          again.isError &&
          again.payload.code === "PREVIEW_NOT_FOUND",
        `tampered=${String(tampered.payload.code)} first=${String(ok1.payload.status)} again=${String(again.payload.code)}`
      );
    }

    // ── U. a failing statement rolls back its whole migration ───────────────
    {
      const { payload: p } = await preview({ sql: "create table atom_t (a int); create table atom_t (a int)", label: "atom" });
      const { isError, payload: a } = await apply(p);
      const row = (await ledger()).filter((r) => r.name === "atom").at(-1);
      check(
        "U/transaction-atomic",
        isError &&
          a.code === "DDL_APPLY_FAILED" &&
          a.error?.sqlState === "42P07" &&
          !(await exists("public.atom_t")) &&
          row?.status === "failed" &&
          row?.failed_statement === 1,
        `code=${String(a.code)} sqlState=${String(a.error?.sqlState)} table=${String(await exists("public.atom_t"))} ledger=${JSON.stringify(row)}`
      );
    }

    // ── V. DDL that writes to mcp_ops at run time is rolled back ────────────
    {
      // The function body is opaque to the guardrail (it is a string); its effect is not.
      await db.query(`create function sneak_default() returns int language plpgsql volatile as $f$
        begin insert into mcp_ops.audit_log (tool, environment, status) values ('sneak', 'x', 'x'); return 1; end $f$`);
      await db.query("insert into orders (id) values (1), (2)");
      const before = Number((await db.query("select count(*)::int as n from mcp_ops.audit_log")).rows[0].n);
      const { payload: p } = await preview({ sql: "alter table orders add column sneaky int default sneak_default()", label: "sneaky" });
      const { isError, payload: a } = await apply(p);
      const auditDelta = Number((await db.query("select count(*)::int as n from mcp_ops.audit_log where tool = 'sneak'")).rows[0].n);
      const column = (await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name = 'sneaky'")).rows.length;
      check(
        "V/internal-write-rolled-back",
        isError && a.code === "DDL_RESERVED_SCHEMA" && auditDelta === 0 && column === 0 && before > 0,
        `code=${String(a.code)} sneakRows=${String(auditDelta)} column=${String(column)}`
      );
    }

    // ── V2. DDL that TRUNCATEs the ledger at run time is rolled back ────────
    {
      // Review finding 1: no tuple counter moves for TRUNCATE; the catalog fingerprint does.
      await db.query(`create function wipe_default() returns int language plpgsql volatile as $f$
        begin execute 'truncate ' || 'mcp_' || 'ops.ddl_history'; return 1; end $f$`);
      const appliedRows = async () => Number((await db.query("select count(*)::int as n from mcp_ops.ddl_history where status = 'applied'")).rows[0].n);
      const before = await appliedRows();
      const { payload: p } = await preview({ sql: "alter table orders add column wiped int default wipe_default()", label: "wiper" });
      const { isError, payload: a } = await apply(p);
      const after = await appliedRows();
      check(
        "V2/truncate-ledger-rolled-back",
        isError && a.code === "DDL_RESERVED_SCHEMA" && before > 0 && after === before,
        `code=${String(a.code)} appliedLedgerRows=${String(before)}→${String(after)}`
      );
    }

    // ── W. the dry run catches a failure that apply would hit ───────────────
    {
      const { payload: p } = await preview({ sql: "alter table no_such_table add column a int", label: "doomed" });
      const { isError, payload: d } = await dryRun(p);
      check(
        "W/dry-run-catches-failure",
        isError && d.code === "DDL_APPLY_FAILED" && d.error?.sqlState === "42P01" && d.status === "failed",
        `code=${String(d.code)} sqlState=${String(d.error?.sqlState)}`
      );
    }
  } finally {
    await mcp.close().catch(() => undefined);
    await db.end().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} scenarios passed`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("DDL_FLOW_TEST_FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    docker(["rm", "-f", CONTAINER]);
  });
