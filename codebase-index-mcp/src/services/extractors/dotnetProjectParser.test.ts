import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "../indexing/indexRunner.js";
import type { IndexMode, SymbolRecord } from "../../types/index.js";
import { extractDotnetProjectData } from "./dotnetProjectParser.js";

/**
 * MCP-ISSUE-065: a `<ProjectReference>` / `.sln` `DEPENDS_ON` edge must point at the referenced
 * project's real module symbol.
 *
 * The edge used to be minted as `stableId(repoId:project:<raw refPath>)` while the module symbol was
 * `stableId(repoId:<filePath>:module:<name>)`, so every project edge held a 24-hex `to_id` that matched
 * no symbol — neither resolved nor a prefixed token. Measured live: 271 such edges on wec.be, 5 on
 * wec.notification. Being "resolved-looking" also made the MCP-ISSUE-063 prune delete them on every
 * incremental run.
 */

const REPO = "dotnet-refs";

const API_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.1.1" />
    <ProjectReference Include="..\\Domain\\Domain.csproj" />
    <ProjectReference Include="..\\..\\..\\Shared\\Shared.csproj" />
  </ItemGroup>
</Project>
`;

const DOMAIN_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
</Project>
`;

const SLN = `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "API", "src\\API\\API.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Domain", "src\\Domain\\Domain.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
`;

function projectModule(symbols: SymbolRecord[]): SymbolRecord {
  const mod = symbols.find((s) => s.kind === "module" && s.signature === undefined);
  assert.ok(mod, "the .csproj emits a project module symbol");
  return mod;
}

for (const sep of ["/", "\\"]) {
  test(`a ProjectReference edge targets the referenced project's module symbol id (separator ${JSON.stringify(sep)})`, () => {
    const apiPath = ["src", "API", "API.csproj"].join(sep);
    const domainPath = ["src", "Domain", "Domain.csproj"].join(sep);
    const api = extractDotnetProjectData({ repoId: REPO, filePath: apiPath, language: "csproj", source: API_CSPROJ });
    const domain = extractDotnetProjectData({ repoId: REPO, filePath: domainPath, language: "csproj", source: DOMAIN_CSPROJ });

    const apiModule = projectModule(api.symbols);
    const domainModule = projectModule(domain.symbols);
    assert.equal(apiModule.filePath, apiPath, "the symbol keeps the path the pipeline passed in");

    const projectEdges = api.edges.filter((e) => e.type === "DEPENDS_ON" && !e.toId.startsWith("nuget:"));
    assert.equal(projectEdges.length, 2);
    for (const edge of projectEdges) assert.equal(edge.fromId, apiModule.symbolId);

    const inRepo = projectEdges.find((e) => e.toId === domainModule.symbolId);
    assert.ok(inRepo, `API -> Domain must point at Domain's module symbol ${domainModule.symbolId}; got ${JSON.stringify(projectEdges.map((e) => e.toId))}`);

    // The third reference climbs out of the repository: it cannot be a symbol here, so it is a token.
    const outside = projectEdges.find((e) => e !== inRepo);
    assert.equal(outside?.toId, "project:../shared/shared.csproj");
    assert.equal(outside?.reason, "external boundary");
  });
}

test("the module id does not depend on path separator or casing, so a reference spelled differently still binds", () => {
  const a = projectModule(extractDotnetProjectData({ repoId: REPO, filePath: "src/Domain/Domain.csproj", language: "csproj", source: DOMAIN_CSPROJ }).symbols);
  const b = projectModule(extractDotnetProjectData({ repoId: REPO, filePath: "src\\Domain\\Domain.csproj", language: "csproj", source: DOMAIN_CSPROJ }).symbols);
  assert.equal(a.symbolId, b.symbolId);

  const consumer = extractDotnetProjectData({
    repoId: REPO,
    filePath: "src/API/API.csproj",
    language: "csproj",
    source: `<Project><ItemGroup><ProjectReference Include="../domain/./DOMAIN.csproj" /></ItemGroup></Project>`
  });
  assert.equal(consumer.edges[0]?.toId, a.symbolId);
});

test("a ProjectReference built from an MSBuild property is an unresolved token, not a bare hex id", () => {
  const extracted = extractDotnetProjectData({
    repoId: REPO,
    filePath: "src/API/API.csproj",
    language: "csproj",
    source: `<Project><ItemGroup><ProjectReference Include="$(SolutionDir)Domain\\Domain.csproj" /></ItemGroup></Project>`
  });
  const edge = extracted.edges[0];
  assert.ok(edge?.toId.startsWith("project:"), `got ${String(edge?.toId)}`);
  assert.equal(edge?.reason, "unresolved project reference token");
});

