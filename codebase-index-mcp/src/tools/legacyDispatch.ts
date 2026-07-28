/**
 * The pre-SDK tool dispatcher — 43 tools, one `switch` (S-31).
 *
 * Lifted verbatim out of `index.ts` so the SDK's `LegacyBridge` has something to call.
 * Nothing here is new: each branch still parses with the same zod schema and calls the
 * same handler, in the same order.
 *
 * This file is temporary by design. S-32 moves tools to one-file-per-tool definitions a
 * batch at a time, deleting a branch per tool; S-33 deletes what is left. Two consequences
 * worth knowing while it exists:
 *
 *   - It does not catch anything. Errors propagate to the bridge, and the entry point's
 *     `formatError` renders them — which is how the `{ code, message, requestId }` envelope
 *     survives the migration.
 *   - The `default:` branch is the server's unknown-tool rejection, and it is reached for
 *     names the registry does not serve either. See the bridge in `server.ts`.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas/toolSchemas.js";
import type { HandlerContext } from "../handlers/handlerContext.js";
import type { DescriptorLimits } from "./descriptors/limits.js";

import {
  handleChangeImpact
} from "../handlers/indexHandler.js";
import {
  handleGetSymbolBlame
} from "../handlers/searchHandler.js";
import {
  handleFindFieldAccesses
} from "../handlers/impactHandler.js";
import {
  handleRenameAssist,
  handleRefactorReplacePreview,
  handleRefactorReplaceApply,
  handleRefactorReplaceRollback,
  handleRefactorSymbolMigration,
  handleChangeValueRepresentation
} from "../handlers/refactorHandler.js";
import { handleGetValueContractImpact } from "../handlers/persistenceHandler.js";

export interface LegacyDispatchOptions {
  /** The same env-derived bounds the descriptor table advertises. */
  readonly limits: DescriptorLimits;
  /** Rebuilt per call, as the pre-migration entry point did. */
  readonly buildContext: () => HandlerContext;
}

export type LegacyDispatch = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export function createLegacyDispatcher(options: LegacyDispatchOptions): LegacyDispatch {
  const { maxResultLimit, maxDepth, maxFilesPerRun } = options.limits;

  // Built once at startup, exactly as these were module-level constants before.
  const findFieldAccessesSchema = schemas.findFieldAccessesSchema(maxResultLimit);
  const changeImpactSchema = schemas.changeImpactSchema(maxResultLimit);
  const symbolBlameSchema = schemas.symbolBlameSchema;
  const renameAssistSchema = schemas.renameAssistSchema(maxResultLimit);
  const refactorReplacePreviewSchema = schemas.refactorReplacePreviewSchema;
  const refactorReplaceApplySchema = schemas.refactorReplaceApplySchema;
  const refactorReplaceRollbackSchema = schemas.refactorReplaceRollbackSchema;
  const refactorSymbolMigrationSchema = schemas.refactorSymbolMigrationSchema;
  const changeValueRepresentationSchema = schemas.changeValueRepresentationSchema;
  const getValueContractImpactSchema = schemas.getValueContractImpactSchema;

  return async function dispatchLegacyTool(name, args) {
    const ctx = options.buildContext();

    switch (name) {
      case "find_field_accesses": {
        const hArgs = findFieldAccessesSchema.parse(args);
        return handleFindFieldAccesses(hArgs, ctx);
      }
      case "get_symbol_blame": {
        const hArgs = symbolBlameSchema.parse(args);
        return handleGetSymbolBlame(hArgs, ctx);
      }
      case "change_impact": {
        const hArgs = changeImpactSchema.parse(args);
        return handleChangeImpact(hArgs, ctx);
      }
      case "rename_assist": {
        const hArgs = renameAssistSchema.parse(args);
        return handleRenameAssist(hArgs, ctx);
      }
      case "refactor_replace_preview": {
        const hArgs = refactorReplacePreviewSchema.parse(args);
        return handleRefactorReplacePreview(hArgs, ctx);
      }
      case "refactor_replace_apply": {
        const hArgs = refactorReplaceApplySchema.parse(args);
        return handleRefactorReplaceApply(hArgs, ctx);
      }
      case "refactor_replace_rollback": {
        const hArgs = refactorReplaceRollbackSchema.parse(args);
        return handleRefactorReplaceRollback(hArgs, ctx);
      }
      case "refactor_symbol_migration": {
        const hArgs = refactorSymbolMigrationSchema.parse(args);
        // Awaited rather than returned: these two reject (e.g. INVALID_INITIALIZER_REWRITE)
        // and the rejection must reach the bridge as a failure of *this* call, so the entry
        // point's formatError renders it as an isError result instead of a JSON-RPC error.
        return await handleRefactorSymbolMigration(hArgs, ctx);
      }
      case "change_value_representation": {
        const hArgs = changeValueRepresentationSchema.parse(args);
        return await handleChangeValueRepresentation(hArgs, ctx);
      }
      case "get_value_contract_impact": {
        const hArgs = getValueContractImpactSchema.parse(args);
        return handleGetValueContractImpact(hArgs, ctx);
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  };
}
