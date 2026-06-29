import { createHash } from "node:crypto";

import type { Pool } from "pg";

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  default: string | null;
}

export interface TableSnapshot {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  indexes: string[];
  constraints: string[];
}

export interface SchemaSnapshot {
  schemas: string[];
  tables: TableSnapshot[];
  snapshotId: string;
}

/** Discover every non-system schema (so snapshots aren't silently limited to `public`). */
async function discoverUserSchemas(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ nspname: string }>(
    `
    select nspname
    from pg_namespace
    where nspname not in ('pg_catalog', 'information_schema')
      and nspname not like 'pg\\_%'
    order by nspname
    `
  );
  return result.rows.map((r) => r.nspname);
}

/**
 * Capture a structural snapshot (tables → columns/indexes/constraints).
 * When `schemas` is omitted, ALL non-system schemas are captured — this matters for
 * the migration drift guard and compare_environments, which must not ignore tables
 * that live outside `public`.
 */
export async function captureSchema(pool: Pool, schemas?: string[]): Promise<SchemaSnapshot> {
  const targetSchemas =
    schemas && schemas.length > 0 ? schemas : await discoverUserSchemas(pool);

  const columns = await pool.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `
    select table_schema, table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = any($1)
    order by table_schema, table_name, ordinal_position
    `,
    [targetSchemas]
  );

  const indexes = await pool.query<{ schemaname: string; tablename: string; indexname: string; indexdef: string }>(
    `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname = any($1)`,
    [targetSchemas]
  );

  const constraints = await pool.query<{
    table_schema: string;
    table_name: string;
    constraint_name: string;
    constraint_type: string;
  }>(
    `
    select table_schema, table_name, constraint_name, constraint_type
    from information_schema.table_constraints
    where table_schema = any($1)
    order by table_schema, table_name, constraint_name
    `,
    [targetSchemas]
  );

  const tableMap = new Map<string, TableSnapshot>();
  const keyOf = (s: string, t: string): string => `${s}.${t}`;
  const ensure = (s: string, t: string): TableSnapshot => {
    const k = keyOf(s, t);
    let snap = tableMap.get(k);
    if (!snap) {
      snap = { schema: s, table: t, columns: [], indexes: [], constraints: [] };
      tableMap.set(k, snap);
    }
    return snap;
  };

  for (const row of columns.rows) {
    ensure(row.table_schema, row.table_name).columns.push({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === "YES",
      default: row.column_default
    });
  }
  for (const row of indexes.rows) {
    ensure(row.schemaname, row.tablename).indexes.push(row.indexdef);
  }
  for (const row of constraints.rows) {
    ensure(row.table_schema, row.table_name).constraints.push(`${row.constraint_type}:${row.constraint_name}`);
  }

  const tables = [...tableMap.values()].sort((a, b) =>
    keyOf(a.schema, a.table).localeCompare(keyOf(b.schema, b.table))
  );
  for (const t of tables) {
    t.indexes.sort();
    t.constraints.sort();
  }

  const snapshotId = createHash("sha256")
    .update(JSON.stringify({ schemas: targetSchemas, tables }))
    .digest("hex")
    .slice(0, 24);

  return { schemas: targetSchemas, tables, snapshotId };
}

export interface SchemaDiff {
  identical: boolean;
  addedTables: string[];
  removedTables: string[];
  changedTables: Array<{
    table: string;
    addedColumns: string[];
    removedColumns: string[];
    changedColumns: string[];
    indexChanged: boolean;
    constraintChanged: boolean;
  }>;
}

/** Diff two snapshots (a = source/before, b = target/after). */
export function diffSnapshots(a: SchemaSnapshot, b: SchemaSnapshot): SchemaDiff {
  const aMap = new Map(a.tables.map((t) => [`${t.schema}.${t.table}`, t]));
  const bMap = new Map(b.tables.map((t) => [`${t.schema}.${t.table}`, t]));

  const addedTables = [...bMap.keys()].filter((k) => !aMap.has(k)).sort();
  const removedTables = [...aMap.keys()].filter((k) => !bMap.has(k)).sort();
  const changedTables: SchemaDiff["changedTables"] = [];

  for (const [key, at] of aMap) {
    const bt = bMap.get(key);
    if (!bt) {
      continue;
    }
    const aCols = new Map(at.columns.map((c) => [c.name, c]));
    const bCols = new Map(bt.columns.map((c) => [c.name, c]));
    const addedColumns = [...bCols.keys()].filter((c) => !aCols.has(c)).sort();
    const removedColumns = [...aCols.keys()].filter((c) => !bCols.has(c)).sort();
    const changedColumns: string[] = [];
    for (const [name, ac] of aCols) {
      const bc = bCols.get(name);
      if (bc && (bc.dataType !== ac.dataType || bc.isNullable !== ac.isNullable || bc.default !== ac.default)) {
        changedColumns.push(name);
      }
    }
    const indexChanged = JSON.stringify(at.indexes) !== JSON.stringify(bt.indexes);
    const constraintChanged = JSON.stringify(at.constraints) !== JSON.stringify(bt.constraints);

    if (addedColumns.length || removedColumns.length || changedColumns.length || indexChanged || constraintChanged) {
      changedTables.push({ table: key, addedColumns, removedColumns, changedColumns, indexChanged, constraintChanged });
    }
  }

  return {
    identical: addedTables.length === 0 && removedTables.length === 0 && changedTables.length === 0,
    addedTables,
    removedTables,
    changedTables
  };
}
