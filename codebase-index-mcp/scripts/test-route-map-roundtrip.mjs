/**
 * Round-trip test: Minimal API route extraction → DB store → getRouteMap read-back.
 * Verifies that routes inserted via replaceRoutesForFile are returned by getRouteMap.
 * Covers ISSUE-007: route_map returning count:0 even when routes exist in DB.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../dist/graphStore.js";
import { extractGraphData } from "../dist/treeSitterExtractor.js";

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-route-map-rtrip-"));
  return path.join(tempDir, "test.db");
}

// IEndpointGroup pattern (matches wec.commnunication-hub/Conversations.cs style)
const iEndpointGroupSource = `
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

namespace CommunicationHub.Web.Endpoints;

public class ConversationEndpoints : IEndpointGroup
{
    public void Map(WebApplication app)
    {
        app.MapGet("/conversations", GetAll);
        app.MapPost("/conversations", Create);
        app.MapGet("/conversations/{id}", GetById);
        app.MapPut("/conversations/{id}", Update);
        app.MapDelete("/conversations/{id}", Delete);
    }

    private static IResult GetAll() => Results.Ok();
    private static IResult Create() => Results.Ok();
    private static IResult GetById() => Results.Ok();
    private static IResult Update() => Results.Ok();
    private static IResult Delete() => Results.Ok();
}
`;

// Mixed: class-scoped + top-level minimal API (both common Program.cs patterns)
const topLevelCreateSource = `
using Microsoft.AspNetCore.Builder;

var app = WebApplication.Create();
app.MapGet("/health", () => "ok");
app.MapPost("/items", CreateItem);

static IResult CreateItem() => Results.Ok();
`;

const topLevelBuilderSource = `
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapGet("/status", () => "ok");
app.MapDelete("/items/{id}", DeleteItem);

static IResult DeleteItem() => Results.Ok();
`;

function run() {
  const dbPath = createTempDbPath();
  const store = new GraphStore(dbPath);
  const repoId = "test-communication-hub";

  // ── Test 1: IEndpointGroup class pattern ──────────────────────────────────

  const filePath = "backend/Web/Endpoints/Conversations.cs";
  const extracted = extractGraphData({
    repoId,
    filePath,
    language: "csharp",
    source: iEndpointGroupSource
  });

  assert(extracted.routes.length > 0, `[1a] Expected routes from IEndpointGroup class, got 0`);
  assert(
    extracted.routes.some((r) => r.httpMethod === "GET" && r.routeTemplate === "/conversations"),
    `[1a] Expected GET /conversations in extracted routes. Got: ${JSON.stringify(extracted.routes.map((r) => r.httpMethod + " " + r.routeTemplate))}`
  );

  // Store symbols first (getRouteMap does LEFT JOIN on symbols)
  store.replaceSymbolsForFile(repoId, filePath, extracted.symbols);
  store.replaceRoutesForFile(repoId, filePath, extracted.routes);

  // Read back via getRouteMap
  const routeMapAll = store.getRouteMap(repoId, null, null, 200);
  assert(
    routeMapAll.length === extracted.routes.length,
    `[1b] getRouteMap returned ${routeMapAll.length} rows, expected ${extracted.routes.length}. Routes in DB but not returned by getRouteMap.`
  );

  // Check scoped query (filePathPrefix)
  const routeMapScoped = store.getRouteMap(repoId, "backend/Web", null, 200);
  assert(
    routeMapScoped.length === extracted.routes.length,
    `[1c] getRouteMap(filePathPrefix="backend/Web") returned ${routeMapScoped.length}, expected ${extracted.routes.length}`
  );

  // Check method filter
  const getRoutes = store.getRouteMap(repoId, null, "GET", 200);
  const expectedGetCount = extracted.routes.filter((r) => r.httpMethod === "GET").length;
  assert(
    getRoutes.length === expectedGetCount,
    `[1d] getRouteMap(httpMethod=GET) returned ${getRoutes.length}, expected ${expectedGetCount}`
  );

  console.log("[1] IEndpointGroup pattern: OK", {
    extractedCount: extracted.routes.length,
    routeMapAllCount: routeMapAll.length,
    routeMapScopedCount: routeMapScoped.length,
    getRoutesCount: getRoutes.length
  });

  // ── Test 2: Top-level Program.cs with WebApplication.Create() ────────────

  const programPath = "backend/Program.cs";
  const extractedTopLevel = extractGraphData({
    repoId,
    filePath: programPath,
    language: "csharp",
    source: topLevelCreateSource
  });

  assert(
    extractedTopLevel.routes.length >= 2,
    `[2a] Expected at least 2 top-level routes (WebApplication.Create), got ${extractedTopLevel.routes.length}`
  );

  store.replaceSymbolsForFile(repoId, programPath, extractedTopLevel.symbols);
  store.replaceRoutesForFile(repoId, programPath, extractedTopLevel.routes);

  const allRoutes = store.getRouteMap(repoId, null, null, 200);
  const expectedTotal = extracted.routes.length + extractedTopLevel.routes.length;
  assert(
    allRoutes.length === expectedTotal,
    `[2b] After adding top-level routes, getRouteMap returned ${allRoutes.length}, expected ${expectedTotal}`
  );

  console.log("[2] Top-level WebApplication.Create() pattern: OK", {
    topLevelExtracted: extractedTopLevel.routes.length,
    allRoutesTotal: allRoutes.length
  });

  // ── Test 3: Top-level Program.cs with builder.Build() pattern ────────────

  const programBuilderPath = "backend/Program2.cs";
  const extractedBuilder = extractGraphData({
    repoId,
    filePath: programBuilderPath,
    language: "csharp",
    source: topLevelBuilderSource
  });

  assert(
    extractedBuilder.routes.length >= 2,
    `[3a] Expected at least 2 routes (WebApplication.CreateBuilder+Build), got ${extractedBuilder.routes.length}`
  );

  store.replaceSymbolsForFile(repoId, programBuilderPath, extractedBuilder.symbols);
  store.replaceRoutesForFile(repoId, programBuilderPath, extractedBuilder.routes);

  const allRoutesAfterBuilder = store.getRouteMap(repoId, null, null, 200);
  const expectedTotal2 = expectedTotal + extractedBuilder.routes.length;
  assert(
    allRoutesAfterBuilder.length === expectedTotal2,
    `[3b] After builder.Build() routes, getRouteMap returned ${allRoutesAfterBuilder.length}, expected ${expectedTotal2}`
  );

  console.log("[3] Top-level builder.Build() pattern: OK", {
    builderExtracted: extractedBuilder.routes.length,
    allRoutesTotal: allRoutesAfterBuilder.length
  });

  // ── Test 4: controllerSymbolId = "" does not break LEFT JOIN ─────────────

  const topLevelRoutes = allRoutesAfterBuilder.filter((r) => r.filePath === programPath || r.filePath === programBuilderPath);
  for (const r of topLevelRoutes) {
    assert(
      r.controllerName === null,
      `[4] controllerName should be null (no matching symbol) for top-level route '${r.routeTemplate}', got: ${JSON.stringify(r.controllerName)}`
    );
  }

  console.log("[4] Empty controllerSymbolId LEFT JOIN: OK");

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });

  console.log("test-route-map-roundtrip: ALL PASS");
}

try {
  run();
} catch (err) {
  console.error("test-route-map-roundtrip: FAILED:", err.message);
  process.exit(1);
}
