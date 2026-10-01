/**
 * Execution-time proof that a statement wrote nothing in the server's own schemas.
 *
 * Shared by the write lane (PG-SEC-002), where a trigger on the target table can reach `mcp_ops`,
 * and the DDL lane, where an `ADD COLUMN … DEFAULT f()` or an index expression runs code the
 * guardrail never saw.
 *
 * It reads `pg_stat_xact_user_tables`, the per-table tuple counters for the current transaction.
 * Every insert, update or delete is counted there, however it was reached.
 *
 * Only a DIFFERENCE of two readings in ONE transaction block means anything. Since PG15 the view
 * reports the backend's pending counters, and those still hold writes from earlier transactions on
 * the same pooled connection until they are flushed. The flush never happens inside a transaction
 * block, so within a block the leftover is constant and cancels out. Comparing a single reading
 * against zero refused `write_preview` on any connection whose previous transaction had written the
 * audit row. Outside a transaction block, each statement is its own transaction and a flush can
 * land between the two readings, so this check is not offered there.
 */

import type { Pool, PoolClient } from "pg";

import { INTERNAL_SCHEMAS } from "../middleware/internalSchemas.js";
import { PolicyViolationError } from "../middleware/errors.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export async function internalTupleCount(db: Queryable): Promise<number> {
  const result = await db.query<{ n: string | null }>(
    `select sum(n_tup_ins + n_tup_upd + n_tup_del) as n
     from pg_stat_xact_user_tables
     where schemaname = any($1::text[])`,
    [INTERNAL_SCHEMAS]
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Refuse with `code` if anything wrote to an internal schema since `baseline` was read. Call it
 * inside the same transaction block, after the statement and before the transaction ends.
 */
export async function assertNoInternalWrites(db: Queryable, baseline: number, code: string, message: string): Promise<void> {
  if ((await internalTupleCount(db)) > baseline) {
    throw new PolicyViolationError(code, message);
  }
}
