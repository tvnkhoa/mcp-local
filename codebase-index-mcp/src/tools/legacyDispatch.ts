/**
 * What is left of the pre-SDK dispatcher after S-32: the unknown-tool rejection, and nothing
 * else.
 *
 * All 43 tools are on the registry now, so every `case` is gone. What was the `default:` branch
 * is not dead code — it is this server's established answer to a name it does not serve, and
 * the bridge in `server.ts` routes every unregistered name here precisely to keep it:
 *
 *   an `isError` RESULT carrying `{ code: "MCP_ERROR", message: "<tool>: MCP error -32601:
 *   Unknown tool: <tool>", requestId }` — NOT a JSON-RPC error.
 *
 * `@mcp/sdk` would answer with its own `not_found` PlatformError instead: different payload,
 * different code. bitbucket-mcp accepted that delta during its own migration, so the precedent
 * exists — but this server publishes 43 tools in daily use, and the change is deliberately not
 * being made as a side effect of deleting a `switch`.
 *
 * **S-33 owns that decision**: either keep this as the envelope keeper, or adopt the platform's
 * `not_found` and record the contract change. Deleting it without choosing is the one option
 * that is wrong.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export type LegacyDispatch = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export function createLegacyDispatcher(): LegacyDispatch {
  // Arguments are accepted by signature and ignored: a name that reaches here has no schema to
  // validate against. Still `async`, so the rejection arrives at the bridge as a rejected
  // promise — which is what `formatError` turns into the envelope above.
  return async function dispatchLegacyTool(name) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  };
}
