/**
 * MCP-ISSUE-049 — the response-shape contract.
 *
 * Every assertion here corresponds to one sub-item of that issue. They are grouped in one harness
 * because they share a root cause (response shaping) and a fixture: one full index of this repo over
 * a real stdio handshake, which is the only way to see what a client actually receives — the shaping
 * defects lived between the store and the wire, so a unit test on the store cannot see them.
 *
 * Two lessons from the issue are built into how this file asserts:
 *
 *  - **Never skip.** The identity gap survived `test-profile-responses.mjs` for as long as it did
 *    because the fixture symbol had no callers, so the assertions silently skipped. Anything that
 *    depends on the graph containing a particular shape asks the graph for one first.
 *  - **Assert the absence, not just the presence.** "no duplicate rows" and "no backslash" are the
 *    actual defects; a test that only checks a field exists would have passed before the fix.
 *
 * Usage: node scripts/test/test-issue-049-shapes.mjs   (requires `npm run build` first)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempDbPath } from "./_fixtures.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

function readJson(result) {
  const text = Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "")
    : "";
  try { return JSON.parse(text); } catch { return null; }
}

/** Recursively collect every string value under a path-ish key, to prove path style is uniform. */
function collectPathLikeStrings(value, out = []) {
  if (typeof value === "string") {
    if (/[/\\]/.test(value) && /\.(ts|js|cs|md|json)$/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPathLikeStrings(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectPathLikeStrings(v, out);
  }
  return out;
}

async function main() {
  const repoPath = process.cwd();
  const repoId = "issue-049-repo";

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath,
      CODEBASE_INDEX_DB_PATH: makeTempDbPath("cbi-issue049-"),
      // The docs lane is off by default; query_docs throws without it and its envelope is
      // three of the assertions below.
      CODEBASE_INDEX_DOCS_TOOLS_ENABLED: "true",
      CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "true"
    },
    stderr: "pipe"
  });
  transport.onerror = (e) => console.error("[transport-error]", e);

  const client = new Client({ name: "issue-049-shapes", version: "0.1.0" });
  await client.connect(transport);

  const call = (name, args, timeout = 60_000) =>
    client.callTool({ name, arguments: args }, undefined, { timeout });

  console.log("\n[setup] indexing this repo (docs lane on)...");
  const indexed = readJson(await call("index_repository", { repoId, repoPath, mode: "full", docsMode: "on" }));
  if (!indexed?.runId) throw new Error("indexing failed — no runId");
  console.log(`  ${indexed.filesIndexed} files, ${indexed.symbolsUpserted} symbols`);

  // ── query_docs: one envelope for all three modes ───────────────────────────
  console.log("\n[query_docs] one envelope, three modes");
  const sym = readJson(await call("search_symbols", { repoId, query: "GraphStore", strategy: "name", profile: "standard", limit: 1 }));
  const anySymbolId = sym?.symbols?.[0]?.symbolId;
  assert(typeof anySymbolId === "string", "resolved a symbolId for the stale-docs mode");

  const modes = [
    ["search", { repoId, mode: "search", query: "pipeline" }],
    ["stale", { repoId, mode: "stale", symbolIds: [anySymbolId] }],
    ["coverage", { repoId, mode: "coverage", filePath: "src/repositories/graphStore.ts" }]
  ];
  for (const [label, args] of modes) {
    const body = readJson(await call("query_docs", args));
    // The defect: search returned an object while stale/coverage returned bare arrays, so the same
    // tool answered in three shapes and the caller had to branch on the mode it just requested.
    assert(body != null && !Array.isArray(body), `mode=${label} returns an object, not a bare array`, JSON.stringify(body)?.slice(0, 120));
    assert(body?.mode === label, `mode=${label} echoes its mode`);
    assert(typeof body?.count === "number", `mode=${label} has count`);
    assert(Array.isArray(body?.results), `mode=${label} has results[]`);
    assert(body?.repoId === repoId, `mode=${label} echoes repoId`);
  }

  // includeSymbols defaults off: a docs search must not answer with code symbols.
  const docsDefault = readJson(await call("query_docs", { repoId, mode: "search", query: "pipeline", limit: 20 }));
  const symbolRows = (docsDefault?.results ?? []).filter((r) => r.contentType === "symbol");
  assert(symbolRows.length === 0, "mode=search does not pad with code symbols by default", `got ${symbolRows.length}`);

  // mode=stale must count PROSE mentions only. The filed false positive was five hits in
  // `docs/**/_archive/**` for `ConversationLoopCorrelationCodec.Parse`, every one a `Parse(` inside
  // a pasted C# snippet — `extractMentionsFromCode` harvested every `identifier(` in a fenced block
  // and labelled it `backtick`. Asserted as a pair: excluding by default AND returning them on
  // opt-in, because "count went to zero" alone would also be satisfied by having broken the lane.
  // Asserted over a BATCH rather than a hand-picked symbol: `doc_mentions` is not in query_graph's
  // table allowlist, so the harness cannot ask which symbol has a code_call mention. A batch makes
  // the invariant hold without needing to know.
  const batch = readJson(await call("query_graph", {
    repoId,
    sql: "select symbol_id as sid from symbols where repo_id = :repoId and kind in ('method','function') limit 100",
    profile: "compact"
  }));
  const batchIds = (batch?.rows ?? []).map((r) => r.sid).slice(0, 100);
  assert(batchIds.length > 0, "collected a symbol batch for the staleness check");
  const strict = readJson(await call("query_docs", { repoId, mode: "stale", symbolIds: batchIds }));
  const loose = readJson(await call("query_docs", { repoId, mode: "stale", symbolIds: batchIds, includeCodeMentions: true }));
  assert((strict?.results ?? []).every((r) => r.mentionType !== "code_call"), "mode=stale excludes code_call by default", JSON.stringify([...new Set((strict?.results ?? []).map((r) => r.mentionType))]));
  assert(loose.count >= strict.count, "includeCodeMentions=true is a superset, never smaller", `strict=${strict.count} loose=${loose.count}`);
  if (loose.count > strict.count) {
    assert((loose?.results ?? []).some((r) => r.mentionType === "code_call"), "the extra opted-in rows are labelled code_call");
  } else {
    console.log(`  [note] this repo's docs yield no resolved code_call mention for the batch (strict=loose=${strict.count}); the exclusion is proven on wec.communication-hub, where it cut 5 false hits for ConversationLoopCorrelationCodec.Parse to 0`);
  }

  // ── find_impact_files{view:"surface"} ──────────────────────────────────────
  console.log("\n[find_impact_files] surface: merged rows, groupBy honoured");
  const target = "src/repositories/graphStore.ts";
  const surface = readJson(await call("find_impact_files", { repoId, filePath: target, view: "surface", limit: 200 }));
  const callers = surface?.callers ?? [];
  assert(Array.isArray(callers) && callers.length > 0, "surface returns callers", JSON.stringify(surface)?.slice(0, 160));
  assert(callers.every((c) => Array.isArray(c.edgeTypes)), "every caller carries edgeTypes[]");
  assert(callers.every((c) => c.edgeType === undefined), "the old scalar edgeType is gone");
  // The actual defect: one row per edge type, so a caller reaching a symbol by both CALLS and
  // TYPE_REF appeared twice and the count double-counted it.
  const pairKeys = callers.map((c) => `${c.callerFile}|${c.callerName}|${c.callerLine}|${c.symbolAffected}`);
  assert(new Set(pairKeys).size === pairKeys.length, "no duplicate caller→symbol pair", `${pairKeys.length} rows, ${new Set(pairKeys).size} distinct`);

  const grouped = readJson(await call("find_impact_files", { repoId, filePath: target, view: "surface", groupBy: "module", limit: 200 }));
  // `groupBy` used to be unreachable in this branch: the handler returned before reading it.
  assert(Array.isArray(grouped?.moduleGroups), "surface + groupBy:module returns moduleGroups", JSON.stringify(grouped)?.slice(0, 160));
  assert(grouped?.groupBy === "module", "surface echoes groupBy so an ignored parameter cannot hide");
  assert(grouped?.callers === undefined, "grouped output does not also ship the ungrouped list");

  // ── trace_execution_flow nano: distinct callees ────────────────────────────
  console.log("\n[trace_execution_flow] nano topCallees are distinct");
  const callable = readJson(await call("query_graph", {
    repoId,
    sql: `select e.from_id as fromId, count(*) as n from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          where e.repo_id = :repoId and e.type = 'CALLS'
          group by e.from_id order by n desc limit 1`,
    profile: "compact"
  }));
  const busiest = callable?.rows?.[0]?.fromId;
  assert(typeof busiest === "string", "found the busiest calling symbol");
  const flow = readJson(await call("trace_execution_flow", { repoId, entrySymbolId: busiest, maxDepth: 4, profile: "nano" }));
  const top = flow?.topCallees ?? [];
  assert(Array.isArray(top) && top.length > 0, "nano returns topCallees", JSON.stringify(flow)?.slice(0, 160));
  // The defect: `edges.slice(0,10).map(toName)` returned NotifyAsync four times, so the 10-item cap
  // was spent on repeats and distinct callees never appeared.
  assert(new Set(top).size === top.length, "topCallees has no repeats", JSON.stringify(top));

  // ── get_dependency_graph{filePath}: no self-references ─────────────────────
  console.log("\n[get_dependency_graph] no self-TYPE_REF, no duplicate endpoints");
  const flowGraph = readJson(await call("get_dependency_graph", { repoId, filePath: target, limit: 300 }));
  const gEdges = flowGraph?.edges ?? [];
  assert(gEdges.length > 0, "returns edges for the file");
  assert(gEdges.every((e) => e.fromId !== e.toId), "no edge points a symbol at itself");
  const endpointKeys = gEdges.map((e) => `${e.fromFilePath}|${e.toId}|${e.type}`);
  assert(new Set(endpointKeys).size === endpointKeys.length, "no duplicate (file, target, type)", `${endpointKeys.length} vs ${new Set(endpointKeys).size}`);

  // ── excludeTests reaches the six tools ─────────────────────────────────────
  console.log("\n[excludeTests] accepted by all six, and actually filters");
  const isTestish = (p) => /(^|\/)(__tests__|tests?)\//i.test(p ?? "") || /\.(test|spec)\.[^.]+$/i.test(p ?? "");

  // search_literals — this repo has literals in src/**/*.test.ts, so filtering is observable.
  const litAll = readJson(await call("search_literals", { repoId, query: "expected", limit: 200 }));
  const litNo = readJson(await call("search_literals", { repoId, query: "expected", limit: 200, excludeTests: true }));
  assert((litNo?.literals ?? []).every((l) => !isTestish(l.filePath)), "search_literals: no test paths survive");
  assert((litNo?.count ?? 0) <= (litAll?.count ?? 0), "search_literals: filtered count does not grow");

  // get_symbol_context_pack — candidates AND callers must both honour it.
  const packNo = readJson(await call("get_symbol_context_pack", { repoId, name: "isTestPath", excludeTests: true }));
  const packPaths = [
    ...(packNo?.candidates ?? []).map((c) => c.filePath),
    ...(packNo?.context?.callers ?? []).map((c) => c.callerFile)
  ];
  assert(packPaths.length > 0, "context pack returned something to filter", JSON.stringify(packNo)?.slice(0, 160));
  assert(packPaths.every((p) => !isTestish(p)), "get_symbol_context_pack: no test paths in candidates or callers", JSON.stringify(packPaths.filter(isTestish)));

  // The remaining four are C#-oriented or cross-repo, and return empty on this TypeScript repo.
  // What is asserted is that the parameter is ACCEPTED — a schema/inputSchema mismatch would make
  // the call an error result, which is the failure mode that matters for a contract change.
  for (const [name, args] of [
    ["find_implementations", { repoId, interfaceName: "IEndpointGroup", excludeTests: true }],
    ["route_map", { repoId, excludeTests: true }],
    ["get_value_contract_impact", { value: "resolved", repoIds: [repoId], excludeTests: true }],
    ["get_feature_bundle", { repoId, seedSymbol: "GraphStore", includeSource: false, excludeTests: true }]
  ]) {
    const res = await call(name, args);
    assert(res?.isError !== true, `${name} accepts excludeTests`, JSON.stringify(readJson(res))?.slice(0, 160));
  }

  // ── health_check without repoId ────────────────────────────────────────────
  console.log("\n[health_check] no repoId reports no unmeasured numbers");
  const bare = readJson(await call("health_check", {}));
  assert(bare?.scope === "server", "server-scoped call says so", JSON.stringify(bare?.scope));
  // The defect: `symbolsIndexed: 0` where nothing had been counted, which reads as "index is empty".
  assert(bare?.vectorIndex?.symbolsIndexed === undefined, "symbolsIndexed omitted, not zeroed", JSON.stringify(bare?.vectorIndex));
  assert(typeof bare?.note === "string", "explains that repoId is needed for repo-scoped state");
  const scoped = readJson(await call("health_check", { repoId }));
  assert(scoped?.scope === "repo", "repo-scoped call says so");

  // ── get_file_context vs get_file_summary: one symbolCount ──────────────────
  console.log("\n[symbolCount] the two tools agree");
  // `getFileSummaryImpl` caps `exports` at 50, so equality only holds for a file below that cap.
  // Chosen from the graph rather than hardcoded: a hardcoded file grows past 50 one day and the
  // assertion quietly stops testing anything — which is the same silent-skip failure this whole
  // harness is written to avoid. The module pseudo-symbol is excluded from the count for the same
  // reason the tools now exclude it.
  const smallFile = readJson(await call("query_graph", {
    repoId,
    sql: `select file_path as filePath, count(*) as n from symbols
          where repo_id = :repoId and kind != 'module'
          group by file_path having n between 3 and 40 order by n desc limit 1`,
    profile: "compact"
  }));
  const countTarget = smallFile?.rows?.[0]?.filePath;
  assert(typeof countTarget === "string", "found a file below the 50-export cap", JSON.stringify(smallFile?.rows));

  const ctx = readJson(await call("get_file_context", { repoId, filePath: countTarget, profile: "compact" }));
  const sum = readJson(await call("get_file_summary", { repoId, filePath: countTarget, profile: "compact" }));
  const ctxCount = (ctx?.symbols ?? []).length;
  assert(ctxCount > 0 && sum?.symbolCount > 0, "both tools returned symbols", `ctx=${ctxCount} sum=${sum?.symbolCount}`);
  assert((ctx?.symbols ?? []).every((s) => s.kind !== "module"), "get_file_context excludes the module pseudo-symbol");
  // The defect: 7 vs 6 for the same file, because one counted the module row and the other did not.
  assert(ctxCount === sum.symbolCount, "get_file_context and get_file_summary report the same symbolCount", `${countTarget}: ctx=${ctxCount} sum=${sum.symbolCount}`);

  // Imports must survive the module-symbol exclusion: they hang off that very symbol, so filtering
  // it out of the EDGE query too would have silently emptied every import list.
  const ctxFull = readJson(await call("get_file_context", { repoId, filePath: target, profile: "standard", limit: 400 }));
  assert((ctxFull?.edges ?? []).some((e) => e.type === "IMPORTS"), "IMPORTS edges survive excluding the module symbol");

  // ── rename_assist advisory includes the declaring file ─────────────────────
  console.log("\n[rename_assist] advisory matches what an apply would touch");
  const renameTarget = readJson(await call("search_symbols", { repoId, query: "isTestPath", strategy: "name", profile: "standard", limit: 1 }));
  const renameId = renameTarget?.symbols?.[0]?.symbolId;
  assert(typeof renameId === "string", "resolved a symbol to rename");
  const advisory = readJson(await call("rename_assist", { repoId, symbolId: renameId, newName: "isTestFilePath" }));
  const declaring = advisory?.symbol?.filePath;
  assert(typeof declaring === "string", "advisory reports the declaring file");
  assert((advisory?.affectedFiles ?? []).includes(declaring), "affectedFiles includes the declaring file", JSON.stringify(advisory?.affectedFiles));
  assert(advisory?.affectedFileCount === (advisory?.affectedFiles ?? []).length, "affectedFileCount matches affectedFiles length", `${advisory?.affectedFileCount} vs ${(advisory?.affectedFiles ?? []).length}`);
  // hints splice a path into a sentence, which the key-scoped normalizer cannot reach.
  assert((advisory?.hints ?? []).every((h) => !h.includes("\\")), "hints use forward slashes like affectedFiles", JSON.stringify(advisory?.hints?.filter((h) => h.includes("\\"))));

  // ── path style is uniform ──────────────────────────────────────────────────
  console.log("\n[paths] one convention, tools and resources alike");
  const graphRows = readJson(await call("query_graph", {
    repoId,
    sql: "select file_path, name from symbols where repo_id = :repoId limit 20",
    profile: "compact"
  }));
  const rowPaths = (graphRows?.rows ?? []).map((r) => r.file_path);
  assert(rowPaths.length > 0, "query_graph returned rows with file_path");
  assert(rowPaths.every((p) => !p.includes("\\")), "raw query_graph rows are forward-slash", JSON.stringify(rowPaths.filter((p) => p.includes("\\")).slice(0, 3)));

  const routesResource = await client.readResource({ uri: `repo://${repoId}/routes` });
  const routesBody = JSON.parse(routesResource.contents[0].text);
  const resourcePaths = collectPathLikeStrings(routesBody);
  assert(resourcePaths.every((p) => !p.includes("\\")), "repo://.../routes resource is forward-slash", JSON.stringify(resourcePaths.filter((p) => p.includes("\\")).slice(0, 3)));

  const contextResource = await client.readResource({ uri: `repo://${repoId}/context` });
  const contextPaths = collectPathLikeStrings(JSON.parse(contextResource.contents[0].text));
  assert(contextPaths.every((p) => !p.includes("\\")), "repo://.../context resource is forward-slash", JSON.stringify(contextPaths.filter((p) => p.includes("\\")).slice(0, 3)));

  console.log(`\n[results] ${passed} passed, ${failed} failed`);
  await client.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
