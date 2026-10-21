/**
 * Matching a consumer's endpoint contract id against a provider's (R9, MCP-ISSUE-081).
 *
 * The id itself is NOT changed here: both sides still mint `endpoint:METHOD:/path` through
 * `toEndpointContractId` (`extractors/extractorRoutes.ts`), which lowercases the path and keeps
 * parameter segments verbatim — `{id}`, `{customerid}`, `{id:int}`. Changing that would unlink every
 * already-indexed pair of repos until both were re-indexed, so the tolerance lives in the matcher.
 *
 * Three tiers, tried in order; the first tier with a candidate wins, so an exact match is always
 * preferred over a looser one:
 *
 *   1. `exact`          — the two ids are the same string (what the resolver always did).
 *   2. `wildcard`       — same method, same segment count; literal segments equal (both sides are
 *                         already lowercase, so this is case-insensitive), and a parameter segment
 *                         on the consumer side (`{id}`) matches any parameter segment on the
 *                         provider side (`{customerId}`, `{id:int}`, `{id?}`). A parameter never
 *                         matches a literal, in either direction: `/customers/{id}` must not bind to
 *                         `/customers/global-search`. Empty segments (a trailing slash) are ignored,
 *                         and an ASP.NET `~/` override on the provider restarts the path there.
 *   3. `gateway_prefix` — the consumer path carries leading segments the provider does not declare
 *                         (an API-gateway route such as Ocelot's `/dealer/{everything}` → the
 *                         customer service's `/{everything}`). The consumer's first one or two
 *                         literal segments are stripped and the remainder matched as in tier 2.
 *                         The shortest stripped prefix wins inside this tier.
 *                         Only offered for DECLARED consumers (`http consumer (<scheme>)` edges),
 *                         and the resolver accepts it only when exactly one provider endpoint
 *                         matches — an ambiguous gateway match is counted, never linked.
 */

export type EndpointMatchKind = "exact" | "wildcard" | "gateway_prefix";

export type ParsedEndpointId = {
  method: string;
  segments: string[];
};

/** The most leading consumer segments a gateway prefix may account for. */
export const MAX_GATEWAY_PREFIX_SEGMENTS = 2;

/** Parse cache: the resolver compares every pending consumer against every provider id. */
const parseCache = new Map<string, ParsedEndpointId | null>();
const PARSE_CACHE_MAX = 50_000;

export function parseEndpointContractId(id: string): ParsedEndpointId | null {
  const cached = parseCache.get(id);
  if (cached !== undefined) return cached;
  const parsed = parseEndpointContractIdUncached(id);
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear();
  parseCache.set(id, parsed);
  return parsed;
}

function parseEndpointContractIdUncached(id: string): ParsedEndpointId | null {
  const match = /^endpoint:([A-Z]+):(.*)$/.exec(id);
  if (!match) return null;
  const method = match[1] ?? "";
  let segments = (match[2] ?? "").split("/").filter((s) => s.length > 0);
  // ASP.NET: a method template starting `~/` ignores the controller prefix. The C# lane joins the
  // two blindly, so the provider id can read `/customers/~/health`; the real path starts after `~`.
  const tilde = segments.lastIndexOf("~");
  if (tilde >= 0) segments = segments.slice(tilde + 1);
  return { method, segments };
}

export function isParameterSegment(segment: string): boolean {
  return /^\{[^{}]+\}$/.test(segment);
}

