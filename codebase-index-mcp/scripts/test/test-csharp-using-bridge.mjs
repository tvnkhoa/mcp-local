import assert from "node:assert";

import { extractGraphData } from "../../dist/extractors/treeSitterExtractor.js";

function run() {
  const source = `
using System;
using SSNet.CommunicationHub.Messaging.Contracts;
using SSNet.CommunicationHub.Messaging.Publishers;

namespace CRM.Core.CommunicationHub.Service;

public class CommunicationHubService
{
}
`;

  const result = extractGraphData({
    repoId: "repo-test",
    filePath: "src/CommunicationHubService.cs",
    language: "csharp",
    source
  });

  const imports = result.edges.filter((e) => e.type === "IMPORTS").map((e) => e.toId);
  const dependsOn = result.edges.filter((e) => e.type === "DEPENDS_ON");

  assert(
    imports.includes("import:SSNet.CommunicationHub.Messaging.Contracts"),
    "Expected IMPORTS edge for SSNet.CommunicationHub.Messaging.Contracts"
  );
  assert(
    imports.includes("import:SSNet.CommunicationHub.Messaging.Publishers"),
    "Expected IMPORTS edge for SSNet.CommunicationHub.Messaging.Publishers"
  );

  const packageBridgeEdges = dependsOn.filter((e) => e.toId === "nuget:ssnet.communicationhub.messaging");
  assert.equal(packageBridgeEdges.length, 1, "Expected deduplicated package bridge DEPENDS_ON edge for CommunicationHub namespace imports");
  assert(packageBridgeEdges.every((e) => e.reason === "namespace package contract bridge"));

  console.log("[ok] C# using package bridge smoke test passed");
}

run();
