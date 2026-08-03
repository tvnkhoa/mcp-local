import { createHash } from "node:crypto";

import type { Pool } from "pg";

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  default: string | null;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  definition: string;
}

export interface TableSnapshot {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  indexes: string[];
  constraints: ConstraintInfo[];
}

/** Postgres pg_constraint.contype codes → the readable labels information_schema used to give us. */
const CONSTRAINT_TYPE_LABELS: Record<string, string> = {
  p: "PRIMARY KEY",
  f: "FOREIGN KEY",
  u: "UNIQUE",
  c: "CHECK",
  x: "EXCLUDE"
};

/** Collapse whitespace so formatting differences don't register as semantic drift. */
function normalizeConstraintDef(def: string): string {
  return def.replace(/\s+/g, " ").trim();
}

/** Identity used for equality/diffing — by semantic content, never by (server-specific) name. */
function constraintKey(c: ConstraintInfo): string {
  return `${c.type}:${normalizeConstraintDef(c.definition)}`;
}

/**
 * Count occurrences per semantic key. Postgres allows multiple constraints with the same
 * definition under different names, so a plain Set (membership only) would collapse e.g.
 * two identical CHECK constraints into one entry — dropping one of them would then be
 * invisible to the diff. Comparing counts instead preserves multiplicity.
 */
function constraintMultiset(constraints: ConstraintInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of constraints) {
    const key = constraintKey(c);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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

  // pg_constraint (not information_schema.table_constraints) — the latter synthesizes a
  // pseudo constraint row per NOT NULL column named "{schema_oid}_{table_oid}_{col}_not_null",
  // which embeds the table's OID and therefore differs between any two independently-created
  // databases even when schemas are byte-identical. pg_get_constraintdef gives the real,
  // semantic definition instead of a server-specific auto-generated name.
  // contype is restricted to the five constraint kinds CONSTRAINT_TYPE_LABELS knows about:
  // PostgreSQL 18 added catalogued NOT NULL rows (contype 'n') to pg_constraint, and 't'
  // marks constraint triggers — including either would report spurious drift when comparing
  // a PG18 server against an older one (NOT NULL is already tracked via ColumnInfo.isNullable).
  // pretty=false (not true): pg_get_constraintdef's docs note the pretty-printed form isn't
  // guaranteed stable/comparable across versions (pg_dump uses pretty=false for this reason);
  // whitespace normalization alone can't bridge parenthesization/cast-rendering differences.
  const constraints = await pool.query<{
    table_schema: string;
    table_name: string;
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>(
    `
    select n.nspname as table_schema, c.relname as table_name,
           con.conname as constraint_name, con.contype as constraint_type,
           pg_get_constraintdef(con.oid, false) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any($1) and con.contype = any(array['p','f','u','c','x'])
    order by n.nspname, c.relname, con.conname
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
    ensure(row.table_schema, row.table_name).constraints.push({
      name: row.constraint_name,
      type: CONSTRAINT_TYPE_LABELS[row.constraint_type] ?? row.constraint_type,
      definition: row.definition
    });
  }

  const tables = [...tableMap.values()].sort((a, b) =>
    keyOf(a.schema, a.table).localeCompare(keyOf(b.schema, b.table))
  );
  for (const t of tables) {
    t.indexes.sort();
    t.constraints.sort((a, b) => constraintKey(a).localeCompare(constraintKey(b)));
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
    addedConstraints: string[];
    removedConstraints: string[];
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

    // Compare constraints by semantic content (type + normalized definition), never by name —
    // constraint names can be auto-generated per-server and aren't a stable identity. Compared
    // as multisets (not sets) so dropping one of two identically-defined constraints registers.
    const aMultiset = constraintMultiset(at.constraints);
    const bMultiset = constraintMultiset(bt.constraints);
    const addedConstraints: string[] = [];
    const removedConstraints: string[] = [];
    for (const key of new Set([...aMultiset.keys(), ...bMultiset.keys()])) {
      const delta = (bMultiset.get(key) ?? 0) - (aMultiset.get(key) ?? 0);
      if (delta > 0) {
        addedConstraints.push(...Array(delta).fill(key));
      } else if (delta < 0) {
        removedConstraints.push(...Array(-delta).fill(key));
      }
    }
    addedConstraints.sort();
    removedConstraints.sort();
    const constraintChanged = addedConstraints.length > 0 || removedConstraints.length > 0;

    if (
      addedColumns.length ||
      removedColumns.length ||
      changedColumns.length ||
      indexChanged ||
      constraintChanged
    ) {
      changedTables.push({
        table: key,
        addedColumns,
        removedColumns,
        changedColumns,
        indexChanged,
        constraintChanged,
        addedConstraints,
        removedConstraints
      });
    }
  }

  return {
    identical: addedTables.length === 0 && removedTables.length === 0 && changedTables.length === 0,
    addedTables,
    removedTables,
    changedTables
  };
}
