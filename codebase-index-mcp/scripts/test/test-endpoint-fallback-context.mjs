import assert from "node:assert";

import { extractGraphData } from "../../dist/extractors/treeSitterExtractor.js";

function run() {
  const source = `
using Microsoft.AspNetCore.Mvc;

namespace Provider.Api.Controllers;

[ApiController]
[Route("alpha")]
public class AlphaController : ControllerBase
{
    [HttpGet("one")]
    public IActionResult One() => Ok();
}

[ApiController]
[Route("beta")]
public class BetaController : ControllerBase
{
    [HttpGet("two")]
    public IActionResult Two() => Ok();
}
`;

  const result = extractGraphData({
    repoId: "repo-test",
    filePath: "src/Controllers/MultiController.cs",
    language: "csharp",
    source
  });

  const endpointContracts = new Set(
    result.symbols
      .map((s) => s.signature)
      .filter((sig) => typeof sig === "string" && sig.startsWith("endpoint:"))
  );

  assert(
    endpointContracts.has("endpoint:GET:/alpha/one"),
    "Expected endpoint fallback/provider contract for AlphaController"
  );
  assert(
    endpointContracts.has("endpoint:GET:/beta/two"),
    "Expected endpoint fallback/provider contract for BetaController"
  );

  console.log("[ok] Endpoint fallback class-context smoke test passed");
}

run();
