/**
 * Route template normalization, and the endpoint contract id built from it.
 *
 * The contract id is the join key for cross-repo endpoint impact, which makes its shape a
 * compatibility surface: changing `normalizeEndpointPath` silently unlinks already-indexed
 * repos from each other until both are re-indexed.
 */

import type { RouteRecord } from "../../types/index.js";
import { stripQuotes } from "./extractorPrimitives.js";

export function normalizeEndpointPath(raw: string): string {
  const trimmed = stripQuotes(raw).trim();
  if (!trimmed) {
    return "/";
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.pathname || "/";
    } catch {
      // Keep raw candidate when URL parsing fails.
    }
  }

  const noQuery = candidate.split("?")[0]?.split("#")[0] ?? candidate;
  const normalized = noQuery.replace(/\\/g, "/").replace(/\/{2,}/g, "/").trim();
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash.toLowerCase();
}

/**
 * Structural normalization for a STORED route template: collapse separators and guarantee a single
 * leading slash, preserving case.
 *
 * Distinct from `normalizeEndpointPath`, which lowercases — correct for a contract id, wrong for a
 * template a human reads or matches against a request path, since it would turn `{conversationId}`
 * into `{conversationid}`. MCP-ISSUE-044 reported one payload mixing conventions: templates from one
 * endpoint file had a leading slash and another's did not.
 *
 * Only apply this to a template that IS absolute. A group-relative template whose prefix could not be
 * resolved must stay relative — adding a leading slash would make it masquerade as a real path.
 */
export function normalizeRouteTemplate(template: string): string {
  const collapsed = template.replace(/\\/g, "/").replace(/\/{2,}/g, "/").trim();
  const withLeadingSlash = collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/$/, "") : withLeadingSlash;
}

export function toEndpointContractId(httpMethod: RouteRecord["httpMethod"], routeTemplate: string): string {
  return `endpoint:${httpMethod.toUpperCase()}:${normalizeEndpointPath(routeTemplate)}`;
}

export function normalizeRouteToken(template: string, className: string, methodName: string): string {
  return template
    .replace(/\[controller\]/gi, className.replace(/controller$/i, ""))
    .replace(/\[action\]/gi, methodName);
}

export function combineRouteTemplate(classPrefix: string, methodTemplate: string | null, className: string, methodName: string): string {
  const normalizedClass = normalizeRouteToken(classPrefix, className, methodName);
  if (!methodTemplate) {
    return normalizedClass;
  }
  const normalizedMethod = normalizeRouteToken(methodTemplate, className, methodName);
  const combined = `${normalizedClass}/${normalizedMethod}`.replace(/\/{2,}/g, "/");
  return combined.startsWith("/") ? combined : `/${combined}`;
}

export function dedupeRoutes(routes: RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>();
  const output: RouteRecord[] = [];

  for (const route of routes) {
    const key = `${route.repoId}:${route.httpMethod}:${route.routeTemplate}:${route.handlerSymbolId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(route);
  }

  return output;
}

// ============================================================================
// C# Utilities
// ============================================================================
