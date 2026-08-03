/**
 * postgres-mcp's MCP resource provider.
 *
 * Declared through `createResource` / `registerResource`, which own the descriptor
 * plumbing, the mime type, the JSON serialization and the not-my-URI contract.
 * Two things stay local because both are this server's contract rather than
 * boilerplate: the `schema://…` router, and the split between an unroutable URI
 * (`undefined`, which the SDK renders as invalid-params) and an unknown
 * environment (a throw out of `getPool`, which stays an internal error).
 */

import type { ResourceProvider } from "@mcp/sdk";
import { createResource, registerResource } from "@mcp/sdk";

import type { ConnectionManager } from "../repositories/connectionManager.js";
import { captureSchema } from "../services/migration/schemaSnapshot.js";

/**
 * Each environment's schema as a resource (`schema://<env>`), so a client can
 * read structure once instead of repeating `describe_table` calls.
 */
export function buildSchemaResources(connections: ConnectionManager): ResourceProvider {
  const schema = createResource({
    name: "schema",
    mimeType: "application/json",

    list: () =>
      connections.list().map((env) => ({
        uri: `schema://${env.name}`,
        name: `Schema (${env.name})`,
        description: `Database schema snapshot for environment '${env.name}'.`,
        mimeType: "application/json"
      })),

    /**
     * The environment name is the whole remainder of the URI, greedily — kept
     * exactly as the hand-written provider matched it. A tighter pattern would
     * move `schema://a/b` from "unknown environment" (an internal error out of
     * `getPool`) to "unroutable URI", which is a different answer to the same
     * request.
     */
    match: (uri) => {
      const found = /^schema:\/\/(.+)$/.exec(uri);
      return found === null ? undefined : { environment: found[1] };
    },

    read: async ({ params }) => captureSchema(connections.getPool(params.environment))
  });

  return registerResource([schema]);
}
