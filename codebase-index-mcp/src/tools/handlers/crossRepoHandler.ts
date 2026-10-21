import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { toNugetContractId, resolveResponseProfile } from "../../middleware/responseFormatter.js";
import type { SymbolRecord } from "../../types/index.js";
import type { HandlerContext } from "./handlerContext.js";
import { describeEndpointLink } from "./crossRepoEndpoints.js";

// ── get_cross_repo_impact ─────────────────────────────────────────────────────

export function handleGetCrossRepoImpact(
  args: {
    repoId: string;
    symbolId?: string;
    name?: string;
    filePath?: string;
    direction: "outbound" | "inbound";
    limit: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  // ── What is being asked about: one symbol (plus the endpoint contracts it stands for), or a file.
  let symbol: SymbolRecord | null = null;
  let targetIds: string[];
  let endpointContracts: { symbolId: string; signature: string }[] = [];
  let nameResolution: NameResolution | null = null;
  const filePath = args.filePath?.replace(/\\/g, "/");
  if (filePath && !args.symbolId && !args.name) {
    targetIds = store.getSymbolIdsInFile(args.repoId, filePath, MAX_FILE_SYMBOLS);
    if (targetIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `get_cross_repo_impact: no symbols indexed for file '${filePath}' in repo '${args.repoId}'. Use the repo-relative path with forward slashes.`);
    }
  } else {
    let symbolId = args.symbolId;
    if (!symbolId && args.name) {
      const picked = pickByName(store, args.repoId, args.name);
      if (picked.kind === "ambiguous") {
        return ctx.asText(
          {
            repoId: args.repoId,
            direction: args.direction,
            queriedName: args.name,
            status: "ambiguous",
            impactCount: null,
            candidates: picked.candidates,
            hint: "several symbols carry this name and none (or more than one) is a route with an endpoint contract; re-ask with the symbolId of the one you mean. No count is given for an arbitrary pick."
          },
          profile
        );
      }
      symbolId = picked.symbolId;
      nameResolution = picked.note;
    }
    if (!symbolId) {
      throw new McpError(ErrorCode.InvalidParams, "get_cross_repo_impact: symbol not found. Provide symbolId, a resolvable name, or filePath.");
    }
    symbol = store.getSymbolDetail(args.repoId, symbolId, 1).symbol;
    if (!symbol) {
      throw new McpError(ErrorCode.InvalidParams, `get_cross_repo_impact: symbol '${symbolId}' not found in repo '${args.repoId}'.`);
    }
    // R9: a controller action is not itself the link target; the endpoint contract minted for its
    // route is. Query both, so "who calls this action" does not need the caller to know that.
    endpointContracts = store.findEndpointContractSymbols(args.repoId, symbolId);
    targetIds = [...new Set([symbolId, ...endpointContracts.map((c) => c.symbolId)])];
  }

  const tableCache = new Map<string, { tool: string; at: string } | null>();
  const impactRows = store.getCrossRepoImpact(args.repoId, targetIds, args.direction, args.limit).map((row) => {
    const { edgeReason, targetSignature, ...rest } = row;
    // The contract lives on the TO side of the link whichever way the query runs.
    const contractSignature = (args.direction === "outbound" ? row.relatedSignature : targetSignature) ?? "";
    const isNugetContract = contractSignature.startsWith("nuget:");
    const isEndpointContract = contractSignature.startsWith("endpoint:");
    // MCP-ISSUE-045: a link the type resolver guessed from a bare name is not a symbol-id match, and
    // reporting it as one gave a BCL type the strongest reason string the tool has. The originating
    // edge's `reason` is the only place that distinction survives.
    const isBareNameMatch = (edgeReason ?? "").includes("name-match");
    const endpoint = isEndpointContract
      ? describeEndpointLink(
          store,
          {
            fromRepoId: row.fromRepoId,
            fromSymbolId: row.fromSymbolId,
            providerSignature: contractSignature,
            consumerName: args.direction === "inbound" ? row.relatedName : row.targetName,
            consumerFilePath: args.direction === "inbound" ? row.relatedFilePath : (symbol?.filePath ?? filePath ?? null)
          },
          tableCache
        )
      : null;
    return {
      ...rest,
      contractType: isNugetContract ? "nuget" : isEndpointContract ? "endpoint" : "symbol",
      resolutionReason: isNugetContract
        ? "nuget_contract_signature_match"
        : endpoint
          ? endpoint.matchKind === "wildcard"
            ? "endpoint_contract_wildcard_match"
            : endpoint.matchKind === "gateway_prefix"
              ? "endpoint_contract_gateway_prefix_match"
              : "endpoint_contract_signature_match"
          : isBareNameMatch
            ? "cross_repo_bare_name_match"
            : "symbol_id_exact_match",
      ...(endpoint ? { endpoint } : {})
    };
  });

  // An action or controller whose consumers were asked for in the wrong direction.
  const hint =
    impactRows.length === 0 && args.direction === "outbound" && endpointContracts.length > 0
      ? "this symbol serves HTTP endpoint(s); its consumers are inbound links — rerun with direction:'inbound'"
      : impactRows.length === 0 && args.direction === "inbound" && endpointContracts.length > 0
        ? "no indexed repo links to this endpoint. Cross-repo links are written when the CONSUMER repo is indexed, so a consumer indexed before this provider needs a re-index"
        : null;
  const subject = symbol ?? { filePath, symbolCount: targetIds.length };

  if (profile === "nano") {
    return ctx.asText({
      repoId: args.repoId,
      ...(symbol ? { symbol: { symbolId: symbol.symbolId, name: symbol.name, kind: symbol.kind } } : { filePath }),
      direction: args.direction,
      impactCount: impactRows.length,
      ...(nameResolution ? { nameResolution } : {}),
      relatedRepos: [...new Set(impactRows.map((x) => (args.direction === "outbound" ? x.toRepoId : x.fromRepoId)))].slice(0, 10),
      ...(hint ? { hint } : {})
    }, profile);
  }

  return ctx.asText({
    repoId: args.repoId,
    ...(symbol ? { symbol } : { file: subject }),
    ...(endpointContracts.length > 0 ? { endpointContracts: endpointContracts.map((c) => c.signature) } : {}),
    direction: args.direction,
    impactCount: impactRows.length,
    ...(nameResolution ? { nameResolution } : {}),
    impacts: impactRows,
    ...(hint ? { hint } : {})
  }, profile);
}

