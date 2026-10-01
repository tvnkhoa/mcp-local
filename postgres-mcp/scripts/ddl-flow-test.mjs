/**
 * Live test for the raw-SQL DDL lane, over real stdio MCP against a throwaway Postgres.
 *
 * Phase 1.3 covers the two tools that change no database state: `ddl_status`, which reads the
 * ledger, and `ddl_create`, which writes files. Preview, dry run and apply join in phase 1.4.
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

import { HISTORY_DDL } from "../dist/services/ddl/ddlHistory.js";
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