/** Catch-all parameters (`{*rest}`, `{**path}`) span several segments; this matcher does not try. */
function isCatchAll(segment: string): boolean {
  return /^\{\*/.test(segment);
}

function compareSegments(consumer: string[], provider: string[]): "exact" | "wildcard" | null {
  if (consumer.length !== provider.length) return null;
  let wildcard = false;
  for (let i = 0; i < consumer.length; i++) {
    const c = consumer[i] as string;
    const p = provider[i] as string;
    if (isCatchAll(c) || isCatchAll(p)) return null;
    if (c === p) continue;
    if (isParameterSegment(c) && isParameterSegment(p)) {
      wildcard = true;
      continue;
    }
    return null;
  }
  return wildcard ? "wildcard" : "exact";
}

export type EndpointMatch = { kind: EndpointMatchKind; strippedPrefix?: string };

/**
 * How `consumerId` matches `providerId`, or null. `allowGatewayPrefix` gates tier 3.
 *
 * Segment-level equality after normalisation (trailing slash, `~/`) reports `wildcard`, not
 * `exact`: the ids differ as strings, and the impact tools say so rather than claim a string match.
 */
export function matchEndpoint(consumerId: string, providerId: string, allowGatewayPrefix: boolean): EndpointMatch | null {
  if (consumerId === providerId) return { kind: "exact" };
  const consumer = parseEndpointContractId(consumerId);
  const provider = parseEndpointContractId(providerId);
  if (!consumer || !provider || consumer.method !== provider.method) return null;

  if (compareSegments(consumer.segments, provider.segments)) return { kind: "wildcard" };

  if (!allowGatewayPrefix) return null;
  for (let strip = 1; strip <= MAX_GATEWAY_PREFIX_SEGMENTS; strip++) {
    const prefix = consumer.segments.slice(0, strip);
    // A gateway prefix is a literal route key; a parameter there is a real path segment.
    if (prefix.length < strip || prefix.some(isParameterSegment)) break;
    const rest = consumer.segments.slice(strip);
    if (rest.length === 0) break;
    if (compareSegments(rest, provider.segments)) {
      return { kind: "gateway_prefix", strippedPrefix: `/${prefix.join("/")}` };
    }
  }
  return null;
}

/**
 * The best-tier providers for one consumer id. Returns the tier and every provider in it, in input
 * order; the caller decides what to do with several (exact/wildcard: pick by repo, as the resolver
 * always did for contracts; gateway_prefix: refuse unless unique).
 */
export function pickEndpointProviders<T extends { contractId: string }>(
  consumerId: string,
  providers: readonly T[],
  allowGatewayPrefix: boolean
): { kind: EndpointMatchKind; matches: T[]; strippedPrefix?: string } | null {
  const tiers: Record<EndpointMatchKind, T[]> = { exact: [], wildcard: [], gateway_prefix: [] };
  let strippedPrefix: string | undefined;
  const methodPrefix = /^endpoint:[A-Z]+:/.exec(consumerId)?.[0];
  if (!methodPrefix) return null;
  for (const provider of providers) {
    if (!provider.contractId.startsWith(methodPrefix)) continue;
    const match = matchEndpoint(consumerId, provider.contractId, allowGatewayPrefix);
    if (!match) continue;
    if (match.kind === "gateway_prefix") {
      // Within the gateway tier the SHORTEST stripped prefix wins: `/dealer/customers/{id}/history`
      // is the customer service's `/customers/{id:int}/history` (one segment stripped), not some
      // other service's `/{callId}/history` (two stripped). Live wec.be had exactly that pair.
      const depth = (match.strippedPrefix ?? "").split("/").filter(Boolean).length;
      const current = (strippedPrefix ?? "").split("/").filter(Boolean).length;
      if (strippedPrefix !== undefined && depth > current) continue;
      if (strippedPrefix === undefined || depth < current) {
        tiers.gateway_prefix = [];
        strippedPrefix = match.strippedPrefix;
      }
    }
    tiers[match.kind].push(provider);
  }
  if (tiers.exact.length > 0) return { kind: "exact", matches: tiers.exact };
  if (tiers.wildcard.length > 0) return { kind: "wildcard", matches: tiers.wildcard };
  if (tiers.gateway_prefix.length > 0) {
    return { kind: "gateway_prefix", matches: tiers.gateway_prefix, ...(strippedPrefix ? { strippedPrefix } : {}) };
  }
  return null;
}

/** Reason prefix of a DECLARED consumer edge (`jsHttpConsumers`); the only edges tier 3 serves. */
export const HTTP_CONSUMER_REASON_PREFIX = "http consumer (";
