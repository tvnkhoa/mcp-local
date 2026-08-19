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

import { err, ok } from "@mcp/core";
import { createHealthCheckTool, registerTool } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";

import { describeConfig, type SqlserverConfig } from "../config/index.js";
import { connectionFailureAsPlatformError, toWireError } from "../middleware/errors.js";
import { getServerInfo, listLinkedServers } from "../repositories/introspection.js";
import type { ConnectionManager } from "../repositories/connectionManager.js";
import { buildExecTools } from "./execTools.js";
import { buildQueryTools } from "./queryTools.js";
import { buildReadTools } from "./readTools.js";
import type { SqlserverDeps } from "./common.js";

export type { SqlserverDeps };

/**
 * Re-exported so `index.ts` and the tests keep importing it from here. The function itself moved to
 * `middleware/errors.ts` — see the note there.
 */
export { toWireError };

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
     * four-part-name rule is about. ADR 0004 originally assumed it was zero everywhere; the first
     * run against a real instance returned 2, which is why the field exists — the rule is closing
     * off a path that is reachable, not a hypothetical one.
     */
    createHealthCheckTool({
      serverName: "sqlserver-mcp",
      version: "0.1.0",
      describeConfig: () => describeConfig(config),
      probe: async () => {
        // Returning the failure rather than throwing is the whole point: `createHealthCheckTool`
        // turns a thrown error into `internal_error` / "Health probe failed.", which is the one
        // answer a health check must never give. `connectionFailureAsPlatformError` names the
        // cause — TLS, DNS, login, timeout — without echoing the driver's own text.
        try {
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
        } catch (cause) {
          return err(connectionFailureAsPlatformError(cause));
        }
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
