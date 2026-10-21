/**
 * R9 (MCP-ISSUE-081) — declared JS/TS HTTP consumers linked to ASP.NET controller actions in another
 * repo, end to end over real MCP stdio, both repos in ONE index.
 *
 * Fixture pair (plain-walk, not git repos):
 *   be/   (C#)  CustomerController [Route("dealer/customers")]: global-search, {customerId}/history;
 *               VehicleController  [Route("dealer/vehicles")]:  owned-vehicles;
 *               OrderController    [Route("orders")]:           {id:int}  (reached through a gateway prefix).
 *   aria/ (TS)  a wecrm-routes-like module: three `SourcedRoute` consts in their own files (one with
 *               an `{id}` segment), a routing table binding them to tool names in another file, an
 *               inline table row with a `tool:` sibling (the gateway case), and one source no repo serves.
 *
 * Index order matters and is part of the contract: cross-repo links are written by the CONSUMER's
 * run, so `be` is indexed first.
 *
 * Asserts: get_cross_repo_impact(inbound) from each C# action — by symbol and by file — lists the TS
 * route, its file:line and its tool, with the match kind (exact / wildcard / gateway_prefix); the
 * unmatched source stays a labelled `endpoint:` token counted as no_candidate; outbound from a route
 * const reaches the action's contract; a wrong-direction query says so.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return { error: txt(r) }; } };
const DEBUG = process.env.HTTP_CONSUMERS_HARNESS_DEBUG === "1";
const dump = (label, v) => { if (DEBUG) console.log(`--- ${label}\n${JSON.stringify(v, null, 1)?.slice(0, 4000)}`); };

const tmpDir = makeTempDir("http-consumers-");
const beDir = join(tmpDir, "be");
const ariaDir = join(tmpDir, "aria");
const stamp = Date.now();
const beId = `be-${stamp}`;
const ariaId = `aria-${stamp}`;

const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
};

write(beDir, {
  "src/Customer.Api/Controllers/CustomerController.cs": `using Microsoft.AspNetCore.Mvc;

namespace Customer.Api.Controllers
{
    [Route("dealer/customers")]
    public class CustomerController : ControllerBase
    {
        [HttpGet("global-search")]
        public IActionResult SearchCustomerGlobal(string q)
        {
            return Ok();
        }

        [HttpGet("{customerId}/history")]
        public IActionResult GetHistory(int customerId)
        {
            return Ok();
        }

        [HttpGet("{customerId}/notes")]
        public IActionResult GetNotes(int customerId)
        {
            return Ok();
        }
    }
}
`,
  "src/Customer.Api/Controllers/VehicleController.cs": `using Microsoft.AspNetCore.Mvc;

namespace Customer.Api.Controllers
{
    [Route("dealer/vehicles")]
    public class VehicleController : ControllerBase
    {
        [HttpGet("owned-vehicles")]
        public IActionResult GetOwnedVehicles(int customerId)
        {
            return Ok();
        }
    }
}
`,
  // Release G.1: the action's name is also declared by an interface and a service (wec.be's
  // GetListOwnedVehicle has three declarations), and two plain classes share a routeless name.
  "src/Customer.Api/Services/IVehicleService.cs": `namespace Customer.Api.Services
{
    public interface IVehicleService
    {
        object GetOwnedVehicles(int customerId);
    }
}
`,
  "src/Customer.Api/Services/VehicleService.cs": `namespace Customer.Api.Services
{
    public class VehicleService : IVehicleService
    {
        public object GetOwnedVehicles(int customerId)
        {
            return null;
        }
    }
}
`,
  "src/Customer.Api/Services/Recalc.cs": `namespace Customer.Api.Services
{
    public class PriceRecalc
    {
        public void Recompute() { }
    }

    public class StockRecalc
    {
        public void Recompute() { }
    }
}
`,
  "src/Order.Api/Controllers/OrderController.cs": `using Microsoft.AspNetCore.Mvc;

namespace Order.Api.Controllers
{
    [Route("orders")]
    public class OrderController : ControllerBase
    {
        [HttpGet("{id:int}")]
        public IActionResult GetOrder(int id)
        {
            return Ok();
        }
    }
}
`,
  // A decoy for the gateway tier: '/shop/orders/{id}' minus TWO segments is '/{id}', which this
  // matches; the one-segment strip (OrderController) must win, as on live wec.be (CRC '/{callId}/history').
  "src/Pages.Api/Controllers/PageController.cs": `using Microsoft.AspNetCore.Mvc;

namespace Pages.Api.Controllers
{
    public class PageController : ControllerBase
    {
        [HttpGet("{slug}")]
        public IActionResult GetPage(string slug)
        {
            return Ok();
        }
    }
}
`
});

write(ariaDir, {
  "src/mcp/route.ts": `export type Route = {
  readonly method: 'GET' | 'POST'
  readonly path: (payload: Readonly<Record<string, unknown>>) => string
  readonly source?: string
}
export type SourcedRoute = Route & { readonly source: \`wecrm:\${Route['method']} /\${string}\` }
`,
  "src/mcp/vehicles.ts": `import type { SourcedRoute } from './route.js'

export const get_my_vehicles_route: SourcedRoute = {
  method: 'GET',
  path: (p) => \`/dealer/vehicles/owned-vehicles?CustomerId=\${String(p.customerId)}\`,
  source: 'wecrm:GET /dealer/vehicles/owned-vehicles',
}
`,
  "src/mcp/customers.ts": `import type { SourcedRoute } from './route.js'

// a comment line first, so the route sits on line 4
export const find_customer_route: SourcedRoute = {
  method: 'GET',
  path: (p) => \`/dealer/customers/global-search?q=\${String(p.q)}\`,
  source: 'wecrm:GET /dealer/customers/global-search',
}
`,
  "src/mcp/appointments.ts": `import type { SourcedRoute } from './route.js'

export const get_my_appointments_route: SourcedRoute = {
  method: 'GET',
  path: (p) => \`/dealer/customers/\${String(p.customerId)}/history\`,
  source: 'wecrm:GET /dealer/customers/{id}/history',
}
`,
  "src/mcp/wecrm-routes.ts": `import type { SourcedRoute } from './route.js'
import { find_customer_route } from './customers.js'
import { get_my_appointments_route } from './appointments.js'
import { get_my_vehicles_route } from './vehicles.js'

export const ROUTES: Readonly<Record<string, SourcedRoute>> = {
  get_my_vehicles: get_my_vehicles_route,
  get_my_appointments: get_my_appointments_route,
  find_customer: find_customer_route,
}
`,
  "src/mcp/extra.ts": `export const EXTRA_ROUTES = {
  order_lookup: { tool: 'get_order', method: 'GET', source: 'wecrm:GET /shop/orders/{id}' },
  create_task: { method: 'POST', source: 'wecrm:POST /dealer/tasks' },
}
`
});

const dbPath = join(tmpDir, "index.db");
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: `${beDir},${ariaDir}`, CODEBASE_INDEX_DB_PATH: dbPath, CODEBASE_INDEX_LLM_ENABLED: "false", CODEBASE_INDEX_LARGE_REPO_PROFILE: "standard" },
  stderr: "pipe"
});
const client = new Client({ name: "http-consumers", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-http-consumers");
const call = async (name, args) => js(await client.callTool({ name, arguments: args }));
const direct = (sql, params = {}) => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(params); } finally { db.close(); }
};
const methodId = (name) => direct("select symbol_id as id from symbols where repo_id = :r and kind = 'method' and name = :n", { r: beId, n: name })[0]?.id;

const EXPECT = [
  { action: "GetOwnedVehicles", file: "src/Customer.Api/Controllers/VehicleController.cs", route: "get_my_vehicles_route", routeFile: "src/mcp/vehicles.ts", line: 3, tool: "get_my_vehicles", toolSource: "routing_table", kind: "exact" },
  { action: "SearchCustomerGlobal", file: "src/Customer.Api/Controllers/CustomerController.cs", route: "find_customer_route", routeFile: "src/mcp/customers.ts", line: 4, tool: "find_customer", toolSource: "routing_table", kind: "exact" },
  { action: "GetHistory", file: "src/Customer.Api/Controllers/CustomerController.cs", route: "get_my_appointments_route", routeFile: "src/mcp/appointments.ts", line: 3, tool: "get_my_appointments", toolSource: "routing_table", kind: "wildcard" },
  { action: "GetOrder", file: "src/Order.Api/Controllers/OrderController.cs", route: "EXTRA_ROUTES", routeFile: "src/mcp/extra.ts", line: 1, tool: "get_order", toolSource: "declared", kind: "gateway_prefix" }
];

try {
  // Provider first: links are written by the consumer's run.
  const be = await call("index_repository", { repoId: beId, repoPath: beDir, mode: "full" });
  assert(be && !be.error && (be.parseFailures ?? 0) === 0, "index be (C#) — no parse failures", JSON.stringify(be)?.slice(0, 300));
  const aria = await call("index_repository", { repoId: ariaId, repoPath: ariaDir, mode: "full" });
  dump("aria index", aria);
  assert(aria && !aria.error && (aria.parseFailures ?? 0) === 0, "index aria (TS) — no parse failures", JSON.stringify(aria)?.slice(0, 300));

  const consumerEdges = direct(`select s.name, s.file_path as f, s.line, e.to_id as toId, e.reason, e.confidence
    from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    where e.repo_id = :r and e.type = 'DEPENDS_ON' and e.to_id like 'endpoint:%' order by e.to_id`, { r: ariaId });
  dump("consumer edges", consumerEdges);
  assert(consumerEdges.length === 5, "five declared consumer edges, every fromId a real symbol", JSON.stringify(consumerEdges));
  assert(consumerEdges.some((e) => e.toId === "endpoint:GET:/dealer/customers/{id}/history" && e.name === "get_my_appointments_route" && e.reason === "http consumer (wecrm) route=get_my_appointments_route"),
    "the {id} route keeps its token verbatim and names its route in the reason");

  for (const x of EXPECT) {
    const id = methodId(x.action);
    assert(Boolean(id), `${x.action}: C# action symbol exists`);
    const r = await call("get_cross_repo_impact", { repoId: beId, symbolId: id, direction: "inbound" });
    dump(`impact ${x.action}`, r);
    const hit = (r?.impacts ?? []).find((i) => i.fromRepoId === ariaId);
    assert(Boolean(hit), `${x.action}: inbound lists the aria consumer`, JSON.stringify(r)?.slice(0, 400));
    if (!hit) continue;
    assert(hit.relatedName === x.route && hit.relatedFilePath === x.routeFile && hit.relatedLine === x.line,
      `${x.action}: consumer is ${x.route} at ${x.routeFile}:${x.line}`, `${hit.relatedName} ${hit.relatedFilePath}:${hit.relatedLine}`);
    assert(hit.endpoint?.tool === x.tool && hit.endpoint?.toolSource === x.toolSource,
      `${x.action}: tool ${x.tool} (${x.toolSource})`, JSON.stringify(hit.endpoint));
    assert(hit.endpoint?.matchKind === x.kind && hit.contractType === "endpoint",
      `${x.action}: match kind ${x.kind}`, JSON.stringify(hit.endpoint));
    if (x.kind === "gateway_prefix") assert(hit.endpoint?.strippedPrefix === "/shop", `${x.action}: the stripped gateway prefix is reported`);
    if (x.toolSource === "routing_table") {
      assert(/^src\/mcp\/wecrm-routes\.ts:\d+$/.test(hit.endpoint?.toolDeclaredAt ?? ""), `${x.action}: tool binding located in the routing table`, hit.endpoint?.toolDeclaredAt);
    }
  }

  // An action nobody calls: no rows, and no false link via its sibling's {customerId}.
  const notes = await call("get_cross_repo_impact", { repoId: beId, symbolId: methodId("GetNotes"), direction: "inbound" });
  assert(notes?.impactCount === 0, "GetNotes ({customerId}/notes) has no consumer — the wildcard binds parameters only", JSON.stringify(notes)?.slice(0, 300));

  // Release G.1: a NAME shared by an interface, a service and a controller action answers through the
  // action (the one carrying an endpoint contract), says how it picked, and never a bare 0.
  const byName = await call("get_cross_repo_impact", { repoId: beId, name: "GetOwnedVehicles", direction: "inbound" });
  assert(byName?.symbol?.filePath?.replace(/\\/g, "/") === "src/Customer.Api/Controllers/VehicleController.cs" && byName?.impactCount === 1
    && byName?.nameResolution?.pickedBy === "only_endpoint_carrier" && byName.nameResolution.candidates?.length === 3,
    "by name: the controller action is picked over the interface and service, with the 3 candidates listed", JSON.stringify(byName)?.slice(0, 600));
  const amb = await call("get_cross_repo_impact", { repoId: beId, name: "Recompute", direction: "inbound" });
  assert(amb?.status === "ambiguous" && (amb?.impactCount ?? null) === null && amb?.candidates?.length === 2 && amb.candidates.every((c) => c.symbolId && c.filePath && c.line && Array.isArray(c.endpointContracts)),
    "by name with two routeless declarations: ambiguous with both candidates, no count", JSON.stringify(amb)?.slice(0, 500));

  // File-level query.
  const byFile = await call("get_cross_repo_impact", { repoId: beId, filePath: "src/Customer.Api/Controllers/CustomerController.cs", direction: "inbound" });
  dump("by file", byFile);
  const fileRoutes = new Set((byFile?.impacts ?? []).map((i) => i.relatedName));
  assert(fileRoutes.has("find_customer_route") && fileRoutes.has("get_my_appointments_route") && byFile.impactCount === 2,
    "by file: CustomerController lists both of its consumers", JSON.stringify(byFile)?.slice(0, 400));

  // Wrong direction says so.
  const outbound = await call("get_cross_repo_impact", { repoId: beId, symbolId: methodId("GetHistory"), direction: "outbound" });
  assert(outbound?.impactCount === 0 && /inbound/.test(outbound?.hint ?? ""), "outbound on a provider action hints at direction:'inbound'", JSON.stringify(outbound)?.slice(0, 300));

  // Outbound from the consumer side.
  const routeSym = direct("select symbol_id as id from symbols where repo_id = :r and name = 'get_my_appointments_route'", { r: ariaId })[0]?.id;
  const fromAria = await call("get_cross_repo_impact", { repoId: ariaId, symbolId: routeSym, direction: "outbound" });
  dump("outbound aria", fromAria);
  const out = fromAria?.impacts?.[0];
  assert(fromAria?.impactCount === 1 && out?.toRepoId === beId && out?.relatedSignature === "endpoint:GET:/dealer/customers/{customerid}/history"
    && out?.resolutionReason === "endpoint_contract_wildcard_match" && out?.endpoint?.tool === "get_my_appointments",
    "outbound from the route const reaches the wildcard-matched action contract, with its tool", JSON.stringify(fromAria)?.slice(0, 500));

  // The unmatched source: a labelled token, counted.
  const unmatched = direct("select reason from edges where repo_id = :r and to_id = 'endpoint:POST:/dealer/tasks'", { r: ariaId });
  assert(unmatched.length === 1 && unmatched[0].reason === "http consumer (wecrm) route=create_task tool=create_task", "an unmatched source stays a labelled endpoint: token", JSON.stringify(unmatched));
  const links = direct("select count(*) as n from cross_repo_deps where from_repo_id = :r", { r: ariaId })[0]?.n;
  assert(links === 4, "exactly four cross-repo links from aria (the unmatched one is not linked)", String(links));
  const run = direct("select cross_repo_attempts as a, cross_repo_resolved as res, unresolved_no_candidate as nc from index_runs where repo_id = :r order by finished_at desc limit 1", { r: ariaId })[0];
  assert(run && run.res === 4 && run.nc >= 1 && run.a >= 5, "index_runs counts 4 resolved and the unmatched one as no_candidate", JSON.stringify(run));

  // Re-running the consumer does not duplicate or lose links.
  const again = await call("index_repository", { repoId: ariaId, repoPath: ariaDir, mode: "full" });
  assert(again && !again.error, "re-index aria (full)");
  const links2 = direct("select count(*) as n from cross_repo_deps where from_repo_id = :r", { r: ariaId })[0]?.n;
  assert(links2 === 4, "a second full run lands on the same four links", String(links2));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
