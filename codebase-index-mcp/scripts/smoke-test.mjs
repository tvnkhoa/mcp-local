import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempDbPath } from "./test/_fixtures.mjs";

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "<no text content>")
    : "<no text content>";
}

function readJsonTextContent(result) {
  const text = readTextContent(result);
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function bytesOf(text) {
  return Buffer.byteLength(text, "utf8");
}

async function main() {
  const repoPath = process.cwd();
  const repoId = "smoke-test-repo";

  // Always a throwaway DB. This used to be `process.env.CODEBASE_INDEX_DB_PATH ?? makeTempDbPath()`,
  // which reads as "allow an override" but in the one context that matters did the opposite: the
  // installer runs this smoke test with the server's real configured env, so the ambient var was
  // always set and every install wrote a `smoke-test-repo` row — pointing at the real
  // codebase-index-mcp path — into the central index. Two repoIds for one directory, and a
  // `list_repositories` that misleads whoever reads it next.
  //
  // Overriding is still possible, but only by naming this script's own variable, so inheriting a
  // real path can no longer happen by accident.
  const dbPath = process.env.CODEBASE_INDEX_SMOKE_DB_PATH ?? makeTempDbPath("cbi-smoke-");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      // repoPath is what this test indexes, so it must be on the allowlist even when the ambient
      // config allows something else entirely.
      CODEBASE_INDEX_ALLOWED_ROOTS: [process.env.CODEBASE_INDEX_ALLOWED_ROOTS, repoPath]
        .filter(Boolean)
        .join(","),
      CODEBASE_INDEX_DB_PATH: dbPath
    },
    stderr: "pipe"
  });

  transport.onerror = (error) => {
    console.error("[transport-error]", error);
  };

  const client = new Client({
    name: "codebase-index-mcp-smoke-test",
    version: "0.1.0"
  });

  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("TOOLS:", toolNames);

  const requiredTools = [
    "get_symbol_context_pack",
    "dead_code_scan",
    "detect_circular_dependencies",
    "get_cross_repo_impact",
    "get_symbol_blame",
    "link_tests_to_source",
    "detect_changes",
    "watch_repo",
    "route_map",
    "query_graph",
    "rename_assist",
    "trace_execution_flow",
    "query_docs",
    "search_literals",
    "search_regex"
  ];
  for (const required of requiredTools) {
    if (!toolNames.includes(required)) {
      throw new Error(`Missing required tool in listTools: ${required}`);
    }
  }

  const health = await client.callTool({
    name: "health_check",
    arguments: {
      repoId
    }
  });

  const healthText = readTextContent(health);

  console.log("HEALTH_CHECK_RESULT:");
  console.log(healthText);

  const indexResult = await client.callTool({
    name: "index_repository",
    arguments: {
      repoId,
      repoPath,
      mode: "incremental",
      maxFiles: 200
    }
  }, undefined, { timeout: 180_000 });

  const indexPayload = readJsonTextContent(indexResult);
  console.log("INDEX_REPOSITORY_RESULT:");
  console.log(indexPayload.text);
  if (!indexPayload.json?.runId) {
    throw new Error("index_repository result missing runId");
  }

  // ISSUE-025: run-summary counter invariants — resolved + unresolved phải partition attempted,
  // coverage = resolved/attempted, alias deprecated khớp tên mới, cross-repo bucket sum khớp attempts.
  {
    const s = indexPayload.json;
    const attempted = s.callEdgesAttempted ?? 0;
    const resolved = s.callEdgesResolved ?? 0;
    const unresolved = s.callEdgesUnresolved ?? 0;
    if (resolved + unresolved !== attempted) {
      throw new Error(
        `call-edge partition mismatch: resolved(${resolved}) + unresolved(${unresolved}) != attempted(${attempted})`
      );
    }
    const expectedCoverage = attempted > 0 ? resolved / attempted : 1;
    const coverage = s.resolveCallsCoverage ?? 1;
    if (Math.abs(coverage - expectedCoverage) > 1e-9) {
      throw new Error(`resolveCallsCoverage(${coverage}) != resolved/attempted(${expectedCoverage})`);
    }
    if ((s.unresolvedCallsTotal ?? 0) !== attempted) {
      throw new Error(
        `deprecated alias unresolvedCallsTotal(${s.unresolvedCallsTotal}) != callEdgesAttempted(${attempted})`
      );
    }
    const crossAttempts = s.crossRepoAttempts ?? 0;
    const crossSum =
      (s.crossRepoResolved ?? 0) +
      (s.unresolvedNoCandidate ?? 0) +
      (s.unresolvedAmbiguous ?? 0) +
      (s.unresolvedBoundaryBlocked ?? 0) +
      (s.unresolvedLowConfidence ?? 0);
    if (crossSum !== crossAttempts) {
      throw new Error(
        `cross-repo partition mismatch: bucket sum(${crossSum}) != crossRepoAttempts(${crossAttempts})`
      );
    }
    console.log("RUN_SUMMARY_INVARIANTS: ok");
  }

  // ISSUE-023: string-literal lane — search literal content from src/index.ts stderr templates.
  const literalsResult = await client.callTool({
    name: "search_literals",
    arguments: { repoId, query: "rebuilding FTS indexes", limit: 10 }
  });
  const literalsPayload = readJsonTextContent(literalsResult);
  if (typeof literalsPayload.json?.count !== "number" || !Array.isArray(literalsPayload.json?.literals)) {
    throw new Error("search_literals response missing count/literals fields");
  }
  if (literalsPayload.json.count < 1) {
    throw new Error("search_literals returned no hits for a literal known to exist in src/index.ts");
  }
  console.log("SEARCH_LITERALS_OK:", { count: literalsPayload.json.count, top: literalsPayload.json.literals[0]?.value });

  // ISSUE-027: compact (default) profile must return the contextLines window per match.
  const regexCompact = readJsonTextContent(
    await client.callTool({
      name: "search_regex",
      arguments: { repoId, pattern: "searchRegexImpl", contextLines: 2, limit: 10 }
    })
  ).json;
  if (!regexCompact || regexCompact.count < 1) {
    throw new Error("search_regex('searchRegexImpl') returned 0 hits in smoke index");
  }
  if (!regexCompact.matches.some((m) => Array.isArray(m.beforeContext) || Array.isArray(m.afterContext))) {
    throw new Error("ISSUE-027 regression: compact search_regex dropped the contextLines window (no before/afterContext)");
  }
  // contextLines:0 must omit the window entirely.
  const regexNoCtx = readJsonTextContent(
    await client.callTool({
      name: "search_regex",
      arguments: { repoId, pattern: "searchRegexImpl", contextLines: 0, limit: 10 }
    })
  ).json;
  if (regexNoCtx.matches.some((m) => "beforeContext" in m || "afterContext" in m)) {
    throw new Error("search_regex(contextLines:0) should omit before/afterContext");
  }
  console.log("SEARCH_REGEX_CONTEXT_OK:", { count: regexCompact.count });

  // ISSUE-028: filePathPrefix as an array (OR-semantics) + pathExclude glob.
  //
  // Scoped to two SMALL subtrees rather than all of src/ and scripts/. Matches come back
  // ordered by path, so a broad pattern lets the alphabetically-earlier prefix consume the
  // whole `limit` and starve the other one — which looks exactly like the OR being broken.
  // That is not hypothetical, and it happened twice: with `["src/", "scripts/"]` and
  // `limit: 200`, scripts/ alone crossed 200 matches of "import" in S-31; the replacement
  // pair `["src/repositories/", "src/tools/"]` then grew past 200 as well (291 by the time
  // the builder refactor touched it), failing again on unchanged behaviour.
  //
  // Twice is enough: the assertion no longer depends on how big the subtrees are. Each
  // prefix is measured on its OWN, and the OR is checked as exact set equality against
  // those two measurements — `both === kept + excludable`. Starvation and a broken OR now
  // fail differently from each other, and neither needs a hand-tuned volume assumption.
  // The limit stays only as a runaway guard, and the two prefixes are named once so the
  // exclusion glob cannot drift from the query it describes.
  const OR_PREFIX_KEPT = "src/resources/";
  const OR_PREFIX_EXCLUDED = "src/config/";
  const OR_PREFIXES = [OR_PREFIX_KEPT, OR_PREFIX_EXCLUDED];
  const OR_LIMIT = 500;
  const searchScoped = async (filePathPrefix, extra = {}) =>
    readJsonTextContent(
      await client.callTool({
        name: "search_regex",
        arguments: { repoId, pattern: "import", filePathPrefix, limit: OR_LIMIT, ...extra }
      })
    ).json;

  const keptAlone = await searchScoped([OR_PREFIX_KEPT]);
  const excludableAlone = await searchScoped([OR_PREFIX_EXCLUDED]);
  const regexMultiPrefix = await searchScoped(OR_PREFIXES);
  const expectedUnion = keptAlone.matches.length + excludableAlone.matches.length;

  if (keptAlone.matches.length === 0 || excludableAlone.matches.length === 0) {
    throw new Error(`smoke-test: an OR probe subtree matches nothing on its own (${OR_PREFIX_KEPT}=${keptAlone.matches.length}, ${OR_PREFIX_EXCLUDED}=${excludableAlone.matches.length}) — pick subtrees that still contain the pattern`);
  }
  if (expectedUnion >= OR_LIMIT) {
    throw new Error(`smoke-test: OR probe subtrees outgrew the ${OR_LIMIT} limit (${expectedUnion} matches) — narrow the prefixes or the pattern`);
  }
  if (regexMultiPrefix.matches.length !== expectedUnion) {
    throw new Error(`ISSUE-028 regression: filePathPrefix array is not the union of its prefixes (both=${regexMultiPrefix.matches.length}, ${OR_PREFIX_KEPT}=${keptAlone.matches.length}, ${OR_PREFIX_EXCLUDED}=${excludableAlone.matches.length})`);
  }

  const regexExcluded = await searchScoped(OR_PREFIXES, { pathExclude: `${OR_PREFIX_EXCLUDED}**` });
  if (regexExcluded.matches.some((m) => m.filePath.startsWith(OR_PREFIX_EXCLUDED))) {
    throw new Error(`ISSUE-028 regression: pathExclude '${OR_PREFIX_EXCLUDED}**' did not subtract the excluded subtree`);
  }
  // Exact, not merely non-empty: subtracting one prefix must leave the other one whole.
  if (regexExcluded.matches.length !== keptAlone.matches.length) {
    throw new Error(`ISSUE-028 regression: pathExclude did not subtract exactly the excluded subtree (remaining=${regexExcluded.matches.length}, expected=${keptAlone.matches.length})`);
  }
  console.log("SEARCH_REGEX_SCOPE_OK:", { bothSubtrees: regexMultiPrefix.matches.length, oneExcluded: regexExcluded.matches.length });

  const healthAfterIndex = await client.callTool({
    name: "health_check",
    arguments: {
      repoId
    }
  });
  const healthAfterIndexJson = readJsonTextContent(healthAfterIndex).json;
  if (!healthAfterIndexJson?.latestRun?.runId) {
    throw new Error("health_check did not return latestRun after indexing");
  }
  if (healthAfterIndexJson.latestRun.runId !== indexPayload.json.runId) {
    throw new Error(
      `Expected health_check.latestRun.runId to match index runId (${indexPayload.json.runId}), got ${healthAfterIndexJson.latestRun.runId}`
    );
  }

  const flowResult = await client.callTool({
    name: "get_dependency_graph",
    arguments: {
      repoId,
      filePath: "src/index.ts",
      limit: 20
    }
  });

  const flowPayload = readJsonTextContent(flowResult);
  console.log("MODULE_FLOW_RESULT:");
  console.log(flowPayload.text);
  if (!Array.isArray(flowPayload.json?.edges) || flowPayload.json.edges.length === 0) {
    throw new Error("get_dependency_graph(filePath) returned no edges for src/index.ts");
  }
  if (typeof flowPayload.json?.unresolvedCalls?.count !== "number") {
    throw new Error("get_dependency_graph(filePath) missing unresolvedCalls.count field");
  }

  const fileSummary = await client.callTool({
    name: "get_file_summary",
    arguments: {
      repoId,
      filePath: "src/index.ts"
    }
  });
  const fileSummaryJson = readJsonTextContent(fileSummary).json;
  if (fileSummaryJson?.file?.language !== "typescript") {
    throw new Error(`Expected get_file_summary language=typescript, got ${String(fileSummaryJson?.file?.language)}`);
  }
  if (!Array.isArray(fileSummaryJson?.exports) || fileSummaryJson.exports.length === 0) {
    throw new Error("Expected get_file_summary exports to be non-empty for src/index.ts");
  }

  const contextByNameStandard = await client.callTool({
    name: "get_symbol_context_pack",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "standard"
    }
  });

  const contextByNameNano = await client.callTool({
    name: "get_symbol_context_pack",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "nano"
    }
  });

  const contextByNameCompact = await client.callTool({
    name: "get_symbol_context_pack",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "compact"
    }
  });

  const contextByNameVerbose = await client.callTool({
    name: "get_symbol_context_pack",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "verbose"
    }
  });

  const contextStdText = readTextContent(contextByNameStandard);
  const contextNanoText = readTextContent(contextByNameNano);
  const contextCmpText = readTextContent(contextByNameCompact);
  const contextVrbText = readTextContent(contextByNameVerbose);
  const contextNanoJson = readJsonTextContent(contextByNameNano).json;
  const contextCmpJson = readJsonTextContent(contextByNameCompact).json;
  if (!contextNanoJson || !contextNanoJson.selectedSymbol) {
    throw new Error("get_symbol_context_pack(nano) did not return a selectedSymbol");
  }
  if (!contextCmpJson || !contextCmpJson.selectedSymbol) {
    throw new Error("get_symbol_context_pack(compact) returned no selectedSymbol");
  }

  const nanoBytes = bytesOf(contextNanoText);
  const standardBytes = bytesOf(contextStdText);
  const compactBytes = bytesOf(contextCmpText);
  const verboseBytes = bytesOf(contextVrbText);
  if (nanoBytes > compactBytes) {
    throw new Error(`Expected nano payload <= compact payload (nano=${nanoBytes}, compact=${compactBytes})`);
  }
  if (compactBytes > standardBytes) {
    throw new Error(`Expected compact payload <= standard payload (compact=${compactBytes}, standard=${standardBytes})`);
  }
  if (verboseBytes < standardBytes) {
    throw new Error(`Expected verbose payload >= standard payload (verbose=${verboseBytes}, standard=${standardBytes})`);
  }

  console.log("CONTEXT_PROFILE_BYTES:", {
    nanoBytes,
    standardBytes,
    compactBytes,
    verboseBytes
  });

  const changeByName = await client.callTool({
    name: "get_change_context",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      callerDepth: 2,
      calleeDepth: 1,
      limit: 20,
      profile: "compact"
    }
  });
  const changeByNameJson = readJsonTextContent(changeByName).json;
  if (!changeByNameJson || !changeByNameJson.symbol) {
    throw new Error("get_change_context(name, compact) returned no symbol");
  }

  const symbolCandidates = await client.callTool({
    name: "search_symbols",
    arguments: {
      repoId,
      query: "GraphStore",
      limit: 10,
      ranked: true
    }
  });
  const symbolCandidatesJson = readJsonTextContent(symbolCandidates).json;
  if (!symbolCandidatesJson || !Array.isArray(symbolCandidatesJson.candidates) || symbolCandidatesJson.candidates.length === 0) {
    throw new Error("search_symbols(ranked=true) returned empty candidates");
  }

  // Finding A regression: ranked + intent on a MULTI-WORD query must tokenize, not
  // substring-match the whole phrase. Before the fix this silently returned 0.
  const rankedIntent = await client.callTool({
    name: "search_symbols",
    arguments: {
      repoId,
      query: "search symbols",
      strategy: "intent",
      ranked: true,
      limit: 10
    }
  });
  const rankedIntentJson = readJsonTextContent(rankedIntent).json;
  if (!rankedIntentJson || !Array.isArray(rankedIntentJson.candidates) || rankedIntentJson.candidates.length === 0) {
    throw new Error("search_symbols(ranked=true, strategy=intent, multi-word) returned 0 — intent tokenization not honored on ranked path");
  }
  console.log("RANKED_INTENT_OK:", { count: rankedIntentJson.candidates.length, top: rankedIntentJson.candidates[0]?.name });

  const symbolContextPack = await client.callTool({
    name: "get_symbol_context_pack",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      callerDepth: 2,
      calleeDepth: 1,
      limit: 20,
      profile: "compact"
    }
  });
  const symbolContextPackJson = readJsonTextContent(symbolContextPack).json;
  if (!symbolContextPackJson || !symbolContextPackJson.selectedSymbol) {
    throw new Error("get_symbol_context_pack(compact) returned no selectedSymbol");
  }

  // Finding B regression: for a class with a same-named constructor, the pack must
  // select the class (which carries edges), not the edgeless constructor. The selected
  // symbol must also agree with the top-ranked candidate.
  const classPack = await client.callTool({
    name: "get_symbol_context_pack",
    arguments: { repoId, name: "GraphStore", limit: 20, profile: "compact" }
  });
  const classPackJson = readJsonTextContent(classPack).json;
  if (!classPackJson || !classPackJson.selectedSymbol) {
    throw new Error("get_symbol_context_pack('GraphStore') returned no selectedSymbol");
  }
  if (classPackJson.selectedSymbol.kind === "constructor") {
    throw new Error("get_symbol_context_pack('GraphStore') selected the constructor over the class");
  }
  if (Array.isArray(classPackJson.candidates) && classPackJson.candidates[0] &&
      classPackJson.candidates[0].symbolId !== classPackJson.selectedSymbol.symbolId) {
    throw new Error("get_symbol_context_pack selectedSymbol disagrees with top-ranked candidate");
  }
  console.log("CONTEXT_PACK_KIND_OK:", { selected: classPackJson.selectedSymbol.kind });

  // get_symbol_source: raw source span read from disk (end_line persisted via re-index in this run).
  const symbolSource = await client.callTool({
    name: "get_symbol_source",
    arguments: { repoId, name: "GraphStore", profile: "compact" }
  });
  const symbolSourceJson = readJsonTextContent(symbolSource).json;
  if (!symbolSourceJson || typeof symbolSourceJson.source !== "string" || !symbolSourceJson.source.includes("class GraphStore")) {
    throw new Error("get_symbol_source('GraphStore') did not return source containing 'class GraphStore'");
  }
  if (typeof symbolSourceJson.symbolStartLine !== "number" || typeof symbolSourceJson.symbolEndLine !== "number" || symbolSourceJson.symbolEndLine < symbolSourceJson.symbolStartLine) {
    throw new Error("get_symbol_source returned invalid start/end lines");
  }
  console.log("GET_SYMBOL_SOURCE_OK:", { start: symbolSourceJson.symbolStartLine, end: symbolSourceJson.symbolEndLine, estimated: symbolSourceJson.endLineEstimated, lines: symbolSourceJson.lineCount });

  const detectChanges = await client.callTool({
    name: "detect_changes",
    arguments: {
      repoId,
      profile: "nano",
      maxFiles: 30,
      impactLimit: 20,
      policy: "release-gate",
      maxResults: 5
    }
  });
  const detectChangesJson = readJsonTextContent(detectChanges).json;
  if (!detectChangesJson || typeof detectChangesJson.changedFileCount !== "number") {
    throw new Error("detect_changes(nano) missing changedFileCount");
  }
  if (!detectChangesJson.riskSummary || typeof detectChangesJson.riskSummary.highRiskCount !== "number") {
    throw new Error("detect_changes(nano) missing riskSummary.highRiskCount");
  }
  if (!Array.isArray(detectChangesJson.topRiskChanges)) {
    throw new Error("detect_changes(nano) missing topRiskChanges array");
  }
  if (!detectChangesJson.filter || detectChangesJson.filter.maxResults !== 5) {
    throw new Error("detect_changes(nano) missing filter.maxResults");
  }
  if (detectChangesJson.filter.policyUsed !== "release-gate") {
    throw new Error("detect_changes(nano) did not report policyUsed=release-gate");
  }
  if (detectChangesJson.topRiskChanges.length > 5) {
    throw new Error("detect_changes(nano) did not respect maxResults filter");
  }
  if (!detectChangesJson.topRiskChanges.every((x) => typeof x.riskScore === "number" && x.riskScore >= 67)) {
    throw new Error("detect_changes(nano) returned item below release-gate threshold");
  }
  if (!detectChangesJson.topRiskChanges.every((x) => x.riskLevel === "high")) {
    throw new Error("detect_changes(nano) returned non-high risk item for release-gate policy");
  }

  // Phase 7A: groupBy=module
  const detectChangesGrouped = await client.callTool({
    name: "detect_changes",
    arguments: {
      repoId,
      profile: "compact",
      maxFiles: 30,
      impactLimit: 20,
      groupBy: "module"
    }
  });
  const detectChangesGroupedJson = readJsonTextContent(detectChangesGrouped).json;
  if (!detectChangesGroupedJson || !Array.isArray(detectChangesGroupedJson.moduleGroups)) {
    throw new Error("detect_changes(groupBy=module) did not return moduleGroups array");
  }
  console.log("DETECT_CHANGES_MODULE_GROUPS:", detectChangesGroupedJson.moduleGroups.length, "modules");

  const routeMap = await client.callTool({
    name: "route_map",
    arguments: {
      repoId,
      profile: "compact",
      limit: 20
    }
  });
  const routeMapJson = readJsonTextContent(routeMap).json;
  if (!routeMapJson || !Array.isArray(routeMapJson.routes)) {
    throw new Error("route_map(compact) missing routes array");
  }
  // This TS repo has no ASP.NET routes → empty result must carry an actionable hint.
  if (routeMapJson.count === 0 && typeof routeMapJson.hint !== "string") {
    throw new Error("route_map(compact) returned 0 routes without an actionable hint");
  }
  console.log("ROUTE_MAP_COUNT:", routeMapJson.count);

  const queryGraph = await client.callTool({
    name: "query_graph",
    arguments: {
      repoId,
      sql: "select file_path, name from symbols where repo_id = :repoId order by name limit 5",
      limit: 5,
      profile: "compact"
    }
  });
  const queryGraphJson = readJsonTextContent(queryGraph).json;
  if (!queryGraphJson || !Array.isArray(queryGraphJson.rows) || !Array.isArray(queryGraphJson.columns)) {
    throw new Error("query_graph(compact) missing rows/columns");
  }
  console.log("QUERY_GRAPH_ROW_COUNT:", queryGraphJson.rowCount);

  const deadCodeScan = await client.callTool({
    name: "dead_code_scan",
    arguments: {
      repoId,
      profile: "compact",
      limit: 20
    }
  });
  const deadCodeScanJson = readJsonTextContent(deadCodeScan).json;
  if (!deadCodeScanJson || !Array.isArray(deadCodeScanJson.symbols)) {
    throw new Error("dead_code_scan(compact) missing symbols array");
  }
  console.log("DEAD_CODE_COUNT:", deadCodeScanJson.count);

  const circularDeps = await client.callTool({
    name: "detect_circular_dependencies",
    arguments: {
      repoId,
      mode: "module",
      maxDepth: 4,
      maxCycles: 20,
      profile: "compact"
    }
  });
  const circularDepsJson = readJsonTextContent(circularDeps).json;
  if (!circularDepsJson || !Array.isArray(circularDepsJson.cycles) || typeof circularDepsJson.cycleCount !== "number") {
    throw new Error("detect_circular_dependencies(compact) missing cycles/cycleCount");
  }
  console.log("CIRCULAR_DEP_COUNT:", circularDepsJson.cycleCount);

  const testSourceLinks = await client.callTool({
    name: "link_tests_to_source",
    arguments: {
      repoId,
      limit: 20,
      maxCandidates: 3,
      minScore: 0.4,
      profile: "compact"
    }
  });
  const testSourceLinksJson = readJsonTextContent(testSourceLinks).json;
  if (!testSourceLinksJson || !Array.isArray(testSourceLinksJson.links)) {
    throw new Error("link_tests_to_source(compact) missing links array");
  }
  console.log("TEST_SOURCE_LINK_COUNT:", testSourceLinksJson.count);

  const resources = await client.listResources();
  if (!Array.isArray(resources.resources) || resources.resources.length === 0) {
    throw new Error("listResources returned no resources");
  }
  const contextResource = resources.resources.find((r) => typeof r.uri === "string" && r.uri.endsWith("/context"));
  if (!contextResource?.uri) {
    throw new Error("listResources missing /context resource URI");
  }
  const readResource = await client.readResource({ uri: contextResource.uri });
  if (!Array.isArray(readResource.contents) || readResource.contents.length === 0) {
    throw new Error("readResource returned empty contents");
  }
  console.log("RESOURCES_COUNT:", resources.resources.length);

  // Phase 7B-2: rename_assist — pick first symbol from ranked search
  const symbolsForRename = await client.callTool({
    name: "search_symbols",
    arguments: {
      repoId,
      query: "GraphStore",
      limit: 1,
      ranked: true
    }
  });
  const symbolsForRenameJson = readJsonTextContent(symbolsForRename).json;
  const firstSymbol = symbolsForRenameJson?.candidates?.[0];
  if (firstSymbol?.symbolId) {
    const crossRepoImpact = await client.callTool({
      name: "get_cross_repo_impact",
      arguments: {
        repoId,
        symbolId: firstSymbol.symbolId,
        direction: "outbound",
        profile: "compact"
      }
    });
    const crossRepoImpactJson = readJsonTextContent(crossRepoImpact).json;
    if (!crossRepoImpactJson || !Array.isArray(crossRepoImpactJson.impacts)) {
      throw new Error("get_cross_repo_impact(compact) missing impacts array");
    }
    console.log("CROSS_REPO_IMPACT_COUNT:", crossRepoImpactJson.impactCount);

    const symbolBlame = await client.callTool({
      name: "get_symbol_blame",
      arguments: {
        repoId,
        symbolId: firstSymbol.symbolId,
        profile: "compact"
      }
    });
    const symbolBlameJson = readJsonTextContent(symbolBlame).json;
    if (!symbolBlameJson || !symbolBlameJson.blame || typeof symbolBlameJson.blame.commit !== "string") {
      throw new Error("get_symbol_blame(compact) missing blame.commit");
    }
    console.log("SYMBOL_BLAME_COMMIT:", symbolBlameJson.blame.commit);

    const renameAssist = await client.callTool({
      name: "rename_assist",
      arguments: {
        repoId,
        symbolId: firstSymbol.symbolId,
        newName: "GraphStoreV2",
        profile: "compact"
      }
    });
    const renameAssistJson = readJsonTextContent(renameAssist).json;
    if (!renameAssistJson || typeof renameAssistJson.affectedFileCount !== "number" || !Array.isArray(renameAssistJson.affectedFiles)) {
      throw new Error("rename_assist(compact) missing affectedFileCount or affectedFiles");
    }
    console.log("RENAME_ASSIST:", { symbol: renameAssistJson.symbol?.name, affectedFileCount: renameAssistJson.affectedFileCount });

    // Phase 7C: trace_execution_flow
    const traceFlow = await client.callTool({
      name: "trace_execution_flow",
      arguments: {
        repoId,
        entrySymbolId: firstSymbol.symbolId,
        maxDepth: 2,
        maxNodes: 15,
        profile: "compact"
      }
    });
    const traceFlowJson = readJsonTextContent(traceFlow).json;
    if (!traceFlowJson || !Array.isArray(traceFlowJson.nodes)) {
      throw new Error("trace_execution_flow(compact) missing nodes array");
    }
    console.log("TRACE_EXECUTION_FLOW:", { nodeCount: traceFlowJson.nodeCount, edgeCount: traceFlowJson.edgeCount, depthReached: traceFlowJson.depthReached });
  } else {
    console.log("SKIP: rename_assist + trace_execution_flow (no symbolId from search)");
  }

  if (!indexPayload.json || !flowPayload.json) {
    throw new Error("Smoke test received non-JSON text output from tool call.");
  }

  // ── Nano profile sanity check (verify new profile support works) ──────────
  const nanoFindImpact = await client.callTool({
    name: "find_impact_files",
    arguments: { repoId, filePath: "src/graphStore.ts", profile: "nano" }
  });
  // Finding C: impact tools must never hard-fail. A stale index becomes an embedded
  // `staleWarning`, not an McpError. (The fresh smoke index isn't stale, so the stale
  // branch is verified live on a stale repo; here we just guard against regressing to throw.)
  if (nanoFindImpact.isError) {
    throw new Error("find_impact_files should not return an error result (stale index must warn, not throw)");
  }
  const nanoFindImpactJson = readJsonTextContent(nanoFindImpact).json;
  if (!nanoFindImpactJson || typeof nanoFindImpactJson.totalFiles !== "number") {
    throw new Error("find_impact_files(profile=nano) missing totalFiles — profile support may be broken");
  }
  if (!Array.isArray(nanoFindImpactJson.topFiles)) {
    throw new Error("find_impact_files(profile=nano) missing topFiles array");
  }
  const nanoProfileBytes = bytesOf(readTextContent(nanoFindImpact));
  if (nanoProfileBytes > 8_000) {
    throw new Error(`find_impact_files(nano) response too large (${nanoProfileBytes} bytes) — expected < 8KB for nano mode`);
  }
  console.log("NANO_PROFILE_SANITY:", { tool: "find_impact_files", totalFiles: nanoFindImpactJson.totalFiles, nanoBytes: nanoProfileBytes });

  // ── Enhanced empty-result / shape contracts ──────────────────────────────
  // find_implementations: unknown interface → wrapped object (not bare array) + hint + didYouMean.
  const findImpl = await client.callTool({
    name: "find_implementations",
    arguments: { repoId, interfaceName: "IDefinitelyDoesNotExist__SmokeTest", profile: "compact" }
  });
  const findImplJson = readJsonTextContent(findImpl).json;
  if (!findImplJson || Array.isArray(findImplJson)) {
    throw new Error("find_implementations should return a wrapped object, not a bare array");
  }
  if (findImplJson.count !== 0 || !Array.isArray(findImplJson.implementations)) {
    throw new Error("find_implementations(unknown) missing count:0 / implementations array");
  }
  if (typeof findImplJson.hint !== "string" || !Array.isArray(findImplJson.didYouMean)) {
    throw new Error("find_implementations(unknown) missing hint / didYouMean on empty result");
  }
  console.log("FIND_IMPL_EMPTY_HINT_OK:", { interfaceName: findImplJson.interfaceName, count: findImplJson.count });

  // link_tests_to_source: when no links resolve, must carry a hint.
  if (testSourceLinksJson.count === 0 && typeof testSourceLinksJson.hint !== "string") {
    throw new Error("link_tests_to_source returned 0 links without an actionable hint");
  }

  // find_entry_points: compact profile drops the redundant flat `entryPoints` field.
  const entryPointsCompact = await client.callTool({
    name: "find_entry_points",
    arguments: { repoId, limit: 20, profile: "compact" }
  });
  const entryPointsCompactJson = readJsonTextContent(entryPointsCompact).json;
  if (!entryPointsCompactJson || !Array.isArray(entryPointsCompactJson.runtimeEntryPoints)) {
    throw new Error("find_entry_points(compact) missing runtimeEntryPoints array");
  }
  if ("entryPoints" in entryPointsCompactJson) {
    throw new Error("find_entry_points(compact) should omit the redundant flat entryPoints field");
  }
  const entryPointsStandard = await client.callTool({
    name: "find_entry_points",
    arguments: { repoId, limit: 20, profile: "standard" }
  });
  const entryPointsStandardJson = readJsonTextContent(entryPointsStandard).json;
  if (!entryPointsStandardJson || !Array.isArray(entryPointsStandardJson.entryPoints)) {
    throw new Error("find_entry_points(standard) should retain the flat entryPoints field for back-compat");
  }
  console.log("ENTRY_POINTS_DEDUP_OK:", { total: entryPointsCompactJson.total });

  // query_docs: docs lane may be disabled in this env (returns an isError result, not a throw).
  // When enabled, search must return a stable keyed object whose headingPaths are POSIX-normalized.
  const queryDocs = await client.callTool({
    name: "query_docs",
    arguments: { repoId, mode: "search", query: "refactor", limit: 10 }
  });
  const { text: queryDocsText, json: queryDocsJson } = readJsonTextContent(queryDocs);
  if (queryDocs.isError || queryDocsText.includes("docs lane is disabled")) {
    console.log("SKIP: query_docs path assertion (docs lane disabled)");
  } else {
    if (!queryDocsJson || !Array.isArray(queryDocsJson.results) || typeof queryDocsJson.count !== "number") {
      throw new Error("query_docs(search) should return a keyed object with count + results array");
    }
    const offending = queryDocsJson.results.find((d) => typeof d?.headingPath === "string" && d.headingPath.includes("\\"));
    if (offending) {
      throw new Error(`query_docs headingPath not POSIX-normalized: ${offending.headingPath}`);
    }
    console.log("QUERY_DOCS_PATH_OK:", { rows: queryDocsJson.results.length });
  }

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
