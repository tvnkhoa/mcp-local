/**
 * The query tools: the guardrailed SELECT path, and the column profiler built on it.
 *
 * Split from `readTools.ts` because these two are the only read tools that run caller-influenced
 * SQL. Everything in `readTools.ts` runs a constant catalog statement with bound parameters; these
 * two are where the guardrail, the row cap and the fan-out live, and keeping that boundary visible
 * in the file layout is worth more than having one file called "the read tools".
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import { PolicyViolationError } from "../middleware/errors.js";
import { catalogPayload, resolveCatalogs, runAcrossCatalogs } from "./fanout.js";
import { referencedCatalogCandidates, validateReadOnlySql } from "../middleware/sqlGuardrails.js";
import { describeColumns } from "../repositories/introspection.js";
import { runBounded, type BoundedResult } from "../repositories/queryRunner.js";
import {
  clamp,
  databaseArg,
  databaseProp,
  databasesArg,
  databasesProp,
  environmentArg,
  environmentProp,
  profileArg,
  profileProp,
  readsDatabase,
  scalarParamArg,
  scalarParamProp,
  schemaArg,
  schemaProp,
  type SqlserverDeps
} from "./common.js";

/**
 * Types SQL Server refuses to compare or sort, and therefore to `COUNT(DISTINCT …)`.
 *
 * Not a nicety: the error aborts the whole statement, so one `xml` column made `profile_table`
 * return nothing at all for the table instead of profiling the other forty.
 */
const NON_COMPARABLE_TYPES = new Set([
  "xml",
  "text",
  "ntext",
  "image",
  "geography",
  "geometry",
  "hierarchyid"
]);

function isComparable(sqlTypeName: string): boolean {
  return !NON_COMPARABLE_TYPES.has(sqlTypeName.toLowerCase());
}

