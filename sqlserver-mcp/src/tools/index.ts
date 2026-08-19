/**
 * The sqlserver-mcp tool table.
 *
 * Separated from `index.ts` on purpose: the entry point has start-up side effects (config load,
 * transport connect), so everything worth testing lives here and is exercised without a server.
 *
 * Two lanes, and the split is the security boundary:
 *
 *  - **read** — always on. Introspection plus a guardrailed SELECT path.
 *  - **exec** — off unless `SQLSERVER_EXEC_ENABLED=true`. Runs stored procedures, which on SQL
 *    Server may write without anything in the catalog saying so.
 */

import { isPlatformError, ok } from "@mcp/core";
import { createHealthCheckTool, registerTool } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";

import { describeConfig, type SqlserverConfig } from "../config/index.js";
import { mapError, type MappedError } from "../middleware/errors.js";
import { getServerInfo, listLinkedServers } from "../repositories/introspection.js";
import type { ConnectionManager } from "../repositories/connectionManager.js";
import { buildExecTools } from "./execTools.js";
import { buildQueryTools } from "./queryTools.js";
import { buildReadTools } from "./readTools.js";
import type { SqlserverDeps } from "./common.js";

export type { SqlserverDeps };

/**
 * `mapError`, plus the refusals dispatch itself raises.
 *
 * A `PlatformError` reaching `mapError` would fall into its catch-all and be reported as
 * `internal_error` — misleading for an unknown tool name, which dispatch answers with `not_found`.
 * Unwrapping it first preserves the code dispatch chose. This is what `formatError` gets.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}

export function buildTools(deps: SqlserverDeps): readonly AnyToolDefinition[] {
  const { config, connections } = deps;

  // `registerTool` flattens the groups and rejects a duplicate name at assembly — at start-up —
  // rather than letting one tool silently shadow another at call time.
  return registerTool([
    /**
     * Server convention S1: every server exposes `health_check` with an identical shape, so
     * `mcp:doctor` and the smoke tests need no per-server special cases.
     *
     * The probe reports `linkedServerCount` because that number is what the SQL guardrail's
     * four-part-name rule assumes. If it stops being zero, the assumption behind the rule has
     * changed and an operator should be able to see that without reading the source.
     */
    createHealthCheckTool({
      serverName: "sqlserver-mcp",
      version: "0.1.0",
      describeConfig: () => describeConfig(config),
      probe: async () => {
        const target = connections.resolve();
        const pool = await connections.pool(target);
        const [info, linked] = await Promise.all([getServerInfo(pool), listLinkedServers(pool)]);
        return ok({
          environment: target.environment.name,
          serverName: info.serverName,
          version: info.version,
          edition: info.edition,
          currentDatabase: info.currentDatabase,
          serverUtcTime: info.utcTime,
          linkedServerCount: linked.length,
          linkedServers: linked.map((entry) => entry.name)
        });
      }
    }),

    ...buildReadTools(deps),
    ...buildQueryTools(deps),
    ...buildExecTools(deps)
  ]);
}

/** Convenience for the entry point and the tests, which both need the same wiring. */
export function buildDeps(
  config: SqlserverConfig,
  connections: ConnectionManager,
  logger: SqlserverDeps["logger"]
): SqlserverDeps {
  return { config, connections, logger };
}
