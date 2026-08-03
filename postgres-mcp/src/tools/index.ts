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

import type { AnyToolDefinition } from "@mcp/sdk";
import { registerTool } from "@mcp/sdk";

import type { PostgresDeps } from "./common.js";
import { buildMigrationTools } from "./migrationTools.js";
import { buildReadTools } from "./readTools.js";
import { buildWriteTools } from "./writeTools.js";

export type { PostgresDeps, QueryLimits } from "./common.js";

/**
 * The 17 tools in registration order — which is the order `tools/list`
 * advertises, and is unchanged from the hand-written array it replaced.
 *
 * `registerTool` flattens the three groups and rejects a duplicate name at the
 * point of assembly, so a tool accidentally declared in two groups fails here
 * rather than inside the runtime one frame later.
 */
export function buildTools(deps: PostgresDeps): readonly AnyToolDefinition[] {
  return registerTool([buildReadTools(deps), buildWriteTools(deps), buildMigrationTools(deps)]);
}
