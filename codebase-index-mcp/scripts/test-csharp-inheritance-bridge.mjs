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

run();
