import assert from "node:assert";

import { extractGraphData } from "../dist/treeSitterExtractor.js";

function run() {
  const source = `
namespace CRM.CommunicationHub.Service;

public interface ICommunicationHubService {}

public class BaseService {}

public class CommunicationHubService : BaseService, ICommunicationHubService
{
}
`;

  const result = extractGraphData({
    repoId: "repo-test",
    filePath: "src/CommunicationHubService.cs",
    language: "csharp",
    source
  });

  const implementsToIds = result.edges
    .filter((e) => e.type === "IMPLEMENTS")
    .map((e) => e.toId);

  const interfaceSymbol = result.symbols.find(
    (s) => s.kind === "interface" && s.name === "ICommunicationHubService"
  );
  assert(interfaceSymbol, "Expected interface symbol ICommunicationHubService");

  assert(
    implementsToIds.includes(interfaceSymbol.symbolId) || implementsToIds.includes("iface:ICommunicationHubService"),
    "Expected IMPLEMENTS edge for ICommunicationHubService"
  );
  assert(
    !implementsToIds.includes("iface:BaseService"),
    "Did not expect IMPLEMENTS iface edge for BaseService"
  );

  const typeRefToIds = result.edges
    .filter((e) => e.type === "TYPE_REF")
    .map((e) => e.toId);

  const baseClassSymbol = result.symbols.find((s) => s.kind === "class" && s.name === "BaseService");
  assert(baseClassSymbol, "Expected class symbol BaseService");

  assert(
    typeRefToIds.includes(baseClassSymbol.symbolId) || typeRefToIds.includes("type:BaseService"),
    "Expected TYPE_REF edge for BaseService inheritance"
  );

  console.log("[ok] C# inheritance bridge smoke test passed");
}

// ISSUE-013: C# `record` / `record struct` request types must emit IMPLEMENTS
// edges for every marker interface in a multi-item base list (the dominant
// CQRS/MediatR shape). Before the fix, the IMPLEMENTS extraction only ran for
// class/struct declarations, so find_implementations was blind to records.
function runRecords() {
  const source = `
namespace App.Features;

public interface IRequest<T> {}
public interface ITenantScopedRequest {}
public interface IAgentScopedRequest {}
public class Result<T> {}
public class ThingDto {}

public record GetThing(int Id)
  : IRequest<Result<ThingDto>>, ITenantScopedRequest, IAgentScopedRequest;

public record struct GetThingStruct(int Id)
  : IRequest<Result<ThingDto>>, ITenantScopedRequest;
`;

  const result = extractGraphData({
    repoId: "repo-test",
    filePath: "src/GetThing.cs",
    language: "csharp",
    source
  });

  const implementsToIds = result.edges
    .filter((e) => e.type === "IMPLEMENTS")
    .map((e) => e.toId);

  // Marker interfaces are declared in-file, so IMPLEMENTS edges may resolve to the
  // interface symbolId; accept either the resolved id or the `iface:` placeholder.
  const ifaceMatches = (name) => {
    const sym = result.symbols.find((s) => s.kind === "interface" && s.name === name);
    return implementsToIds.filter((id) => id === `iface:${name}` || (sym && id === sym.symbolId));
  };

  // record GetThing implements all three markers
  for (const iface of ["IRequest", "ITenantScopedRequest", "IAgentScopedRequest"]) {
    assert(
      ifaceMatches(iface).length >= 1,
      `Expected record IMPLEMENTS edge for ${iface} (got: ${JSON.stringify(implementsToIds)})`
    );
  }

  // nested-generic strip must yield a clean token, not a partial like `IRequest<Result`
  assert(
    !implementsToIds.some((id) => id.includes("<") || id.includes("Result")),
    `Generic args must be stripped from IMPLEMENTS token (got: ${JSON.stringify(implementsToIds)})`
  );

  // record struct also emits IMPLEMENTS (single record_declaration node covers it):
  // ITenantScopedRequest is implemented by BOTH GetThing and GetThingStruct.
  assert(
    ifaceMatches("ITenantScopedRequest").length >= 2,
    "Expected `record struct` to also emit IMPLEMENTS for ITenantScopedRequest"
  );

  console.log("[ok] C# record inheritance bridge smoke test passed");
}

run();
runRecords();
