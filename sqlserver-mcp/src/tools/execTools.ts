/**
 * `execute_routine` — the gated lane.
 *
 * Why this exists at all: on the schema this server was designed against, roughly 540 stored
 * procedures and 200 views hold most of the read logic, and a server that can only `SELECT` from
 * tables cannot reach any of it.
 *
 * Why it is gated: nothing in the SQL Server catalog says whether a procedure writes.
 * `Report_GetContactCentreResults` and `Customer_UpdateLastActivity` are the same kind of object,
 * in the same schema, reachable the same way. There is no read-only subset to expose, so the whole
 * lane is off by default and the annotations declare the worst case.
 *
 * This tool never accepts statement text. It takes a routine name and typed parameters, and the
 * driver binds them — so the SQL guardrail is not in this path, and does not need to be.
 */

import { err, ok, policyViolation } from "@mcp/core";
import type { AnyToolDefinition, Guard } from "@mcp/sdk";
import { defineGuard, defineTool, featureFlagGuard, schema } from "@mcp/sdk";
import mssql from "mssql";
import { z } from "zod";

import { PolicyViolationError } from "../middleware/errors.js";
import { describeRoutineParameters } from "../repositories/introspection.js";
import { runBounded } from "../repositories/queryRunner.js";
import {
  clamp,
  databaseArg,
  databaseProp,
  environmentArg,
  environmentProp,
  executesRoutine,
  profileArg,
  profileProp,
  qualify,
  schemaArg,
  schemaProp,
  type SqlserverDeps
} from "./common.js";

/**
 * Glob match over `schema.routine`, supporting `*` only.
 *
 * Deliberately not a regular expression: an allowlist is security configuration, and a config
 * language where a typo can widen the match — `.` matching any character, an unanchored pattern —
 * is the wrong tool. `*` is the whole grammar, and everything else is a literal.
 */
function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

interface ExecInput {
  readonly environment?: string;
  readonly database?: string;
  readonly schema?: string;
  readonly routine: string;
}

