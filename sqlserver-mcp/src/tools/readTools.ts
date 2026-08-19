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
  schemaExists,
  describeColumns,
  describeForeignKeys,
  describeIndexes,
  describeRoutineParameters,
  findCrossDatabaseReferences,
  type CrossDatabaseReference,
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
  databasesArg,
  databasesProp,
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
import { includesDetail, resolveProfile, type ResponseProfile } from "../middleware/responseFormatter.js";
import { catalogPayload, resolveCatalogs, runAcrossCatalogs } from "./fanout.js";
import type { CatalogInfo } from "../repositories/connectionManager.js";


/** One catalog reached by the catalog under inspection, with whether it is a real database. */
export interface CrossDatabaseTarget {
  readonly database: string;
  readonly exists: boolean;
  readonly referenceCount: number;
  readonly referencingObjectCount: number;
  readonly referencingObjects: readonly string[];
}

/**
 * Group `sys.sql_expression_dependencies` rows by target catalog, and mark the ones that are not
 * catalogs at all.
 *
 * A name in `referenced_database_name` is not proof a catalog exists, and two very different
 * things land there looking identical:
 *
 *  - **XML shredding.** `CROSS APPLY x.nodes(…) AS agent_nodes(agent_node)` followed by
 *    `agent_node.value(…)` is recorded as the three-part name `agent_nodes.agent_node.value`.
 *    Pure noise — there is no catalog and never was.
 *  - **A dropped catalog.** SQL Server binds names late, so a module still carries a dependency on
 *    a database that no longer exists. That is not noise: the module no longer binds, and this is
 *    the only place that says so.
 *
 * Both are marked rather than dropped, because the second is worth more than the tool's headline
 * number. Real catalogs sort first; the counts are split so the headline is not inflated by either.
 *
 * Split out of the handler so it can be tested without a database, which is the whole test suite's
 * posture — and the reason a broken `list_tables` shipped, so the seam is deliberate.
 */
export function summarizeCrossDatabaseTargets(
  references: readonly CrossDatabaseReference[],
  catalogNames: ReadonlyMap<string, CatalogInfo>
): {
  targets: CrossDatabaseTarget[];
  unresolvedTargets: CrossDatabaseTarget[];
  unresolvedReferenceCount: number;
} {
  // Keyed lower-case, because `referenced_database_name` records the spelling the developer typed
  // and SQL Server catalog names are case-insensitive under a CI collation. Grouping on the raw
  // name split `CRM_Marketing` (848 refs) from `CRM_marketing` (4) into two targets and understated
  // both — while the existence check below already folded case, so one catalog could be reported
  // as several that all `exists: true`.
  const byDatabase = new Map<
    string,
    { database: string; referenceCount: number; objects: Set<string> }
  >();
  for (const row of references) {
    const key = row.toDatabase.toLowerCase();
    const entry = byDatabase.get(key) ?? {
      // The instance's own spelling when it is a real catalog, else the first one seen. Echoing a
      // name back in whatever casing a developer happened to use makes it unusable as a `database`
      // argument on the next call.
      database: catalogNames.get(key)?.name ?? row.toDatabase,
      referenceCount: 0,
      objects: new Set<string>()
    };
    entry.referenceCount += 1;
    entry.objects.add(`${row.fromSchema}.${row.fromObject}`);
    byDatabase.set(key, entry);
  }

  const targets: CrossDatabaseTarget[] = [...byDatabase.values()]
    .map((entry) => ({
      database: entry.database,
      exists: catalogNames.has(entry.database.toLowerCase()),
      referenceCount: entry.referenceCount,
      referencingObjectCount: entry.objects.size,
      referencingObjects: [...entry.objects].sort()
    }))
    .sort((a, b) => (a.exists === b.exists ? b.referenceCount - a.referenceCount : a.exists ? -1 : 1));

  const unresolvedTargets = targets.filter((entry) => !entry.exists);
  return {
    targets,
    unresolvedTargets,
    unresolvedReferenceCount: unresolvedTargets.reduce((n, e) => n + e.referenceCount, 0)
  };
}


