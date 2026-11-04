/**
 * MCP-ISSUE-111 follow-up 4: every write transaction of the index begins IMMEDIATE.
 *
 * better-sqlite3's `db.transaction(fn)` begins DEFERRED. A deferred transaction that reads before its first write holds
 * a read snapshot; when another connection commits meanwhile, the upgrade to the write lock fails at once with
 * SQLITE_BUSY ("database is locked") — the busy handler cannot help a stale snapshot. IMMEDIATE takes the write lock at
 * BEGIN, where `busy_timeout` does wait. Nested calls stay savepoints, as with `db.transaction`.
 *
 * Not for read-only transactions (a temp-table query on the read path): IMMEDIATE would make a read take the write lock.
 */

import type Database from "better-sqlite3";

export function immediateTransaction<F extends (...args: never[]) => unknown>(
  db: Database.Database,
  fn: F
): (...args: Parameters<F>) => ReturnType<F> {
  const tx = db.transaction(fn as unknown as (...args: unknown[]) => unknown);
  return (...args: Parameters<F>) => tx.immediate(...(args as unknown[])) as ReturnType<F>;
}
