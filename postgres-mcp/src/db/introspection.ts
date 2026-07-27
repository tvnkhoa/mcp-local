import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";

import type { ConnectionManager } from "./connectionManager.js";
import { PolicyViolationError } from "../errors.js";
import { asText, type ResponseProfile } from "../response/responseFormatter.js";
import { quoteIdent } from "../guardrails/ident.js";
import { safeRollback } from "../write/writeHandlers.js";

// ── get_table_relationships ─────────────────────────────────────────────────────

export async function handleGetTableRelationships(
  args: { environment?: string; table?: string; profile?: ResponseProfile },
  connections: ConnectionManager
): Promise<CallToolResult> {
  const pool = connections.getPool(args.environment);
  const params: unknown[] = [];
  let filter = "";
  if (args.table) {
    params.push(args.table);
    filter = "and (cl.relname = $1 or fcl.relname = $1)";
  }

  const result = await pool.query<{
    constraint_name: string;
    schema: string;
    table: string;
    column: string;
    ref_schema: string;
    ref_table: string;
    ref_column: string;
  }>(
    `
    select
      con.conname as constraint_name,
      ns.nspname  as schema,
      cl.relname  as table,
      att.attname as column,
      fns.nspname as ref_schema,
      fcl.relname as ref_table,
      fatt.attname as ref_column
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_class fcl on fcl.oid = con.confrelid
    join pg_namespace fns on fns.oid = fcl.relnamespace
    join unnest(con.conkey) with ordinality as ck(attnum, ord) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = ck.attnum
    join unnest(con.confkey) with ordinality as fk(attnum, ord) on fk.ord = ck.ord
    join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = fk.attnum
    where con.contype = 'f' ${filter}
    order by schema, "table", constraint_name, ck.ord
    `,
    params
  );

  return asText(
    {
      environment: connections.resolveEnvName(args.environment),
      table: args.table ?? null,
      relationshipCount: result.rowCount,
      foreignKeys: result.rows.map((r) => ({
        constraint: r.constraint_name,
        from: `${r.schema}.${r.table}.${r.column}`,
        to: `${r.ref_schema}.${r.ref_table}.${r.ref_column}`
      }))
    },
    args.profile ?? "compact"
  );
}

// ── profile_table ───────────────────────────────────────────────────────────────

export async function handleProfileTable(
  args: { environment?: string; schema?: string; table: string; sampleLimit?: number; profile?: ResponseProfile },
  connections: ConnectionManager
): Promise<CallToolResult> {
  const pool = connections.getPool(args.environment);
  const schema = args.schema ?? "public";
  const sampleLimit = Math.min(Math.max(args.sampleLimit ?? 10, 1), 100);

  const estimate = await pool.query<{ reltuples: string }>(
    `
    select c.reltuples::bigint as reltuples
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relname = $2
    `,
    [schema, args.table]
  );
  if (estimate.rowCount === 0) {
    throw new PolicyViolationError("TABLE_NOT_FOUND", `Table '${schema}.${args.table}' not found.`);
  }

  const stats = await pool.query<{ attname: string; n_distinct: number; null_frac: number }>(
    `select attname, n_distinct, null_frac from pg_stats where schemaname = $1 and tablename = $2 order by attname`,
    [schema, args.table]
  );

  const sample = await pool.query(
    `select * from ${quoteIdent(schema)}.${quoteIdent(args.table)} limit ${sampleLimit}`
  );

  return asText(
    {
      environment: connections.resolveEnvName(args.environment),
      schema,
      table: args.table,
      estimatedRows: Number(estimate.rows[0]?.reltuples ?? 0),
      columnStats: stats.rows.map((s) => ({
        column: s.attname,
        distinct: s.n_distinct,
        nullFraction: s.null_frac
      })),
      sampleRowCount: sample.rowCount,
      sample: sample.rows
    },
    args.profile ?? "compact"
  );
}

// ── data_diff ───────────────────────────────────────────────────────────────────

/**
 * Resolve which columns to include in the row checksum. Always an explicit, sorted
 * list — never the bare table alias (`t::text`) — so the checksum depends only on the
 * *logical* column set, not physical storage order (attnum), which can silently shift
 * across environments (e.g. a column dropped and re-added gets a new attnum even
 * though the logical schema is unchanged, which would otherwise read as a false diff).
 * When `requestedColumns` is omitted, falls back to the intersection of columns present
 * on both sides so a caller isn't misled by columns that only exist on one side.
 *
 * A table absent from *both* environments would otherwise fall through to the generic
 * "no common columns" error (every real table has at least one column, so zero columns
 * on a side unambiguously means the table doesn't exist there) — checked explicitly so
 * the caller gets an accurate TABLE_NOT_FOUND instead of a misleading column-mismatch
 * message. Explicitly `requestedColumns` are validated against both sides up front too,
 * so a typo surfaces as a clear error instead of a raw Postgres "column does not exist"
 * from inside the checksum query.
 */
