/**
 * `@mcp/manifest` — what servers exist in this workspace, and what each one needs.
 *
 * Workspace *tooling* data, not a runtime capability. `scripts/` consumes it; a server must not,
 * and `guard:deps` enforces that (rule: `servers/tooling-import`) — a server that knew about its
 * siblings would defeat the isolation the tier model exists to provide.
 *
 * S-34 promoted this from `scripts/lib/manifest.mjs`. That file is now a re-export shim, kept for
 * one phase so the seven consumers could move without a flag day.
 */

export type { EnvEvaluation, EnvField, ServerBuild, ServerDescriptor } from "./types.js";
export { SERVERS, getServer, serverKeys } from "./servers.js";
export { evaluateEnv } from "./env.js";
export { WORKSPACE_ROOT, serverDirPath, serverEntryPath } from "./paths.js";
/** Generated from `contracts/` — see `scripts/generate-tools.mjs`. */
export { TOOL_LISTS, TOTAL_TOOL_COUNT } from "./generated/toolLists.js";
