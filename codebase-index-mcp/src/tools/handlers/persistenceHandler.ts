import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { getPersistenceMapping } from "../../services/analysis/efPersistence.js";
import { getValueContractImpact } from "../../services/analysis/valueContract.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
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
    ownerType: args.ownerType,
    // The repo-wide constraint list is a debugging aid, not an answer — verbose only (MCP-ISSUE-047).
    includeUnrelatedConstraints: profile === "verbose"
  });

  const isValueConverted = result.mappings.some((m) => m.hasConverter);

  // MCP-ISSUE-047 scenario C: `find_field_accesses` reports the DECLARING type, EF configures the
  // OWNING entity, and passing the former in returned `mappings: []` — indistinguishable from "this
  // property is not persisted". Say so explicitly instead.
  const ownerMismatch =
    result.mappings.length === 0 && result.requestedOwnerType !== null && result.ownersWithMapping.length > 0
      ? {
          hint:
            `'${result.requestedOwnerType}' has no EF mapping for this property, but it IS persisted under ` +
            `another owner — retry with one of ownersWithMapping. A property declared on an owned type is ` +
            `configured on the owning entity, so the declaring type reported by find_field_accesses is often ` +
            `not the EF owner.`
        }
      : result.mappings.length === 0
        ? {
            // Without this the tool returns a silent zero, which reads as "this property is not
            // persisted" in any repo — including a TypeScript one, where it can only ever be zero.
            hint:
              `no EF mapping found — this tool reads EF Core configuration out of C# ` +
              `(IEntityTypeConfiguration/OnModelCreating) only. Prisma, TypeORM, Drizzle and raw SQL are not ` +
              `read, so a TS/JS repo is always empty here.`
          }
        : null;

  if (profile === "nano") {
    return ctx.asText({
      repoId: result.repoId,
      property: result.property,
      resolvedProperty: result.resolvedProperty,
      mappingCount: result.mappings.length,
      columnName: result.mappings[0]?.columnName ?? null,
      isValueConverted,
      maxLength: result.mappings[0]?.maxLength ?? null,
      checkConstraintCount: result.checkConstraints.length,
      projectionWarningCount: result.projectionWarnings.length,
      ownersWithMapping: result.ownersWithMapping,
      ...(ownerMismatch !== null && ownerMismatch)
    }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({
      repoId: result.repoId,
      property: result.property,
      resolvedProperty: result.resolvedProperty,
      requestedOwnerType: result.requestedOwnerType,
      // Drop converterExpression — it is the single largest field and is rarely what the caller needs.
      mappings: result.mappings.map((m) => ({
        ownerType: m.ownerType,
        property: m.property,
        columnName: m.columnName,
        hasConverter: m.hasConverter,
        maxLength: m.maxLength,
        filePath: m.filePath,
        line: m.line
      })),
      ownersWithMapping: result.ownersWithMapping,
      checkConstraints: result.checkConstraints,
      // Drop `snippet` (160 chars) and `detail` (prose) — the code + location is the actionable part.
      projectionWarnings: result.projectionWarnings.map((w) => ({
        code: w.code,
        property: w.property,
        operator: w.operator,
        filePath: w.filePath,
        line: w.line
      })),
      isValueConverted,
      hasProjectionTrap: result.projectionWarnings.length > 0,
      filesScanned: result.filesScanned,
      ...(ownerMismatch !== null && ownerMismatch),
      executionPolicy: { decisionSource: "rule_engine", llmInvolved: false }
    }, profile);
  }

  return ctx.asText({
    ...result,
    isValueConverted,
    hasProjectionTrap: result.projectionWarnings.length > 0,
    ...(ownerMismatch !== null && ownerMismatch),
    executionPolicy: { decisionSource: "rule_engine", llmInvolved: false }
  }, profile);
}

/**
 * ENH-029-E — `get_value_contract_impact`. Traces a storage/wire value (e.g. "resolved") across every
 * registered repo, grouping hits by repo and classifying each as producer/consumer where inferable.
 * This is the data-contract gate a symbol-oriented cross-repo query can't answer. Rule-based, no LLM.
 */
export function handleGetValueContractImpact(
  args: { value: string; column?: string; repoIds?: string[]; excludeTests?: boolean; profile?: string },
  ctx: HandlerContext
): CallToolResult {
  // compact is the default for read tools (per CLAUDE.md: minified JSON, null fields dropped).
  const profile = resolveResponseProfile((args.profile ?? "compact") as Parameters<typeof resolveResponseProfile>[0]);
  const result = getValueContractImpact(ctx.store, {
    value: args.value,
    column: args.column,
    repoIds: args.repoIds,
    excludeTests: args.excludeTests
  });

  return ctx.asText({
    ...result,
    executionPolicy: { decisionSource: "rule_engine", llmInvolved: false }
  }, profile);
}