async function resolveDiffColumns(
  sourcePool: Pool,
  targetPool: Pool,
  schema: string,
  table: string,
  requestedColumns?: string[]
): Promise<{ columns: string[]; onlySource: string[]; onlyTarget: string[] }> {
  const columnQuery = `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`;
  const [sourceCols, targetCols] = await Promise.all([
    sourcePool.query<{ column_name: string }>(columnQuery, [schema, table]),
    targetPool.query<{ column_name: string }>(columnQuery, [schema, table])
  ]);

  if (sourceCols.rowCount === 0 || targetCols.rowCount === 0) {
    const missingFrom = [
      sourceCols.rowCount === 0 ? "source" : null,
      targetCols.rowCount === 0 ? "target" : null
    ].filter((side): side is string => side !== null);
    throw new PolicyViolationError(
      "TABLE_NOT_FOUND",
      `Table '${schema}.${table}' not found on: ${missingFrom.join(", ")}.`
    );
  }

  const sourceSet = new Set(sourceCols.rows.map((r) => r.column_name));
  const targetSet = new Set(targetCols.rows.map((r) => r.column_name));

  if (requestedColumns && requestedColumns.length > 0) {
    const unknown = requestedColumns.filter((c) => !sourceSet.has(c) || !targetSet.has(c));
    if (unknown.length > 0) {
      throw new PolicyViolationError(
        "UNKNOWN_COLUMN",
        `Column(s) not present on both sides of '${schema}.${table}': ${unknown.join(", ")}.`
      );
    }
    return { columns: [...requestedColumns].sort(), onlySource: [], onlyTarget: [] };
  }

  const columns = [...sourceSet].filter((c) => targetSet.has(c)).sort();
  const onlySource = [...sourceSet].filter((c) => !targetSet.has(c)).sort();
  const onlyTarget = [...targetSet].filter((c) => !sourceSet.has(c)).sort();

  if (columns.length === 0) {
    throw new PolicyViolationError(
      "NO_COMPARABLE_COLUMNS",
      `No common columns to diff for '${schema}.${table}' between the two environments.`
    );
  }

  return { columns, onlySource, onlyTarget };
}

/**
 * count + order-independent checksum of a table over an explicit, fixed column list.
 * Uses sum() of each row's hash (split into two 64-bit halves so the full 128-bit MD5
 * digest contributes) rather than string_agg(... order by ...): sum is commutative, so
 * no ORDER BY / sort is needed to make it order-independent, and it keeps only two
 * numeric accumulators in memory regardless of table size — unlike string_agg, which
 * concatenates every row's hash into one in-memory string (multi-GB / OOM risk on large
 * tables). Sum was chosen over XOR because XOR cancels to zero for any value repeated an
 * even number of times, which would mask real duplicate-row drift; casting to numeric
 * before summing avoids bigint overflow regardless of row count. The per-row hash is
 * computed once in a derived table (`s`) and reused for both halves, instead of calling
 * md5(row(...)::text) twice per row.
 */
async function tableFingerprint(
  pool: Pool,
  schema: string,
  table: string,
  columns: string[]
): Promise<{ count: number; checksum: string }> {
  const rowExpr = `row(${columns.map(quoteIdent).join(", ")})`;
  const q = `
    select
      count(*)::bigint as c,
      coalesce(
        md5(
          sum(('x' || substr(h, 1, 16))::bit(64)::bigint::numeric)::text
          || ':' ||
          sum(('x' || substr(h, 17, 16))::bit(64)::bigint::numeric)::text
        ),
        ''
      ) as checksum
    from (
      select md5(${rowExpr}::text) as h
      from ${quoteIdent(schema)}.${quoteIdent(table)} t
    ) s
  `;
  const client = await pool.connect();
  try {
    // Canonicalize every session GUC that affects row(...)::text rendering — TimeZone /
    // extra_float_digits (timestamptz / float precision), DateStyle / IntervalStyle (date
    // and interval formatting), bytea_output (hex vs. escape), lc_monetary (currency
    // symbol/decimal formatting) — so byte-identical data never produces different
    // checksums just because the two servers have different session defaults. Sent as one
    // multi-statement round trip (no bind params, so the simple query protocol accepts
    // it) instead of one round trip per statement; SET LOCAL is scoped to this transaction.
    await client.query(
      "begin; set transaction read only; set local time zone 'UTC'; " +
        "set local extra_float_digits = 3; set local datestyle = 'ISO, MDY'; " +
        "set local intervalstyle = 'postgres'; set local bytea_output = 'hex'; " +
        "set local lc_monetary = 'C';"
    );
    const res = await client.query<{ c: string; checksum: string }>(q);
    return { count: Number(res.rows[0]?.c ?? 0), checksum: res.rows[0]?.checksum ?? "" };
  } finally {
    await safeRollback(client);
    client.release();
  }
}

export async function handleDataDiff(
  args: {
    source: string;
    target: string;
    schema?: string;
    table: string;
    columns?: string[];
    profile?: ResponseProfile;
  },
  connections: ConnectionManager
): Promise<CallToolResult> {
  const schema = args.schema ?? "public";
  const sourcePool = connections.getPool(args.source);
  const targetPool = connections.getPool(args.target);

  const { columns, onlySource, onlyTarget } = await resolveDiffColumns(
    sourcePool,
    targetPool,
    schema,
    args.table,
    args.columns
  );

  const [source, target] = await Promise.all([
    tableFingerprint(sourcePool, schema, args.table, columns),
    tableFingerprint(targetPool, schema, args.table, columns)
  ]);

  // When the caller didn't pin an explicit column list and the two sides' column sets
  // differ, the checksum only covers the shared columns — a side-only column full of
  // divergent data would otherwise slip through as identical:true. Surface that as a
  // hard non-match rather than a footnote, since "identical" is the field a go/no-go
  // decision is likely to key off.
  const columnsMismatch = onlySource.length > 0 || onlyTarget.length > 0;

  return asText(
    {
      source: connections.resolveEnvName(args.source),
      target: connections.resolveEnvName(args.target),
      schema,
      table: args.table,
      columns,
      columnsOnlySource: onlySource.length > 0 ? onlySource : undefined,
      columnsOnlyTarget: onlyTarget.length > 0 ? onlyTarget : undefined,
      columnsMismatch,
      identical: !columnsMismatch && source.count === target.count && source.checksum === target.checksum,
      sourceCount: source.count,
      targetCount: target.count,
      sourceChecksum: source.checksum,
      targetChecksum: target.checksum
    },
    args.profile ?? "compact"
  );
}
