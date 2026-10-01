/**
 * Execution-time proof that a statement changed nothing in the server's own schemas.
 *
 * Shared by the write lane (PG-SEC-002), where a trigger on the target table can reach `mcp_ops`,
 * and both migration lanes, where an `ADD COLUMN … DEFAULT f()`, an index expression or a trigger
 * runs code that the guardrail never saw. That code may also build the schema name at run time
 * (`'mcp_' || 'ops'`), so no textual check can be enough on its own.
 *
 * The reading has two parts, and a change in either part is a violation:
 *  - **Rows:** `pg_stat_xact_user_tables`, the per-table tuple counters for the current
 *    transaction. Every insert, update or delete is counted there, however it was reached.
 *  - **Structure:** a fingerprint of the internal schemas' catalog rows: each relation's oid, name,
 *    filenode, column count, kind and trigger flag, the trigger count, and whether the schema exists.
 *    `TRUNCATE` and a rewriting `ALTER` move no tuple counter but do assign a new filenode.
 *    `DROP`, `CREATE`, `ADD COLUMN` and new triggers change rows of the catalog. The tuple counters
 *    alone missed all of these. That gap was found by review, as finding 1 of the 2026-10-01 pass.
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

/** An opaque reading. Compare two readings from the same transaction with `assertNoInternalWrites`. */
export interface InternalState {
  tuples: number;
  catalog: string;
}

export async function internalState(db: Queryable): Promise<InternalState> {
  const result = await db.query<{ tuples: string | null; catalog: string | null }>(
    `select
       (select sum(n_tup_ins + n_tup_upd + n_tup_del)
          from pg_stat_xact_user_tables where schemaname = any($1::text[])) as tuples,
       (select coalesce(string_agg(n.nspname::text, ',' order by n.nspname), '') || '|' ||
               coalesce((select string_agg(concat_ws(':', c.oid::text, c.relname::text, c.relfilenode::text, c.relnatts::text, c.relkind::text, c.relhastriggers::text), ',' order by c.oid)
                         from pg_class c join pg_namespace cn on cn.oid = c.relnamespace
                         where cn.nspname = any($1::text[])), '') || '|' ||
               (select count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace cn on cn.oid = c.relnamespace
                 where cn.nspname = any($1::text[]))
          from pg_namespace n where n.nspname = any($1::text[])) as catalog`,
    [INTERNAL_SCHEMAS]
  );
  return { tuples: Number(result.rows[0]?.tuples ?? 0), catalog: result.rows[0]?.catalog ?? "" };
}

/**
 * Refuse with `code` if anything changed in an internal schema since `baseline` was read, rows or
 * structure. Call it inside the same transaction block, after the statement and before the
 * transaction ends.
 */
export async function assertNoInternalWrites(db: Queryable, baseline: InternalState, code: string, message: string): Promise<void> {
  const now = await internalState(db);
  if (now.tuples > baseline.tuples || now.catalog !== baseline.catalog) {
    throw new PolicyViolationError(code, message);
  }
}
