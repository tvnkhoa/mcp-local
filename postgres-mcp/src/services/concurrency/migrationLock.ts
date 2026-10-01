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
 * Needs a direct connection. Under PgBouncer transaction pooling the session that took the lock
 * is not guaranteed to be the one that holds it (B-16.1).
 */

import pg, { type PoolConfig } from "pg";

import { PolicyViolationError } from "../../middleware/errors.js";
import { DDL_LOCK_KEY } from "../ddl/ddlHistory.js";

export async function withMigrationLock<T>(poolConfig: PoolConfig, fn: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...poolConfig, application_name: "communicationhub-postgres-mcp:migration-lock" });
  await client.connect();
  try {
    const locked = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1, $2) as ok", [...DDL_LOCK_KEY]);
    if (locked.rows[0]?.ok !== true) {
      throw new PolicyViolationError(
        "MIGRATION_LOCKED",
        "Another session holds the migration lock for this database — a ddl_apply or migration_apply in another server process. Wait for it to finish, then retry."
      );
    }
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [...DDL_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
