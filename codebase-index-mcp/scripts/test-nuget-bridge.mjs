import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractDotnetProjectData } from "../dist/dotnetProjectParser.js";
import { GraphStore } from "../dist/graphStore.js";
import { toNugetContractId } from "../dist/responseFormatter.js";

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

// ISSUE-CR-001: provider repos rarely declare an explicit <PackageId>. NuGet defaults
// PackageId to AssemblyName, then to the project file name. The provider-side bridge
// symbol must follow that default so the cross-repo bridge resolves for real repos.
function runImplicitPackageIdScenario() {
  const dbPath = createTempDbPath();
  const store = new GraphStore(dbPath);

  const providerRepoId = "repo-provider-implicit";
  const consumerRepoId = "repo-consumer-implicit";

  // Provider .csproj with NO <PackageId> — PackageId defaults to the project file name.
  const providerExtract = extractDotnetProjectData({
    repoId: providerRepoId,
    filePath: "src/SSNet.CommunicationHub.Messaging/SSNet.CommunicationHub.Messaging.csproj",
    language: "csproj",
    source: `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>`
  });

  const exportSymbol = providerExtract.symbols.find((s) => s.signature === "nuget:ssnet.communicationhub.messaging");
  assert(exportSymbol, "Expected an implicit nuget-export symbol derived from the project file name");

  const consumerExtract = extractDotnetProjectData({
    repoId: consumerRepoId,
    filePath: "src/Wec.Be.Api/Wec.Be.Api.csproj",
    language: "csproj",
    source: `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="SSNet.CommunicationHub.Messaging" Version="2.1.0" />
  </ItemGroup>
</Project>`
  });

  store.runInTransaction(() => {
    store.ensureRepository(providerRepoId, process.cwd());
    store.ensureRepository(consumerRepoId, process.cwd());
    store.upsertFile({ repoId: providerRepoId, path: providerExtract.symbols[0].filePath, contentHash: "p", language: "csproj", updatedAt: new Date().toISOString() });
    store.replaceSymbolsForFile(providerRepoId, providerExtract.symbols[0].filePath, providerExtract.symbols);
    store.replaceEdgesForFile(providerRepoId, providerExtract.symbols[0].filePath, providerExtract.edges);
    store.upsertFile({ repoId: consumerRepoId, path: consumerExtract.symbols[0].filePath, contentHash: "c", language: "csproj", updatedAt: new Date().toISOString() });
    store.replaceSymbolsForFile(consumerRepoId, consumerExtract.symbols[0].filePath, consumerExtract.symbols);
    store.replaceEdgesForFile(consumerRepoId, consumerExtract.symbols[0].filePath, consumerExtract.edges);
  });

  store.resolveUnlinkedEdges(consumerRepoId);
  const stats = store.getPackageBridgeStats(consumerRepoId);
  assert.equal(stats.packageResolved, 1, "Expected bridge to resolve against implicit (project-name) PackageId");

  console.log("[ok] NuGet bridge implicit-PackageId scenario passed");
}

// Non-packable projects must not emit a provider bridge symbol — covers the explicit
// IsPackable=false tag, attribute-bearing tags, IsTestProject, and the Microsoft.NET.Test.Sdk
// reference that implies IsPackable=false (ISSUE-CR-001 collision hardening).
function runNonPackableScenario() {
  const cases = [
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>`,
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsPackable Condition="'$(CI)'=='true'">false</IsPackable></PropertyGroup></Project>`,
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>`,
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>`
  ];
  for (const source of cases) {
    const extract = extractDotnetProjectData({
      repoId: "repo-nonpackable",
      filePath: "src/Wec.Be.Tests/Wec.Be.Tests.csproj",
      language: "csproj",
      source
    });
    const exportSymbol = extract.symbols.find((s) => typeof s.signature === "string" && s.signature.startsWith("nuget:"));
    assert(!exportSymbol, `Expected no nuget-export symbol for non-packable project: ${source.slice(0, 60)}`);
  }
  console.log("[ok] NuGet bridge non-packable scenario passed");
}

