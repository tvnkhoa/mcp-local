/**
 * Route template normalization, and the endpoint contract id built from it.
 *
 * The contract id is the join key for cross-repo endpoint impact, which makes its shape a
 * compatibility surface: changing `normalizeEndpointPath` silently unlinks already-indexed
 * repos from each other until both are re-indexed.
 */

import type { RouteRecord } from "../types.js";
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
