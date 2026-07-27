import assert from "node:assert";

import { GraphStore } from "../../dist/graphStore.js";
import { extractGraphData } from "../../dist/treeSitterExtractor.js";
import { makeTempDbPath } from "./_fixtures.mjs";

function run() {
  const dbPath = makeTempDbPath("cbi-endpoint-bridge-");
  const store = new GraphStore(dbPath);
  try {

  const providerRepoId = "repo-provider-api";
  const consumerRepoId = "repo-consumer-client";

  const providerFilePath = "src/Controllers/MessagesController.cs";
  const consumerFilePath = "src/Clients/MessageClient.cs";

  const providerSource = `
using Microsoft.AspNetCore.Mvc;

namespace Provider.Api.Controllers;

[ApiController]
[Route("api/messages")]
public class MessagesController : ControllerBase
{
  [HttpGet("search")]
  public IActionResult Search()
    {
    return Ok();
    }
}
`;

  const consumerSource = `
using System.Net.Http;
using System.Threading.Tasks;

namespace Consumer.Client;

public class MessageClient
{
    private readonly HttpClient _httpClient;

    public MessageClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<HttpResponseMessage> GetMessage()
    {
      return await _httpClient.GetAsync("/api/messages/search");
    }
}
`;

  const providerExtract = extractGraphData({
    repoId: providerRepoId,
    filePath: providerFilePath,
    language: "csharp",
    source: providerSource
  });

  const consumerExtract = extractGraphData({
    repoId: consumerRepoId,
    filePath: consumerFilePath,
    language: "csharp",
    source: consumerSource
  });

  const providerContractSymbol = providerExtract.symbols.find((s) => s.signature === "endpoint:GET:/api/messages/search");
  assert(providerContractSymbol, "Expected provider endpoint contract symbol to be emitted");

  const consumerEndpointEdge = consumerExtract.edges.find(
    (e) => e.type === "DEPENDS_ON" && e.toId === "endpoint:GET:/api/messages/search"
  );
  assert(consumerEndpointEdge, "Expected consumer endpoint DEPENDS_ON edge");

  store.runInTransaction(() => {
    store.ensureRepository(providerRepoId, process.cwd());
    store.ensureRepository(consumerRepoId, process.cwd());

    store.upsertFile({
      repoId: providerRepoId,
      path: providerFilePath,
      contentHash: "provider-hash",
      language: "csharp",
      updatedAt: new Date().toISOString()
    });
    store.replaceSymbolsForFile(providerRepoId, providerFilePath, providerExtract.symbols);
    store.replaceEdgesForFile(providerRepoId, providerFilePath, providerExtract.edges);
    store.replaceRoutesForFile(providerRepoId, providerFilePath, providerExtract.routes ?? []);

    store.upsertFile({
      repoId: consumerRepoId,
      path: consumerFilePath,
      contentHash: "consumer-hash",
      language: "csharp",
      updatedAt: new Date().toISOString()
    });
    store.replaceSymbolsForFile(consumerRepoId, consumerFilePath, consumerExtract.symbols);
    store.replaceEdgesForFile(consumerRepoId, consumerFilePath, consumerExtract.edges);
    store.replaceRoutesForFile(consumerRepoId, consumerFilePath, consumerExtract.routes ?? []);
  });

  const resolutionStats = store.resolveUnlinkedEdges(consumerRepoId);
  assert.equal(resolutionStats.attempts >= 1, true, "Expected at least one cross-repo resolution attempt");
  assert.equal(resolutionStats.resolved >= 1, true, "Expected endpoint contract resolution to succeed");

  const consumerMethodSymbol = consumerExtract.symbols.find((s) => s.kind === "method" && s.name === "GetMessage");
  assert(consumerMethodSymbol, "Expected consumer method symbol");

  const crossDeps = store.getCrossRepoDeps(consumerRepoId, consumerMethodSymbol.symbolId, 20);
  const endpointLink = crossDeps.find((d) => d.toRepoId === providerRepoId && d.type === "DEPENDS_ON");
  assert(endpointLink, "Expected cross-repo endpoint link from consumer method to provider endpoint symbol");

    console.log("[ok] Endpoint bridge resolution smoke test passed");
  } finally {
    store.close();
  }
}

run();
