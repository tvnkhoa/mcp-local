/**
 * Declared HTTP consumers in JavaScript/TypeScript (R9, MCP-ISSUE-081).
 *
 * A route table that calls another system names each endpoint as a STATIC string, so the graph can
 * read it without running anything:
 *
 *     export const get_my_vehicles_route: SourcedRoute = {
 *       method: 'GET',
 *       path: (p) => `/dealer/vehicles/owned-vehicles?CustomerId=${...}`,   // a function: unreadable
 *       source: 'wecrm:GET /dealer/vehicles/owned-vehicles',                 // a literal: read here
 *     }
 *
 * Any object literal with a string-literal `source: '<scheme>:<METHOD> /<path>'` becomes
 * `DEPENDS_ON endpoint:METHOD:/path`. The id is minted by `toEndpointContractId` — the very function
 * the C# controller lane uses — so the two sides cannot drift apart in spelling (lowercased path,
 * one leading slash, parameter segments verbatim). Path-parameter tolerance (`{id}` against
 * `{customerId}` / `{id:int}`) is the matcher's job, not the id's: `services/graph/endpointMatch.ts`.
 *
 * The edge starts life as a token and stays one if no indexed repo serves the endpoint. The reason
 * carries what the impact tools need to describe the consumer without re-reading the file:
 * `http consumer (<scheme>) route=<name> tool=<name>` — `route` is the binding the literal is the
 * value of (the const, or the property key in a table), `tool` a sibling `tool:`/`name:` string or
 * the property key of a table row. Either part is omitted when the literal does not say.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord, RouteRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { findEnclosingSymbolId, makeSymbolId } from "./extractorPrimitives.js";
import { toEndpointContractId } from "./extractorRoutes.js";
import { HTTP_CONSUMER_REASON_PREFIX } from "../graph/endpointMatch.js";

const HTTP_VERBS = new Set<RouteRecord["httpMethod"]>(["GET", "POST", "PUT", "DELETE", "PATCH"]);

/** `<scheme>:<METHOD> /<path>` — scheme is a bare name, METHOD an HTTP verb, path absolute. */
const SOURCE_PATTERN = /^([A-Za-z][A-Za-z0-9_.-]*):([A-Za-z]+)\s+(\/\S*)$/;

/** Wrappers an object literal may sit in before it reaches its declarator or pair. */
const TRANSPARENT_PARENTS = new Set(["satisfies_expression", "as_expression", "parenthesized_expression", "non_null_expression", "type_assertion"]);

/** Confidence of a declared-consumer edge: a literal the author wrote for exactly this purpose. */
export const HTTP_CONSUMER_CONFIDENCE = 0.9;

export type ParsedHttpSource = { scheme: string; method: RouteRecord["httpMethod"]; path: string };

export function parseHttpSource(text: string): ParsedHttpSource | null {
  const match = SOURCE_PATTERN.exec(text.trim());
  if (!match) return null;
  const method = (match[2] ?? "").toUpperCase() as RouteRecord["httpMethod"];
  if (!HTTP_VERBS.has(method)) return null;
  return { scheme: match[1] ?? "", method, path: match[3] ?? "/" };
}

/** A string literal's value, or null for anything computed (a template with `${}` included). */
function staticStringValue(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "string") return node.text.slice(1, -1);
  if (node.type === "template_string") {
    if (node.namedChildren.some((c) => c.type === "template_substitution")) return null;
    return node.text.slice(1, -1);
  }
  return null;
}

function pairKeyName(pair: Parser.SyntaxNode): string | null {
  const key = pair.childForFieldName("key");
  if (!key) return null;
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  if (key.type === "string") return key.text.slice(1, -1);
  return null;
}

/** Walk out of `satisfies` / `as` / parentheses to the node that binds the literal. */
function bindingParent(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current = node.parent;
  while (current && TRANSPARENT_PARENTS.has(current.type)) current = current.parent;
  return current;
}

export function extractJavaScriptHttpConsumers(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Cheap gate: almost no file declares one, and the AST walk below visits every pair.
  if (!/\bsource\s*:/.test(input.source)) return;
  const knownIds = new Set(symbols.map((s) => s.symbolId));

  for (const object of root.descendantsOfType(["object"])) {
    const pairs = object.namedChildren.filter((c) => c.type === "pair");
    const sourcePair = pairs.find((p) => pairKeyName(p) === "source");
    if (!sourcePair) continue;
    const parsed = parseHttpSource(staticStringValue(sourcePair.childForFieldName("value")) ?? "");
    if (!parsed) continue;

    const sibling = (name: string): string | null => {
      const pair = pairs.find((p) => pairKeyName(p) === name);
      return pair ? staticStringValue(pair.childForFieldName("value")) : null;
    };

    let route: string | null = null;
    let tool: string | null = sibling("tool") ?? sibling("name");
    let fromId: string | null = null;

    const binder = bindingParent(object);
    if (binder?.type === "variable_declarator") {
      const nameNode = binder.childForFieldName("name");
      const declaration = binder.parent;
      if (nameNode?.type === "identifier" && declaration) {
        route = nameNode.text;
        // `jsSymbols` registers an exported const as `variable`, keyed on the declaration's row.
        const candidate = makeSymbolId(input, "variable", nameNode.text, declaration.startPosition.row);
        if (knownIds.has(candidate)) fromId = candidate;
      }
    } else if (binder?.type === "pair") {
      // A row of an inline table: `ROUTES = { get_my_vehicles: { source: ... } }`.
      route = pairKeyName(binder);
      tool ??= route;
      // The table's own binding, when it is a registered symbol.
      const tableDeclarator = bindingParent(binder.parent ?? binder);
      const tableName = tableDeclarator?.type === "variable_declarator" ? tableDeclarator.childForFieldName("name") : null;
      const tableDeclaration = tableDeclarator?.parent;
      if (tableName?.type === "identifier" && tableDeclaration) {
        const candidate = makeSymbolId(input, "variable", tableName.text, tableDeclaration.startPosition.row);
        if (knownIds.has(candidate)) fromId = candidate;
      }
    }
    fromId ??= findEnclosingSymbolId(object, input) ?? moduleSymbolId;

    // The reason is parsed back by `parseHttpConsumerReason`, so a name may not carry whitespace.
    const token = (value: string): string => value.trim().replace(/\s+/g, "_");
    const reasonParts = [`${HTTP_CONSUMER_REASON_PREFIX}${parsed.scheme})`];
    if (route) reasonParts.push(`route=${token(route)}`);
    if (tool) reasonParts.push(`tool=${token(tool)}`);

    edges.push({
      repoId: input.repoId,
      fromId,
      toId: toEndpointContractId(parsed.method, parsed.path),
      type: "DEPENDS_ON",
      confidence: HTTP_CONSUMER_CONFIDENCE,
      reason: reasonParts.join(" ")
    });
  }
}

/** Read `route=` / `tool=` / the scheme back out of a consumer edge's reason. */
export function parseHttpConsumerReason(reason: string | null | undefined): { scheme: string; route?: string; tool?: string } | null {
  if (!reason || !reason.startsWith(HTTP_CONSUMER_REASON_PREFIX)) return null;
  const scheme = /^http consumer \(([^)]*)\)/.exec(reason)?.[1] ?? "";
  const route = /\broute=(\S+)/.exec(reason)?.[1];
  const tool = /\btool=(\S+)/.exec(reason)?.[1];
  return { scheme, ...(route ? { route } : {}), ...(tool ? { tool } : {}) };
}
