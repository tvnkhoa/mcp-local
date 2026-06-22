import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { getPersistenceMapping } from "../efPersistence.js";
import { getValueContractImpact } from "../valueContract.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import type { HandlerContext } from "./handlerContext.js";

/**
 * ENH-029-C — `get_persistence_mapping`. Returns the EF mapping (column, converter, max length,
 * CHECK constraints) for a property plus any DB_TRANSLATED_PROJECTION warnings — the persistence-layer
 * facts a symbol graph can't see. Rule/AST-based (llmInvolved=false).
 */
export function handleGetPersistenceMapping(
  args: { repoId: string; property: string; ownerType?: string; profile?: string },
  ctx: HandlerContext
): CallToolResult {
  // compact is the default for read tools (per CLAUDE.md: minified JSON, null fields dropped).
  const profile = resolveResponseProfile((args.profile ?? "compact") as Parameters<typeof resolveResponseProfile>[0]);
  const repo = ctx.store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `get_persistence_mapping: repo '${args.repoId}' not found.`);
  }

  const result = getPersistenceMapping(ctx.store, repo.repoPath, args.repoId, {
    property: args.property,
    ownerType: args.ownerType
  });

  return ctx.asText({
    ...result,
    isValueConverted: result.mappings.some((m) => m.hasConverter),
    hasProjectionTrap: result.projectionWarnings.length > 0,
    executionPolicy: { decisionSource: "rule_engine", llmInvolved: false }
  }, profile);
}

/**
 * ENH-029-E — `get_value_contract_impact`. Traces a storage/wire value (e.g. "resolved") across every
 * registered repo, grouping hits by repo and classifying each as producer/consumer where inferable.
 * This is the data-contract gate a symbol-oriented cross-repo query can't answer. Rule-based, no LLM.
 */
export function handleGetValueContractImpact(
  args: { value: string; column?: string; repoIds?: string[]; profile?: string },
  ctx: HandlerContext
): CallToolResult {
  // compact is the default for read tools (per CLAUDE.md: minified JSON, null fields dropped).
  const profile = resolveResponseProfile((args.profile ?? "compact") as Parameters<typeof resolveResponseProfile>[0]);
  const result = getValueContractImpact(ctx.store, {
    value: args.value,
    column: args.column,
    repoIds: args.repoIds
  });

  return ctx.asText({
    ...result,
    executionPolicy: { decisionSource: "rule_engine", llmInvolved: false }
  }, profile);
}
