/**
 * The read tools: environment/catalog inventory, schema introspection, and the guarded query path.
 *
 * Every one of them takes an optional `database`, because the unit of work on a SQL Server instance
 * is a catalog rather than the server. See `repositories/connectionManager.ts`.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import { PolicyViolationError } from "../middleware/errors.js";
import {
  countUnresolvedModules,
  describeColumns,
  describeForeignKeys,
  describeIndexes,
  describeRoutineParameters,
  findCrossDatabaseReferences,
  getObjectDescription,
  getRoutineDefinition,
  listDatabases,
  listRoutines,
  listTables,
  ROUTINE_TYPES
} from "../repositories/introspection.js";
import {
  databaseArg,
  databaseProp,
  environmentArg,
  environmentProp,
  profileArg,
  profileProp,
  readsConfig,
  readsDatabase,
  schemaArg,
  schemaProp,
  type SqlserverDeps
} from "./common.js";

export function buildReadTools(deps: SqlserverDeps): AnyToolDefinition[] {
  const { config, connections } = deps;

  const listEnvironments = defineTool({
    name: "list_environments",
    title: "List environments",
    description:
      "List configured SQL Server environments with masked connection details, which are allowed, " +
      "and how many catalog pools are currently open for each.",
    annotations: readsConfig,
    inputSchema: schema.object({ profile: profileProp }),
    input: z.object({ profile: profileArg }).strict(),
    handler: async () =>
      ok({
        defaultEnvironment: connections.defaultEnvironment,
        count: connections.list().length,
        environments: connections.list()
      })
  });

  const listDatabasesTool = defineTool({
    name: "list_databases",
    title: "List databases",
    description:
      "List catalogs on the instance, with state, collation and whether the current login can " +
      "actually open each one. Start here — catalog names are deployment-specific and must be " +
      "discovered, not assumed.",
    annotations: readsDatabase,
    inputSchema: schema.object({
      environment: environmentProp,
      includeSystem: schema.boolean("Include master/model/msdb/tempdb. Defaults to false."),
      profile: profileProp
    }),
    input: z
      .object({
        environment: environmentArg,
        includeSystem: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment);
      const pool = await connections.pool(target);
      const system = new Set(["master", "model", "msdb", "tempdb"]);
      const allowed = config.allowedDatabases.map((entry) => entry.toLowerCase());

      const rows = (await listDatabases(pool))
        .filter((row) => (input.includeSystem === true ? true : !system.has(row.name.toLowerCase())))
        .map((row) => ({
          ...row,
          // Distinct from `accessible`: one is what the login can open, the other is what this
          // server is configured to let it reach.
          allowedByConfig: allowed.length === 0 || allowed.includes(row.name.toLowerCase())
        }));

      return ok({
        environment: target.environment.name,
        count: rows.length,
        allowlistActive: allowed.length > 0,
        databases: rows
      });
    }
  });

  const listTablesTool = defineTool({
    name: "list_tables",
    title: "List tables and views",
    description:
      "Inventory of tables and views in one catalog, with approximate row counts taken from " +
      "partition statistics rather than COUNT(*).",
    annotations: readsDatabase,
    inputSchema: schema.object({
      environment: environmentProp,
      database: databaseProp,
      schema: schema.string("Restrict to one schema. Omit for all schemas."),
      namePattern: schema.string("T-SQL LIKE pattern on the object name, e.g. 'Trigger%'."),
      includeViews: schema.boolean("Include views. Defaults to true."),
      profile: profileProp
    }),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        schema: schemaArg,
        namePattern: z.string().min(1).max(256).optional(),
        includeViews: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);
      const rows = await listTables(pool, {
        schema: input.schema,
        namePattern: input.namePattern,
        includeViews: input.includeViews ?? true
      });
      return ok({
        environment: target.environment.name,
        database: target.database,
        count: rows.length,
        objects: rows
      });
    }
  });

  const describeTable = defineTool({
    name: "describe_table",
    title: "Describe table",
    description:
      "Full shape of one table or view: columns with types and defaults, computed definitions, " +
      "indexes, and foreign keys in both directions.",
    annotations: readsDatabase,
    inputSchema: schema.object(
      {
        environment: environmentProp,
        database: databaseProp,
        schema: schemaProp,
        table: schema.string("Table or view name."),
        profile: profileProp
      },
      { required: ["table"] }
    ),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        schema: schemaArg,
        table: z.string().min(1).max(128),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);
      const schemaName = input.schema ?? "dbo";

      const [columns, indexes, foreignKeys, description] = await Promise.all([
        describeColumns(pool, schemaName, input.table),
        describeIndexes(pool, schemaName, input.table),
        describeForeignKeys(pool, schemaName, input.table),
        getObjectDescription(pool, schemaName, input.table)
      ]);

      if (columns.length === 0) {
        throw new PolicyViolationError(
          "not_found",
          `No table or view "${schemaName}.${input.table}" in ${target.database}.`
        );
      }

      return ok({
        environment: target.environment.name,
        database: target.database,
        schema: schemaName,
        table: input.table,
        description,
        columnCount: columns.length,
        columns,
        indexes,
        foreignKeys: {
          outgoing: foreignKeys.filter((fk) => fk.direction === "out"),
          incoming: foreignKeys.filter((fk) => fk.direction === "in")
        }
      });
    }
  });

  const getTableRelationships = defineTool({
    name: "get_table_relationships",
    title: "Get table relationships",
    description:
      "Foreign keys touching a table, in both directions — what it points at, and what points at " +
      "it. The incoming half is what determines whether a row can be deleted.",
    annotations: readsDatabase,
    inputSchema: schema.object(
      {
        environment: environmentProp,
        database: databaseProp,
        schema: schemaProp,
        table: schema.string("Table name."),
        profile: profileProp
      },
      { required: ["table"] }
    ),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        schema: schemaArg,
        table: z.string().min(1).max(128),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);
      const schemaName = input.schema ?? "dbo";
      const rows = await describeForeignKeys(pool, schemaName, input.table);
      return ok({
        environment: target.environment.name,
        database: target.database,
        schema: schemaName,
        table: input.table,
        outgoing: rows.filter((fk) => fk.direction === "out"),
        incoming: rows.filter((fk) => fk.direction === "in")
      });
    }
  });

  const listRoutinesTool = defineTool({
    name: "list_routines",
    title: "List routines",
    description:
      "Inventory of stored procedures, functions, views and triggers in one catalog. On a schema " +
      "where most read logic lives in procedures rather than in tables, this is the map.",
    annotations: readsDatabase,
    inputSchema: schema.object({
      environment: environmentProp,
      database: databaseProp,
      schema: schema.string("Restrict to one schema."),
      namePattern: schema.string("T-SQL LIKE pattern on the routine name, e.g. 'Report[_]%'."),
      type: schema.enumOf(Object.keys(ROUTINE_TYPES), "Restrict to one routine kind."),
      profile: profileProp
    }),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        schema: schemaArg,
        namePattern: z.string().min(1).max(256).optional(),
        type: z.enum(Object.keys(ROUTINE_TYPES) as [string, ...string[]]).optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);
      const rows = await listRoutines(pool, {
        schema: input.schema,
        namePattern: input.namePattern,
        typeCode: input.type === undefined ? undefined : ROUTINE_TYPES[input.type]
      });
      return ok({
        environment: target.environment.name,
        database: target.database,
        count: rows.length,
        routines: rows
      });
    }
  });

  const getRoutineDefinitionTool = defineTool({
    name: "get_routine_definition",
    title: "Get routine definition",
    description:
      "Full text of a stored procedure, function, view or trigger, plus its parameter contract " +
      "(name, type, output, has-default). Read this before calling execute_routine.",
    annotations: readsDatabase,
    inputSchema: schema.object(
      {
        environment: environmentProp,
        database: databaseProp,
        schema: schemaProp,
        routine: schema.string("Routine name."),
        includeBody: schema.boolean("Include the definition text. Defaults to true."),
        profile: profileProp
      },
      { required: ["routine"] }
    ),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        schema: schemaArg,
        routine: z.string().min(1).max(128),
        includeBody: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);
      const schemaName = input.schema ?? "dbo";

      const [found, parameters] = await Promise.all([
        getRoutineDefinition(pool, schemaName, input.routine),
        describeRoutineParameters(pool, schemaName, input.routine)
      ]);

      if (found === null) {
        throw new PolicyViolationError(
          "not_found",
          `No routine "${schemaName}.${input.routine}" in ${target.database}.`
        );
      }

      return ok({
        environment: target.environment.name,
        database: target.database,
        schema: schemaName,
        routine: input.routine,
        type: found.type,
        parameters,
        // Null for an encrypted module — reported as such rather than as an empty body.
        definition: input.includeBody === false ? undefined : found.definition,
        definitionAvailable: found.definition !== null
      });
    }
  });

  const findCrossDatabaseReferencesTool = defineTool({
    name: "find_cross_database_references",
    title: "Find cross-database references",
    description:
      "Which objects in this catalog reference objects in another catalog on the same instance, " +
      "grouped by the catalog they reach into. This is the dependency graph between databases — " +
      "SQL Server's three-part names are the only cross-catalog mechanism short of a linked server.",
    annotations: readsDatabase,
    inputSchema: schema.object({
      environment: environmentProp,
      database: databaseProp,
      profile: profileProp
    }),
    input: z
      .object({ environment: environmentArg, database: databaseArg, profile: profileArg })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);

      const [references, dynamicSqlModules] = await Promise.all([
        findCrossDatabaseReferences(pool),
        countUnresolvedModules(pool)
      ]);

      const byDatabase = new Map<string, { database: string; referenceCount: number; objects: Set<string> }>();
      for (const row of references) {
        const entry = byDatabase.get(row.toDatabase) ?? {
          database: row.toDatabase,
          referenceCount: 0,
          objects: new Set<string>()
        };
        entry.referenceCount += 1;
        entry.objects.add(`${row.fromSchema}.${row.fromObject}`);
        byDatabase.set(row.toDatabase, entry);
      }

      return ok({
        environment: target.environment.name,
        database: target.database,
        referenceCount: references.length,
        targets: [...byDatabase.values()]
          .map((entry) => ({
            database: entry.database,
            referenceCount: entry.referenceCount,
            referencingObjectCount: entry.objects.size,
            referencingObjects: [...entry.objects].sort()
          }))
          .sort((a, b) => b.referenceCount - a.referenceCount),
        references,
        // Stated rather than implied. sys.sql_expression_dependencies resolves names as they were
        // compiled, so a catalog reached only through dynamic SQL leaves no row here at all.
        coverage: {
          complete: dynamicSqlModules === 0,
          dynamicSqlModules,
          note:
            dynamicSqlModules === 0
              ? "No modules build SQL dynamically; the dependency graph is complete."
              : `${dynamicSqlModules} module(s) build SQL dynamically (sp_executesql / EXEC(@…)). ` +
                "References made only inside dynamic SQL are invisible to the catalog and are NOT listed."
        }
      });
    }
  });

  return [
    listEnvironments,
    listDatabasesTool,
    listTablesTool,
    describeTable,
    getTableRelationships,
    listRoutinesTool,
    getRoutineDefinitionTool,
    findCrossDatabaseReferencesTool
  ];
}
