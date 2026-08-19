/**
 * Row-bounded execution.
 *
 * T-SQL has no `LIMIT`, and that single fact shapes this module. `postgres-mcp` bounds a read by
 * appending `LIMIT n` to the caller's statement; the T-SQL equivalent, `TOP (n)`, cannot be
 * appended — it belongs at the front of a `SELECT`, so imposing it means either rewriting the
 * statement or wrapping it as `select top (n) * from (<sql>) q`. The wrap breaks a CTE, breaks a
 * top-level `ORDER BY`, and silently changes the shape of a multi-recordset result.
 *
 * So the caller's SQL is never touched. The bound is applied to the *stream*: rows are counted as
 * they arrive and the request is cancelled at the cap. The statement the server ran is exactly the
 * statement that was asked for, which also means an `EXPLAIN`-style comparison against the same
 * text is meaningful.
 */

import type sql from "mssql";

export interface ColumnMeta {
  readonly name: string;
  readonly type: string;
}

export interface RecordSetResult {
  readonly columns: readonly ColumnMeta[];
  /** Row arrays, positional against `columns` — see {@link runBoundedQuery} for why not objects. */
  readonly rows: readonly unknown[][];
  readonly truncated: boolean;
}

export interface BoundedResult {
  readonly recordsets: readonly RecordSetResult[];
  readonly rowsAffected: readonly number[];
  /** The row cap was reached. Distinct from {@link BoundedResult.timedOut} — see `cancelReason`. */
  readonly truncated: boolean;
  /** `timeoutMs` elapsed and the stream was cancelled. Rows read before that point are returned. */
  readonly timedOut: boolean;
  readonly elapsedMs: number;
  readonly output?: Record<string, unknown>;
  readonly returnValue?: unknown;
}

/**
 * `Canceled.` is what the driver raises when {@link BoundedResult.truncated} was our own doing.
 * Distinguishing it from a genuine failure is the difference between "here are your 500 rows" and
 * an error the caller cannot act on.
 */
function isCancellation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ECANCEL") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /cancell?ed/i.test(message);
}

/**
 * JSON-safe values.
 *
 * Two SQL Server types break `JSON.stringify` outright or produce something unreadable:
 * `varbinary` arrives as a Buffer and serializes to `{"type":"Buffer","data":[…]}`, and `bigint`
 * can arrive as a JS BigInt, which throws. Both are rendered as strings.
 */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 64).toString("hex");
    return value.length > 64 ? `0x${hex}… (${value.length} bytes)` : `0x${hex}`;
  }
  return value;
}

/** The `recordset` event hands columns as an array in arrayRowMode and a keyed object otherwise. */
function toColumnMeta(meta: unknown): ColumnMeta[] {
  const entries = Array.isArray(meta) ? meta : Object.values(meta as Record<string, unknown>);
  return entries.map((entry, index) => {
    const column = entry as { name?: string; type?: { declaration?: string; name?: string } };
    return {
      name: column.name ?? `column${index + 1}`,
      type: column.type?.declaration ?? column.type?.name ?? "unknown"
    };
  });
}

export interface BoundedOptions {
  readonly maxRows: number;
  readonly timeoutMs: number;
}

/**
 * Stream a request, stopping at `maxRows` **per recordset**, and never rewriting the statement.
 *
 * `arrayRowMode` is on deliberately. Object rows silently drop a column when two columns share a
 * name, which a wide join across catalogs produces constantly — `SELECT c.Id, t.Id FROM …` yields
 * one `Id`. Positional rows plus a `columns` list cannot lose one, and they cost fewer tokens.
 *
 * @param start called after the listeners are attached — `() => request.query(sql)` or
 *              `() => request.execute(name)`. Attaching first matters: rows can arrive before the
 *              returned promise is awaited.
 */
export async function runBounded(
  request: sql.Request,
  start: () => Promise<sql.IResult<unknown> | sql.IProcedureResult<unknown>>,
  options: BoundedOptions
): Promise<BoundedResult> {
  const startedAt = Date.now();

  request.stream = true;
  request.arrayRowMode = true;

  const recordsets: Array<{ columns: ColumnMeta[]; rows: unknown[][]; truncated: boolean }> = [];
  let current: { columns: ColumnMeta[]; rows: unknown[][]; truncated: boolean } | undefined;
  /**
   * Why we cancelled, or `undefined` if we did not.
   *
   * One field rather than two booleans, so `truncated` and `timedOut` cannot both be true and
   * leave a caller guessing which bound it actually hit. It also has to be *this* variable the
   * guard below tests: the driver reports both cancellations identically as `Canceled.`, and a
   * timeout that set some other flag would fall through to `throw` and return an error with zero
   * rows — the opposite of returning what was read.
   */
  let cancelReason: "rowCap" | "timeout" | undefined;
  let streamError: unknown;

  request.on("recordset", (meta: unknown) => {
    current = { columns: toColumnMeta(meta), rows: [], truncated: false };
    recordsets.push(current);
  });

  request.on("row", (row: unknown) => {
    if (current === undefined) {
      current = { columns: [], rows: [], truncated: false };
      recordsets.push(current);
    }
    if (current.rows.length >= options.maxRows) {
      if (cancelReason === undefined) {
        current.truncated = true;
        cancelReason = "rowCap";
        request.cancel();
      }
      return;
    }
    const values = Array.isArray(row) ? row : Object.values(row as Record<string, unknown>);
    current.rows.push(values.map(normalizeValue));
  });

  // Attached so a driver-level `error` event cannot reach the process as an unhandled emitter
  // error. The rejection from `start()` is what the caller actually sees.
  request.on("error", (error: unknown) => {
    streamError = error;
  });

  /**
   * The statement timeout, applied the same way the row cap is: by cancelling the stream.
   *
   * `mssql` has no per-request timeout — `requestTimeout` is set once per pool, and the
   * `request.timeout = …` this replaced assigned a property the driver never reads, so every
   * caller-supplied `timeoutMs` was silently ignored. A query asked to finish in 2s ran for 17s
   * and returned normally.
   */
  const deadline = setTimeout(() => {
    if (cancelReason === undefined) {
      cancelReason = "timeout";
      request.cancel();
    }
  }, options.timeoutMs);

  let settled: sql.IResult<unknown> | sql.IProcedureResult<unknown> | undefined;
  try {
    settled = await start();
  } catch (error) {
    if (!(cancelReason !== undefined && isCancellation(error))) {
      throw error;
    }
  } finally {
    clearTimeout(deadline);
  }

  if (streamError !== undefined && !(cancelReason !== undefined && isCancellation(streamError))) {
    throw streamError;
  }

  const output = settled?.output;
  const returnValue = (settled as sql.IProcedureResult<unknown> | undefined)?.returnValue;

  return {
    recordsets: recordsets.map((set) => ({
      columns: set.columns,
      rows: set.rows,
      truncated: set.truncated
    })),
    rowsAffected: settled?.rowsAffected ?? [],
    truncated: cancelReason === "rowCap",
    timedOut: cancelReason === "timeout",
    elapsedMs: Date.now() - startedAt,
    output:
      output === undefined || Object.keys(output).length === 0
        ? undefined
        : Object.fromEntries(Object.entries(output).map(([k, v]) => [k, normalizeValue(v)])),
    returnValue: returnValue === undefined ? undefined : normalizeValue(returnValue)
  };
}
