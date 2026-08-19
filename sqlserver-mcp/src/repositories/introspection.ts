/**
 * Catalog-view queries.
 *
 * Every statement here is a constant with typed parameters — no caller value is ever concatenated
 * into SQL. That is what lets the read tools accept free-text filters (`schema`, `namePattern`)
 * without any of them reaching the guardrail, or the statement text.
 *
 * `sys.*` is used in preference to `INFORMATION_SCHEMA.*` throughout: the ISO views omit most of
 * what makes a SQL Server schema legible (computed columns, filtered indexes, extended properties)
 * and, for `sys.sql_expression_dependencies`, have no equivalent at all.
 */

import type sql from "mssql";
import mssql from "mssql";

/** Run a constant statement with named parameters. Never used with interpolated text. */
async function query<T>(
  pool: sql.ConnectionPool,
  statement: string,
  parameters: Record<string, { type: sql.ISqlType | (() => sql.ISqlType); value: unknown }> = {},
  timeoutMs?: number
): Promise<T[]> {
  const request = pool.request();
  if (timeoutMs !== undefined) {
    // `requestTimeout` is per-pool in mssql's config; a per-call override goes on the request.
    (request as unknown as { timeout?: number }).timeout = timeoutMs;
  }
  for (const [name, spec] of Object.entries(parameters)) {
    request.input(name, spec.type, spec.value);
  }
  const result = await request.query(statement);
  return result.recordset as unknown as T[];
}

const nvarchar = (value: unknown) => ({ type: mssql.NVarChar(256), value });
const nvarcharMax = (value: unknown) => ({ type: mssql.NVarChar(mssql.MAX), value });

// --- server -------------------------------------------------------------------

export interface ServerInfo {
  serverName: string;
  version: string;
  edition: string;
  currentDatabase: string;
  utcTime: string;
}

export async function getServerInfo(pool: sql.ConnectionPool): Promise<ServerInfo> {
  const rows = await query<ServerInfo>(
    pool,
    `select
        cast(serverproperty('ServerName') as nvarchar(256))    as serverName,
        cast(serverproperty('ProductVersion') as nvarchar(64)) as version,
        cast(serverproperty('Edition') as nvarchar(128))       as edition,
        db_name()                                              as currentDatabase,
        convert(varchar(33), sysutcdatetime(), 126)            as utcTime`
  );
  return rows[0] as ServerInfo;
}

/**
 * Linked servers configured on the instance.
 *
 * Reported by `health_check` because it is the one instance-level fact that changes what this
 * server's guardrail means: the four-part-name rule assumes the answer is zero, and an operator
 * should be able to see when it stops being zero.
 */
export async function listLinkedServers(pool: sql.ConnectionPool): Promise<Array<{ name: string; product: string }>> {
  return query(
    pool,
    `select name, product from sys.servers where server_id <> 0 order by name`
  );
}

// --- databases ----------------------------------------------------------------

export interface DatabaseRow {
  name: string;
  state: string;
  recoveryModel: string;
  collation: string | null;
  isReadOnly: boolean;
  createdAt: string;
  accessible: boolean;
}

/**
 * Catalogs on the instance.
 *
 * `HAS_DBACCESS` is what makes this honest: `sys.databases` lists every catalog on the instance
 * regardless of whether the login can open it, so without the flag the result promises access it
 * does not have. Offline and restoring databases return NULL, which is reported as inaccessible.
 */
export async function listDatabases(pool: sql.ConnectionPool): Promise<DatabaseRow[]> {
  return query(
    pool,
    `select
        d.name                                        as name,
        d.state_desc                                  as state,
        d.recovery_model_desc                         as recoveryModel,
        d.collation_name                              as collation,
        cast(d.is_read_only as bit)                   as isReadOnly,
        convert(varchar(33), d.create_date, 126)      as createdAt,
        cast(isnull(has_dbaccess(d.name), 0) as bit)  as accessible
      from sys.databases d
      order by d.name`
  );
}

// --- tables and views ---------------------------------------------------------

export interface TableRow {
  schemaName: string;
  name: string;
  type: "table" | "view";
  rowCount: number | null;
  createdAt: string;
}

