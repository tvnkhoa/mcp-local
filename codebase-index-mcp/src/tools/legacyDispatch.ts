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
  handleIndexRepository,
  handleWatchRepo,
  handleDetectChanges,
  handleChangeImpact
} from "../handlers/indexHandler.js";
import {
  handleSearchSymbols,
  handleSearchLiterals,
  handleSearchRegex,
  handleFindSymbolAtLine,
  handleGetSymbolDetail,
  handleGetSymbolContextPack,
  handleGetSymbolBlame,
  handleGetSymbolSource
} from "../handlers/searchHandler.js";
import { handleGetFeatureBundle } from "../handlers/bundleHandler.js";
import {
  handleGetDependencyGraph,
  handleGetCallChain,
  handleFindFieldAccesses,
  handleFindImpactFiles,
  handleGetChangeContext,
  handleRouteMap,
  handleQueryGraph
} from "../handlers/impactHandler.js";
import {
  handleDeadCodeScan,
  handleDetectCircularDependencies,
  handleFindImplementations,
  handleLinkTestsToSource
} from "../handlers/analysisHandler.js";
import {
  handleGetCrossRepoImpact,
  handleFindPackageConsumers
} from "../handlers/crossRepoHandler.js";
import {
  handleRenameAssist,
  handleRefactorReplacePreview,
  handleRefactorReplaceApply,
  handleRefactorReplaceRollback,
  handleRefactorSymbolMigration,
  handleChangeValueRepresentation,
  handleTraceExecutionFlow
} from "../handlers/refactorHandler.js";
import { handleGetPersistenceMapping, handleGetValueContractImpact } from "../handlers/persistenceHandler.js";

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
  const indexRepositorySchema = schemas.indexRepositorySchema(maxFilesPerRun);
  const getDependencyGraphSchema = schemas.getDependencyGraphSchema(maxDepth, maxResultLimit);
  const getCallChainSchema = schemas.getCallChainSchema(maxDepth, maxResultLimit);
  const searchSymbolsSchema = schemas.searchSymbolsSchema(maxResultLimit);
  const searchLiteralsSchema = schemas.searchLiteralsSchema(maxResultLimit);
  const searchRegexSchema = schemas.searchRegexSchema(maxResultLimit);
  const getSymbolDetailSchema = schemas.getSymbolDetailSchema(maxResultLimit);
  const findImpactFilesSchema = schemas.findImpactFilesSchema(maxResultLimit);
  const findFieldAccessesSchema = schemas.findFieldAccessesSchema(maxResultLimit);
  const getChangeContextSchema = schemas.getChangeContextSchema(maxDepth, maxResultLimit);
  const findSymbolAtLineSchema = schemas.findSymbolAtLineSchema;
  const getSymbolContextPackSchema = schemas.getSymbolContextPackSchema(maxDepth, maxResultLimit);
  const detectChangesSchema = schemas.detectChangesSchema(maxResultLimit);
  const changeImpactSchema = schemas.changeImpactSchema(maxResultLimit);
  const getFeatureBundleSchema = schemas.getFeatureBundleSchema;
  const deadCodeScanSchema = schemas.deadCodeScanSchema(maxResultLimit);
  const detectCircularDependenciesSchema = schemas.detectCircularDependenciesSchema(maxDepth, maxResultLimit);
  const crossRepoImpactSchema = schemas.crossRepoImpactSchema(maxResultLimit);
  const findPackageConsumersSchema = schemas.findPackageConsumersSchema(maxResultLimit);
  const symbolBlameSchema = schemas.symbolBlameSchema;
  const getSymbolSourceSchema = schemas.getSymbolSourceSchema;
  const linkTestsToSourceSchema = schemas.linkTestsToSourceSchema(maxResultLimit);
  const findImplementationsSchema = schemas.findImplementationsSchema(maxResultLimit);
  const watchRepoSchema = schemas.watchRepoSchema;
  const renameAssistSchema = schemas.renameAssistSchema(maxResultLimit);
  const traceExecutionFlowSchema = schemas.traceExecutionFlowSchema;
  const routeMapSchema = schemas.routeMapSchema(maxResultLimit);
  const queryGraphSchema = schemas.queryGraphSchema(maxResultLimit);
  const refactorReplacePreviewSchema = schemas.refactorReplacePreviewSchema;
  const refactorReplaceApplySchema = schemas.refactorReplaceApplySchema;
  const refactorReplaceRollbackSchema = schemas.refactorReplaceRollbackSchema;
  const refactorSymbolMigrationSchema = schemas.refactorSymbolMigrationSchema;
  const changeValueRepresentationSchema = schemas.changeValueRepresentationSchema;
  const getPersistenceMappingSchema = schemas.getPersistenceMappingSchema;
  const getValueContractImpactSchema = schemas.getValueContractImpactSchema;

  return async function dispatchLegacyTool(name, args) {
    const ctx = options.buildContext();

    switch (name) {
      case "index_repository": {
        const hArgs = indexRepositorySchema.parse(args);
        return handleIndexRepository(hArgs, ctx);
      }
      case "get_dependency_graph": {
        const hArgs = getDependencyGraphSchema.parse(args);
        return handleGetDependencyGraph(hArgs, ctx);
      }
      case "get_call_chain": {
        const hArgs = getCallChainSchema.parse(args);
        return handleGetCallChain(hArgs, ctx);
      }
      case "find_impact_files": {
        const hArgs = findImpactFilesSchema.parse(args);
        return handleFindImpactFiles(hArgs, ctx);
      }
      case "find_field_accesses": {
        const hArgs = findFieldAccessesSchema.parse(args);
        return handleFindFieldAccesses(hArgs, ctx);
      }
      case "get_change_context": {
        const hArgs = getChangeContextSchema.parse(args);
        return handleGetChangeContext(hArgs, ctx);
      }
      case "search_symbols": {
        const hArgs = searchSymbolsSchema.parse(args);
        return handleSearchSymbols(hArgs, ctx);
      }
      case "search_literals": {
        const hArgs = searchLiteralsSchema.parse(args);
        return handleSearchLiterals(hArgs, ctx);
      }
      case "search_regex": {
        const hArgs = searchRegexSchema.parse(args);
        return handleSearchRegex(hArgs, ctx);
      }
      case "get_symbol_detail": {
        const hArgs = getSymbolDetailSchema.parse(args);
        return handleGetSymbolDetail(hArgs, ctx);
      }
      case "watch_repo": {
        const hArgs = watchRepoSchema.parse(args);
        return handleWatchRepo(hArgs, ctx);
      }
      case "find_symbol_at_line": {
        const hArgs = findSymbolAtLineSchema.parse(args);
        return handleFindSymbolAtLine(hArgs, ctx);
      }
      case "get_symbol_context_pack": {
        const hArgs = getSymbolContextPackSchema.parse(args);
        return handleGetSymbolContextPack(hArgs, ctx);
      }
      case "dead_code_scan": {
        const hArgs = deadCodeScanSchema.parse(args);
        return handleDeadCodeScan(hArgs, ctx);
      }
      case "detect_circular_dependencies": {
        const hArgs = detectCircularDependenciesSchema.parse(args);
        return handleDetectCircularDependencies(hArgs, ctx);
      }
      case "get_cross_repo_impact": {
        const hArgs = crossRepoImpactSchema.parse(args);
        return handleGetCrossRepoImpact(hArgs, ctx);
      }
      case "find_package_consumers": {
        const hArgs = findPackageConsumersSchema.parse(args);
        return handleFindPackageConsumers(hArgs, ctx);
      }
      case "get_symbol_blame": {
        const hArgs = symbolBlameSchema.parse(args);
        return handleGetSymbolBlame(hArgs, ctx);
      }
      case "get_symbol_source": {
        const hArgs = getSymbolSourceSchema.parse(args);
        return handleGetSymbolSource(hArgs, ctx);
      }
      case "link_tests_to_source": {
        const hArgs = linkTestsToSourceSchema.parse(args);
        return handleLinkTestsToSource(hArgs, ctx);
      }
      case "detect_changes": {
        const hArgs = detectChangesSchema.parse(args);
        return handleDetectChanges(hArgs, ctx);
      }
      case "change_impact": {
        const hArgs = changeImpactSchema.parse(args);
        return handleChangeImpact(hArgs, ctx);
      }
      case "get_feature_bundle": {
        const hArgs = getFeatureBundleSchema.parse(args);
        return handleGetFeatureBundle(hArgs, ctx);
      }
      case "find_implementations": {
        const hArgs = findImplementationsSchema.parse(args);
        return handleFindImplementations(hArgs, ctx);
      }
      case "route_map": {
        const hArgs = routeMapSchema.parse(args);
        return handleRouteMap(hArgs, ctx);
      }
      case "query_graph": {
        const hArgs = queryGraphSchema.parse(args);
        return handleQueryGraph(hArgs, ctx);
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
      case "get_persistence_mapping": {
        const hArgs = getPersistenceMappingSchema.parse(args);
        return handleGetPersistenceMapping(hArgs, ctx);
      }
      case "get_value_contract_impact": {
        const hArgs = getValueContractImpactSchema.parse(args);
        return handleGetValueContractImpact(hArgs, ctx);
      }
      case "trace_execution_flow": {
        const hArgs = traceExecutionFlowSchema.parse(args);
        return handleTraceExecutionFlow(hArgs, ctx);
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  };
}