export interface CrossDatabasePayloadInput {
  readonly environment: string;
  readonly database: string;
  readonly references: readonly CrossDatabaseReference[];
  readonly catalogNames: ReadonlyMap<string, CatalogInfo>;
  readonly dynamicSqlModules: number;
  readonly profile: ResponseProfile;
  readonly includeReferences?: boolean;
}

/**
 * Assemble the `find_cross_database_references` payload, sized to the profile.
 *
 * Pure, and split out for the same reason `summarizeCrossDatabaseTargets` above it is: the whole
 * suite runs without a database, and a broken `list_tables` shipped because the parts that needed
 * one were never executed. Every profile rung below is asserted by a test that opens no connection.
 *
 * The sizing exists because this tool returned **295KB** on a real catalog and overflowed the
 * client at every profile — `nano` and `compact` were byte-identical, since the platform's profile
 * handling is null-dropping plus minification and this payload has no nulls. Three rungs now:
 *
 *  - `nano` — targets without `referencingObjects`. The remaining unbounded string array.
 *  - `compact` (the default) — targets in full. This is the answer to "which catalogs depend on
 *    which", which is what the tool is for.
 *  - `standard` / `verbose` — plus `references[]`, the per-row drill-down that caused the overflow.
 *
 * `referenceCount` is always present, so the number never disappears along with the array it
 * counts. `includeReferences` overrides in **both** directions, including forcing the 295KB array
 * back on at `nano` — that footgun is one explicit flag away and is left armed deliberately.
 */
export function buildCrossDatabasePayload(input: CrossDatabasePayloadInput): Record<string, unknown> {
  const { targets, unresolvedTargets, unresolvedReferenceCount } = summarizeCrossDatabaseTargets(
    input.references,
    input.catalogNames
  );
  const withReferences = includesDetail(input.profile, input.includeReferences);
  // NOT overridable by `includeReferences`. That flag is documented as "include the per-reference
  // rows", and passing it here too meant `verbose` + `includeReferences: false` returned strictly
  // less than the default `compact` — turning references off silently demoted you to nano's target
  // shape, with no way to ask for "full targets, skip the 1,573 rows".
  const withReferencingObjects = includesDetail(input.profile, undefined, "compact");
  const dynamic = input.dynamicSqlModules;

  return {
    environment: input.environment,
    database: input.database,
    referenceCount: input.references.length,
    resolvedReferenceCount: input.references.length - unresolvedReferenceCount,
    unresolvedReferenceCount,
    unresolvedTargets: unresolvedTargets.map((entry) => entry.database),
    targets: withReferencingObjects
      ? targets
      : targets.map(({ referencingObjects: _dropped, ...rest }) => rest),
    ...(withReferences ? { references: input.references } : {}),
    // Stated rather than implied. sys.sql_expression_dependencies resolves names as they were
    // compiled, so a catalog reached only through dynamic SQL leaves no row here at all.
    coverage: {
      complete: dynamic === 0,
      dynamicSqlModules: dynamic,
      unresolvedTargetCount: unresolvedTargets.length,
      referencesIncluded: withReferences,
      note:
        (dynamic === 0
          ? "No modules build SQL dynamically; the dependency graph is complete."
          : `${String(dynamic)} module(s) build SQL dynamically (sp_executesql / EXEC(@…)). ` +
            "References made only inside dynamic SQL are invisible to the catalog and are NOT listed.") +
        (unresolvedTargets.length === 0
          ? ""
          : ` ${String(unresolvedTargets.length)} target name(s) are not catalogs on this instance ` +
            "(`exists: false`): either XML shredding recorded as a three-part name, or a " +
            "reference to a dropped database — which means that module no longer binds. " +
            "Use resolvedReferenceCount for the real cross-catalog total.") +
        (withReferences
          ? ""
          : " Per-reference rows are omitted at this profile; ask for `standard` or set " +
            "`includeReferences: true` for the drill-down.")
    }
  };
}

