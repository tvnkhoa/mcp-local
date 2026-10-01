/**
 * Live test for the EF Core lane, against a throwaway Postgres, without `dotnet` (B-15.3).
 *
 * The handlers in `dist/` run unmodified. Only the `dotnet ef` child is replaced, through
 * `MigrationConfig.run`, by a fake that behaves like EF where the handlers can observe it:
 *  - `migrations list --json` reads the real `__EFMigrationsHistory` table;
 *  - `migrations script [from]` and `--idempotent` emit EF-shaped SQL, with START TRANSACTION /
 *    COMMIT around each migration and `DO $EF$` guards in the idempotent form;
 *  - `database update` applies the pending migrations to the database, recording each in the
 *    history table.
 * That lets preview, apply, dry run, the drift guards and the contiguity logic be tested at all;
 * before this, nothing beyond the feature gate was.
 *
 * Same posture as the other two flow harnesses: a container, no configured environment touched,
 * skip without Docker, under `smoke`. Needs a build first, because it imports `dist/`.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

import pg from "pg";

const CONTAINER = "postgres-mcp-migration-flow-test";
const PORT = Number(process.env.POSTGRES_MIGRATION_FLOW_TEST_PORT ?? 55435);
const PASSWORD = "migration_flow_test_only";
const CONN = `postgres://probe:${PASSWORD}@127.0.0.1:${String(PORT)}/probe`;

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8" });
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

// ── a fake `dotnet ef`, backed by the real history table ─────────────────────

const HISTORY = `"__EFMigrationsHistory"`;

function createFakeEf() {
  const state = {
    /** In EF apply order: what `migrations list` reports, and what `database update` applies. */
    migrations: [],
    calls: [],
    updateCalls: 0,
    failNextUpdate: false,
    updateDelayMs: 0
  };

  const withDb = async (connectionString, fn) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };
  const appliedIds = (connectionString) =>
    withDb(connectionString, async (c) => new Set((await c.query(`select "MigrationId" as id from ${HISTORY}`)).rows.map((r) => r.id)));

  const record = (id) => `INSERT INTO ${HISTORY} ("MigrationId", "ProductVersion") VALUES ('${id}', '9.0.0');`;
  const unrecord = (id) => `DELETE FROM ${HISTORY} WHERE "MigrationId" = '${id}';`;
  const plain = (m) => `START TRANSACTION;\n${m.sql}\n${record(m.id)}\nCOMMIT;\n`;
  const guarded = (m) =>
    `START TRANSACTION;\nDO $EF$\nBEGIN\n    IF NOT EXISTS(SELECT 1 FROM ${HISTORY} WHERE "MigrationId" = '${m.id}') THEN\n    ${m.sql}\n    ${record(m.id)}\n    END IF;\nEND $EF$;\nCOMMIT;\n`;
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: "" });

  const run = async (efArgs, connectionString) => {
    state.calls.push(efArgs);
    const [group, verb, ...rest] = efArgs;
    if (group === "migrations" && verb === "list") {
      const applied = await appliedIds(connectionString);
      return ok(JSON.stringify(state.migrations.map((m) => ({ id: m.id, name: m.id, safeName: m.id, applied: applied.has(m.id) }))));
    }
    if (group === "migrations" && verb === "script") {
      if (rest[0] === "--idempotent") {
        return ok(state.migrations.map(guarded).join("\n"));
      }
      const [from, to] = rest;
      if (to !== undefined) {
        // `script <latest> <target>`: the Down methods of everything after target, newest first.
        const fromIdx = state.migrations.findIndex((m) => m.id === from);
        const toIdx = to === "0" ? -1 : state.migrations.findIndex((m) => m.id === to);
        const reverted = state.migrations.slice(toIdx + 1, fromIdx + 1).reverse();
        return ok(reverted.map((m) => `START TRANSACTION;\n${m.down}\n${unrecord(m.id)}\nCOMMIT;\n`).join("\n"));
      }
      const start = from === undefined ? 0 : state.migrations.findIndex((m) => m.id === from) + 1;
      return ok(state.migrations.slice(start).map(plain).join("\n"));
    }
    if (group === "migrations" && verb === "add") {
      return ok("Done.");
    }
    if (group === "database" && verb === "update") {
      state.updateCalls += 1;
      if (state.updateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.updateDelayMs));
      }
      if (state.failNextUpdate) {
        state.failNextUpdate = false;
        return { exitCode: 1, stdout: "", stderr: "Failed executing DbCommand (simulated)" };
      }
      state.lastUpdateArgs = rest;
      const applied = await appliedIds(connectionString);
      if (rest[0] !== undefined) {
        // `database update <target>`: revert what is applied after target, newest first.
        const toIdx = rest[0] === "0" ? -1 : state.migrations.findIndex((m) => m.id === rest[0]);
        const reverting = state.migrations.slice(toIdx + 1).filter((m) => applied.has(m.id)).reverse();
        await withDb(connectionString, async (c) => {
          for (const m of reverting) {
            await c.query("begin");
            await c.query(m.down);
            await c.query(unrecord(m.id));
            await c.query("commit");
          }
        });
        return ok("Done.");
      }
      await withDb(connectionString, async (c) => {
        for (const m of state.migrations.filter((x) => !applied.has(x.id))) {
          await c.query("begin");
          await c.query(m.sql);
          await c.query(record(m.id));
          await c.query("commit");
        }
      });
      return ok("Done.");
    }
    return { exitCode: 1, stdout: "", stderr: `fake ef: unsupported ${efArgs.join(" ")}` };
  };

  return { state, run };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    console.log("SKIP: Docker is not available — the migration-flow test needs a throwaway Postgres.");
    return;
  }
  console.log(`starting throwaway postgres on port ${String(PORT)}...`);
  await startContainer();

  // The registry is built from the environment at construction, so set it before importing.
  for (const key of Object.keys(process.env)) {
    if (/^(POSTGRES_|PG_|CH_|MCP_DB_)/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    POSTGRES_ENV_DEV: CONN,
    POSTGRES_ENV_PROD: CONN,
    POSTGRES_WRITABLE_ENVIRONMENTS: "dev",
    POSTGRES_DEFAULT_ENVIRONMENT: "dev",
    PGSSLMODE: "disable"
  });
  const { ConnectionManager } = await import("../dist/repositories/connectionManager.js");
  const handlers = await import("../dist/tools/handlers/migrationHandlers.js");

  const db = new pg.Client({ connectionString: CONN });
  await db.connect();
  await db.query(`create table ${HISTORY} ("MigrationId" varchar(150) primary key, "ProductVersion" varchar(32) not null)`);

  const ef = createFakeEf();
  const config = {
    enabled: true,
    project: "/fake/Infrastructure.csproj",
    startupProject: "/fake/Web.csproj",
    timeoutMs: 30_000,
    lockTimeoutMs: 1000,
    approvalSecret: "migration-flow-test-secret",
    previewTtlMs: 3_600_000,
    run: ef.run
  };
  const connections = new ConnectionManager({ poolMax: 4, idleTimeoutMs: 1000, statementTimeoutMs: 30_000, applicationName: "migration-flow-test" });

  const invoke = async (name, args) => {
    try {
      const result = await handlers[name](args, connections, config);
      return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
    } catch (error) {
      return { isError: true, payload: { code: error.code, message: error.message } };
    }
  };
  const status = () => invoke("handleMigrationStatus", { environment: "dev" });
  const preview = () => invoke("handleMigrationPreview", { environment: "dev", profile: "standard" });
  const apply = (p) => invoke("handleMigrationApply", { previewId: p.previewId, approvalToken: p.approvalToken, profile: "standard" });
  const exists = async (t) => (await db.query("select to_regclass($1) is not null as present", [t])).rows[0].present;

  // An already-applied baseline, then two pending migrations.
  ef.state.migrations.push({ id: "20260101000000_Init", sql: "CREATE TABLE init_t (id int primary key);" });
  await db.query("CREATE TABLE init_t (id int primary key)");
  await db.query(`INSERT INTO ${HISTORY} VALUES ('20260101000000_Init', '9.0.0')`);
  ef.state.migrations.push({ id: "20260102000000_AddA", sql: "CREATE TABLE a_t (id int primary key);" });
  ef.state.migrations.push({ id: "20260103000000_AddB", sql: "CREATE TABLE b_t (id int primary key);" });

  try {
    // ── A. status reads the real history table ──────────────────────────────
    {
      const { payload: s } = await status();
      check(
        "A/status",
        JSON.stringify(s.applied) === JSON.stringify(["20260101000000_Init"]) &&
          JSON.stringify(s.pending) === JSON.stringify(["20260102000000_AddA", "20260103000000_AddB"]),
        `applied=${JSON.stringify(s.applied)} pending=${JSON.stringify(s.pending)}`
      );
    }

    // ── B. a contiguous pending set is scripted as a delta from the last applied ──
    {
      ef.state.calls.length = 0;
      const { payload: p } = await preview();
      const scriptCalls = ef.state.calls.filter((c) => c[1] === "script");
      check(
        "B/preview-delta",
        p.pendingCount === 2 &&
          JSON.stringify(scriptCalls) === JSON.stringify([["migrations", "script", "20260101000000_Init"]]) &&
          p.pendingScript.includes("a_t") &&
          !p.pendingScript.includes("init_t"),
        `scriptCalls=${JSON.stringify(scriptCalls)} pending=${String(p.pendingCount)}`
      );
    }

    // ── C. a failed apply, then a retry of the same preview (PG-MIG-005 end to end) ──
    {
      // Runs first among the applies on purpose: the failure path's audit is what creates mcp_ops,
      // and before PG-MIG-005 that new schema made the retry report a drift nobody caused.
      const { payload: p } = await preview();
      ef.state.failNextUpdate = true;
      const failed = await apply(p);
      const mcpOpsCreated = await exists("mcp_ops.audit_log");
      const retry = await apply(p);
      check(
        "C/fail-then-retry",
        failed.isError &&
          failed.payload.code === "EF_COMMAND_FAILED" &&
          mcpOpsCreated &&
          !retry.isError &&
          retry.payload.status === "applied" &&
          retry.payload.schemaChanged === true &&
          retry.payload.diff.addedTables.includes("public.a_t") &&
          (await exists("public.b_t")),
        `failed=${String(failed.payload.code)} mcp_ops=${String(mcpOpsCreated)} retry=${String(retry.payload.status ?? retry.payload.code)}: ${String(retry.payload.message ?? "")}`
      );
    }

    // ── D. the schema changed between preview and apply ─────────────────────
    ef.state.migrations.push({ id: "20260104000000_AddC", sql: "CREATE TABLE c_t (id int primary key);" });
    {
      const { payload: p } = await preview();
      await db.query("create table out_of_band (a int)");
      const before = ef.state.updateCalls;
      const r = await apply(p);
      await db.query("drop table out_of_band");
      check(
        "D/drift-schema",
        r.isError && r.payload.code === "MIGRATION_DRIFT" && /Schema changed/.test(r.payload.message) && ef.state.updateCalls === before,
        `code=${String(r.payload.code)} updateRan=${String(ef.state.updateCalls !== before)}`
      );
    }

    // ── E. a migration was added between preview and apply ──────────────────
    {
      const { payload: p } = await preview();
      ef.state.migrations.push({ id: "20260105000000_AddD", sql: "CREATE TABLE d_t (id int primary key);" });
      const r = await apply(p);
      check(
        "E/drift-pending-set",
        r.isError && r.payload.code === "MIGRATION_DRIFT" && /Pending migration set changed/.test(r.payload.message),
        `code=${String(r.payload.code)} message=${String(r.payload.message)}`
      );
    }

    // ── F. two concurrent applies of one preview run `database update` once ──
    {
      const { payload: p } = await preview();
      ef.state.updateDelayMs = 300;
      const before = ef.state.updateCalls;
      const [x, y] = await Promise.all([apply(p), apply(p)]);
      ef.state.updateDelayMs = 0;
      const outcomes = [x, y].map((r) => (r.isError ? r.payload.code : r.payload.status)).sort();
      check(
        "F/concurrent-apply",
        JSON.stringify(outcomes) === JSON.stringify(["PREVIEW_NOT_FOUND", "applied"]) && ef.state.updateCalls === before + 1,
        `outcomes=${JSON.stringify(outcomes)} updateCalls=+${String(ef.state.updateCalls - before)}`
      );
    }

    // ── G. a non-contiguous pending set falls back to the idempotent script ──
    {
      // A branch merge: a migration ordered BEFORE an applied one, still pending.
      ef.state.migrations.splice(2, 0, { id: "20260102120000_Merged", sql: "CREATE TABLE merged_t (id int primary key);" });
      ef.state.calls.length = 0;
      const { payload: p } = await preview();
      const scriptCalls = ef.state.calls.filter((c) => c[1] === "script");
      check(
        "G/preview-non-contiguous",
        JSON.stringify(p.pendingMigrations) === JSON.stringify(["20260102120000_Merged"]) &&
          JSON.stringify(scriptCalls) === JSON.stringify([["migrations", "script", "--idempotent"]]),
        `pending=${JSON.stringify(p.pendingMigrations)} scriptCalls=${JSON.stringify(scriptCalls)}`
      );
      await apply(p);
    }

    // ── H. the dry run executes and rolls back; a failing script reports failed ──
    {
      ef.state.migrations.push({ id: "20260106000000_AddE", sql: "CREATE TABLE e_t (id int primary key);" });
      const good = await invoke("handleMigrationDryRun", { environment: "dev" });
      const persisted = await exists("public.e_t");
      ef.state.migrations.push({ id: "20260107000000_Broken", sql: "ALTER TABLE no_such_table ADD COLUMN x int;" });
      const bad = await invoke("handleMigrationDryRun", { environment: "dev" });
      ef.state.migrations.pop();
      check(
        "H/dry-run",
        good.payload.status === "ok" &&
          persisted === false &&
          bad.payload.status === "failed" &&
          /no_such_table/.test(bad.payload.error) &&
          bad.payload.failure?.sqlState === "42P01" &&
          /no_such_table/.test(bad.payload.failure?.statement ?? ""),
        `good=${String(good.payload.status)} persisted=${String(persisted)} bad=${String(bad.payload.status)}`
      );
    }

    // ── J. the dry run executes the delta the preview showed (PG-MIG-008) ───
    {
      ef.state.calls.length = 0;
      const { payload: d } = await invoke("handleMigrationDryRun", { environment: "dev" });
      const scriptCalls = ef.state.calls.filter((c) => c[1] === "script");
      check(
        "J/dry-run-runs-delta",
        d.status === "ok" &&
          d.script === "delta" &&
          d.statementsRun === 2 &&
          d.transactionControlRemoved === 2 &&
          scriptCalls.length === 1 &&
          scriptCalls[0][2] !== "--idempotent",
        `status=${String(d.status)} script=${String(d.script)} ran=${String(d.statementsRun)} scriptCalls=${JSON.stringify(scriptCalls)}`
      );
    }

    // ── K. a hand-written COMMIT inside a migration cannot commit the dry run (PG-MIG-007) ──
    {
      // `commit;` on the same line as a statement: invisible to a line filter, whatever its regex.
      ef.state.migrations.push({ id: "20260108000000_HandEdited", sql: ["CREATE TABLE k_t (a int); commit;", "CREATE TABLE k2_t (a int);"].join("\n") });
      const { payload: d } = await invoke("handleMigrationDryRun", { environment: "dev" });
      const persisted = (await exists("public.k_t")) || (await exists("public.e_t"));
      ef.state.migrations.pop();
      check(
        "K/dry-run-commit-contained",
        d.status === "ok" && persisted === false,
        `status=${String(d.status)} persisted=${String(persisted)} controlRemoved=${String(d.transactionControlRemoved)}`
      );
    }

    // ── L. CONCURRENTLY cannot run in the dry run's transaction: skipped, reported ──
    {
      ef.state.migrations.push({ id: "20260109000000_Concurrent", sql: "CREATE INDEX CONCURRENTLY init_idx ON init_t (id);" });
      const { payload: d } = await invoke("handleMigrationDryRun", { environment: "dev" });
      const index = await exists("public.init_idx");
      ef.state.migrations.pop();
      check(
        "L/dry-run-skips-concurrently",
        d.status === "ok" && d.skipped?.length === 1 && d.skipped[0].reason === "NON_TRANSACTIONAL" && index === false,
        `status=${String(d.status)} skipped=${JSON.stringify(d.skipped)} index=${String(index)}`
      );
    }

    // ── M. the dry run waits at most lock_timeout for a busy table (B-15.1) ──
    {
      ef.state.migrations.push({ id: "20260110000000_AlterInit", sql: "ALTER TABLE init_t ADD COLUMN m int;" });
      const holder = new pg.Client({ connectionString: CONN });
      await holder.connect();
      await holder.query("begin; lock table init_t in access share mode");
      const started = Date.now();
      const { payload: d } = await invoke("handleMigrationDryRun", { environment: "dev" });
      const elapsed = Date.now() - started;
      await holder.query("rollback");
      await holder.end();
      ef.state.migrations.pop();
      check(
        "M/dry-run-lock-timeout",
        d.status === "failed" && d.failure?.sqlState === "55P03" && d.lockTimeoutMs === 1000 && elapsed < 5000,
        `status=${String(d.status)} sqlState=${String(d.failure?.sqlState)} elapsed=${String(elapsed)}ms`
      );
    }

    // ── N. preview says whether dotnet ef really gets the lock wait ──────────
    {
      // This harness connects with a postgres:// URI, which Npgsql cannot take an Options keyword on.
      const { payload: p } = await preview();
      check(
        "N/lock-timeout-reported",
        p.lockTimeout?.ms === 1000 && p.lockTimeout?.applied === false && /URI/.test(p.lockTimeout?.note ?? ""),
        `lockTimeout=${JSON.stringify(p.lockTimeout)}`
      );
    }

    // ═══ B-15.4: rollback to a target ═══════════════════════════════════════

    // A migration with a Down, applied forward first (together with whatever else is pending).
    ef.state.migrations.push({ id: "20260111000000_AddR", sql: "CREATE TABLE r_t (id int primary key);", down: "DROP TABLE r_t;" });
    {
      const { payload: up } = await preview();
      await apply(up);
    }
    const appliedNow = (await status()).payload.applied;
    const beforeR = appliedNow[appliedNow.length - 2];
    const revertPreview = (targetMigration) => invoke("handleMigrationPreview", { environment: "dev", targetMigration, profile: "standard" });
    const applyAck = (p, acknowledgeRisks) =>
      invoke("handleMigrationApply", { previewId: p.previewId, approvalToken: p.approvalToken, acknowledgeRisks, profile: "standard" });

    // ── O. a rollback preview scripts the Down range and names its risks ────
    let rollback;
    {
      ef.state.calls.length = 0;
      rollback = (await revertPreview(beforeR)).payload;
      const scriptCalls = ef.state.calls.filter((c) => c[1] === "script");
      check(
        "O/rollback-preview",
        rollback.direction === "down" &&
          JSON.stringify(rollback.revertMigrations) === JSON.stringify(["20260111000000_AddR"]) &&
          JSON.stringify(scriptCalls) === JSON.stringify([["migrations", "script", "20260111000000_AddR", beforeR]]) &&
          JSON.stringify(rollback.requiredAcknowledgements) === JSON.stringify(["EF_REVERT", "DROP_TABLE"]) &&
          /DROP TABLE r_t/.test(rollback.revertScript),
        `revert=${JSON.stringify(rollback.revertMigrations)} required=${JSON.stringify(rollback.requiredAcknowledgements)} scriptCalls=${JSON.stringify(scriptCalls)}`
      );
    }

    // ── P. it runs only once acknowledged, and runs `database update <target>` ──
    {
      const without = await applyAck(rollback, ["EF_REVERT"]);
      const withAll = await applyAck(rollback, rollback.requiredAcknowledgements);
      const s = (await status()).payload;
      check(
        "P/rollback-apply",
        without.isError &&
          without.payload.code === "MIGRATION_RISK_NOT_ACKNOWLEDGED" &&
          /DROP_TABLE/.test(without.payload.message) &&
          !withAll.isError &&
          withAll.payload.direction === "down" &&
          JSON.stringify(ef.state.lastUpdateArgs) === JSON.stringify([beforeR]) &&
          !(await exists("public.r_t")) &&
          s.pending.includes("20260111000000_AddR") &&
          withAll.payload.diff?.removedTables?.includes("public.r_t"),
        `without=${String(without.payload.code)} with=${String(withAll.payload.status ?? withAll.payload.code)} updateArgs=${JSON.stringify(ef.state.lastUpdateArgs)} r_t=${String(await exists("public.r_t"))}`
      );
    }

    // ── Q. a target that is not applied is refused; the latest one is a no-op ──
    {
      const unknown = await revertPreview("20991231000000_Nope");
      const latest = (await status()).payload.applied.at(-1);
      const noop = await revertPreview(latest);
      check(
        "Q/rollback-targets",
        unknown.isError && unknown.payload.code === "MIGRATION_UNKNOWN_TARGET" && noop.payload.status === "nothing_to_revert",
        `unknown=${String(unknown.payload.code)} latest=${String(noop.payload.status)}`
      );
    }

    // ── R. the applied set changed between preview and apply ────────────────
    {
      const { payload: up } = await preview();
      await apply(up);
      const { payload: p } = await revertPreview(beforeR);
      // History only: the schema is untouched, so only the applied-set check can see this.
      await db.query(`DELETE FROM ${HISTORY} WHERE "MigrationId" = '20260111000000_AddR'`);
      const r = await applyAck(p, p.requiredAcknowledgements);
      await db.query(`INSERT INTO ${HISTORY} VALUES ('20260111000000_AddR', '9.0.0')`);
      check(
        "R/rollback-drift",
        r.isError && r.payload.code === "MIGRATION_DRIFT" && /Applied migration set changed/.test(r.payload.message) && (await exists("public.r_t")),
        `code=${String(r.payload.code)} message=${String(r.payload.message)}`
      );
    }

    // ── I. prod is never writable ───────────────────────────────────────────
    {
      const r = await invoke("handleMigrationPreview", { environment: "prod" });
      const s = await invoke("handleMigrationStatus", { environment: "prod" });
      check(
        "I/prod",
        r.isError && r.payload.code === "ENVIRONMENT_READ_ONLY" && !s.isError,
        `preview=${String(r.payload.code)} statusOk=${String(!s.isError)}`
      );
    }
  } finally {
    await db.end().catch(() => undefined);
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
    console.error("MIGRATION_FLOW_TEST_FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    docker(["rm", "-f", CONTAINER]);
    // The ConnectionManager's pools hold sockets open; the container is gone, so exit.
    setTimeout(() => process.exit(), 200).unref();
  });
