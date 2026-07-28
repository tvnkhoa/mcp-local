/**
 * postgres-mcp's tool table, declared as data (migration-plan step S-24).
 *
 * Everything that used to be a `ListTools` array plus a hand-written `switch` in
 * `index.ts` lives here as 17 `defineTool` declarations, split across three
 * files along the same boundary the handler modules already use. The shared
 * pipeline in `@mcp/sdk` supplies resolve → profile → validate → guards →
 * handle → serialize; what stays local is this server's own contract — the exact
 * descriptions and JSON Schemas, the guardrails, and the `{ code, message,
 * detail? }` error envelope injected through `formatError`.
 *
 * Two deliberate properties of these files:
 *
 *   - The JSON Schemas are written out rather than generated from the zod
 *     schemas. `contracts/postgres-mcp.json` is a committed contract, and a
 *     generator would be free to drift it. `schema.*` only removes boilerplate.
 *
 *   - Most handlers are `rawResult: true`. The write, migration and
 *     introspection modules already build their own `CallToolResult`, several
 *     with envelopes a `PlatformError` cannot express (`run_read_query` carries
 *     `requestId` and `environment` on its guardrail rejections). Converting
 *     ~1,300 lines of handler to return payloads instead is a behaviour change,
 *     so those modules are untouched and are marked as still owning their
 *     serialization. The four that only ever returned a plain payload use the
 *     normal path.
 */

import type { AnyToolDefinition, ResourceProvider } from "@mcp/sdk";

import type { ConnectionManager } from "../db/connectionManager.js";
import { captureSchema } from "../migration/schemaSnapshot.js";

import type { PostgresDeps } from "./common.js";
import { buildMigrationTools } from "./migrationTools.js";
import { buildReadTools } from "./readTools.js";
import { buildWriteTools } from "./writeTools.js";

export type { PostgresDeps, QueryLimits } from "./common.js";

/**
 * The 17 tools in registration order — which is the order `tools/list`
 * advertises, and is unchanged from the hand-written array it replaced.
 */
export function buildTools(deps: PostgresDeps): AnyToolDefinition[] {
  return [...buildReadTools(deps), ...buildWriteTools(deps), ...buildMigrationTools(deps)];
}

/**
 * Each environment's schema as a resource (`schema://<env>`), so a client can
 * read structure once instead of repeating `describe_table` calls.
 */
export function buildSchemaResources(connections: ConnectionManager): ResourceProvider {
  return {
    list: () =>
      connections.list().map((env) => ({
        uri: `schema://${env.name}`,
        name: `Schema (${env.name})`,
        description: `Database schema snapshot for environment '${env.name}'.`,
        mimeType: "application/json"
      })),

    read: async (uri) => {
      const match = /^schema:\/\/(.+)$/.exec(uri);
      if (match === null) {
        // Not a URI this server routes — the SDK turns undefined into the
        // protocol's invalid-params rejection, which is what the hand-written
        // handler raised. An unknown *environment*, by contrast, throws out of
        // getPool and stays an internal error, as it did before.
        return undefined;
      }
      const pool = connections.getPool(match[1]);
      const snapshot = await captureSchema(pool);
      return [{ uri, mimeType: "application/json", text: JSON.stringify(snapshot) }];
    }
  };
}
