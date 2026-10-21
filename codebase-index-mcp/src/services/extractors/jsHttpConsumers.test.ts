import assert from "node:assert/strict";
import test from "node:test";

import { extractGraphData } from "./treeSitterExtractor.js";
import { parseHttpConsumerReason, parseHttpSource } from "./jsHttpConsumers.js";

/**
 * R9 (MCP-ISSUE-081), extractor level: declared `source: 'scheme:METHOD /path'` literals in TS/JS
 * become `DEPENDS_ON endpoint:` edges whose id is the one the C# controller lane mints. Matching
 * across repos is `endpointMatch.test.ts`; end to end over MCP stdio is `test-http-consumers`.
 */

const ts = (source: string, filePath = "src/routes.ts") => extractGraphData({ repoId: "aria", filePath, language: "typescript", source });
const consumerEdges = (out: ReturnType<typeof ts>) => out.edges.filter((e) => e.type === "DEPENDS_ON" && e.toId.startsWith("endpoint:"));

const ROUTES = `
import type { SourcedRoute } from './route.js'
export const get_my_vehicles_route: SourcedRoute = {
  method: 'GET',
  path: (p) => \`/dealer/vehicles/owned-vehicles?CustomerId=\${String(p.id)}\`,
  source: 'wecrm:GET /dealer/vehicles/owned-vehicles',
}
export const find_customer_route = {
  method: 'GET',
  path: () => '/dealer/customers/global-search',
  source: 'wecrm:GET /dealer/customers/global-search',
} satisfies SourcedRoute
export const get_my_appointments_route: SourcedRoute = {
  method: 'GET',
  path: (p) => \`/dealer/customers/\${String(p.id)}/history\`,
  source: 'wecrm:GET /dealer/customers/{id}/history',
}
`;

test("template-typed sources: one edge per route, from the route const, with the scheme in the reason", () => {
  const out = ts(ROUTES);
  const edges = consumerEdges(out);
  assert.deepEqual(edges.map((e) => e.toId).sort(), [
    "endpoint:GET:/dealer/customers/global-search",
    "endpoint:GET:/dealer/customers/{id}/history",
    "endpoint:GET:/dealer/vehicles/owned-vehicles"
  ]);
  for (const edge of edges) {
    const from = out.symbols.find((s) => s.symbolId === edge.fromId);
    assert.ok(from, `fromId ${edge.fromId} must be a registered symbol`);
    assert.equal(from.kind, "variable");
    assert.match(edge.reason ?? "", new RegExp(`^http consumer \\(wecrm\\) route=${from.name}$`));
    assert.equal(edge.confidence, 0.9);
  }
});

test("a route with no source, a computed source, or a non-HTTP verb emits nothing", () => {
  const out = ts(`
export const probe = { method: 'GET', path: () => '/x' }
const dynamic = { source: \`wecrm:GET /x/\${id}\` }
export const notHttp = { source: 'wecrm:FETCH /x' }
export const notAbsolute = { source: 'wecrm:GET x/y' }
export const label = { source: 'the docs say so' }
`);
  assert.deepEqual(consumerEdges(out), []);
});

test("an inline table row: the property key is the route and the tool; a sibling tool: wins", () => {
  const out = ts(`
export const ROUTES = {
  get_my_vehicles: { method: 'GET', source: 'crm:GET /vehicles/owned-vehicles' },
  find: { tool: 'find_customer', source: 'crm:POST /customers/search' },
}
`);
  const edges = consumerEdges(out).sort((a, b) => a.toId.localeCompare(b.toId));
  const table = out.symbols.find((s) => s.name === "ROUTES");
  assert.ok(table);
  assert.deepEqual(edges.map((e) => [e.toId, e.fromId === table.symbolId, e.reason]), [
    ["endpoint:GET:/vehicles/owned-vehicles", true, "http consumer (crm) route=get_my_vehicles tool=get_my_vehicles"],
    ["endpoint:POST:/customers/search", true, "http consumer (crm) route=find tool=find_customer"]
  ]);
});

test("id parity: the consumer id equals the C# controller lane's id for the same route", () => {
  const cs = extractGraphData({
    repoId: "be",
    filePath: "Controllers/CustomerController.cs",
    language: "csharp",
    source: `
using Microsoft.AspNetCore.Mvc;
namespace Be;
[Route("Dealer/Customers")]
public class CustomerController : ControllerBase
{
    [HttpGet("Global-Search")]
    public IActionResult Search() { return Ok(); }
    [HttpGet("{id}/history")]
    public IActionResult History(int id) { return Ok(); }
}
`
  });
  const providerIds = cs.symbols.map((s) => s.signature ?? "").filter((s) => s.startsWith("endpoint:")).sort();
  assert.deepEqual(providerIds, ["endpoint:GET:/dealer/customers/global-search", "endpoint:GET:/dealer/customers/{id}/history"]);
  const consumerIds = consumerEdges(ts(ROUTES)).map((e) => e.toId);
  for (const id of providerIds) assert.ok(consumerIds.includes(id), `${id} minted identically on both sides`);
});

test("parseHttpSource / parseHttpConsumerReason", () => {
  assert.deepEqual(parseHttpSource("wecrm:get /a/{id}"), { scheme: "wecrm", method: "GET", path: "/a/{id}" });
  assert.equal(parseHttpSource("wecrm:GET"), null);
  assert.equal(parseHttpSource(":GET /a"), null);
  assert.deepEqual(parseHttpConsumerReason("http consumer (wecrm) route=r tool=t"), { scheme: "wecrm", route: "r", tool: "t" });
  assert.deepEqual(parseHttpConsumerReason("http consumer (wecrm)"), { scheme: "wecrm" });
  assert.equal(parseHttpConsumerReason("http endpoint contract"), null);
});