test(".sln project edges target the projects' own module symbols and mint no proxy symbols", () => {
  const sln = extractDotnetProjectData({ repoId: REPO, filePath: "app.sln", language: "sln", source: SLN });
  const apiModule = projectModule(extractDotnetProjectData({ repoId: REPO, filePath: "src\\API\\API.csproj", language: "csproj", source: API_CSPROJ }).symbols);
  const domainModule = projectModule(extractDotnetProjectData({ repoId: REPO, filePath: "src\\Domain\\Domain.csproj", language: "csproj", source: DOMAIN_CSPROJ }).symbols);

  assert.equal(sln.symbols.length, 1, `only the solution's own module symbol; got ${JSON.stringify(sln.symbols.map((s) => s.name))}`);
  assert.deepEqual(sln.edges.map((e) => e.toId).sort(), [apiModule.symbolId, domainModule.symbolId].sort());
});

// ── End to end: the real runner on a two-project tree ─────────────────────────────────────────────

function runnerFor(store: GraphStore) {
  return createIndexRunner({
    store,
    limits: {
      subtxSize: 20,
      checkpointEveryNBatches: 1,
      largeFileThresholdBytes: 512 * 1024,
      maxFileSizeBytes: 500 * 1024,
      parseWorkers: 0,
      parseJobTimeoutMs: 20_000
    },
    resolvePerformanceProfileOverride: () => "auto"
  });
}

async function index(store: GraphStore, repoPath: string, mode: IndexMode): Promise<void> {
  await runnerFor(store)(REPO, repoPath, mode, false, 1000, 50);
}

function query(store: GraphStore, sql: string): Record<string, unknown>[] {
  return store.runReadOnlyGraphQuery(sql, { repoId: REPO }, 500, 5000).rows;
}

/** Bare (un-prefixed) `to_id`s that match no symbol: the defect, counted the way it was measured live. */
function danglingIds(store: GraphStore): number {
  const rows = query(
    store,
    `select count(*) as n from edges e
     where e.repo_id = :repoId and e.to_id not like '%:%'
       and not exists (select 1 from symbols s where s.repo_id = e.repo_id and s.symbol_id = e.to_id)`
  );
  return Number(rows[0]?.n ?? -1);
}

/** Project-to-project DEPENDS_ON edges, by endpoint file paths. */
function projectEdges(store: GraphStore): string[] {
  return query(
    store,
    `select src.file_path as fromFile, coalesce(dst.file_path, e.to_id) as target
     from edges e
     join symbols src on src.repo_id = e.repo_id and src.symbol_id = e.from_id
     left join symbols dst on dst.repo_id = e.repo_id and dst.symbol_id = e.to_id
     where e.repo_id = :repoId and e.type = 'DEPENDS_ON' and e.to_id not like 'nuget:%'`
  )
    .map((r) => `${String(r.fromFile)} -> ${String(r.target)}`.replaceAll("\\", "/"))
    .sort();
}

const EXPECTED_PROJECT_EDGES = [
  "app.sln -> src/API/API.csproj",
  "app.sln -> src/Domain/Domain.csproj",
  "src/API/API.csproj -> project:../shared/shared.csproj",
  "src/API/API.csproj -> src/Domain/Domain.csproj"
];

test("a full index of a two-project tree has 0 dangling ids and the reference binds to Domain's module symbol", async () => {
  const repoPath = mkdtempSync(path.join(tmpdir(), "cim-dotnet-"));
  const dbDir = mkdtempSync(path.join(tmpdir(), "cim-dotnet-db-"));
  const store = new GraphStore(path.join(dbDir, "graph.db"));
  try {
    mkdirSync(path.join(repoPath, "src", "API"), { recursive: true });
    mkdirSync(path.join(repoPath, "src", "Domain"), { recursive: true });
    writeFileSync(path.join(repoPath, "src", "API", "API.csproj"), API_CSPROJ);
    writeFileSync(path.join(repoPath, "src", "Domain", "Domain.csproj"), DOMAIN_CSPROJ);
    writeFileSync(path.join(repoPath, "app.sln"), SLN);
    writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
    await index(store, repoPath, "full");

    assert.equal(danglingIds(store), 0, "no DEPENDS_ON edge may hold a bare id that matches no symbol");
    assert.deepEqual(projectEdges(store), EXPECTED_PROJECT_EDGES);

    // An incremental run that touches an unrelated file must keep the edges. Before the fix they were
    // resolved-looking and dangling, so the MCP-ISSUE-063 prune deleted them on every incremental run.
    writeFileSync(path.join(repoPath, "README.md"), "# fixture, edited\n");
    await index(store, repoPath, "incremental");
    assert.equal(danglingIds(store), 0);
    assert.deepEqual(projectEdges(store), EXPECTED_PROJECT_EDGES);
  } finally {
    store.close();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
