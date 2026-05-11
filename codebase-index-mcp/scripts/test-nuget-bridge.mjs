import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractDotnetProjectData } from "../dist/dotnetProjectParser.js";
import { GraphStore } from "../dist/graphStore.js";

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-nuget-bridge-"));
  return path.join(tempDir, "test.db");
}

function run() {
  const dbPath = createTempDbPath();
  const store = new GraphStore(dbPath);

  const providerRepoId = "repo-provider";
  const consumerRepoId = "repo-consumer";

  const providerExtract = extractDotnetProjectData({
    repoId: providerRepoId,
    filePath: "src/SSNet.CommunicationHub.Messaging/SSNet.CommunicationHub.Messaging.csproj",
    language: "csproj",
    source: `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <PackageId>SSNet.CommunicationHub.Messaging</PackageId>
  </PropertyGroup>
</Project>`
  });

  const consumerExtract = extractDotnetProjectData({
    repoId: consumerRepoId,
    filePath: "src/Wec.Be.Api/Wec.Be.Api.csproj",
    language: "csproj",
    source: `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="SSNet.CommunicationHub.Messaging" Version="2.1.0" />
    <PackageReference Include="Some.Unresolved.Package" Version="1.0.0" />
  </ItemGroup>
</Project>`
  });

  const consumerNugetEdge = consumerExtract.edges.find(
    (edge) => edge.type === "DEPENDS_ON" && edge.toId === "nuget:ssnet.communicationhub.messaging"
  );
  assert(consumerNugetEdge, "Expected a DEPENDS_ON edge for SSNet.CommunicationHub.Messaging");

  store.runInTransaction(() => {
    store.ensureRepository(providerRepoId, process.cwd());
    store.ensureRepository(consumerRepoId, process.cwd());

    store.upsertFile({
      repoId: providerRepoId,
      path: "src/SSNet.CommunicationHub.Messaging/SSNet.CommunicationHub.Messaging.csproj",
      contentHash: "provider-hash",
      language: "csproj",
      updatedAt: new Date().toISOString()
    });
    store.replaceSymbolsForFile(providerRepoId, "src/SSNet.CommunicationHub.Messaging/SSNet.CommunicationHub.Messaging.csproj", providerExtract.symbols);
    store.replaceEdgesForFile(providerRepoId, "src/SSNet.CommunicationHub.Messaging/SSNet.CommunicationHub.Messaging.csproj", providerExtract.edges);

    store.upsertFile({
      repoId: consumerRepoId,
      path: "src/Wec.Be.Api/Wec.Be.Api.csproj",
      contentHash: "consumer-hash",
      language: "csproj",
      updatedAt: new Date().toISOString()
    });
    store.replaceSymbolsForFile(consumerRepoId, "src/Wec.Be.Api/Wec.Be.Api.csproj", consumerExtract.symbols);
    store.replaceEdgesForFile(consumerRepoId, "src/Wec.Be.Api/Wec.Be.Api.csproj", consumerExtract.edges);
  });

  const resolutionStats = store.resolveUnlinkedEdges(consumerRepoId);
  assert.equal(resolutionStats.attempts, 2, "Expected two cross-repo resolution attempts for two packages");
  assert.equal(resolutionStats.resolved, 1, "Expected only one nuget contract resolution to succeed");

  const consumerProjectSymbol = consumerExtract.symbols.find((s) => s.filePath.endsWith("Wec.Be.Api.csproj") && s.signature === undefined);
  assert(consumerProjectSymbol, "Expected consumer project module symbol");

  const crossRepoDeps = store.getCrossRepoDeps(consumerRepoId, consumerProjectSymbol.symbolId, 10);
  assert.equal(crossRepoDeps.length, 1, "Expected one cross-repo dependency link");
  assert.equal(crossRepoDeps[0].toRepoId, providerRepoId);

  const packageConsumers = store.findPackageConsumers("nuget:ssnet.communicationhub.messaging", null, 10);
  assert.equal(packageConsumers.length, 1, "Expected one package consumer record");
  assert.equal(packageConsumers[0].consumerRepoId, consumerRepoId);
  assert.equal(packageConsumers[0].providerRepoId, providerRepoId);

  const packageBridgeStats = store.getPackageBridgeStats(consumerRepoId);
  assert.equal(packageBridgeStats.packageAttempts, 2, "Expected two package bridge attempts");
  assert.equal(packageBridgeStats.packageResolved, 1, "Expected one package bridge resolution");
  assert.equal(packageBridgeStats.packageNoCandidate, 1, "Expected one unresolved package bridge candidate");

  console.log("[ok] NuGet bridge resolution smoke test passed");
}

run();
