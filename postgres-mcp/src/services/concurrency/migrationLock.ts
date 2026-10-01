/**
 * The cross-process migration lock: a Postgres session advisory lock on `DDL_LOCK_KEY`.
 *
 * The in-process mutex (`envMutex.ts`) orders one server process. This lock orders every process
 * that can migrate the same database: another postgres-mcp instance, or the DDL lane and the EF
 * lane of two different instances. Both lanes take the SAME key, so a DDL apply and an EF apply
 * cannot interleave either (B-15.5). The DDL lane takes it inside `withDdlSession`. The EF lane
 * takes it here, on a side session of its own, because `dotnet ef` opens a connection this server
 * does not control.
 *
 * Never waits. `pg_try_advisory_lock` either takes the lock or reports who has it, so a second
 * apply is refused immediately rather than queued behind a migration of unknown length.
 *
 * ## The session must stay on one backend (B-16.1)
 *
 * A session lock, and the session timeouts the DDL lane sets, belong to a Postgres BACKEND. They
 * do not belong to the client connection. Through PgBouncer in transaction pooling mode, each
 * statement outside a transaction may run on a different backend. The lock then stays behind on a
 * backend that other clients are handed, and the "exclusive" migration is not exclusive at all.
 *
 * `assertSessionPinned` checks for the two symptoms that pooling produces: the backend pid
 * changed, or the advisory lock is no longer held by the current backend. Both lanes run it right
 * after taking the lock, and the DDL lane runs it again before every step. **It cannot prove the
 * absence of pooling.** A pooler that happens to hand back the same backend every time passes it,
 * and it is exactly the busy case, with many clients and many backends, that it catches. A direct
 * connection is still the requirement. This check makes violating it loud in the common case,
 * instead of silent in every case.
 */

import pg, { type PoolConfig } from "pg";

import { PolicyViolationError } from "../../middleware/errors.js";
import { DDL_LOCK_KEY } from "../ddl/ddlHistory.js";

type Queryable = Pick<pg.Client, "query">;

/** Take the lock without waiting. Returns whether it was taken, and by which backend. */
export async function tryTakeMigrationLock(db: Queryable): Promise<{ ok: boolean; pid: number }> {
  const result = await db.query<{ ok: boolean; pid: number }>("select pg_try_advisory_lock($1, $2) as ok, pg_backend_pid() as pid", [
    ...DDL_LOCK_KEY
  ]);
  return { ok: result.rows[0]?.ok === true, pid: Number(result.rows[0]?.pid) };
}

/**
 * Refuse with `code` unless this statement runs on backend `pid` and that backend still holds
 * the lock. `pg_try_advisory_lock(int, int)` records the key as classid = key 1, objid = key 2,
 * objsubid = 2.
 */
export async function assertSessionPinned(db: Queryable, pid: number, code: string): Promise<void> {
  const result = await db.query<{ pid: number; held: boolean }>(
    `select pg_backend_pid() as pid,
            exists (select 1 from pg_locks
                    where locktype = 'advisory' and granted and pid = pg_backend_pid()
                      and classid = $1::bigint::oid and objid = $2::bigint::oid and objsubid = 2) as held`,
    [...DDL_LOCK_KEY]
  );
  const now = Number(result.rows[0]?.pid);
  const held = result.rows[0]?.held === true;
  if (now !== pid || !held) {
    throw new PolicyViolationError(
      code,
      `The migration session does not stay on one Postgres backend (${now !== pid ? `backend ${String(pid)} took the lock, but this statement ran on ${String(now)}` : "the migration lock is not held by the current backend"}). That is what PgBouncer in transaction pooling mode does, and it makes the migration lock and its timeouts meaningless. Connect this environment directly to Postgres, or through PgBouncer in session mode.`
    );
  }
}

export async function withMigrationLock<T>(poolConfig: PoolConfig, fn: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...poolConfig, application_name: "communicationhub-postgres-mcp:migration-lock" });
  await client.connect();
  try {
    const locked = await tryTakeMigrationLock(client);
    if (!locked.ok) {
      throw new PolicyViolationError(
        "MIGRATION_LOCKED",
        "Another session holds the migration lock for this database — a ddl_apply or migration_apply in another server process. Wait for it to finish, then retry. If nothing is applying, a lock may have been left behind by a pooled connection (B-16.1): look for it with select pid, application_name from pg_locks join pg_stat_activity using (pid) where locktype = 'advisory'."
      );
    }
    try {
      await assertSessionPinned(client, locked.pid, "MIGRATION_POOLED_CONNECTION");
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [...DDL_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