type NameCandidate = { symbolId: string; name: string; kind: string; filePath: string; line: number; endpointContracts: string[] };
type NameResolution = { queriedName: string; pickedBy: "only_exact_match" | "only_endpoint_carrier" | "substring_match"; candidates?: NameCandidate[] };
type NamePick = { kind: "picked"; symbolId: string; note: NameResolution | null } | { kind: "ambiguous"; candidates: NameCandidate[] };

/**
 * Release G.1 (wec.aria acceptance): a name used to resolve to search's first hit. For
 * "GetListOwnedVehicle" that was the IVehicleService declaration, so the answer was "0 consumers" —
 * a confident zero, while the controller action of that name is what Aria calls. Exact-name matches
 * are now all considered; the one(s) carrying an endpoint contract (a route) are preferred; more
 * than one left is `ambiguous` with every candidate, never a count for an arbitrary pick.
 */
function pickByName(store: HandlerContext["store"], repoId: string, name: string): NamePick {
  const found = store.searchSymbols(name, repoId, null, null, null, 25, "name");
  const exact = found.filter((c) => c.name === name);
  if (exact.length === 0) {
    const first = found[0];
    if (!first) return { kind: "picked", symbolId: "", note: null };
    return { kind: "picked", symbolId: first.symbolId, note: { queriedName: name, pickedBy: "substring_match" } };
  }
  const candidates: NameCandidate[] = exact.map((c) => ({
    symbolId: c.symbolId,
    name: c.name,
    kind: c.kind,
    filePath: c.filePath.replace(/\\/g, "/"),
    line: c.line,
    endpointContracts: store.findEndpointContractSymbols(repoId, c.symbolId).map((e) => e.signature)
  }));
  if (candidates.length === 1) return { kind: "picked", symbolId: candidates[0]!.symbolId, note: null };
  const carriers = candidates.filter((c) => c.endpointContracts.length > 0);
  if (carriers.length === 1) return { kind: "picked", symbolId: carriers[0]!.symbolId, note: { queriedName: name, pickedBy: "only_endpoint_carrier", candidates } };
  return { kind: "ambiguous", candidates };
}

/** Symbols considered for a file-level query; a file with more is answered for its first ones by line. */
const MAX_FILE_SYMBOLS = 1000;

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
