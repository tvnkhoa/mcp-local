/**
 * HTTP route registrations in JavaScript/TypeScript.
 *
 * Still a regex over the source rather than an AST walk, and still limited to a direct
 * `app|router|fastify.VERB("/path", handler)` call. What it does NOT read is recorded in
 * `route_map`'s empty-result hint so a caller is not misled about the coverage: decorator routing
 * (NestJS), file-based routing (Next.js/Remix), prefix mounting via `app.use(prefix, router)` or
 * `fastify.register(plugin, { prefix })`, and the all/head/options verbs.
 */

import type { RouteRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { dedupeRoutes, findSymbolIdByName, lineFromOffset } from "./extractorUtils.js";

export function extractJavaScriptRoutesImpl(
  input: ExtractInput,
  symbols: SymbolRecord[],
  moduleSymbolId: string
): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const routeRegex = /\b(app|router|fastify)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(["'`])([^"'`]+)\3\s*(?:,\s*([A-Za-z_$][A-Za-z0-9_$]*))?/gi;

  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(input.source)) !== null) {
    const method = (match[2] ?? "").toUpperCase() as RouteRecord["httpMethod"];
    const template = match[4] ?? "/";
    const handlerName = match[5] ?? "";
    const line = lineFromOffset(input.source, match.index);
    const handlerSymbolId = handlerName ? (findSymbolIdByName(symbols, handlerName) ?? moduleSymbolId) : moduleSymbolId;

    routes.push({
      repoId: input.repoId,
      filePath: input.filePath,
      controllerSymbolId: moduleSymbolId,
      handlerSymbolId,
      // MCP-ISSUE-055: the name as written at the registration site, kept even when unresolved.
      handlerName: handlerName.length > 0 ? handlerName : null,
      httpMethod: method,
      routeTemplate: template.startsWith("/") ? template : `/${template}`,
      line
    });
  }

  return dedupeRoutes(routes);
}
