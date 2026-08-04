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
    const { edgeReason, ...rest } = row;
    const signature = row.relatedSignature ?? "";
    const isNugetContract = signature.startsWith("nuget:");
    const isEndpointContract = signature.startsWith("endpoint:");
    // MCP-ISSUE-045: a link the type resolver guessed from a bare name is not a symbol-id match, and
    // reporting it as one gave a BCL type the strongest reason string the tool has. The originating
    // edge's `reason` is the only place that distinction survives.
    const isBareNameMatch = (edgeReason ?? "").includes("name-match");
    return {
      ...rest,
      contractType: isNugetContract ? "nuget" : isEndpointContract ? "endpoint" : "symbol",
      resolutionReason: isNugetContract
        ? "nuget_contract_signature_match"
        : isEndpointContract
          ? "endpoint_contract_signature_match"
          : isBareNameMatch
            ? "cross_repo_bare_name_match"
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

  // The repos that PUBLISH this contract. Reported separately rather than mixed into `consumers[]`,
  // which is where they used to land (MCP-ISSUE-046).
  const providers = store.findPackageProviders(packageContractId, 10);

  // When no consumers found, surface similar indexed package contract IDs as hints.
  // This covers cases like querying "FluentValidation" when only
  // "FluentValidation.DependencyInjectionExtensions" is indexed.
  const didYouMean: string[] =
    rows.length === 0
      ? store.findSimilarPackageContractIds(packageContractId, args.repoId ?? null, 10)
      : [];

  // MCP-ISSUE-046: an empty result must say WHICH kind of empty it is. A mistyped name and a
  // package nobody consumes were indistinguishable, and `didYouMean` cannot close the gap because
  // it is prefix-anchored — a name wrong in its first segment yields no suggestions at all, and the
  // hint was spread only when suggestions existed.
  const unknownPackage = rows.length === 0 && providers.length === 0 && !store.packageContractExists(packageContractId);
  const emptyHint =
    rows.length > 0
      ? null
      : unknownPackage
        ? "no such package contract id is indexed — check the name, or query edges WHERE type='DEPENDS_ON' AND to_id LIKE 'nuget:%' for the exact ids"
        : didYouMean.length > 0
          ? "no consumers found for exact package name — did you mean one of these indexed packages?"
          : "this package contract IS indexed but has no consumers outside the repo that publishes it";

  // Never let the publisher exclusion be a silent truncation.
  const excludedPublisherRows = store.countPublisherSelfReferences(packageContractId);

  const diagnostics = {
    ...(unknownPackage && { unknownPackage: true }),
    ...(excludedPublisherRows > 0 && { excludedPublisherRows }),
    ...(emptyHint !== null && { hint: emptyHint }),
    ...(didYouMean.length > 0 && { didYouMean })
  };

  if (profile === "nano") {
    return ctx.asText({
      packageName: args.packageName,
      packageContractId,
      consumerCount: rows.length,
      consumerRepos: [...new Set(rows.map((x) => x.consumerRepoId))].slice(0, 10),
      resolvedCount: rows.filter((x) => x.resolved).length,
      ...diagnostics
    }, profile);
  }

  return ctx.asText({
    packageName: args.packageName,
    packageContractId,
    consumerCount: rows.length,
    consumers: rows,
    providerCount: providers.length,
    ...(providers.length > 0 && { providers }),
    ...diagnostics
  }, profile);
}
