/**
 * Live test for B-16.1: the migration lock behind PgBouncer in transaction pooling mode.
 *
 * Starts Postgres 17 and PgBouncer (`POOL_MODE=transaction`) on a private Docker network. Then it
 * takes the migration session the way both lanes do (`withDdlSession` / `withMigrationLock` from
 * `dist/`) while background clients keep the pool busy with short transactions, which is what
 * makes PgBouncer move a session between backends.
 *
 * What it proves, and what it cannot:
 *  - Direct to Postgres, the session is never refused (no false positives).
 *  - Through PgBouncer under load, a moved session is refused with `*_POOLED_CONNECTION` before
 *    anything relies on the lock.
 *  - It shows the hazard itself: through the pooler, a second client can "take" the lock that a
 *    first client holds.
 *  - It cannot show that every pooled session is caught. A pooler that keeps handing back the
 *    same backend is indistinguishable from a direct connection, and that is the documented limit.
 *
 * Skips (exit 0) without Docker, or if the PgBouncer image cannot be pulled. Needs a build first.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

import pg from "pg";

const NET = "postgres-mcp-pgbouncer-test";
const PG = "postgres-mcp-pgbouncer-test-pg";
const BOUNCER = "postgres-mcp-pgbouncer-test-bouncer";
const PG_PORT = Number(process.env.POSTGRES_PGBOUNCER_TEST_PG_PORT ?? 55436);
const BOUNCER_PORT = Number(process.env.POSTGRES_PGBOUNCER_TEST_PORT ?? 56436);
const PASSWORD = "pgbouncer_test_only";
const DIRECT = `postgres://probe:${PASSWORD}@127.0.0.1:${String(PG_PORT)}/probe`;
const POOLED = `postgres://probe:${PASSWORD}@127.0.0.1:${String(BOUNCER_PORT)}/probe`;
const IMAGE = "edoburu/pgbouncer:latest";
const ATTEMPTS = 40;

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}
const docker = (args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanup() {
  docker(["rm", "-f", BOUNCER]);
  docker(["rm", "-f", PG]);
  docker(["network", "rm", NET]);
}

async function waitFor(connectionString) {
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const c = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      return;
    } catch {
      await c.end().catch(() => undefined);
    }
  }
  throw new Error(`never became ready: ${connectionString.replace(PASSWORD, "***")}`);
}

/** Clients that keep every backend busy with short transactions, so PgBouncer reshuffles. */
function startLoad(n) {
  let running = true;
  const loops = Array.from({ length: n }, async () => {
    const c = new pg.Client({ connectionString: POOLED });
    await c.connect();
    while (running) {
      await c.query("begin; select pg_sleep(0.01); commit").catch(() => undefined);
    }
    await c.end().catch(() => undefined);
  });
  return async () => {
    running = false;
    await Promise.all(loops);
  };
}