export async function listTables(
  pool: sql.ConnectionPool,
  options: { schema?: string; namePattern?: string; includeViews: boolean }
): Promise<TableRow[]> {
  // Row counts come from partition stats rather than COUNT(*): this is an inventory call, and
  // counting every row of every table to answer "what is in here" is the kind of query that gets a
  // read tool banned from production.
  return query(
    pool,
    `with counts as (
        select ps.object_id, sum(ps.row_count) as row_count
        from sys.dm_db_partition_stats ps
        where ps.index_id in (0, 1)
        group by ps.object_id
     )
     select
        s.name                                    as schemaName,
        o.name                                    as name,
        case o.type when 'V' then 'view' else 'table' end as type,
        c.row_count                               as [rowCount],
        convert(varchar(33), o.create_date, 126)  as createdAt
     from sys.objects o
     join sys.schemas s on s.schema_id = o.schema_id
     left join counts c on c.object_id = o.object_id
     where (o.type = 'U' or (o.type = 'V' and @includeViews = 1))
       and o.is_ms_shipped = 0
       and (@schemaName is null or s.name = @schemaName)
       and (@namePattern is null or o.name like @namePattern)
     order by s.name, o.name`,
    {
      schemaName: nvarchar(options.schema ?? null),
      namePattern: nvarchar(options.namePattern ?? null),
      includeViews: { type: mssql.Bit, value: options.includeViews }
    }
  );
}

export interface ColumnRow {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  isNullable: boolean;
  isIdentity: boolean;
  isComputed: boolean;
  computedDefinition: string | null;
  defaultDefinition: string | null;
  description: string | null;
  ordinal: number;
}

export async function describeColumns(
  pool: sql.ConnectionPool,
  schemaName: string,
  objectName: string
): Promise<ColumnRow[]> {
  return query(
    pool,
    `select
        c.name                                    as name,
        t.name                                    as type,
        -- nvarchar/nchar store bytes; report characters, and -1 (MAX) as null.
        case when c.max_length = -1 then null
             when t.name in ('nvarchar','nchar','ntext') then c.max_length / 2
             else c.max_length end                as maxLength,
        c.precision                               as precision,
        c.scale                                   as scale,
        cast(c.is_nullable as bit)                as isNullable,
        cast(c.is_identity as bit)                as isIdentity,
        cast(c.is_computed as bit)                as isComputed,
        cc.definition                             as computedDefinition,
        dc.definition                             as defaultDefinition,
        cast(ep.value as nvarchar(max))           as description,
        c.column_id                               as ordinal
     from sys.columns c
     join sys.objects o on o.object_id = c.object_id
     join sys.schemas s on s.schema_id = o.schema_id
     join sys.types t on t.user_type_id = c.user_type_id
     left join sys.computed_columns cc
            on cc.object_id = c.object_id and cc.column_id = c.column_id
     left join sys.default_constraints dc
            on dc.parent_object_id = c.object_id and dc.parent_column_id = c.column_id
     left join sys.extended_properties ep
            on ep.major_id = c.object_id and ep.minor_id = c.column_id and ep.name = 'MS_Description'
     where s.name = @schemaName and o.name = @objectName
     order by c.column_id`,
    { schemaName: nvarchar(schemaName), objectName: nvarchar(objectName) }
  );
}

export interface IndexRow {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  columns: string;
  includedColumns: string | null;
  filter: string | null;
}

export async function describeIndexes(
  pool: sql.ConnectionPool,
  schemaName: string,
  objectName: string
): Promise<IndexRow[]> {
  return query(
    pool,
    `select
        i.name                            as name,
        i.type_desc                       as type,
        cast(i.is_primary_key as bit)     as isPrimaryKey,
        cast(i.is_unique as bit)          as isUnique,
        stuff((select ', ' + c.name
               from sys.index_columns ic
               join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
               where ic.object_id = i.object_id and ic.index_id = i.index_id
                 and ic.is_included_column = 0
               order by ic.key_ordinal
               for xml path(''), type).value('.', 'nvarchar(max)'), 1, 2, '')  as columns,
        stuff((select ', ' + c.name
               from sys.index_columns ic
               join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
               where ic.object_id = i.object_id and ic.index_id = i.index_id
                 and ic.is_included_column = 1
               order by c.name
               for xml path(''), type).value('.', 'nvarchar(max)'), 1, 2, '')  as includedColumns,
        i.filter_definition               as filter
     from sys.indexes i
     join sys.objects o on o.object_id = i.object_id
     join sys.schemas s on s.schema_id = o.schema_id
     where s.name = @schemaName and o.name = @objectName and i.type <> 0
     order by i.is_primary_key desc, i.name`,
    { schemaName: nvarchar(schemaName), objectName: nvarchar(objectName) }
  );
}

export interface ForeignKeyRow {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string;
  toSchema: string;
  toTable: string;
  toColumns: string;
  deleteAction: string;
  updateAction: string;
}

/**
 * Foreign keys touching a table, in both directions.
 *
 * `direction: "in"` means another table points at this one — the half people forget, and the half
 * that determines whether a row can be deleted.
 */
