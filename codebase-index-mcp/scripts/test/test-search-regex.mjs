import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { makeTempDbPath } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";
import "./_indexWait.mjs";

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

async function main() {
  const repoPath = process.cwd();
  const repoId = "regex-test-repo";
  // Step 12 writes a fake second repo into the DB: only into the harness's own temp DB, never a caller's.
  const ownDb = !process.env.CODEBASE_INDEX_DB_PATH;
  const dbPath = process.env.CODEBASE_INDEX_DB_PATH ?? makeTempDbPath("cbi-regex-");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath,
      CODEBASE_INDEX_DB_PATH: dbPath
    },
    stderr: "pipe"
  });
  transport.onerror = (error) => console.error("[transport-error]", error);

  const client = new Client({ name: "codebase-index-mcp-regex-test", version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, "test-search-regex");

  const toolNames = (await client.listTools()).tools.map((t) => t.name);
  if (!toolNames.includes("search_regex")) {
    throw new Error("search_regex not registered in listTools");
  }

  const indexResult = await client.callTool(
    { name: "index_repository", arguments: { wait: true, repoId, repoPath, mode: "incremental", maxFiles: 1000 } },
    undefined,
    { timeout: 180_000 }
  );
  if (!readJsonTextContent(indexResult).json?.runId) {
    throw new Error("index_repository result missing runId");
  }

  // 1. Pattern hitting a known symbol → match with enclosingSymbol populated.
  const symbolHit = await client.callTool({
    name: "search_regex",
    arguments: { repoId, pattern: "searchRegexImpl", limit: 50, profile: "compact" }
  });
  const symbolHitJson = readJsonTextContent(symbolHit).json;
  if (!symbolHitJson || typeof symbolHitJson.count !== "number" || !Array.isArray(symbolHitJson.matches)) {
    throw new Error("search_regex response missing count/matches fields");
  }
  if (symbolHitJson.count < 1) {
    throw new Error("search_regex('searchRegexImpl') returned 0 — expected hits in regexSearch.ts/graphStore.ts");
  }
  if (!symbolHitJson.matches.some((m) => m.enclosingSymbol && typeof m.enclosingSymbol.name === "string")) {
    throw new Error("search_regex did not populate enclosingSymbol on any match");
  }
  console.log("SYMBOL_HIT_OK:", { count: symbolHitJson.count, firstFile: symbolHitJson.matches[0]?.filePath });

  // 2. JSON is indexed since release F (MCP-ISSUE-076, language `json`), so the default (index-backed)
  // mode finds tsconfig.json without scanAll — this used to assert the opposite — and scanAll still does.
  // This repo tracks no file of an unmapped extension any more, so the scanAll-only contrast is not
  // reproducible here.
  const jsonPattern = "compilerOptions"; // present in tsconfig.json
  const defaultScan = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: jsonPattern, limit: 200 } })
  ).json;
  const scanAllScan = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: jsonPattern, limit: 200, scanAll: true } })
  ).json;
  const defaultJsonHits = (defaultScan?.matches ?? []).filter((m) => m.filePath.endsWith(".json")).length;
  const scanAllJsonHits = (scanAllScan?.matches ?? []).filter((m) => m.filePath.endsWith(".json")).length;
  if (defaultJsonHits < 1) {
    throw new Error(`Expected >=1 .json match without scanAll, got ${defaultJsonHits} (json files are indexed, MCP-ISSUE-076)`);
  }
  if (scanAllJsonHits < 1) {
    throw new Error("Expected >=1 .json match with scanAll=true (tsconfig.json contains 'compilerOptions')");
  }
  console.log("SCAN_ALL_OK:", { defaultJsonHits, scanAllJsonHits });

  // 3. Invalid regex → clean InvalidParams error, not a crash.
  let invalidErrored = false;
  try {
    const bad = await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "(" } });
    invalidErrored = Boolean(bad?.isError);
  } catch {
    invalidErrored = true;
  }
  if (!invalidErrored) {
    throw new Error("search_regex('(') should have returned an InvalidParams error");
  }
  console.log("INVALID_PATTERN_OK");

  // 4. Cross-line pattern → must match (whole-file matching, not line-by-line).
  const multiline = readJsonTextContent(
    await client.callTool({
      name: "search_regex",
      arguments: { repoId, pattern: "super\\(message\\);\\s+this\\.code", limit: 10, profile: "standard" }
    })
  ).json;
  if (!multiline || multiline.count < 1) {
    throw new Error("search_regex did not match a cross-line pattern — line-by-line scanning regression");
  }
  if (!multiline.matches.some((m) => m.matchText.includes("\n"))) {
    throw new Error("search_regex cross-line match did not span a newline in matchText");
  }
  console.log("MULTILINE_OK:", { count: multiline.count });

  // 5. High-frequency pattern with a small limit → truncation signal fires, cap holds.
  const truncated = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "import", limit: 3 } })
  ).json;
  if (!truncated || truncated.matches.length > 3) {
    throw new Error(`search_regex(limit=3) returned ${truncated?.matches?.length} matches — cap not respected`);
  }
  if (truncated.truncated !== true || truncated.truncationReason !== "limit_reached") {
    throw new Error("search_regex(limit=3) did not surface truncated/truncationReason=limit_reached");
  }
  if (truncated.complete !== false || typeof truncated.warning !== "string" || typeof truncated.nextAfterPath !== "string") {
  throw new Error("search_regex(limit=3) did not surface complete:false + warning + nextAfterPath");
}
  // IX-C: the caller's own limit cut it → a limitHint naming the max and outputMode:"files"; a complete answer has none.
  if (typeof truncated.limitHint !== "string" || !/max \d+/.test(truncated.limitHint) || !truncated.limitHint.includes('outputMode:"files"')) {
    throw new Error(`IX-C: search_regex(limit=3) missing limitHint (max + outputMode:"files"): ${truncated.limitHint}`);
  }
  if (multiline.complete !== true || "limitHint" in multiline) {
    throw new Error("IX-C: a complete search_regex answer must not carry limitHint");
  }
