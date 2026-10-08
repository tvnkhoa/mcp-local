/**
 * Runs a write batch inside a transaction this server owns. ADR 0006.
 *
 * One connection is pinned for the whole run by `mssql.Transaction`, and the sequence is:
 *
 *     BEGIN TRAN                      (driver, TDS level)           @@TRANCOUNT = 1
 *     SET XACT_ABORT ON; BEGIN TRAN ×N (N = COMMITs in the batch)    @@TRANCOUNT = 1 + N
 *     <the batch, unmodified>
 *     SELECT @@TRANCOUNT              must still be 1 + N
 *     preview → ROLLBACK              apply → COMMIT ×N, then COMMIT
 *
 * The extra levels are why a batch's own `BEGIN TRAN … COMMIT` is harmless here: its COMMIT
 * decrements a count that cannot reach zero (the guardrail keeps each COMMIT to one execution).
 * `XACT_ABORT ON` makes any run-time error roll the whole transaction back rather than leave the
 * batch running half-applied. The `@@TRANCOUNT` check is the run-time backstop for everything the
 * text-level guardrail could not see: if the count is not what was opened, the run is refused and
 * rolled back, in apply as well as in preview.
 */

import mssql from "mssql";

import { runBounded, type BoundedResult } from "./queryRunner.js";

export type WriteRunMode = "preview" | "apply";

export interface WriteRunOptions {
  readonly mode: WriteRunMode;
  /** COMMIT statements in the batch, from the guardrail. */
  readonly commitCount: number;
  readonly maxRows: number;
  readonly timeoutMs: number;
  /**
   * Apply only: the preview's `rowsAffected`. A different result means the data changed since the
   * preview, and the run is rolled back instead of committed.
   */
  readonly expectedRowsAffected?: readonly number[];
}

/** A SQL Server error raised by the batch itself — `THROW`, a constraint, a permission. */
export interface BatchError {
  readonly number: number | undefined;
  readonly lineNumber: number | undefined;
  readonly message: string;
}

export type WriteRunOutcome =
  | { readonly status: "rolled_back"; readonly result: BoundedResult }
  | { readonly status: "committed"; readonly result: BoundedResult }
  | { readonly status: "batch_failed"; readonly error: BatchError }
  | { readonly status: "timed_out"; readonly elapsedMs: number }
  | {
      readonly status: "transaction_unbalanced";
      readonly expected: number;
      readonly actual: number | undefined;
      readonly result: BoundedResult;
    }
  | {
      readonly status: "drifted";
      readonly expected: readonly number[];
      readonly result: BoundedResult;
    };

/** True when a driver error is SQL Server's own (it carries a server error number). */
function asBatchError(error: unknown): BatchError | undefined {
  const own = error as { number?: unknown; lineNumber?: unknown; message?: unknown; originalError?: unknown };
  const inner = (own.originalError ?? {}) as { number?: unknown; lineNumber?: unknown; message?: unknown };
  const number = typeof own.number === "number" ? own.number : typeof inner.number === "number" ? inner.number : undefined;
  if (number === undefined) {
    return undefined;
  }
  const lineNumber =
    typeof own.lineNumber === "number" ? own.lineNumber : typeof inner.lineNumber === "number" ? inner.lineNumber : undefined;
  const message = typeof own.message === "string" ? own.message : String(inner.message ?? "SQL Server error");
  return { number, lineNumber, message };
}

function sameCounts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Roll back whatever is left. Tolerates a transaction SQL Server already ended — XACT_ABORT, or
 * the batch's own `ROLLBACK; THROW` — which the driver reports as `EABORT`.
 */
async function rollbackQuietly(transaction: mssql.Transaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // Already rolled back by the server; the driver has released the connection.
  }
}

export async function runWriteBatch(
  pool: mssql.ConnectionPool,
  sql: string,
  options: WriteRunOptions
): Promise<WriteRunOutcome> {
  const transaction = new mssql.Transaction(pool);
  await transaction.begin();

  const expectedLevels = 1 + options.commitCount;
  let result: BoundedResult;
  try {
    await transaction.request().batch(`SET XACT_ABORT ON;${" BEGIN TRAN;".repeat(options.commitCount)}`);

    const request = transaction.request();
    result = await runBounded(request, () => request.batch(sql), {
      maxRows: options.maxRows,
      timeoutMs: options.timeoutMs,
      cancelAtRowCap: false
    });
  } catch (error) {
    await rollbackQuietly(transaction);
    const batchError = asBatchError(error);
    if (batchError !== undefined) {
      return { status: "batch_failed", error: batchError };
    }
    throw error;
  }

  if (result.timedOut) {
    await rollbackQuietly(transaction);
    return { status: "timed_out", elapsedMs: result.elapsedMs };
  }

  let actual: number | undefined;
  try {
    const levels = await transaction.request().query<{ n: number }>("SELECT @@TRANCOUNT AS n");
    actual = levels.recordset[0]?.n;
  } catch {
    actual = undefined;
  }
  if (actual !== expectedLevels) {
    await rollbackQuietly(transaction);
    return { status: "transaction_unbalanced", expected: expectedLevels, actual, result };
  }

  if (options.mode === "preview") {
    await transaction.rollback();
    return { status: "rolled_back", result };
  }

  if (options.expectedRowsAffected !== undefined && !sameCounts(options.expectedRowsAffected, result.rowsAffected)) {
    await rollbackQuietly(transaction);
    return { status: "drifted", expected: options.expectedRowsAffected, result };
  }

  try {
    if (options.commitCount > 0) {
      await transaction.request().batch("COMMIT TRAN;".repeat(options.commitCount));
    }
    await transaction.commit();
  } catch (error) {
    await rollbackQuietly(transaction);
    throw error;
  }
  return { status: "committed", result };
}