export function buildReadTools(deps: SqlserverDeps): AnyToolDefinition[] {
  const { config, connections, logger } = deps;

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
      databases: databasesProp,
      schema: schema.string("Restrict to one schema. Omit for all schemas."),
      namePattern: schema.string("T-SQL LIKE pattern on the object name, e.g. 'Trigger%'."),
      includeViews: schema.boolean("Include views. Defaults to true."),
      profile: profileProp
    }),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        databases: databasesArg,
        schema: schemaArg,
        namePattern: z.string().min(1).max(256).optional(),
        includeViews: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const selection = resolveCatalogs(input, config.limits.maxFanout);
      const outcomes = await runAcrossCatalogs({
        ...selection,
        runOne: async (database) => {
          const target = connections.resolve(input.environment, database);
          const pool = await connections.pool(target);
          const rows = await listTables(pool, {
            schema: input.schema,
            namePattern: input.namePattern,
            includeViews: input.includeViews ?? true
          });
          // Only on the empty path, so the ordinary call pays nothing. A named schema that does not
          // exist is a typo, and answering `count: 0` makes it indistinguishable from an empty one
          // — while a typo'd table already gets `not_found`.
          if (rows.length === 0 && input.schema !== undefined && !(await schemaExists(pool, input.schema))) {
            throw new PolicyViolationError(
              "not_found",
              `No schema named "${input.schema}" in ${target.database}.`
            );
          }
          return { database: target.database, count: rows.length, objects: rows };
        },
        // No per-catalog success log. A fan-out over 25 catalogs would emit 25 info lines for one
        // call; the failure line is the one an operator needs.
        onFailure: (database, error) => {
          logger.error("list_tables_failed", {
            database: database ?? "(default)",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
      const environment = connections.resolve(input.environment).environment.name;
      return ok(catalogPayload({ environment }, outcomes, selection.fannedOut));
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
      databases: databasesProp,
      schema: schema.string("Restrict to one schema."),
      namePattern: schema.string("T-SQL LIKE pattern on the routine name, e.g. 'Report[_]%'."),
      type: schema.enumOf(Object.keys(ROUTINE_TYPES), "Restrict to one routine kind."),
      modifiedAfter: schema.string(
        "ISO 8601 timestamp. Only routines altered at or after it — the fastest way to find what " +
          "changed during an incident."
      ),
      profile: profileProp
    }),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        databases: databasesArg,
        schema: schemaArg,
        namePattern: z.string().min(1).max(256).optional(),
        type: z.enum(Object.keys(ROUTINE_TYPES) as [string, ...string[]]).optional(),
        modifiedAfter: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const selection = resolveCatalogs(input, config.limits.maxFanout);
      const outcomes = await runAcrossCatalogs({
        ...selection,
        runOne: async (database) => {
          const target = connections.resolve(input.environment, database);
          const pool = await connections.pool(target);
          const rows = await listRoutines(pool, {
            schema: input.schema,
            namePattern: input.namePattern,
            typeCode: input.type === undefined ? undefined : ROUTINE_TYPES[input.type],
            modifiedAfter: input.modifiedAfter
          });
          // Same rule as list_tables. Applying it to one of the two left the server answering a
          // typo'd schema two different ways depending on which inventory you asked for.
          if (rows.length === 0 && input.schema !== undefined && !(await schemaExists(pool, input.schema))) {
            throw new PolicyViolationError(
              "not_found",
              `No schema named "${input.schema}" in ${target.database}.`
            );
          }
          return { database: target.database, count: rows.length, routines: rows };
        },
        onFailure: (database, error) => {
          logger.error("list_routines_failed", {
            database: database ?? "(default)",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
      const environment = connections.resolve(input.environment).environment.name;
      return ok(catalogPayload({ environment }, outcomes, selection.fannedOut));
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
      includeReferences: schema.boolean(
        "Include the per-reference rows. Defaults to on at `standard` and above, off below — the " +
          "rollup in `targets` answers the usual question and this array is what overflows clients."
      ),
      profile: profileProp
    }),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        includeReferences: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input, ctx) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);

      const [references, dynamicSqlModules, catalogNames] = await Promise.all([
        findCrossDatabaseReferences(pool),
        countUnresolvedModules(pool),
        connections.catalogNames(target)
      ]);

      return ok(
        buildCrossDatabasePayload({
          environment: target.environment.name,
          database: target.database,
          references,
          catalogNames,
          dynamicSqlModules,
          profile: resolveProfile(input.profile, ctx),
          includeReferences: input.includeReferences
        })
      );
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
