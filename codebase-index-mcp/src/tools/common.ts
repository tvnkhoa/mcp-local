/**
 * Shared vocabulary for codebase-index-mcp's tool declarations (S-32).
 *
 * The tool table is one file per S-32 migration batch. While the migration ran, each batch was
 * a symmetric diff — add `tools/<batch>.ts`, delete `descriptors/<batch>.ts`, delete that
 * batch's `switch` branches — which is why the grouping follows the batches rather than the
 * domains. The migration plan wrote this step as 43 separate files; postgres-mcp, the only
 * other migrated multi-tool server here, grouped its 17 along the boundary its handler modules
 * already used, and that reads better than 43 files each re-importing the same dependency
 * bundle.
 */

import type { ToolAnnotations, ToolCallResult, JsonSchemaNode } from "@mcp/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { HandlerContext } from "./handlers/handlerContext.js";
import type { DescriptorLimits } from "./limits.js";

export interface CodebaseIndexDeps {
  /** The env-derived bounds the JSON Schemas advertise. */
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
 * contract addition, made one batch at a time, and the reason
 * `contracts/codebase-index.json` gained annotations across S-32.
 */
export const readsGraph: ToolAnnotations = {
  readOnly: true,
  idempotent: true,
  destructive: false,
  openWorld: false
};

/**
 * `index_repository`.
 *
 * `destructive: true` is a deliberate call, not carelessness. The tool overwrites the symbols
 * and edges of every file it scans, and `mode: "full"` prunes entries for files that no longer
 * exist — so it is a replace, not an additive write, which is exactly what the MCP hint
 * distinguishes. What it overwrites is DERIVED state: the SQLite graph, rebuildable from source
 * at any time. It cannot modify or delete a single line of the repository it reads.
 *
 * `idempotent: true` for the same reason a PUT is: two runs with the same arguments converge on
 * the same index.
 *
 * A reviewer who thinks a re-index should not make a host prompt for confirmation is arguing
 * with `destructive`, and this is the paragraph to argue with.
 */
export const rebuildsIndex: ToolAnnotations = {
  readOnly: false,
  idempotent: true,
  destructive: true,
  openWorld: false
};

/**
 * `watch_repo`.
 *
 * Not read-only — it starts and stops a filesystem watcher, which is server state. Not
 * destructive: starting or stopping a watcher removes nothing by itself. A running watcher does
 * go on to trigger incremental re-indexes, but an annotation describes what the CALL does, not
 * what the state it establishes may later cause.
 *
 * Idempotent because the actions are declarative: two `start`s leave one watcher, two `stop`s
 * leave none, and `status` never changes anything.
 */
export const controlsWatcher: ToolAnnotations = {
  readOnly: false,
  idempotent: true,
  destructive: false,
  openWorld: false
};

/**
 * A refactor step that computes a plan and writes nothing to the working tree.
 *
 * `refactor_replace_preview` and `rename_assist`. Not `readsGraph`, because these are not free of
 * effect: each one persists a preview row plus an HMAC approval token that a later
 * `refactor_replace_apply` will accept. Nothing in the repo changes, so `readOnly: true` is still
 * the honest hint for a host deciding whether to confirm — but `idempotent: false`, because every
 * call mints a new previewId.
 *
 * MCP-ISSUE-060: `refactor_symbol_migration` and `change_value_representation` used to be annotated
 * with this and are NOT preview-only — `dryRun:false` reaches `applyPreviewExclusively`, the same
 * `fs.writeFileSync` path `refactor_replace_apply` uses. MCP annotations are static per tool, not
 * per argument, so a host trusting `readOnlyHint` to skip its confirmation had no way to know that
 * one particular call was about to rewrite source files. They now carry `appliesChange`. Annotate
 * for the worst a tool can do, never for its default.
 */
export const previewsChange: ToolAnnotations = {
  readOnly: true,
  idempotent: false,
  destructive: false,
  openWorld: false
};

/**
 * `refactor_replace_apply` — the one tool here that edits source files on disk.
 *
 * Destructive without qualification: unlike `index_repository`, what it overwrites is the
 * user's code, not derived state. Not idempotent — a second apply of the same previewId is
 * rejected, and the preview is consumed.
 */
export const appliesChange: ToolAnnotations = {
  readOnly: false,
  idempotent: false,
  destructive: true,
  openWorld: false
};

/**
 * `refactor_replace_rollback` — restores the files an apply changed.
 *
 * Destructive for the same reason apply is: it overwrites working-tree files. That it is the
 * *undo* does not make it safe to invoke unprompted, since anything written after the apply is
 * overwritten too. Idempotent: rolling the same rollbackId back twice lands on the same state.
 */
export const revertsChange: ToolAnnotations = {
  readOnly: false,
  idempotent: true,
  destructive: true,
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
