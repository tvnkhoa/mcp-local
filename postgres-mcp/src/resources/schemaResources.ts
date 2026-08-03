/**
 * postgres-mcp's MCP resource provider.
 *
 * Split out of `tools/index.ts` so `resources/list` + `resources/read` sit at the
 * conventional path rather than inside the tool table. The provider itself is
 * unchanged — same URI scheme, same descriptors, same `undefined`-on-no-match
 * contract that the SDK turns into the protocol's invalid-params rejection.
 */

import type { ResourceProvider } from "@mcp/sdk";

import type { ConnectionManager } from "../repositories/connectionManager.js";
import { captureSchema } from "../services/migration/schemaSnapshot.js";

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