export function buildQueryTools(deps: SqlserverDeps): AnyToolDefinition[] {
  const { config, connections, logger } = deps;
  const { limits } = config;

  const runReadQuery = defineTool({
    name: "run_read_query",
    title: "Run read query",
    description:
      "Run one read-only T-SQL statement (SELECT, or WITH … SELECT). Three-part names " +
      "(Database.dbo.Table) are allowed and are the way to join across catalogs; four-part names " +
      "are refused. Pass `databases` to run the same statement across several catalogs and get " +
      "results labelled per catalog.",
    annotations: readsDatabase,
    inputSchema: schema.object(
      {
        sql: schema.string("A single SELECT / WITH … SELECT statement."),
        environment: environmentProp,
        database: databaseProp,
        databases: databasesProp,
        parameters: scalarParamProp,
        maxRows: schema.integer(
          "Row cap. Reaching it cancels the request, so a batch returning several recordsets is cut " +
            "off at that point — `truncated: true` says so."
        ),
        timeoutMs: schema.integer("Statement timeout in milliseconds."),
        profile: profileProp
      },
      { required: ["sql"] }
    ),
    input: z
      .object({
        sql: z.string().min(1).max(100_000),
        environment: environmentArg,
        database: databaseArg,
        databases: databasesArg,
        parameters: scalarParamArg,
        maxRows: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const guard = validateReadOnlySql(input.sql);
      if (!guard.ok) {
        throw new PolicyViolationError(guard.error.code, guard.error.message);
      }

      // After the guardrail, deliberately. `drop table t` across too many catalogs is bad SQL, not
      // a fan-out that is too wide, and reporting the width first would send the caller to fix the
      // wrong thing. Pinned by "the guardrail runs before the fan-out limit" in tools.test.ts.
      const selection = resolveCatalogs(input, limits.maxFanout);

      // `resolve()` bounds the catalog a CONNECTION is opened against, but the guardrail
      // deliberately permits `OtherDb.dbo.Table` — so without this the allowlist bounded nothing
      // that mattered: one connection to an allowed catalog could read every other catalog on the
      // instance by three-part name. Candidates are filtered against the real catalog list because
      // `dbo.Customer.Name` has the identical shape and must not be refused.
      if (config.allowedDatabases.length > 0) {
        const candidates = referencedCatalogCandidates(guard.sanitizedSql);
        if (candidates.length > 0) {
          const allowed = new Set(config.allowedDatabases.map((entry) => entry.toLowerCase()));
          const known = await connections.catalogNames(connections.resolve(input.environment));
          const blocked = candidates.filter((name) => known.has(name) && !allowed.has(name));
          if (blocked.length > 0) {
            throw new PolicyViolationError(
              "database_not_allowed",
              `Statement references catalog(s) not in SQLSERVER_ALLOWED_DATABASES: ${blocked.join(", ")}.`
            );
          }
        }
      }

      const maxRows = clamp(input.maxRows, limits.defaultLimit, limits.maxLimit);
      const timeoutMs = clamp(input.timeoutMs, limits.defaultTimeoutMs, limits.maxTimeoutMs);

      const outcomes = await runAcrossCatalogs<BoundedResult>({
        ...selection,
        // `resolve` is INSIDE `runOne`, not before it. It throws for an unknown environment, a
        // malformed catalog name, or one outside the allowlist — and hoisted out, a single bad
        // entry in `databases[]` rejected the whole fan-out and discarded every other catalog's
        // rows, which is exactly what a per-catalog slot exists to prevent.
        runOne: async (database) => {
          const target = connections.resolve(input.environment, database);
          const pool = await connections.pool(target);
          const request = pool.request();
          for (const [index, value] of (input.parameters ?? []).entries()) {
            request.input(`p${String(index + 1)}`, value);
          }
          const result = await runBounded(request, () => request.query(guard.sanitizedSql), {
            maxRows,
            timeoutMs
          });
          logger.info("query_succeeded", {
            environment: target.environment.name,
            database: target.database,
            elapsedMs: result.elapsedMs,
            truncated: result.truncated
          });
          return { database: target.database, ...result };
        },
        onFailure: (database, error) => {
          logger.error("query_failed", {
            database: database ?? "(default)",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });

      const environmentName = connections.resolve(input.environment).environment.name;
      // `timeoutMs` is echoed for the same reason `maxRows` is: both are clamped, and a caller who
      // asked for 999999 and got `timedOut: true` at 60s otherwise has no in-band signal that
      // their bound was overridden rather than their query being genuinely that slow.
      return ok(
        catalogPayload({ environment: environmentName, maxRows, timeoutMs }, outcomes, selection.fannedOut)
      );
    }
  });

  const profileTable = defineTool({
    name: "profile_table",
    title: "Profile table",
    description:
      "Per-column null ratio and distinct count for a table, plus its exact row count. Reads the " +
      "table, so it is bounded by the same timeout as a query. distinctCount is null for types SQL " +
      "Server cannot compare (xml, text, image, geography, …).",
    annotations: readsDatabase,
    inputSchema: schema.object(
      {
        environment: environmentProp,
        database: databaseProp,
        schema: schemaProp,
        table: schema.string("Table name."),
        columns: schema.array(schema.string(), "Restrict to these columns. Defaults to all."),
        timeoutMs: schema.integer("Statement timeout in milliseconds."),
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
        columns: z.array(z.string().min(1).max(128)).max(64).optional(),
        timeoutMs: z.number().int().positive().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const pool = await connections.pool(target);
      const schemaName = input.schema ?? "dbo";

      // Column names come from the catalog, never from the caller: the profile statement is the
      // one place this server composes SQL text, and composing it from `sys.columns` output means
      // the identifiers are known-good before they are quoted.
      const known = await describeColumns(pool, schemaName, input.table);
      if (known.length === 0) {
        throw new PolicyViolationError(
          "not_found",
          `No table or view "${schemaName}.${input.table}" in ${target.database}.`
        );
      }
      const wanted =
        input.columns === undefined
          ? known
          : known.filter((column) =>
              input.columns!.some((name) => name.toLowerCase() === column.name.toLowerCase())
            );
      if (wanted.length === 0) {
        throw new PolicyViolationError(
          "validation_error",
          `None of the requested columns exist on ${schemaName}.${input.table}.`
        );
      }

      const quote = (identifier: string): string => `[${identifier.replace(/]/g, "]]")}]`;

      // Positional aliases, not `[null_<columnName>]`. Interpolating the column name into an alias
      // re-opened the injection the `quote()` beside it closes — a column legally named `a]b`
      // produces `[null_a]b]`, which terminates the alias early. It also blew past the 128-char
      // identifier limit for a long name. `c0n` / `c0d` cannot do either, and the mapping back is
      // an array index.
      const projections = wanted
        .map((column, index) => {
          const parts = [`count(case when ${quote(column.name)} is null then 1 end) as [c${index}n]`];
          if (isComparable(column.type)) {
            parts.push(`count(distinct ${quote(column.name)}) as [c${index}d]`);
          }
          return parts.join(", ");
        })
        .join(", ");

      const request = pool.request();
      const statement = `select count_big(1) as [row_count], ${projections} from ${quote(schemaName)}.${quote(input.table)}`;
      const result = await runBounded(request, () => request.query(statement), {
        maxRows: 1,
        timeoutMs: clamp(input.timeoutMs, limits.defaultTimeoutMs, limits.maxTimeoutMs)
      });

      const row = result.recordsets[0]?.rows[0] ?? [];
      const names = result.recordsets[0]?.columns.map((column) => column.name) ?? [];
      const value = (name: string): number | null => {
        const at = names.indexOf(name);
        return at === -1 ? null : Number(row[at] ?? 0);
      };
      const rowCount = value("row_count") ?? 0;

      return ok({
        environment: target.environment.name,
        database: target.database,
        schema: schemaName,
        table: input.table,
        rowCount,
        elapsedMs: result.elapsedMs,
        columns: wanted.map((column, index) => {
          const nulls = value(`c${index}n`) ?? 0;
          return {
            name: column.name,
            type: column.type,
            nullCount: nulls,
            nullRatio: rowCount === 0 ? 0 : Number((nulls / rowCount).toFixed(4)),
            // null, not 0, when the type cannot be counted distinctly — see NON_COMPARABLE_TYPES.
            distinctCount: isComparable(column.type) ? value(`c${index}d`) : null
          };
        })
      });
    }
  });

  return [runReadQuery, profileTable];
}