// ISSUE-CR-001 collision hardening: when two provider repos export the same contract id,
// resolveUnlinkedEdges must resolve to the most complete provider rather than dropping the
// link as ambiguous.
function runContractCollisionTiebreakScenario() {
  const dbPath = createTempDbPath();
  const store = new GraphStore(dbPath);

  const realProviderRepoId = "repo-real-provider";   // larger repo = real package source
  const phantomProviderRepoId = "repo-phantom";       // tiny repo with a colliding project name
  const consumerRepoId = "repo-consumer-collision";

  const mkProvider = (repoId, file) => extractDotnetProjectData({
    repoId, filePath: file, language: "csproj",
    source: `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><PackageId>Acme.Common</PackageId></PropertyGroup></Project>`
  });
  const realProvider = mkProvider(realProviderRepoId, "src/Acme.Common/Acme.Common.csproj");
  const phantomProvider = mkProvider(phantomProviderRepoId, "src/Acme.Common/Acme.Common.csproj");

  const consumer = extractDotnetProjectData({
    repoId: consumerRepoId, filePath: "src/App/App.csproj", language: "csproj",
    source: `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Acme.Common" Version="1.0.0" /></ItemGroup></Project>`
  });

  store.runInTransaction(() => {
    for (const [repoId, extract] of [[realProviderRepoId, realProvider], [phantomProviderRepoId, phantomProvider], [consumerRepoId, consumer]]) {
      store.ensureRepository(repoId, process.cwd());
      const file = extract.symbols[0].filePath;
      store.upsertFile({ repoId, path: file, contentHash: `${repoId}-h`, language: "csproj", updatedAt: new Date().toISOString() });
      store.replaceSymbolsForFile(repoId, file, extract.symbols);
      store.replaceEdgesForFile(repoId, file, extract.edges);
    }
    // Make the real provider repo materially larger so the tiebreak can prefer it.
    const filler = Array.from({ length: 25 }, (_, i) => ({
      repoId: realProviderRepoId,
      symbolId: `filler-${i}`,
      filePath: "src/Acme.Common/Filler.cs",
      name: `Filler${i}`,
      kind: "class",
      line: i + 1
    }));
    store.upsertFile({ repoId: realProviderRepoId, path: "src/Acme.Common/Filler.cs", contentHash: "filler-h", language: "csharp", updatedAt: new Date().toISOString() });
    store.replaceSymbolsForFile(realProviderRepoId, "src/Acme.Common/Filler.cs", filler);
  });

  store.resolveUnlinkedEdges(consumerRepoId);
  const consumers = store.findPackageConsumers("nuget:acme.common", null, 10);
  assert.equal(consumers.length, 1, "Expected the colliding contract to resolve (not be dropped as ambiguous)");
  assert.equal(consumers[0].providerRepoId, realProviderRepoId, "Expected resolution to prefer the most complete provider repo");
  console.log("[ok] NuGet bridge contract-collision tiebreak scenario passed");
}

// ISSUE-CR-002: toNugetContractId must be idempotent — a fully-qualified id must not
// be double-prefixed to nuget:nuget:...
function runIdempotentContractIdScenario() {
  assert.equal(toNugetContractId("SSNet.CommunicationHub.Messaging"), "nuget:ssnet.communicationhub.messaging");
  assert.equal(toNugetContractId("nuget:ssnet.communicationhub.messaging"), "nuget:ssnet.communicationhub.messaging");
  assert.equal(toNugetContractId("nuget:SSNet.CommunicationHub.Messaging"), "nuget:ssnet.communicationhub.messaging");
  assert.equal(toNugetContractId("  nuget: SSNet.CommunicationHub.Messaging  "), "nuget:ssnet.communicationhub.messaging");
  console.log("[ok] toNugetContractId idempotency scenario passed");
}

run();
runImplicitPackageIdScenario();
runNonPackableScenario();
runContractCollisionTiebreakScenario();
runIdempotentContractIdScenario();