export function buildExecTools(deps: SqlserverDeps): AnyToolDefinition[] {
  const { config, connections, logger } = deps;

  /** Gate 1 — the feature flag. Nothing in this lane runs without it. */
  const enabledGuard = featureFlagGuard(
    "exec-enabled",
    () => config.exec.enabled,
    "Stored-procedure execution is disabled. Set SQLSERVER_EXEC_ENABLED=true to enable it."
  );

  /**
   * Gate 2 — the catalog is not on the never-execute list.
   *
   * Checked before the allowlist and independent of the feature flag's reach, so a catalog named
   * in SQLSERVER_READONLY_DATABASES stays read-only however the allowlist is written. This is the
   * analogue of `postgres-mcp`'s "prod is always read-only" invariant.
   */
  const readOnlyDatabaseGuard: Guard = defineGuard("readonly-database", (context) => {
    const input = context.input as ExecInput;
    let database: string;
    try {
      // `input.environment`, not `undefined`. Dropping it made the guard resolve the DEFAULT
      // environment's catalog while the handler resolved the caller's — so with
      // SQLSERVER_READONLY_DATABASES naming a prod catalog, `{environment:"prod"}` was checked
      // against the dev catalog, passed, and then executed against prod. The guard and the handler
      // must resolve the same target or the guard is decoration.
      database = connections.resolve(input.environment, input.database).database;
    } catch {
      // Resolution errors belong to the handler, which reports them properly. A guard that cannot
      // identify the target must not pass it, so fall back to the raw value.
      database = input.database ?? "";
    }
    if (database !== "" && connections.isReadOnlyDatabase(database)) {
      return err(
        policyViolation(
          `Database "${database}" is listed in SQLSERVER_READONLY_DATABASES; routines cannot be executed against it.`,
          { guard: "readonly-database", database }
        )
      );
    }
    return ok(undefined);
  });

  /** Gate 3 — optional narrowing to named routines. Empty allowlist means no narrowing. */
  const allowlistGuard: Guard = defineGuard("exec-allowlist", (context) => {
    if (config.exec.allowlist.length === 0) {
      return ok(undefined);
    }
    const input = context.input as ExecInput;
    const name = qualify(input.schema ?? "dbo", input.routine);
    if (config.exec.allowlist.some((pattern) => matchesGlob(pattern, name))) {
      return ok(undefined);
    }
    return err(
      policyViolation(
        `Routine "${name}" does not match SQLSERVER_EXEC_ALLOWLIST.`,
        { guard: "exec-allowlist", routine: name }
      )
    );
  });

  const executeRoutine = defineTool({
    name: "execute_routine",
    title: "Execute routine",
    description:
      "Execute a stored procedure with bound parameters and return its recordsets, output " +
      "parameters and return value. DISABLED unless SQLSERVER_EXEC_ENABLED=true. Treated as " +
      "destructive for every routine: SQL Server records nothing about whether a procedure writes, " +
      "so the name is not evidence. Read get_routine_definition first.",
    annotations: executesRoutine,
    guards: [enabledGuard, readOnlyDatabaseGuard, allowlistGuard],
    inputSchema: schema.object(
      {
        environment: environmentProp,
        database: databaseProp,
        schema: schemaProp,
        routine: schema.string("Stored procedure name."),
        parameters: schema.object(
          {},
          {
            description:
              "Parameter values keyed by name, without the @ prefix. Bound by the driver, never " +
              "interpolated. Types are inferred from the value.",
            additionalProperties: true
          }
        ),
        maxRows: schema.integer("Row cap per recordset."),
        timeoutMs: schema.integer("Execution timeout in milliseconds."),
        profile: profileProp
      },
      { required: ["routine"] }
    ),
    input: z
      .object({
        environment: environmentArg,
        database: databaseArg,
        schema: schemaArg,
        routine: z
          .string()
          .min(1)
          .max(128)
          // No brackets, dots or semicolons: the name reaches the driver as an object name, and a
          // value carrying its own qualification would silently redirect the call.
          .regex(/^[A-Za-z_][A-Za-z0-9_@#$]*$/, "Routine name must be a bare identifier."),
        parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        maxRows: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      const schemaName = input.schema ?? "dbo";
      const pool = await connections.pool(target);

      // Reject an unknown parameter here rather than letting the server do it: the driver's error
      // for a surplus parameter names the procedure, not the parameter, which is not enough to fix
      // the call.
      const declared = await describeRoutineParameters(pool, schemaName, input.routine);
      if (declared.length === 0 && Object.keys(input.parameters ?? {}).length > 0) {
        throw new PolicyViolationError(
          "not_found",
          `No routine "${schemaName}.${input.routine}" in ${target.database}, or it takes no parameters.`
        );
      }
      const declaredNames = new Set(declared.map((p) => p.name.replace(/^@/, "").toLowerCase()));
      const surplus = Object.keys(input.parameters ?? {}).filter(
        (name) => !declaredNames.has(name.replace(/^@/, "").toLowerCase())
      );
      if (surplus.length > 0) {
        throw new PolicyViolationError(
          "validation_error",
          `Unknown parameter(s) for ${schemaName}.${input.routine}: ${surplus.join(", ")}. ` +
            `Declared: ${declared.map((p) => p.name).join(", ") || "(none)"}.`
        );
      }

      const request = pool.request();
      const supplied = new Set<string>();
      for (const [name, value] of Object.entries(input.parameters ?? {})) {
        const bare = name.replace(/^@/, "");
        supplied.add(bare.toLowerCase());
        request.input(bare, value);
      }
      for (const parameter of declared.filter((p) => p.isOutput)) {
        const bare = parameter.name.replace(/^@/, "");
        // An INOUT parameter is declared `OUTPUT` and still takes a value. Declaring it twice
        // makes mssql throw `The parameter name X has already been declared` (EDUPEPARAM), so a
        // caller supplying a value for one could never call the procedure at all. The value the
        // caller gave wins; `request.input` already registered it.
        if (supplied.has(bare.toLowerCase())) {
          continue;
        }
        request.output(bare, mssqlTypeFor(parameter.type));
      }

      const quoted = `[${schemaName.replace(/]/g, "]]")}].[${input.routine.replace(/]/g, "]]")}]`;
      const result = await runBounded(request, () => request.execute(quoted), {
        maxRows: clamp(input.maxRows, config.limits.defaultLimit, config.limits.maxLimit),
        timeoutMs: clamp(input.timeoutMs, config.exec.timeoutMs, config.exec.timeoutMs)
      });

      logger.info("routine_executed", {
        environment: target.environment.name,
        database: target.database,
        routine: qualify(schemaName, input.routine),
        elapsedMs: result.elapsedMs
      });

      return ok({
        environment: target.environment.name,
        database: target.database,
        schema: schemaName,
        routine: input.routine,
        ...result
      });
    }
  });

  return [executeRoutine];
}

/**
 * Map a `sys.types` name to a driver type, for OUTPUT parameters only.
 *
 * INPUT parameters do not need this — `request.input(name, value)` lets the driver infer from the
 * JS value, which is both correct and one fewer mapping to keep in sync. An OUTPUT parameter has no
 * value to infer from, so its type has to be named. Anything unrecognised becomes NVarChar(MAX),
 * which round-trips as text rather than failing the call.
 */
function mssqlTypeFor(sqlTypeName: string): mssql.ISqlType {
  const types = mssql;
  switch (sqlTypeName.toLowerCase()) {
    case "int":
      return types.Int();
    case "bigint":
      return types.BigInt();
    case "smallint":
      return types.SmallInt();
    case "tinyint":
      return types.TinyInt();
    case "bit":
      return types.Bit();
    case "decimal":
    case "numeric":
      return types.Decimal(38, 10);
    case "float":
      return types.Float();
    case "real":
      return types.Real();
    case "money":
      return types.Money();
    case "uniqueidentifier":
      return types.UniqueIdentifier();
    case "date":
      return types.Date();
    case "datetime":
      return types.DateTime();
    case "datetime2":
      return types.DateTime2();
    case "datetimeoffset":
      return types.DateTimeOffset();
    case "varchar":
      return types.VarChar(types.MAX);
    default:
      return types.NVarChar(types.MAX);
  }
}
