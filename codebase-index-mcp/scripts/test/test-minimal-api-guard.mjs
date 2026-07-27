import { extractGraphData } from "../../dist/treeSitterExtractor.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const source = `
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

public static class EndpointRegistration {
  public static void MapEndpoints(WebApplication app) {
    app.MapGet("/health", Health);
    var groupBuilder = app.MapGroup("/v1");
    groupBuilder.MapPost("/items", CreateItem);
  }

  private static string Health() => "ok";
  private static IResult CreateItem() => Results.Ok();
}

public class NotAspNet {
  public void Run(FakeClient client) {
    client.MapGet("/should-not-be-route", Handler);
  }

  private void Handler() {}
}
`;

const result = extractGraphData({
  repoId: "test-repo",
  filePath: "Endpoints.cs",
  language: "csharp",
  source
});

const routes = result.routes.map((r) => `${r.httpMethod} ${r.routeTemplate}`);

assert(routes.includes("GET /health"), "Expected route GET /health");
assert(routes.includes("POST /v1/items"), "Expected route POST /v1/items from MapGroup receiver");
assert(!routes.includes("GET /should-not-be-route"), "Unexpected non-ASP.NET receiver route was extracted");

console.log("test-minimal-api-guard: OK", { routeCount: result.routes.length, routes });
