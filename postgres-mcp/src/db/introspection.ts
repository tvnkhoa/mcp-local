import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";

import type { ConnectionManager } from "./connectionManager.js";
import { PolicyViolationError } from "../errors.js";
import { asText, type ResponseProfile } from "../response/responseFormatter.js";
import { quoteIdent } from "../sql/ident.js";

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

/** count + order-independent checksum of a table (optionally a column subset). */
async function tableFingerprint(
  pool: Pool,
  schema: string,
  table: string,
  columns?: string[]
): Promise<{ count: number; checksum: string }> {
  const rowExpr = columns && columns.length > 0
    ? `row(${columns.map(quoteIdent).join(", ")})`
    : "t";
  // Order by the per-row hash itself so the aggregate is deterministic regardless of
  // whether a key was supplied or whether key values are unique — two byte-identical
  // tables always produce the same checksum. (Ordering by key columns alone left rows
  // with tied keys in unspecified order, yielding spurious "differs" results.)
  const q = `
    select
      count(*)::bigint as c,
      coalesce(md5(string_agg(md5(${rowExpr}::text), '' order by md5(${rowExpr}::text))), '') as checksum
    from ${quoteIdent(schema)}.${quoteIdent(table)} t
  `;
  const res = await pool.query<{ c: string; checksum: string }>(q);
  return { count: Number(res.rows[0]?.c ?? 0), checksum: res.rows[0]?.checksum ?? "" };
}

export async function handleDataDiff(
  args: {
    source: string;
    target: string;
    schema?: string;
    table: string;
    keyColumns?: string[];
    columns?: string[];
    profile?: ResponseProfile;
  },
  connections: ConnectionManager
): Promise<CallToolResult> {
  const schema = args.schema ?? "public";
  const sourcePool = connections.getPool(args.source);
  const targetPool = connections.getPool(args.target);

  const [source, target] = await Promise.all([
    tableFingerprint(sourcePool, schema, args.table, args.columns),
    tableFingerprint(targetPool, schema, args.table, args.columns)
  ]);

  return asText(
    {
      source: connections.resolveEnvName(args.source),
      target: connections.resolveEnvName(args.target),
      schema,
      table: args.table,
      columns: args.columns ?? null,
      identical: source.count === target.count && source.checksum === target.checksum,
      sourceCount: source.count,
      targetCount: target.count,
      sourceChecksum: source.checksum,
      targetChecksum: target.checksum
    },
    args.profile ?? "compact"
  );
}
