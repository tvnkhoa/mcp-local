/**
 * Live test for the write flow: write_preview -> write_apply -> write_rollback.
 *
 * This is the only test in the workspace that WRITES to a database, so it never
 * touches a configured environment. It provisions a throwaway Postgres container,
 * points the server at it, and removes it again — the same "never the real thing"
 * posture as bitbucket-mcp's `dryRun` smoke case and codebase-index-mcp's temp SQLite.
 *
 * It lives under `smoke` rather than `test` because it needs Docker, and CI is a
 * Windows runner with none: under `test` it would skip on every run, which is a test
 * that never runs. Needs a build first — it boots `dist/index.js` over real stdio MCP.
 *
 * Skips (exit 0) when Docker is unavailable. Fails (exit 1) when a scenario fails.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";

const CONTAINER = "postgres-mcp-write-flow-test";
const PORT = Number(process.env.POSTGRES_WRITE_FLOW_TEST_PORT ?? 55433);
const PASSWORD = "write_flow_test_only";
const CONN = `postgres://probe:${PASSWORD}@127.0.0.1:${String(PORT)}/probe`;

// Mirrors MAX_ROLLBACK_ROWS in src/services/write/previewStore.ts.
const MAX_ROLLBACK_ROWS = 10_000;

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...opts });
}

function dockerAvailable() {
  const probe = docker(["version", "--format", "{{.Server.Version}}"]);
  return probe.status === 0;
}

async function startContainer() {
  docker(["rm", "-f", CONTAINER]);
  const run = docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_USER=probe",
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e",
    "POSTGRES_DB=probe",
    "-p",
    `${String(PORT)}:5432`,
    "postgres:17-alpine"
  ]);
  if (run.status !== 0) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  // Retry a real connection rather than trusting pg_isready: the official image runs a
  // temporary server for initdb and then restarts it, so pg_isready can go green against
  // a server that is about to shut down.
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
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

function stopContainer() {
  docker(["rm", "-f", CONTAINER]);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const SCHEMA = `
create table t_update  (id int primary key, name text, note text);
create table t_delete  (id int primary key, name text);
create table t_insert  (id int primary key, name text);
create table t_multi   (id int primary key, name text);
create table t_upsert  (id int primary key, name text);
create table t_pkchange(id int primary key, name text);
create table t_ident   (id int generated always as identity primary key,
                        name text,
                        upper_name text generated always as (upper(name)) stored);
create table t_stale   (id int primary key, name text);
create table t_big     (id int primary key, name text);
create table t_comment (id int primary key, name text);
create table t_setcomment (id int primary key, name text);
insert into t_update  values (1,'a','n1'),(2,'b','n2');
insert into t_delete  values (1,'a'),(2,'b');
insert into t_multi   values (1,'a'),(2,'b'),(3,'c');
insert into t_upsert  values (7,'original');
insert into t_pkchange values (1,'a');
insert into t_ident (name) values ('x'),('y');
insert into t_stale  values (1,'before');
insert into t_comment values (1,'keep');
insert into t_setcomment values (1,'keep');
insert into t_big select g, 'row' from generate_series(1, ${String(MAX_ROLLBACK_ROWS + 1)}) g;
`;

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!dockerAvailable()) {
    console.log("SKIP: Docker is not available — the write-flow test needs a throwaway Postgres.");
    console.log("      Everything else in `npm run smoke` still ran.");
    return;
  }

  console.log(`starting throwaway postgres on port ${String(PORT)}...`);
  await startContainer();

  const db = new pg.Client({ connectionString: CONN });
  await db.connect();
  await db.query(SCHEMA);

  // Only this connection exists for the server, so no configured environment is
  // reachable even by name. The unwanted keys are DELETED, not blanked: an empty
  // POSTGRES_WRITABLE_ENVIRONMENTS means "nothing is writable", while absent means
  // the dev/staging/default default (see config/environments.ts).
  const serverEnv = { ...process.env };
  for (const key of Object.keys(serverEnv)) {
    if (/^(POSTGRES_|PG_|CH_|MCP_DB_)/.test(key)) {
      delete serverEnv[key];
    }
  }
  Object.assign(serverEnv, {
    POSTGRES_CONNECTION: CONN,
    PGSSLMODE: "disable",
    POSTGRES_WRITE_ENABLED: "true",
    POSTGRES_WRITE_APPROVAL_SECRET: "write-flow-test-secret"
  });

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    stderr: "pipe",
    env: serverEnv
  });
  transport.onerror = (error) => {
    console.error("[transport-error]", error);
  };

  const mcp = new McpClient({ name: "postgres-mcp-write-flow-test", version: "0.1.0" });
  await mcp.connect(transport);

  const callRaw = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.find((x) => x.type === "text")?.text ?? "null";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  };
  const call = async (name, args) => {
    const { isError, payload } = await callRaw(name, args);
    if (isError) {
      throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
    }
    return payload;
  };
  const preview = (sql, extra = {}) => call("write_preview", { sql, profile: "standard", ...extra });
  const apply = (p) =>
    call("write_apply", { previewId: p.previewId, approvalToken: p.approvalToken, profile: "standard" });
  const rollback = (rollbackId) => callRaw("write_rollback", { rollbackId, profile: "standard" });
  const rows = async (sql) => (await db.query(sql)).rows;

  try {
    // ── A. UPDATE, restored end to end ──────────────────────────────────────
    {
      const p = await preview("update t_update set name = 'CHANGED' where id = 1");
      const a = await apply(p);
      const applied = (await rows("select name from t_update where id = 1"))[0].name;
      const { payload: r } = await rollback(a.rollbackId);
      const final = (await rows("select name, note from t_update where id = 1"))[0];
      check(
        "A/update-restored",
        applied === "CHANGED" && r.status === "restored" && r.restored === 1 && final.name === "a" && final.note === "n1",
        `applied=${applied} rollback=${JSON.stringify(r)} final=${JSON.stringify(final)}`
      );
    }

    // ── B. DELETE, row comes back ───────────────────────────────────────────
    {
      const p = await preview("delete from t_delete where id = 2");
      const a = await apply(p);
      const gone = (await rows("select 1 from t_delete where id = 2")).length === 0;
      const { payload: r } = await rollback(a.rollbackId);
      const back = await rows("select name from t_delete where id = 2");
      check(
        "B/delete-restored",
        gone && r.status === "restored" && back.length === 1 && back[0].name === "b",
        `deleted=${String(gone)} rollback=${JSON.stringify(r)} back=${JSON.stringify(back)}`
      );
    }

    // ── C. INSERT, row is removed again ─────────────────────────────────────
    {
      const p = await preview("insert into t_insert (id, name) values (5, 'new')");
      const a = await apply(p);
      const present = (await rows("select 1 from t_insert where id = 5")).length === 1;
      const { payload: r } = await rollback(a.rollbackId);
      const left = (await rows("select 1 from t_insert where id = 5")).length;
      check(
        "C/insert-rolled-back",
        present && r.status === "restored" && left === 0,
        `inserted=${String(present)} rollback=${JSON.stringify(r)} rowsLeft=${String(left)}`
      );
    }

    // ── D. one conflicting row must not cost the others (PG-WRT-001) ────────
    {
      const p = await preview("delete from t_multi where id in (1,2,3)");
      const a = await apply(p);
      await db.query("insert into t_multi values (2, 'squatter')");
      const { payload: r } = await rollback(a.rollbackId);
      const table = await rows("select id, name from t_multi order by id");
      const restoredIds = table.filter((x) => x.name !== "squatter").map((x) => x.id);
      check(
        "D/partial-conflict-isolated",
        r.status === "partial" &&
          r.restored === 2 &&
          r.conflicts === 1 &&
          r.pending === 1 &&
          restoredIds.length === 2 &&
          restoredIds.includes(1) &&
          restoredIds.includes(3),
        `rollback=${JSON.stringify(r)} actuallyRestored=[${restoredIds.join(",")}]`
      );

      // A partial rollback stays retryable, and only retries what is outstanding.
      const { payload: retry } = await rollback(a.rollbackId);
      check(
        "D/partial-retryable",
        retry.status === "failed" && retry.restored === 0 && retry.conflicts === 1,
        `retry=${JSON.stringify(retry)}`
      );

      // Clear the squatter, then the outstanding row can finally be restored.
      await db.query("delete from t_multi where id = 2");
      const { payload: third } = await rollback(a.rollbackId);
      const finalIds = (await rows("select id from t_multi order by id")).map((x) => x.id);
      check(
        "D/partial-completes",
        third.status === "restored" && third.restored === 1 && third.pending === 0 && finalIds.length === 3,
        `third=${JSON.stringify(third)} finalIds=[${finalIds.join(",")}]`
      );
    }

    // ── E. upsert that can update in place is refused up front (PG-WRT-002) ─
    {
      const p = await preview(
        "insert into t_upsert (id, name) values (7, 'upserted') on conflict (id) do update set name = excluded.name"
      );
      const a = await apply(p);
      const row = await rows("select name from t_upsert where id = 7");
      check(
        "E/upsert-do-update-refused",
        p.rollbackSupported === false && a.rollbackId === null && row.length === 1 && row[0].name === "upserted",
        `rollbackSupported=${String(p.rollbackSupported)} rollbackId=${String(a.rollbackId)} note=${String(p.rollbackNote)}`
      );
    }

    // ── E2. DO NOTHING is safe and keeps rollback ───────────────────────────
    {
      const p = await preview(
        "insert into t_upsert (id, name) values (7, 'ignored'), (8, 'fresh') on conflict (id) do nothing"
      );
      const a = await apply(p);
      const { payload: r } = await rollback(a.rollbackId);
      const table = await rows("select id, name from t_upsert order by id");
      check(
        "E2/upsert-do-nothing-supported",
        p.rollbackSupported === true &&
          r.status === "restored" &&
          r.restored === 1 &&
          table.length === 1 &&
          table[0].id === 7 &&
          table[0].name === "upserted",
        `rollbackSupported=${String(p.rollbackSupported)} rollback=${JSON.stringify(r)} table=${JSON.stringify(table)}`
      );
    }

    // ── F. UPDATE that moves the primary key is refused up front (PG-WRT-003)
    {
      const p = await preview("update t_pkchange set id = 99, name = 'moved' where id = 1");
      const a = await apply(p);
      check(
        "F/pk-changing-update-refused",
        p.rollbackSupported === false && a.rollbackId === null,
        `rollbackSupported=${String(p.rollbackSupported)} note=${String(p.rollbackNote)}`
      );
    }

    // ── G. identity + stored generated columns survive a reinsert ───────────
    {
      const p = await preview("delete from t_ident where name = 'x'");
      const a = await apply(p);
      const { payload: r } = await rollback(a.rollbackId);
      const table = await rows("select id, name, upper_name from t_ident order by id");
      const restored = table.find((x) => x.name === "x");
      check(
        "G/identity-generated",
        r.status === "restored" && restored !== undefined && restored.id === 1 && restored.upper_name === "X",
        `rollback=${JSON.stringify(r)} table=${JSON.stringify(table)}`
      );
    }

    // ── H. rollback is once-only, and unknown ids are rejected ──────────────
    {
      const p = await preview("update t_update set name = 'twice' where id = 2");
      const a = await apply(p);
      const { payload: first } = await rollback(a.rollbackId);
      const { payload: second, isError: secondIsError } = await rollback(a.rollbackId);
      const { payload: unknown, isError: unknownIsError } = await rollback("00000000-0000-0000-0000-000000000000");
      check(
        "H/idempotency",
        first.status === "restored" &&
          secondIsError &&
          second.code === "ALREADY_ROLLED_BACK" &&
          unknownIsError &&
          unknown.code === "ROLLBACK_NOT_FOUND",
        `first=${JSON.stringify(first)} second=${second.code} unknown=${unknown.code}`
      );
    }

    // ── I. statements whose undo data cannot be captured ────────────────────
    {
      const paramUpdate = await preview("update t_update set note = $1 where id = 1", { params: ["viaparam"] });
      const ownReturning = await preview("delete from t_delete where id = 1 returning id");
      const applied = await apply(paramUpdate);
      check(
        "I/uncapturable-refused",
        paramUpdate.rollbackSupported === false &&
          applied.rollbackId === null &&
          ownReturning.rollbackSupported === false,
        `paramUpdate=${String(paramUpdate.rollbackSupported)} ownReturning=${String(ownReturning.rollbackSupported)}`
      );
    }

    // ── J. a row changed after apply is not clobbered (PG-WRT-004) ──────────
    {
      const p = await preview("update t_stale set name = 'applied' where id = 1");
      const a = await apply(p);
      // Somebody else edits the same row after the apply committed.
      await db.query("update t_stale set name = 'someone else' where id = 1");
      const { payload: r } = await rollback(a.rollbackId);
      const final = (await rows("select name from t_stale where id = 1"))[0].name;
      check(
        "J/stale-row-not-clobbered",
        r.status === "failed" &&
          r.restored === 0 &&
          final === "someone else" &&
          Array.isArray(r.unrestored) &&
          r.unrestored[0]?.reason === "row_changed_since_apply",
        `rollback=${JSON.stringify(r)} finalName=${final}`
      );
    }

    // ── L. a trailing line comment must not swallow the capture clause ──────
    {
      // The clause is appended on its own line. On the same line it would land inside the
      // comment, the write would commit with no undo data, and rollback would report
      // "restored" having done nothing.
      const p = await preview("delete from t_comment where id = 1 -- cleanup");
      const a = await apply(p);
      const gone = (await rows("select 1 from t_comment where id = 1")).length === 0;
      const { payload: r } = await rollback(a.rollbackId);
      const back = await rows("select id, name from t_comment where id = 1");
      check(
        "L/trailing-comment-capture",
        p.rollbackSupported === true &&
          a.rollbackId !== null &&
          gone &&
          r.status === "restored" &&
          back.length === 1 &&
          back[0].name === "keep",
        `rollbackSupported=${String(p.rollbackSupported)} deleted=${String(gone)} rollback=${JSON.stringify(r)} back=${JSON.stringify(back)}`
      );
    }

    // ── M. an unparseable SET list must not disarm the PK guard ─────────────
    {
      // Without the guard this reads the column name as "/* bump */ id", matches no
      // primary key, and offers rollback on a statement that moves the key.
      const p = await preview("update t_setcomment set /* bump */ id = 5 where id = 1");
      const a = await apply(p);
      check(
        "M/unparseable-set-refused",
        p.rollbackSupported === false && a.rollbackId === null,
        `rollbackSupported=${String(p.rollbackSupported)} note=${String(p.rollbackNote)}`
      );
    }

    // ── K. an oversized snapshot is refused up front ────────────────────────
    {
      const p = await preview("delete from t_big where id > 0");
      check(
        "K/oversized-snapshot-refused",
        p.rollbackSupported === false && p.rowsAffected === MAX_ROLLBACK_ROWS + 1,
        `rowsAffected=${String(p.rowsAffected)} rollbackSupported=${String(p.rollbackSupported)} note=${String(p.rollbackNote)}`
      );
    }
  } finally {
    await mcp.close().catch(() => undefined);
    await db.end().catch(() => undefined);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} scenarios passed`);
  if (failed.length > 0) {
    // Not thrown: every scenario's verdict is the point of the run.
    console.error(`FAILED: ${failed.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("WRITE_FLOW_TEST_FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    stopContainer();
  });
