import assert from "node:assert/strict";
import test from "node:test";

import { matchEndpoint, parseEndpointContractId, pickEndpointProviders } from "./endpointMatch.js";

/** R9 (MCP-ISSUE-081): the cross-repo endpoint matcher. The id format itself is unchanged. */

test("exact first; a parameter matches a parameter of any name or constraint", () => {
  assert.deepEqual(matchEndpoint("endpoint:GET:/a/b", "endpoint:GET:/a/b", false), { kind: "exact" });
  assert.deepEqual(matchEndpoint("endpoint:GET:/customers/{id}/history", "endpoint:GET:/customers/{customerid}/history", false), { kind: "wildcard" });
  assert.deepEqual(matchEndpoint("endpoint:GET:/customers/{id}/history", "endpoint:GET:/customers/{id:int}/history", false), { kind: "wildcard" });
  assert.deepEqual(matchEndpoint("endpoint:GET:/customers/{id}", "endpoint:GET:/customers/{id?}", false), { kind: "wildcard" });
});

test("a parameter never matches a literal, the method must agree, and segment counts must agree", () => {
  assert.equal(matchEndpoint("endpoint:GET:/customers/{id}", "endpoint:GET:/customers/global-search", false), null);
  assert.equal(matchEndpoint("endpoint:GET:/customers/global-search", "endpoint:GET:/customers/{id}", false), null);
  assert.equal(matchEndpoint("endpoint:POST:/a/{id}", "endpoint:GET:/a/{id}", false), null);
  assert.equal(matchEndpoint("endpoint:GET:/a/{id}", "endpoint:GET:/a/{id}/b", false), null);
  assert.equal(matchEndpoint("endpoint:GET:/a/{*rest}", "endpoint:GET:/a/{*rest}", false)?.kind, "exact", "string-equal is exact");
  assert.equal(matchEndpoint("endpoint:GET:/a/{x}", "endpoint:GET:/a/{*rest}", false), null, "catch-all is not a one-segment wildcard");
});

test("trailing slash and ASP.NET ~/ are normalised by the matcher, reported as wildcard", () => {
  assert.equal(matchEndpoint("endpoint:GET:/api/x", "endpoint:GET:/api/x/", false)?.kind, "wildcard");
  assert.deepEqual(parseEndpointContractId("endpoint:GET:/customers/~/health"), { method: "GET", segments: ["health"] });
});

test("gateway prefix: only when allowed, at most two literal segments, never a parameter", () => {
  const consumer = "endpoint:GET:/dealer/customers/{id}/history";
  const provider = "endpoint:GET:/customers/{id:int}/history";
  assert.equal(matchEndpoint(consumer, provider, false), null);
  assert.deepEqual(matchEndpoint(consumer, provider, true), { kind: "gateway_prefix", strippedPrefix: "/dealer" });
  assert.deepEqual(matchEndpoint("endpoint:GET:/api/dealer/vehicles/x", "endpoint:GET:/vehicles/x", true), { kind: "gateway_prefix", strippedPrefix: "/api/dealer" });
  assert.equal(matchEndpoint("endpoint:GET:/a/b/c/vehicles/x", "endpoint:GET:/vehicles/x", true), null);
  assert.equal(matchEndpoint("endpoint:GET:/{tenant}/vehicles/x", "endpoint:GET:/vehicles/x", true), null);
});

test("pickEndpointProviders prefers the tightest tier", () => {
  const providers = [
    { contractId: "endpoint:GET:/customers/{id:int}/history", n: 1 },
    { contractId: "endpoint:GET:/dealer/customers/{customerid}/history", n: 2 },
    { contractId: "endpoint:GET:/dealer/customers/{id}/history", n: 3 }
  ];
  assert.deepEqual(pickEndpointProviders("endpoint:GET:/dealer/customers/{id}/history", providers, true)?.matches.map((m) => m.n), [3]);
  assert.deepEqual(pickEndpointProviders("endpoint:GET:/dealer/customers/{x}/history", providers, true)?.matches.map((m) => m.n), [2, 3]);
  const gw = pickEndpointProviders("endpoint:GET:/gw/customers/{x}/history", providers, true);
  assert.equal(gw?.kind, "gateway_prefix");
  assert.deepEqual(gw?.matches.map((m) => m.n), [1]);
  assert.equal(pickEndpointProviders("endpoint:GET:/nothing", providers, true), null);
});

test("gateway tier: the shortest stripped prefix wins (live wec.be: customer history vs CRC call history)", () => {
  const providers = [
    { contractId: "endpoint:GET:/{callid}/history", n: "crc" },
    { contractId: "endpoint:GET:/customers/{id:int}/history", n: "customer" }
  ];
  const picked = pickEndpointProviders("endpoint:GET:/dealer/customers/{id}/history", providers, true);
  assert.equal(picked?.kind, "gateway_prefix");
  assert.equal(picked?.strippedPrefix, "/dealer");
  assert.deepEqual(picked?.matches.map((m) => m.n), ["customer"]);
});