async function main() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    console.log("SKIP: Docker is not available.");
    return;
  }
  if (docker(["pull", "-q", IMAGE]).status !== 0) {
    console.log(`SKIP: could not pull ${IMAGE}.`);
    return;
  }
  cleanup();
  docker(["network", "create", NET]);
  const pgRun = docker([
    "run", "-d", "--name", PG, "--network", NET,
    "-e", "POSTGRES_USER=probe", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", "POSTGRES_DB=probe",
    "-p", `${String(PG_PORT)}:5432`, "postgres:17-alpine"
  ]);
  if (pgRun.status !== 0) throw new Error(pgRun.stderr);
  await waitFor(DIRECT);
  const bouncerRun = docker([
    "run", "-d", "--name", BOUNCER, "--network", NET,
    "-e", `DB_HOST=${PG}`, "-e", "DB_USER=probe", "-e", `DB_PASSWORD=${PASSWORD}`, "-e", "DB_NAME=probe",
    "-e", "POOL_MODE=transaction", "-e", "AUTH_TYPE=scram-sha-256", "-e", "DEFAULT_POOL_SIZE=4", "-e", "MAX_CLIENT_CONN=100",
    // node-pg sends these as startup parameters; PgBouncer refuses unknown ones unless told to ignore them.
    "-e", "IGNORE_STARTUP_PARAMETERS=extra_float_digits,statement_timeout,lock_timeout,options",
    "-p", `${String(BOUNCER_PORT)}:5432`, IMAGE
  ]);
  if (bouncerRun.status !== 0) throw new Error(bouncerRun.stderr);
  await waitFor(POOLED);

  const { withDdlSession } = await import("../dist/services/ddl/ddlExecutor.js");
  const { withMigrationLock } = await import("../dist/services/concurrency/migrationLock.js");
  const { DDL_LOCK_KEY } = await import("../dist/services/ddl/ddlHistory.js");
  const timeouts = { lockTimeoutMs: 2000, statementTimeoutMs: 10_000 };

  const outcome = async (fn) => {
    try {
      await fn();
      return "ok";
    } catch (error) {
      return error.code ?? String(error.message).slice(0, 60);
    }
  };
  const tally = (list) => list.reduce((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

  // ── A. direct: never refused ──────────────────────────────────────────────
  {
    const stop = startLoad(4);
    const ddl = [];
    const ef = [];
    for (let i = 0; i < 10; i += 1) {
      ddl.push(await outcome(() => withDdlSession({ connectionString: DIRECT }, timeouts, async () => sleep(5))));
      ef.push(await outcome(() => withMigrationLock({ connectionString: DIRECT }, async () => sleep(5))));
    }
    await stop();
    check("A/direct-never-refused", ddl.every((x) => x === "ok") && ef.every((x) => x === "ok"), `ddl=${JSON.stringify(tally(ddl))} ef=${JSON.stringify(tally(ef))}`);
  }

  // ── B. the hazard: through the pooler the lock is not exclusive ──────────
  {
    const stop = startLoad(4);
    const a = new pg.Client({ connectionString: POOLED });
    const b = new pg.Client({ connectionString: POOLED });
    await a.connect();
    await b.connect();
    await a.query("select pg_advisory_lock($1, $2)", [...DDL_LOCK_KEY]);
    let alsoGot = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await b.query("select pg_try_advisory_lock($1, $2) as ok", [...DDL_LOCK_KEY]);
      if (r.rows[0].ok) alsoGot += 1;
      await sleep(10);
    }
    await stop();
    await a.end();
    await b.end();
    // Informational: if this is 0 the pooler happened to keep the two clients apart, which is
    // precisely the case no client-side check can tell from a direct connection.
    console.log(`INFO  B/hazard — a second pooled client "took" the held lock ${String(alsoGot)}/20 times`);
  }

  // ── C. pooled under load: a moved session is refused, in both lanes ──────
  {
    // Fresh server connections, so locks leaked by B are gone.
    docker(["restart", BOUNCER]);
    await waitFor(POOLED);
    const stop = startLoad(6);
    const ddl = [];
    const ef = [];
    for (let i = 0; i < ATTEMPTS; i += 1) {
      ddl.push(await outcome(() => withDdlSession({ connectionString: POOLED }, timeouts, async () => sleep(20))));
      ef.push(await outcome(() => withMigrationLock({ connectionString: POOLED }, async () => sleep(20))));
    }
    await stop();
    const ddlCaught = ddl.filter((x) => x === "DDL_POOLED_CONNECTION").length;
    const efCaught = ef.filter((x) => x === "MIGRATION_POOLED_CONNECTION").length;
    check(
      "C/pooled-session-refused",
      ddlCaught > 0 && efCaught > 0,
      `ddl=${JSON.stringify(tally(ddl))} ef=${JSON.stringify(tally(ef))} (of ${String(ATTEMPTS)} each; LOCKED = a lock left behind on another backend by an earlier refused attempt)`
    );
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} scenarios passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("PGBOUNCER_TEST_FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    setTimeout(() => process.exit(), 200).unref();
  });