export async function describeForeignKeys(
  pool: sql.ConnectionPool,
  schemaName: string,
  objectName: string
): Promise<Array<ForeignKeyRow & { direction: "out" | "in" }>> {
  return query(
    pool,
    `select
        fk.name                                                          as name,
        ps.name                                                          as fromSchema,
        pt.name                                                          as fromTable,
        stuff((select ', ' + pc.name
               from sys.foreign_key_columns fkc
               join sys.columns pc on pc.object_id = fkc.parent_object_id
                                  and pc.column_id = fkc.parent_column_id
               where fkc.constraint_object_id = fk.object_id
               order by fkc.constraint_column_id
               for xml path(''), type).value('.', 'nvarchar(max)'), 1, 2, '')  as fromColumns,
        rs.name                                                          as toSchema,
        rt.name                                                          as toTable,
        stuff((select ', ' + rc.name
               from sys.foreign_key_columns fkc
               join sys.columns rc on rc.object_id = fkc.referenced_object_id
                                  and rc.column_id = fkc.referenced_column_id
               where fkc.constraint_object_id = fk.object_id
               order by fkc.constraint_column_id
               for xml path(''), type).value('.', 'nvarchar(max)'), 1, 2, '')  as toColumns,
        fk.delete_referential_action_desc                                as deleteAction,
        fk.update_referential_action_desc                                as updateAction,
        case when ps.name = @schemaName and pt.name = @objectName then 'out' else 'in' end as direction
     from sys.foreign_keys fk
     join sys.objects pt on pt.object_id = fk.parent_object_id
     join sys.schemas ps on ps.schema_id = pt.schema_id
     join sys.objects rt on rt.object_id = fk.referenced_object_id
     join sys.schemas rs on rs.schema_id = rt.schema_id
     where (ps.name = @schemaName and pt.name = @objectName)
        or (rs.name = @schemaName and rt.name = @objectName)
     order by direction, fk.name`,
    { schemaName: nvarchar(schemaName), objectName: nvarchar(objectName) }
  );
}

export async function getObjectDescription(
  pool: sql.ConnectionPool,
  schemaName: string,
  objectName: string
): Promise<string | null> {
  const rows = await query<{ description: string | null }>(
    pool,
    `select cast(ep.value as nvarchar(max)) as description
     from sys.extended_properties ep
     join sys.objects o on o.object_id = ep.major_id
     join sys.schemas s on s.schema_id = o.schema_id
     where ep.minor_id = 0 and ep.name = 'MS_Description'
       and s.name = @schemaName and o.name = @objectName`,
    { schemaName: nvarchar(schemaName), objectName: nvarchar(objectName) }
  );
  return rows[0]?.description ?? null;
}

// --- routines -----------------------------------------------------------------

/** `sys.objects.type` codes, mapped to names a caller can filter on without a lookup table. */
export const ROUTINE_TYPES: Record<string, string> = {
  procedure: "P",
  scalar_function: "FN",
  inline_table_function: "IF",
  table_function: "TF",
  view: "V",
  trigger: "TR"
};

export interface RoutineRow {
  schemaName: string;
  name: string;
  type: string;
  createdAt: string;
  modifiedAt: string;
  lineCount: number | null;
}

export async function listRoutines(
  pool: sql.ConnectionPool,
  options: { schema?: string; namePattern?: string; typeCode?: string; modifiedAfter?: string }
): Promise<RoutineRow[]> {
  return query(
    pool,
    `select
        s.name                                     as schemaName,
        o.name                                     as name,
        o.type_desc                                as type,
        convert(varchar(33), o.create_date, 126)   as createdAt,
        convert(varchar(33), o.modify_date, 126)   as modifiedAt,
        case when m.definition is null then null
             else len(m.definition) - len(replace(m.definition, char(10), '')) + 1 end as lineCount
     from sys.objects o
     join sys.schemas s on s.schema_id = o.schema_id
     left join sys.sql_modules m on m.object_id = o.object_id
     where o.type in ('P', 'FN', 'IF', 'TF', 'V', 'TR')
       and o.is_ms_shipped = 0
       and (@typeCode is null or o.type = @typeCode)
       and (@schemaName is null or s.name = @schemaName)
       and (@namePattern is null or o.name like @namePattern)
       and (@modifiedAfter is null or o.modify_date >= convert(datetime2, @modifiedAfter, 126))
     order by s.name, o.name`,
    {
      schemaName: nvarchar(options.schema ?? null),
      namePattern: nvarchar(options.namePattern ?? null),
      typeCode: nvarchar(options.typeCode ?? null),
      modifiedAfter: nvarchar(options.modifiedAfter ?? null)
    }
  );
}