console.log("TRUNCATION_OK:", { count: truncated.matches.length, reason: truncated.truncationReason });

  // 6. ISSUE-027: compact (default) profile returns the contextLines window per match.
  const ctxCompact = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "searchRegexImpl", contextLines: 2, limit: 10 } })
  ).json;
  if (!ctxCompact.matches.some((m) => Array.isArray(m.beforeContext) && Array.isArray(m.afterContext))) {
    throw new Error("ISSUE-027: compact profile did not return beforeContext/afterContext when contextLines=2");
  }
  const ctxZero = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "searchRegexImpl", contextLines: 0, limit: 10 } })
  ).json;
  if (ctxZero.matches.some((m) => "beforeContext" in m || "afterContext" in m)) {
    throw new Error("ISSUE-027: contextLines=0 should omit before/afterContext in compact");
  }
  console.log("COMPACT_CONTEXT_OK:", { withCtx: ctxCompact.matches[0]?.beforeContext?.length ?? 0 });

  // 7. ISSUE-028: filePathPrefix array (OR-semantics) returns hits from multiple subtrees.
  // A rare token present in both: `import` filled the 500-row page from scripts/ alone (paths sort
  // scripts/ before src/) once scripts/ passed 500 import lines — release K's new harness tipped it.
  const multiPrefix = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "searchRegexImpl", filePathPrefix: ["src/", "scripts/"], limit: 500 } })
  ).json;
  const fromSrc = multiPrefix.matches.some((m) => m.filePath.startsWith("src/"));
  const fromScripts = multiPrefix.matches.some((m) => m.filePath.startsWith("scripts/"));
  if (!fromSrc || !fromScripts) {
    throw new Error(`ISSUE-028: filePathPrefix array did not OR across subtrees (src=${fromSrc}, scripts=${fromScripts})`);
  }
  // single-string form unchanged
  const singlePrefix = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "import", filePathPrefix: "scripts/", limit: 500 } })
  ).json;
  if (singlePrefix.matches.some((m) => !m.filePath.startsWith("scripts/"))) {
    throw new Error("ISSUE-028: single-string filePathPrefix leaked matches outside the prefix");
  }
  console.log("MULTI_PREFIX_OK:", { multi: multiPrefix.matches.length, single: singlePrefix.matches.length });

  // 8. ISSUE-028: pathExclude glob subtracts a subtree that the include set otherwise covers.
  const excluded = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "import", filePathPrefix: ["src/", "scripts/"], pathExclude: "scripts/**", limit: 500 } })
  ).json;
  if (excluded.matches.some((m) => m.filePath.startsWith("scripts/"))) {
    throw new Error("ISSUE-028: pathExclude 'scripts/**' did not remove the scripts subtree");
  }
  if (!excluded.matches.some((m) => m.filePath.startsWith("src/"))) {
    throw new Error("ISSUE-028: pathExclude over-removed — expected src/ hits to remain");
  }
  console.log("PATH_EXCLUDE_OK:", { remaining: excluded.matches.length });

  // 9. IX-C: contextLines max is 20 — 20 accepted and honoured (≤ 20 lines each side, > 10 somewhere), 21 rejected.
  const ctx20 = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "searchRegexImpl", contextLines: 20, limit: 10, profile: "standard" } })
  ).json;
  if (!ctx20 || !Array.isArray(ctx20.matches) || ctx20.matches.length < 1) throw new Error("IX-C: contextLines:20 returned no matches");
  if (ctx20.matches.some((m) => m.beforeContext.length > 20 || m.afterContext.length > 20)) {
    throw new Error("IX-C: contextLines:20 returned more than 20 lines on a side");
  }
  if (!ctx20.matches.some((m) => m.beforeContext.length > 10 || m.afterContext.length > 10)) {
    throw new Error("IX-C: contextLines:20 never returned more than 10 lines on a side — still capped at 10?");
  }
  let ctx21Rejected = false;
  try {
    ctx21Rejected = Boolean((await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "searchRegexImpl", contextLines: 21 } }))?.isError);
  } catch {
    ctx21Rejected = true;
  }
  if (!ctx21Rejected) throw new Error("IX-C: contextLines:21 should be rejected");
  console.log("CONTEXT_LINES_20_OK");

  // 10. IX-C: get_symbol_source by symbolId alone resolves the one repo holding it.
  const found = readJsonTextContent(
    await client.callTool({ name: "search_symbols", arguments: { repoId, query: "searchRegexImpl", strategy: "name", limit: 5 } })
  ).json;
  const symbolId = found?.symbols?.find((s) => s.name === "searchRegexImpl")?.symbolId;
  if (typeof symbolId !== "string") throw new Error("IX-C: search_symbols did not find searchRegexImpl");
  const bare = await client.callTool({ name: "get_symbol_source", arguments: { symbolId } });
  const bareJson = readJsonTextContent(bare).json;
  if (bare.isError || bareJson?.symbolId !== symbolId || !String(bareJson?.source).includes("searchRegexImpl")) {
    throw new Error(`IX-C: get_symbol_source(symbolId only) did not resolve: ${readTextContent(bare)}`);
  }
  // 11. not found anywhere; and a name lookup without repoId stays an error.
  const missing = await client.callTool({ name: "get_symbol_source", arguments: { symbolId: "0".repeat(24) } });
  if (!missing.isError || !/not found in any indexed repo/.test(readTextContent(missing))) {
    throw new Error(`IX-C: unknown symbolId without repoId should be not-found: ${readTextContent(missing)}`);
  }
  let byNameRejected = false;
  try {
    byNameRejected = Boolean((await client.callTool({ name: "get_symbol_source", arguments: { name: "searchRegexImpl" } }))?.isError);
  } catch {
    byNameRejected = true;
  }
  if (!byNameRejected) throw new Error("IX-C: get_symbol_source(name, no repoId) should be an error");
  // 12. two registered repos holding the same symbolId → a deterministic ambiguity error naming both.
  if (!ownDb) {
    console.log("SYMBOL_SOURCE_AMBIGUITY_SKIPPED: CODEBASE_INDEX_DB_PATH is set; the two-repo fixture only goes into the harness's own temp DB");
    console.log("SYMBOL_SOURCE_REPO_RESOLUTION_OK");
    await client.close();
    console.log("SEARCH_REGEX_TEST_PASSED");
    return;
  }
  const otherRepoId = "regex-test-repo-b";
  const db = new Database(dbPath);
  try {
    db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)").run(otherRepoId, repoPath, new Date().toISOString());
    db.prepare(
      "insert into symbols (repo_id, symbol_id, file_path, name, kind, line, end_line, signature, parent_symbol_id) " +
        "select ?, symbol_id, file_path, name, kind, line, end_line, signature, parent_symbol_id from symbols where repo_id = ? and symbol_id = ?"
    ).run(otherRepoId, repoId, symbolId);
  } finally {
    db.close();
  }
  const ambiguous = await client.callTool({ name: "get_symbol_source", arguments: { symbolId } });
  const ambiguousText = readTextContent(ambiguous);
  if (!ambiguous.isError || !ambiguousText.includes(`in 2 indexed repos (${repoId}, ${otherRepoId})`)) {
    throw new Error(`IX-C: same symbolId in two repos should be an ambiguity error naming both: ${ambiguousText}`);
  }
  const explicit = await client.callTool({ name: "get_symbol_source", arguments: { repoId, symbolId } });
  if (explicit.isError) throw new Error(`IX-C: an explicit repoId must still answer when the id is ambiguous: ${readTextContent(explicit)}`);
  console.log("SYMBOL_SOURCE_REPO_RESOLUTION_OK");

  await client.close();
  console.log("SEARCH_REGEX_TEST_PASSED");
}

main().catch((error) => {
  console.error("SEARCH_REGEX_TEST_FAILED:", error);
  process.exit(1);
});
