/**
 * Shared vocabulary for codebase-index-mcp's tool declarations (S-32).
 *
 * The tool table is split one file per migration batch, mirroring `descriptors/`, so each
 * batch is a symmetric diff: add `tools/<batch>.ts`, delete `descriptors/<batch>.ts`, delete
 * that batch's branches from `legacyDispatch.ts`. The migration plan wrote this step as 43
 * separate files; postgres-mcp — the only already-migrated multi-tool server here — grouped
 * its 17 along the boundary its handler modules already used, and that reads better than 43
 * files each re-importing the same dependency bundle.
 */

import type { ToolAnnotations, ToolCallResult, JsonSchemaNode } from "@mcp/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { HandlerContext } from "../handlers/handlerContext.js";
import type { DescriptorLimits } from "./descriptors/limits.js";

export interface CodebaseIndexDeps {
  /** The env-derived bounds the JSON Schemas advertise. Same object the descriptors get. */
  readonly limits: DescriptorLimits;
  /**
   * Rebuilt per call, as the pre-SDK dispatcher did. The handlers reach the store, the watch
   * manager, the env constants and `asText` through it.
   */
  readonly buildContext: () => HandlerContext;
}

/**
 * Bridge a handler's protocol result to the platform's text-only one.
 *
 * `CallToolResult.content` admits image/audio/resource blocks; `ToolCallResult` narrows it to
 * text. Everything here is a single text block, so this is variance rather than a shape change
 * — the same assertion `server.ts` makes at the bridge boundary, for the same reason.
 */
export function raw(result: CallToolResult): ToolCallResult {
  return result as ToolCallResult;
}

/**
 * Every read tool's annotations.
 *
 * `openWorld: false` throughout: this server touches the local filesystem and a local SQLite
 * file and nothing else — the no-LLM policy and the path allowlist are what guarantee it.
 * That is the one field where a copy of postgres-mcp's presets would have been wrong, since a
 * Postgres server is reachable over the network even when it only reads.
 *
 * Note these are NEW on the wire. The pre-SDK descriptors carried no annotations at all, so a
 * migrated tool gains an `annotations` object in `tools/list` — a real, deliberate, spec-shaped
 * contract addition, one tool at a time, and the reason `contracts/codebase-index-local.json`
 * changes in this commit.
 */
export const readsGraph: ToolAnnotations = {
  readOnly: true,
  idempotent: true,
  destructive: false,
  openWorld: false
};

/**
 * The `profile` property, verbatim as this server has always advertised it.
 *
 * Deliberately NOT `schema.profile()`: that helper attaches a description this server has
 * never published, and `tools/list` is a committed contract. Shared as one constant because it
 * appears on most tools and a divergent copy would be a silent contract drift.
 */
export const PROFILE_PROP: JsonSchemaNode = {
  type: "string",
  enum: ["nano", "compact", "standard", "verbose"]
};
