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
import { referencedCatalogCandidates, validateReadOnlySql } from "../middleware/sqlGuardrails.js";
import { describeColumns } from "../repositories/introspection.js";
import { MAX_FANOUT_CONCURRENCY, type ResolvedTarget } from "../repositories/connectionManager.js";
import { runBounded, type BoundedResult } from "../repositories/queryRunner.js";
import {
  clamp,
  databaseArg,
  databaseProp,
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

/** One catalog's slice of a `run_read_query` result. `error` is set only in the fan-out form. */
type CatalogOutcome = BoundedResult & { database: string; error?: string };

/**
 * `run_read_query` returns one of two shapes, discriminated by whether `databases` was passed.
 *
 * The single-catalog form is deliberately NOT wrapped in a one-element array. That call is the
 * overwhelmingly common one, and making every caller reach through `results[0]` to get at
 * `recordsets[0].rows` costs two levels of nesting — and the tokens to render them — on every read,
 * to spare a branch on the rare one.
 */
type ReadQueryPayload = { environment: string; maxRows: number } & (
  | Omit<CatalogOutcome, "error">
  | { catalogCount: number; failureCount: number; results: CatalogOutcome[] }
);

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
        databases: schema.array(
          schema.string(),
          "Run the same statement against each of these catalogs. Mutually exclusive with `database`."
        ),
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
        databases: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
        parameters: scalarParamArg,
        maxRows: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      if (input.database !== undefined && input.databases !== undefined) {
        throw new PolicyViolationError(
          "validation_error",
          "Pass either `database` or `databases`, not both."
        );
      }

      const guard = validateReadOnlySql(input.sql);
      if (!guard.ok) {
        throw new PolicyViolationError(guard.error.code, guard.error.message);
      }

      if (input.databases !== undefined && input.databases.length > limits.maxFanout) {
        throw new PolicyViolationError(
          "fanout_limit_exceeded",
          `Requested ${input.databases.length} catalogs; SQLSERVER_MAX_FANOUT is ${limits.maxFanout}.`
        );
      }

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
      const catalogs = input.databases ?? [input.database as string | undefined];

      const runOne = async (database: string | undefined) => {
        // `resolve` is INSIDE the try. It throws for an unknown environment, a malformed catalog
        // name, or one outside the allowlist — and with it outside, a single bad entry in
        // `databases[]` rejected the whole Promise.all and discarded every other catalog's rows,
        // which is exactly what the comment below promises does not happen.
        let target: ResolvedTarget | undefined;
        try {
          target = connections.resolve(input.environment, database);
          const pool = await connections.pool(target);
          const request = pool.request();
          for (const [index, value] of (input.parameters ?? []).entries()) {
            request.input(`p${index + 1}`, value);
          }
          const result = await runBounded(
            request,
            () => request.query(guard.sanitizedSql),
            { maxRows, timeoutMs }
          );
          logger.info("query_succeeded", {
            environment: target.environment.name,
            database: target.database,
            elapsedMs: result.elapsedMs,
            truncated: result.truncated
          });
          return { database: target.database, ...result, error: undefined };
        } catch (error) {
          // A fan-out is not all-or-nothing: one unreachable catalog must not discard the results
          // from the others, so the failure is reported in that catalog's slot.
          const message = error instanceof Error ? error.message : String(error);
          const label = target?.database ?? database ?? "(default)";
          logger.error("query_failed", { database: label, error: message });
          if (input.databases === undefined) {
            throw error;
          }
          return { database: label, recordsets: [], rowsAffected: [], truncated: false, elapsedMs: 0, error: message };
        }
      };

      // Bounded concurrency, results kept in request order. A fan-out across 25 catalogs run all
      // at once would open 25 pools simultaneously — slow to establish, and exactly what
      // SQLSERVER_MAX_POOLS exists to prevent.
      const results = new Array<Awaited<ReturnType<typeof runOne>>>(catalogs.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(MAX_FANOUT_CONCURRENCY, catalogs.length) }, async () => {
          for (let index = cursor++; index < catalogs.length; index = cursor++) {
            results[index] = await runOne(catalogs[index]);
          }
        })
      );

      const environmentName = connections.resolve(input.environment).environment.name;

      const payload: ReadQueryPayload =
        input.databases === undefined
          ? (() => {
              const { error: _unused, ...single } = results[0]!;
              return { environment: environmentName, maxRows, ...single };
            })()
          : {
              environment: environmentName,
              maxRows,
              catalogCount: results.length,
              failureCount: results.filter((result) => result.error !== undefined).length,
              results
            };

      return ok(payload);
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
