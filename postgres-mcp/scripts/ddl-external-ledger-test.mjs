/**
 * Live test for external-ledger mode (POSTGRES_DDL_EXTERNAL_LEDGER), over real stdio MCP against a
 * throwaway Postgres.
 *
 * The scenario is wec.aria's: a repo whose own runner (`db/migrate.sh`) applies psql-style
 * `NNNN-name.sql` files and records `(filename, sha256sum)` in `public.schema_migration`. Two files
 * are already applied, the way that runner left them, and the third has the shape of its 0017:
 * `\set ON_ERROR_STOP on`, its own BEGIN / COMMIT, a SECURITY DEFINER function handed to an owner
 * role, REVOKE FROM PUBLIC and GRANT EXECUTE. The lane must apply it, record it in the repo's
 * ledger with the checksum `sha256sum` would compute, and leave no second ledger behind.
 *
 * Same posture as `ddl-flow-test.mjs`: its own container and temporary directory, removed
 * afterwards; skips (exit 0) without Docker; needs a build because it boots `dist/index.js`.
 *
 * Three environments point at three databases in the one container: `dev` (the repo's database),
 * `adopt` (a populated schema with an empty ledger) and `fresh` (nothing at all).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";

const CONTAINER = "postgres-mcp-ddl-external-ledger-test";
const PORT = Number(process.env.POSTGRES_DDL_EXTERNAL_LEDGER_TEST_PORT ?? 55436);
const PASSWORD = "ddl_external_ledger_test_only";
const conn = (db) => `postgres://probe:${PASSWORD}@127.0.0.1:${String(PORT)}/${db}`;

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

const docker = (args) => spawnSync("docker", args, { encoding: "utf8" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = new pg.Client({ connectionString: conn("probe"), connectionTimeoutMillis: 2000 });
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

// The ledger exactly as wec.aria's db/migrate.sh creates it.
const LEDGER_DDL = `
  create table if not exists schema_migration (
    filename   text        primary key,
    checksum   text        not null,
    applied_at timestamptz not null default now()
  )`;

const FILE_1 = "-- 0001\nbegin;\ncreate table public.usage_events (id int, usage_kind text, created_at timestamptz);\ncreate table public.chunks (id int);\ncommit;\n";
const FILE_2 = "-- 0002\nbegin;\ncreate table public.review_run (id int primary key);\ncommit;\n";
// The shape of wec.aria's 0017. CRLF line endings on purpose: the checksum must be over the
// bytes on disk, as sha256sum takes it, not over normalized text.
const FILE_3 = [
  "-- 0003: a review run counts its window",
  "",
  "\\set ON_ERROR_STOP on",
  "",
  "begin;",
  "",
  "alter table public.review_run add column if not exists turns_in_window integer;",
  "-- Evaluated once, at ADD COLUMN: proves POSTGRES_DDL_SESSION_SETTINGS reached the migration.",
  "alter table public.review_run add column if not exists market text default current_setting('aria.expected_market');",
  "",
  "create or replace function public.turns_recorded_in_window(p_from timestamptz, p_to timestamptz)",
  "  returns integer",
  "  language sql",
  "  stable",
  "  security definer",
  "  set search_path = pg_catalog, public",
  "as $$",
  "  select count(*)::integer from usage_events u where u.usage_kind = 'turn' and u.created_at >= p_from and u.created_at <= p_to;",
  "$$;",
  "",
  "alter function public.turns_recorded_in_window(timestamptz, timestamptz) owner to aria;",
  "",
  "comment on function public.turns_recorded_in_window(timestamptz, timestamptz) is 'one integer; granted to aria_review only';",
  "",
  "revoke all on function public.turns_recorded_in_window(timestamptz, timestamptz) from public;",
  "grant execute on function public.turns_recorded_in_window(timestamptz, timestamptz) to aria_review;",
  "",
  "commit;",
  ""
].join("\r\n");

const ROLE_FILE = [
  "\\set ON_ERROR_STOP on",
  "begin;",
  "create schema if not exists review_jobs authorization aria_review;",
  "create table public.tenant (id int primary key, location text);",
  "insert into public.tenant values (1, 'syd'), (2, 'mel'), (3, '');",
  "create table public.tenant_location (tenant_id int, location text);",
  "do $$ begin insert into public.tenant_location select id, location from public.tenant where location <> ''; end $$;",
  "update public.tenant set location = null where location = '';",
  "alter table public.tenant drop column location;",
  "commit;",
  ""
].join("\n");

async function runSessionRoleScenario(baseEnv) {
  const admin = new pg.Client({ connectionString: conn("probe") });
  await admin.connect();
  await admin.query("create database roles");
  await admin.query(`create role deployer login nosuperuser password '${PASSWORD}'; create role outsider login nosuperuser password '${PASSWORD}'; grant aria to deployer`);
  await admin.end();
  const roles = new pg.Client({ connectionString: conn("roles") });
  await roles.connect();
  // aria creates the objects, deployer writes the ledger row and the audit log (mcp_ops).
  await roles.query(`grant create on database roles to aria, deployer; grant create on schema public to aria; ${LEDGER_DDL}; grant select, insert on schema_migration to deployer, outsider`);

  const roleDir = await mkdtemp(path.join(os.tmpdir(), "ddl-session-role-"));
  await writeFile(path.join(roleDir, "0001-job-schema-and-tenant-location.sql"), ROLE_FILE);
  const login = (user, db) => `postgres://${user}:${PASSWORD}@127.0.0.1:${String(PORT)}/${db}`;
  const env = {
    ...baseEnv,
    POSTGRES_ENV_DEV: login("deployer", "roles"),
    POSTGRES_ENV_OUTSIDER: login("outsider", "roles"),
    POSTGRES_WRITABLE_ENVIRONMENTS: "dev,outsider",
    POSTGRES_DDL_MIGRATIONS_DIR: roleDir,
    POSTGRES_DDL_OWNER_ROLES: "aria,aria_review",
    POSTGRES_DDL_SESSION_ROLE: "aria"
  };
  delete env.POSTGRES_ENV_ADOPT;
  delete env.POSTGRES_ENV_FRESH;
  delete env.POSTGRES_DDL_ADOPTION_SENTINEL;
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "pipe", env });
  const mcp = new McpClient({ name: "postgres-mcp-ddl-session-role-test", version: "0.1.0" });
  await mcp.connect(transport);
  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (Array.isArray(result.content) ? result.content : []).find((x) => x.type === "text")?.text ?? "null";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  };

  try {
    // A login that cannot SET ROLE aria is refused before anything is planned.
    const outsider = await call("ddl_preview", { environment: "outsider" });
    check("X8a/login-not-member-of-session-role-refused", outsider.isError && outsider.payload.code === "DDL_SESSION_ROLE_NOT_MEMBER", `code=${String(outsider.payload.code)}`);

    // aria is not yet a member of aria_review, so AUTHORIZATION aria_review cannot run as aria.
    const blocked = await call("ddl_preview", { environment: "dev" });
    check(
      "X8b/authorization-to-a-role-aria-cannot-become-blocked",
      blocked.isError && blocked.payload.code === "DDL_RISK_BLOCKED" && /runs as aria, which cannot SET ROLE aria_review/.test(blocked.payload.message),
      `code=${String(blocked.payload.code)} message=${String(blocked.payload.message).slice(0, 140)}`
    );

    await roles.query("grant aria_review to aria");
    const preview = await call("ddl_preview", { environment: "dev", profile: "standard" });
    const p = preview.payload;
    // No DROP_COLUMN: tenant is created earlier in the same plan, so it holds nothing anyone relied on.
    const acks = ["PRIVILEGE_CHANGE", "DATA_CHANGE", "DO_BLOCK"];
    check(
      "X8c/preview-runs-as-aria-and-asks-for-every-acknowledgement",
      !preview.isError && p.runsAs === "aria" && acks.every((code) => p.requiredAcknowledgements.includes(code)),
      `runsAs=${String(p.runsAs)} ack=${JSON.stringify(p.requiredAcknowledgements)} code=${String(p.code)} message=${String(p.message ?? "").slice(0, 140)}`
    );
    const dry = await call("ddl_dry_run", { previewId: p.previewId });
    const rows = dry.payload.steps?.[0]?.rowsAffected ?? [];
    check(
      "X8d/dry-run-reports-rows-per-data-change",
      !dry.isError && dry.payload.status === "ok" && JSON.stringify(rows.map((r) => r.rows)) === JSON.stringify([3, 1]),
      `status=${String(dry.payload.status)} rows=${JSON.stringify(rows)} error=${JSON.stringify(dry.payload.error)}`
    );
    const applied = await call("ddl_apply", { previewId: p.previewId, approvalToken: p.approvalToken, acknowledgeRisks: p.requiredAcknowledgements });
    check("X8e/apply-applies", !applied.isError && applied.payload.status === "applied", `status=${String(applied.payload.status)} error=${JSON.stringify(applied.payload.error)}`);

    const facts = (
      await roles.query(
        `select (select tableowner from pg_tables where schemaname = 'public' and tablename = 'tenant') as tenant_owner,
                (select tableowner from pg_tables where schemaname = 'public' and tablename = 'tenant_location') as location_owner,
                (select nspowner::regrole::text from pg_namespace where nspname = 'review_jobs') as schema_owner,
                (select count(*)::int from public.tenant_location) as moved,
                exists (select 1 from information_schema.columns where table_name = 'tenant' and column_name = 'location') as old_column,
                exists (select 1 from schema_migration where filename = '0001-job-schema-and-tenant-location.sql') as recorded`
      )
    ).rows[0];
    check(
      "X8f/objects-owned-by-aria-schema-by-its-role-rows-moved-ledger-written",
      facts.tenant_owner === "aria" &&
        facts.location_owner === "aria" &&
        facts.schema_owner === "aria_review" &&
        facts.moved === 2 &&
        facts.old_column === false &&
        facts.recorded === true,
      JSON.stringify(facts)
    );
  } finally {
    await mcp.close().catch(() => undefined);
    await roles.end().catch(() => undefined);
    await rm(roleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    console.log("SKIP: Docker is not available — the external-ledger test needs a throwaway Postgres.");
    return;
  }
  console.log(`starting throwaway postgres on port ${String(PORT)}...`);
  await startContainer();

  const admin = new pg.Client({ connectionString: conn("probe") });
  await admin.connect();
  for (const db of ["repo", "adopt", "fresh"]) {
    await admin.query(`create database ${db}`);
  }
  await admin.query("create role aria nologin; create role aria_review nologin; create role big nologin createrole");
  await admin.end();

  // `repo`: 0001 and 0002 applied by the repo's runner, rows written as it writes them.
  const dir = await mkdtemp(path.join(os.tmpdir(), "ddl-external-"));
  const files = { "0001-baseline.sql": FILE_1, "0002-review-run.sql": FILE_2, "0003-review-run-counts-its-window.sql": FILE_3 };
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(dir, name), text);
  }
  const repo = new pg.Client({ connectionString: conn("repo") });
  await repo.connect();
  await repo.query("create table public.usage_events (id int, usage_kind text, created_at timestamptz); create table public.chunks (id int); create table public.review_run (id int primary key)");
  await repo.query("insert into public.review_run values (1)");
  await repo.query(LEDGER_DDL);
  for (const name of ["0001-baseline.sql", "0002-review-run.sql"]) {
    await repo.query("insert into schema_migration (filename, checksum) values ($1, $2)", [name, sha256(await readFile(path.join(dir, name)))]);
  }
  // `adopt`: the schema is there (initdb, a dump), the ledger is empty.
  const adopt = new pg.Client({ connectionString: conn("adopt") });
  await adopt.connect();
  await adopt.query(`create table public.chunks (id int); ${LEDGER_DDL}`);
  await adopt.end();

  const serverEnv = { ...process.env };
  for (const key of Object.keys(serverEnv)) {
    if (/^(POSTGRES_|PG_|CH_|MCP_DB_)/.test(key)) {
      delete serverEnv[key];
    }
  }
  Object.assign(serverEnv, {
    POSTGRES_ENV_DEV: conn("repo"),
    POSTGRES_ENV_ADOPT: conn("adopt"),
    POSTGRES_ENV_FRESH: conn("fresh"),
    POSTGRES_WRITABLE_ENVIRONMENTS: "dev,adopt,fresh",
    POSTGRES_DEFAULT_ENVIRONMENT: "dev",
    PGSSLMODE: "disable",
    POSTGRES_DDL_ENABLED: "true",
    POSTGRES_DDL_MIGRATIONS_DIR: dir,
    POSTGRES_DDL_EXTERNAL_LEDGER: "public.schema_migration",
    POSTGRES_DDL_OWNER_ROLES: "aria,big",
    POSTGRES_DDL_SESSION_SETTINGS: "aria.expected_market=AU",
    POSTGRES_DDL_ADOPTION_SENTINEL: "public.chunks"
  });

  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "pipe", env: serverEnv });
  const mcp = new McpClient({ name: "postgres-mcp-ddl-external-ledger-test", version: "0.1.0" });
  await mcp.connect(transport);

  const callRaw = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (Array.isArray(result.content) ? result.content : []).find((x) => x.type === "text")?.text ?? "null";
    return { isError: result.isError === true, payload: JSON.parse(text), text };
  };
  const status = async (environment = "dev") => (await callRaw("ddl_status", { environment, profile: "standard" })).payload;

  try {
    // ── X1. status reads the repo's ledger ──────────────────────────────────
    {
      const s = await status();
      check(
        "X1/status-reads-external-ledger",
        s.ledger === "public.schema_migration" &&
          s.historyTablePresent === true &&
          JSON.stringify(s.applied.map((a) => [a.version, a.checksumMatches])) === JSON.stringify([["0001", true], ["0002", true]]) &&
          JSON.stringify(s.pending.map((p) => p.version)) === JSON.stringify(["0003"]) &&
          s.warnings.some((w) => /0003-review-run-counts-its-window\.sql has CRLF/.test(w)),
        `ledger=${String(s.ledger)} applied=${JSON.stringify(s.applied)} pending=${JSON.stringify(s.pending)}`
      );
    }

    // ── X2. preview → dry run → apply, with both acknowledgements ───────────
    let preview;
    {
      preview = await callRaw("ddl_preview", { environment: "dev", profile: "standard" });
      const p = preview.payload;
      check(
        "X2a/preview-requires-security-definer-and-privilege-change",
        !preview.isError &&
          p.steps.length === 1 &&
          p.steps[0].file === "0003-review-run-counts-its-window.sql" &&
          p.requiredAcknowledgements.includes("SECURITY_DEFINER") &&
          p.requiredAcknowledgements.includes("PRIVILEGE_CHANGE"),
        `ack=${JSON.stringify(p.requiredAcknowledgements)} steps=${JSON.stringify(p.steps?.map((s) => [s.file, s.statementCount]))} code=${String(p.code)}`
      );
      const dry = await callRaw("ddl_dry_run", { previewId: p.previewId });
      check("X2b/dry-run-passes", !dry.isError && dry.payload.status === "ok", `status=${String(dry.payload.status)} code=${String(dry.payload.code)}`);
      const unacked = await callRaw("ddl_apply", { previewId: p.previewId, approvalToken: p.approvalToken, acknowledgeRisks: ["SECURITY_DEFINER"] });
      check("X2c/apply-refuses-unacknowledged", unacked.isError && unacked.payload.code === "DDL_RISK_NOT_ACKNOWLEDGED", `code=${String(unacked.payload.code)}`);
      const applied = await callRaw("ddl_apply", { previewId: p.previewId, approvalToken: p.approvalToken, acknowledgeRisks: p.requiredAcknowledgements });
      check("X2d/apply-applies", !applied.isError && applied.payload.status === "applied", `status=${String(applied.payload.status)} error=${JSON.stringify(applied.payload.error)}`);
    }

    // ── X3. the repo's ledger, the privileges and the owner are what 0017 meant ──
    {
      const bytes = await readFile(path.join(dir, "0003-review-run-counts-its-window.sql"));
      const row = (await repo.query("select checksum from schema_migration where filename = '0003-review-run-counts-its-window.sql'")).rows[0];
      const fn = "public.turns_recorded_in_window(timestamptz, timestamptz)";
      const facts = (
        await repo.query(
          `select has_function_privilege('aria_review', $1, 'execute') as review_can,
                  exists (select 1 from aclexplode((select proacl from pg_proc where oid = $1::regprocedure)) a where a.grantee = 0) as public_can,
                  (select rolname from pg_roles where oid = (select proowner from pg_proc where oid = $1::regprocedure)) as owner,
                  (select market from public.review_run where id = 1) as market,
                  to_regclass('mcp_ops.ddl_history') is null as no_second_ledger`,
          [fn]
        )
      ).rows[0];
      check(
        "X3a/ledger-row-is-sha256sum-of-the-file",
        row?.checksum === sha256(bytes),
        `recorded=${String(row?.checksum).slice(0, 12)} sha256sum=${sha256(bytes).slice(0, 12)}`
      );
      check(
        "X3b/aria-review-can-execute-public-cannot",
        facts.review_can === true && facts.public_can === false && facts.owner === "aria",
        JSON.stringify({ review: facts.review_can, public: facts.public_can, owner: facts.owner })
      );
      check("X3c/session-setting-reached-the-migration", facts.market === "AU", `market=${String(facts.market)}`);
      check("X3d/no-second-ledger", facts.no_second_ledger === true, "mcp_ops.ddl_history must not exist");
      // What the repo's runner checks: every file's sha256sum equals its ledger row.
      const ledger = new Map((await repo.query("select filename, checksum from schema_migration")).rows.map((r) => [r.filename, r.checksum]));
      const runnerView = await Promise.all(Object.keys(files).map(async (name) => ledger.get(name) === sha256(await readFile(path.join(dir, name)))));
      check("X3e/repo-runner-sees-everything-applied", runnerView.every(Boolean), JSON.stringify(runnerView));
      const s = await status();
      check("X3f/status-nothing-pending", s.summary.pending === 0 && s.summary.applied === 3, JSON.stringify(s.summary));
    }

    // ── X4. a changed applied file stops every plan, as migrate.sh does ─────
    {
      const original = await readFile(path.join(dir, "0001-baseline.sql"));
      await writeFile(path.join(dir, "0001-baseline.sql"), `${original.toString("utf8")}-- edited\n`);
      const s = await status();
      const p = await callRaw("ddl_preview", { environment: "dev" });
      await writeFile(path.join(dir, "0001-baseline.sql"), original);
      check(
        "X4/checksum-mismatch",
        s.summary.checksumMismatch === 1 && p.isError && p.payload.code === "DDL_CHECKSUM_MISMATCH",
        `mismatch=${String(s.summary.checksumMismatch)} code=${String(p.payload.code)}`
      );
    }

    // ── X5. OWNER TO a role that reaches past grants is blocked ─────────────
    {
      const name = "0004-hand-to-big.sql";
      await writeFile(path.join(dir, name), "alter function public.turns_recorded_in_window(timestamptz, timestamptz) owner to big;\n");
      const p = await callRaw("ddl_preview", { environment: "dev" });
      await unlink(path.join(dir, name));
      check(
        "X5/owner-to-createrole-role-blocked",
        p.isError && p.payload.code === "DDL_RISK_BLOCKED" && /CREATEROLE/.test(p.payload.message),
        `code=${String(p.payload.code)} message=${String(p.payload.message).slice(0, 120)}`
      );
    }

    // ── X6. forward-only and files-only ─────────────────────────────────────
    {
      const down = await callRaw("ddl_preview", { environment: "dev", direction: "down", target: "0" });
      const inline = await callRaw("ddl_preview", { environment: "dev", sql: "create table z (a int)" });
      const create = await callRaw("ddl_create", { name: "z", up: "create table z (a int)" });
      check(
        "X6/down-inline-create-refused",
        down.payload.code === "DDL_DOWN_UNSUPPORTED" && inline.payload.code === "DDL_INLINE_UNSUPPORTED" && create.payload.code === "DDL_CREATE_UNSUPPORTED",
        `down=${String(down.payload.code)} inline=${String(inline.payload.code)} create=${String(create.payload.code)}`
      );
    }

    // ── X6b. a failing file leaves neither its statements nor a ledger row ──
    {
      const name = "0004-fails-halfway.sql";
      await writeFile(path.join(dir, name), "begin;\ncreate table public.half_done (a int);\nalter table public.no_such_table add column b int;\ncommit;\n");
      const p = await callRaw("ddl_preview", { environment: "dev" });
      const applied = p.isError ? p : await callRaw("ddl_apply", { previewId: p.payload.previewId, approvalToken: p.payload.approvalToken });
      await unlink(path.join(dir, name));
      const facts = (
        await repo.query(
          "select to_regclass('public.half_done') is null as rolled_back, not exists (select 1 from schema_migration where filename = $1) as unrecorded",
          [name]
        )
      ).rows[0];
      check(
        "X6b/failure-is-atomic-with-the-ledger",
        applied.isError && applied.payload.code === "DDL_APPLY_FAILED" && facts.rolled_back && facts.unrecorded,
        `code=${String(applied.payload.code)} ${JSON.stringify(facts)}`
      );
    }

    // ── X7. adoption guard, and a ledger that does not exist yet ────────────
    {
      const adoptPreview = await callRaw("ddl_preview", { environment: "adopt" });
      check(
        "X7a/populated-schema-empty-ledger-refused",
        adoptPreview.isError && adoptPreview.payload.code === "DDL_ADOPTION_REQUIRED",
        `code=${String(adoptPreview.payload.code)}`
      );
      const fresh = await callRaw("ddl_preview", { environment: "fresh" });
      const freshApply = fresh.isError
        ? fresh
        : await callRaw("ddl_apply", { previewId: fresh.payload.previewId, approvalToken: fresh.payload.approvalToken, acknowledgeRisks: fresh.payload.requiredAcknowledgements });
      const freshDb = new pg.Client({ connectionString: conn("fresh") });
      await freshDb.connect();
      const untouched = (await freshDb.query("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0].n === 0;
      await freshDb.end();
      check(
        "X7b/missing-ledger-refused-before-anything-runs",
        !fresh.isError && freshApply.isError && freshApply.payload.code === "DDL_LEDGER_MISSING" && untouched,
        `preview=${String(fresh.payload.code ?? "ok")} apply=${String(freshApply.payload.code)} untouched=${String(untouched)}`
      );
    }

    // ── X9. an enum value added by one migration and used by the next ───────
    // wec.aria's 0019 + 0020. The dry run keeps every step in one transaction, where Postgres
    // refuses the new value (55P04); apply commits 0004 before 0005 runs. The dry run must call
    // that step skipped, not failed, and apply must still apply both.
    {
      await repo.query("create type public.usage_kind as enum ('turn')");
      const add = "0004-usage-kind-retrieval-inspection.sql";
      const use = "0005-usage-events-kind.sql";
      await writeFile(path.join(dir, add), "alter type public.usage_kind add value if not exists 'retrieval_inspection';\n");
      await writeFile(path.join(dir, use), "alter table public.usage_events add column kind public.usage_kind default 'retrieval_inspection';\n");
      const p = await callRaw("ddl_preview", { environment: "dev", profile: "standard" });
      check(
        "X9a/preview-warns-the-dry-run-cannot-check-the-later-step",
        !p.isError && p.payload.warnings.some((w) => /0004-usage-kind-retrieval-inspection\.sql adds an enum value/.test(w)),
        `code=${String(p.payload.code)} warnings=${JSON.stringify(p.payload.warnings)}`
      );
      const dry = p.isError ? p : await callRaw("ddl_dry_run", { previewId: p.payload.previewId });
      const steps = dry.payload.steps ?? [];
      check(
        "X9b/dry-run-reports-the-enum-step-skipped-not-failed",
        !dry.isError &&
          dry.payload.status === "ok" &&
          steps[0]?.status === "ok" &&
          steps[1]?.status === "skipped" &&
          /^ENUM_VALUE_UNCOMMITTED/.test(steps[1]?.reason ?? ""),
        `status=${String(dry.payload.status)} steps=${JSON.stringify(steps.map((s) => [s.status, s.reason?.slice(0, 40)]))} error=${JSON.stringify(dry.payload.error)}`
      );
      const applied = p.isError
        ? p
        : await callRaw("ddl_apply", { previewId: p.payload.previewId, approvalToken: p.payload.approvalToken, acknowledgeRisks: p.payload.requiredAcknowledgements });
      const kind = (await repo.query("select column_default from information_schema.columns where table_name = 'usage_events' and column_name = 'kind'")).rows[0];
      check(
        "X9c/apply-commits-each-migration-so-both-apply",
        !applied.isError && applied.payload.status === "applied" && /retrieval_inspection/.test(String(kind?.column_default)),
        `status=${String(applied.payload.status)} default=${String(kind?.column_default)} error=${JSON.stringify(applied.payload.error)}`
      );
    }

    // ── X8. POSTGRES_DDL_SESSION_ROLE, as wec.aria runs it ──────────────────
    // A second server: a personal, non-superuser login (`deployer`, a member of aria) and the
    // statements run as aria. The file has the shapes of wec.aria's 0004 and 0018: a job-queue
    // schema owned by its own role, then rows moved by a DO block and a backfill before the old
    // column is dropped, all in one transaction.
    await runSessionRoleScenario(serverEnv);
  } finally {
    await mcp.close().catch(() => undefined);
    await repo.end().catch(() => undefined);
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
    console.error("DDL_EXTERNAL_LEDGER_TEST_FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    docker(["rm", "-f", CONTAINER]);
  });