/**
 * Does this schema exist in the current catalog?
 *
 * Only called when a filtered listing came back empty. `list_tables(schema: "notaschema")` used to
 * answer `count: 0`, which is indistinguishable from an empty schema — while a typo'd *table* got
 * a proper `not_found`. One query, on the path that is already returning nothing.
 */
export async function schemaExists(pool: sql.ConnectionPool, schema: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    pool,
    "select count(*) as n from sys.schemas where name = @schemaName",
    { schemaName: nvarchar(schema) }
  );
  return (rows[0]?.n ?? 0) > 0;
}

export interface RoutineParameter {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  isOutput: boolean;
  hasDefault: boolean;
  ordinal: number;
}

export async function describeRoutineParameters(
  pool: sql.ConnectionPool,
  schemaName: string,
  routineName: string
): Promise<RoutineParameter[]> {
  return query(
    pool,
    `select
        p.name                        as name,
        t.name                        as type,
        case when p.max_length = -1 then null
             when t.name in ('nvarchar','nchar') then p.max_length / 2
             else p.max_length end    as maxLength,
        p.precision                   as precision,
        p.scale                       as scale,
        cast(p.is_output as bit)      as isOutput,
        cast(p.has_default_value as bit) as hasDefault,
        p.parameter_id                as ordinal
     from sys.parameters p
     join sys.objects o on o.object_id = p.object_id
     join sys.schemas s on s.schema_id = o.schema_id
     join sys.types t on t.user_type_id = p.user_type_id
     where s.name = @schemaName and o.name = @routineName and p.parameter_id > 0
     order by p.parameter_id`,
    { schemaName: nvarchar(schemaName), routineName: nvarchar(routineName) }
  );
}

export async function getRoutineDefinition(
  pool: sql.ConnectionPool,
  schemaName: string,
  routineName: string
): Promise<{ definition: string | null; type: string } | null> {
  const rows = await query<{ definition: string | null; type: string }>(
    pool,
    `select m.definition as definition, o.type_desc as type
     from sys.objects o
     join sys.schemas s on s.schema_id = o.schema_id
     left join sys.sql_modules m on m.object_id = o.object_id
     where s.name = @schemaName and o.name = @routineName`,
    { schemaName: nvarchar(schemaName), routineName: nvarchar(routineName) }
  );
  return rows[0] ?? null;
}

// --- cross-database references ------------------------------------------------

export interface CrossDatabaseReference {
  fromSchema: string;
  fromObject: string;
  fromType: string;
  toDatabase: string;
  toSchema: string | null;
  toObject: string | null;
}

/**
 * Which objects in this catalog reach into another catalog, and which one.
 *
 * The tool this server exists to have. On an instance where catalogs are joined by three-part
 * names — the only cross-database mechanism SQL Server offers short of a linked server — this is
 * the dependency graph *between* databases, and there is no other way to get it short of parsing
 * every routine body by hand.
 *
 * `sys.sql_expression_dependencies` resolves names at the point they were compiled, so
 * `referenced_database_name` is non-NULL exactly when the reference crosses a catalog boundary.
 * Note the caveat SQL Server carries here: a reference built inside dynamic SQL is invisible to
 * this view, because it never existed at compile time. `find_cross_database_references` says so in
 * its own response rather than implying completeness.
 */
export async function findCrossDatabaseReferences(
  pool: sql.ConnectionPool
): Promise<CrossDatabaseReference[]> {
  return query(
    pool,
    `select
        s.name                             as fromSchema,
        o.name                             as fromObject,
        o.type_desc                        as fromType,
        d.referenced_database_name         as toDatabase,
        d.referenced_schema_name           as toSchema,
        d.referenced_entity_name           as toObject
     from sys.sql_expression_dependencies d
     join sys.objects o on o.object_id = d.referencing_id
     join sys.schemas s on s.schema_id = o.schema_id
     where d.referenced_database_name is not null
       and d.referenced_database_name <> db_name()
       and o.is_ms_shipped = 0
     order by d.referenced_database_name, s.name, o.name`
  );
}

/** Count of routines whose body could not be bound — the blind spot the tool above reports. */
export async function countUnresolvedModules(pool: sql.ConnectionPool): Promise<number> {
  const rows = await query<{ n: number }>(
    pool,
    `select count(*) as n
     from sys.sql_modules m
     join sys.objects o on o.object_id = m.object_id
     where o.is_ms_shipped = 0
       and (m.definition like '%sp[_]executesql%' or m.definition like '%exec%(@%')`
  );
  return rows[0]?.n ?? 0;
}

export { query as runCatalogQuery, nvarcharMax };
