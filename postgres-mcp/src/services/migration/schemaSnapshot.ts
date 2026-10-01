import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

/** A pool or a single client: the snapshot only issues queries, so either will do. */
type Queryable = Pick<Pool | PoolClient, "query">;

import { INTERNAL_SCHEMAS } from "../../middleware/internalSchemas.js";

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

/**
 * Bumped whenever what the snapshot captures changes, and hashed into `snapshotId`, so ids from
 * two different shapes can never compare equal. v1 captured tables only; v2 adds `objects`.
 */
export const SNAPSHOT_VERSION = 2;

/** Schema objects other than tables, each kind keyed by a stable qualified name. */
export const OBJECT_KINDS = ["views", "sequences", "enums", "domains", "routines", "triggers", "extensions"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export interface ObjectDef {
  /** Qualified and stable: `schema.view`, `schema.fn(int, text)`, `schema.table.trigger`, `extname`. */
  name: string;
  /**
   * What decides equality. For views, routines and triggers this is an md5 of the server's own
   * rendering (pg_get_viewdef / pg_get_functiondef / pg_get_triggerdef) rather than the text,
   * which keeps `schema://` small — a diff says WHAT changed, `describe_table` or the catalog
   * shows how. Short definitions (enum labels, sequence parameters, extension version) are kept
   * readable.
   */
  definition: string;
}

export type SchemaObjects = Record<ObjectKind, ObjectDef[]>;

export interface SchemaSnapshot {
  snapshotVersion: number;
  schemas: string[];
  tables: TableSnapshot[];
  objects: SchemaObjects;
  snapshotId: string;
}

/**
 * `not exists (… deptype 'e')` for a catalog row: excludes objects an extension created. Without
 * it, installing PostGIS or pgcrypto floods every kind with hundreds of entries the migrations
 * never wrote — and makes two environments at different extension versions look wholesale
 * different. The extension itself is still captured, by name and version.
 */
function notExtensionOwned(catalog: string, oidExpr: string): string {
  return `not exists (select 1 from pg_depend d where d.classid = '${catalog}'::regclass and d.objid = ${oidExpr} and d.deptype = 'e')`;
}

async function captureObjects(pool: Queryable, schemas: string[]): Promise<SchemaObjects> {
  const [views, sequences, enums, domains, routines, triggers, extensions] = await Promise.all([
    pool.query<{ name: string; definition: string }>(
      `select n.nspname || '.' || c.relname as name,
              case c.relkind when 'm' then 'materialized ' else '' end || md5(pg_get_viewdef(c.oid, false)) as definition
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('v', 'm') and n.nspname = any($1) and ${notExtensionOwned("pg_class", "c.oid")}`,
      [schemas]
    ),
    // Parameters only. last_value is state, not structure, and changes with every insert.
    pool.query<{ name: string; definition: string }>(
      `select n.nspname || '.' || c.relname as name,
              format('%s start %s increment %s min %s max %s cache %s%s',
                     format_type(s.seqtypid, null), s.seqstart, s.seqincrement, s.seqmin, s.seqmax,
                     s.seqcache, case when s.seqcycle then ' cycle' else '' end) as definition
       from pg_sequence s
       join pg_class c on c.oid = s.seqrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($1) and ${notExtensionOwned("pg_class", "c.oid")}`,
      [schemas]
    ),
    // Label ORDER is part of an enum's meaning (it defines < and >), so it is kept.
    pool.query<{ name: string; definition: string }>(
      `select n.nspname || '.' || t.typname as name,
              json_agg(e.enumlabel order by e.enumsortorder)::text as definition
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = any($1) and ${notExtensionOwned("pg_type", "t.oid")}
       group by n.nspname, t.typname`,
      [schemas]
    ),
    // CHECK constraints only (contype 'c'): PG17 started cataloguing a domain's NOT NULL as a
    // constraint row too, the same split PG18 made for tables — typnotnull covers it on every
    // version, so taking the rows as well would report drift between PG16 and PG17 servers.
    pool.query<{ name: string; definition: string }>(
      `select n.nspname || '.' || t.typname as name,
              format_type(t.typbasetype, t.typtypmod)
                || case when t.typnotnull then ' not null' else '' end
                || coalesce(' default ' || t.typdefault, '')
                || coalesce((select ' ' || string_agg(pg_get_constraintdef(k.oid, false), ' ' order by pg_get_constraintdef(k.oid, false))
                             from pg_constraint k where k.contypid = t.oid and k.contype = 'c'), '') as definition
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where t.typtype = 'd' and n.nspname = any($1) and ${notExtensionOwned("pg_type", "t.oid")}`,
      [schemas]
    ),
    // prokind 'f' and 'p' only: pg_get_functiondef raises on an aggregate ('a') or window ('w')
    // function, and one such function would fail the whole snapshot.
    pool.query<{ name: string; definition: string }>(
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
              md5(pg_get_functiondef(p.oid)) as definition
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prokind in ('f', 'p') and n.nspname = any($1) and ${notExtensionOwned("pg_proc", "p.oid")}`,
      [schemas]
    ),
    // tgisinternal excludes the triggers Postgres creates to enforce foreign keys; those are
    // already captured as constraints, under names that differ per server.
    pool.query<{ name: string; definition: string }>(
      `select n.nspname || '.' || c.relname || '.' || t.tgname as name,
              md5(pg_get_triggerdef(t.oid, false)) as definition
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal and n.nspname = any($1) and ${notExtensionOwned("pg_class", "c.oid")}`,
      [schemas]
    ),
    // Database-wide, not per schema: an extension is installed once, whichever schema holds it.
    pool.query<{ name: string; definition: string }>(`select extname as name, extversion as definition from pg_extension`)
  ]);

  const sorted = (rows: ObjectDef[]): ObjectDef[] =>
    rows.map((r) => ({ name: r.name, definition: r.definition })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    views: sorted(views.rows),
    sequences: sorted(sequences.rows),
    enums: sorted(enums.rows),
    domains: sorted(domains.rows),
    routines: sorted(routines.rows),
    triggers: sorted(triggers.rows),
    extensions: sorted(extensions.rows)
  };
}

/**
 * Discover every non-system schema (so snapshots aren't silently limited to `public`).
 * The server's own schemas are excluded too — see INTERNAL_SCHEMAS for why (PG-MIG-005).
 */
async function discoverUserSchemas(pool: Queryable): Promise<string[]> {
  const result = await pool.query<{ nspname: string }>(
    `
    select nspname
    from pg_namespace
    where nspname not in ('pg_catalog', 'information_schema')
      and nspname not like 'pg\\_%'
      and nspname <> all($1::text[])
    order by nspname
    `,
    [INTERNAL_SCHEMAS]
  );
  return result.rows.map((r) => r.nspname);
}

/**
 * Capture a structural snapshot (tables → columns/indexes/constraints).
 * When `schemas` is omitted, ALL non-system schemas are captured — this matters for
 * the migration drift guard and compare_environments, which must not ignore tables
 * that live outside `public`. The server's own `mcp_ops` is not user schema and is left out.
 */
export async function captureSchema(pool: Queryable, schemas?: string[]): Promise<SchemaSnapshot> {
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

  const objects = await captureObjects(pool, targetSchemas);

  const snapshotId = createHash("sha256")
    .update(JSON.stringify({ snapshotVersion: SNAPSHOT_VERSION, schemas: targetSchemas, tables, objects }))
    .digest("hex")
    .slice(0, 24);

  return { snapshotVersion: SNAPSHOT_VERSION, schemas: targetSchemas, tables, objects, snapshotId };
}

export interface ObjectKindDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Per-kind changes, with only the kinds that actually changed present. */
function diffObjects(a: SchemaObjects, b: SchemaObjects): Partial<Record<ObjectKind, ObjectKindDiff>> {
  const result: Partial<Record<ObjectKind, ObjectKindDiff>> = {};
  for (const kind of OBJECT_KINDS) {
    const aMap = new Map(a[kind].map((o) => [o.name, o.definition]));
    const bMap = new Map(b[kind].map((o) => [o.name, o.definition]));
    const added = [...bMap.keys()].filter((k) => !aMap.has(k)).sort();
    const removed = [...aMap.keys()].filter((k) => !bMap.has(k)).sort();
    const changed = [...aMap.keys()].filter((k) => bMap.has(k) && bMap.get(k) !== aMap.get(k)).sort();
    if (added.length || removed.length || changed.length) {
      result[kind] = { added, removed, changed };
    }
  }
  return result;
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
  /** Non-table objects (views, routines, enums, …): only the kinds that changed are present. */
  objectChanges: Partial<Record<ObjectKind, ObjectKindDiff>>;
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

  const objectChanges = diffObjects(a.objects, b.objects);

  return {
    identical:
      addedTables.length === 0 &&
      removedTables.length === 0 &&
      changedTables.length === 0 &&
      Object.keys(objectChanges).length === 0,
    addedTables,
    removedTables,
    changedTables,
    objectChanges
  };
}
