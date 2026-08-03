import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { toNugetContractId, resolveResponseProfile } from "../../middleware/responseFormatter.js";
import type { HandlerContext } from "./handlerContext.js";

// ── get_cross_repo_impact ─────────────────────────────────────────────────────

export function handleGetCrossRepoImpact(
  args: {
    repoId: string;
    symbolId?: string;
    name?: string;
    direction: "outbound" | "inbound";
    limit: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  let symbolId = args.symbolId;
  if (!symbolId && args.name) {
    const candidates = store.searchSymbols(args.name, args.repoId, null, null, null, 1, "name");
    symbolId = candidates[0]?.symbolId;
  }
  if (!symbolId) {
    throw new McpError(ErrorCode.InvalidParams, "get_cross_repo_impact: symbol not found. Provide symbolId or a resolvable name.");
  }

  const symbol = store.getSymbolDetail(args.repoId, symbolId, 1).symbol;
  if (!symbol) {
    throw new McpError(ErrorCode.InvalidParams, `get_cross_repo_impact: symbol '${symbolId}' not found in repo '${args.repoId}'.`);
  }

  const impactRows = store.getCrossRepoImpact(args.repoId, symbolId, args.direction, args.limit).map((row) => {
    const signature = row.relatedSignature ?? "";
    const isNugetContract = signature.startsWith("nuget:");
    const isEndpointContract = signature.startsWith("endpoint:");
    return {
      ...row,
      contractType: isNugetContract ? "nuget" : isEndpointContract ? "endpoint" : "symbol",
      resolutionReason: isNugetContract
        ? "nuget_contract_signature_match"
        : isEndpointContract
          ? "endpoint_contract_signature_match"
          : "symbol_id_exact_match"
    };
  });

  if (profile === "nano") {
    return ctx.asText({
      repoId: args.repoId,
      symbol: { symbolId: symbol.symbolId, name: symbol.name, kind: symbol.kind },
      direction: args.direction,
      impactCount: impactRows.length,
      relatedRepos: [...new Set(impactRows.map((x) => (args.direction === "outbound" ? x.toRepoId : x.fromRepoId)))].slice(0, 10)
    }, profile);
  }

  return ctx.asText({ repoId: args.repoId, symbol, direction: args.direction, impactCount: impactRows.length, impacts: impactRows }, profile);
}

// ── find_package_consumers ────────────────────────────────────────────────────

export function handleFindPackageConsumers(
  args: { packageName: string; repoId?: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const packageContractId = toNugetContractId(args.packageName);
  const rows = store.findPackageConsumers(packageContractId, args.repoId ?? null, args.limit).map((row) => ({
    ...row,
    resolved: Boolean(row.providerRepoId && row.providerSymbolId)
  }));

  // When no consumers found, surface similar indexed package contract IDs as hints.
  // This covers cases like querying "FluentValidation" when only
  // "FluentValidation.DependencyInjectionExtensions" is indexed.
  const didYouMean: string[] =
    rows.length === 0
      ? store.findSimilarPackageContractIds(packageContractId, args.repoId ?? null, 10)
      : [];

  if (profile === "nano") {
    return ctx.asText({
      packageName: args.packageName,
      packageContractId,
      consumerCount: rows.length,
      consumerRepos: [...new Set(rows.map((x) => x.consumerRepoId))].slice(0, 10),
      resolvedCount: rows.filter((x) => x.resolved).length,
      ...(didYouMean.length > 0 && { hint: "no consumers found for exact package name — did you mean one of these indexed packages?", didYouMean })
    }, profile);
  }

  return ctx.asText({
    packageName: args.packageName,
    packageContractId,
    consumerCount: rows.length,
    consumers: rows,
    ...(didYouMean.length > 0 && { hint: "no consumers found for exact package name — did you mean one of these indexed packages?", didYouMean })
  }, profile);
}
