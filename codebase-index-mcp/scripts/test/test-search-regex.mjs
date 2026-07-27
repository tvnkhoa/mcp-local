import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath
    },
    stderr: "pipe"
  });
  transport.onerror = (error) => console.error("[transport-error]", error);

  const client = new Client({ name: "codebase-index-mcp-regex-test", version: "0.1.0" });
  await client.connect(transport);

  const toolNames = (await client.listTools()).tools.map((t) => t.name);
  if (!toolNames.includes("search_regex")) {
    throw new Error("search_regex not registered in listTools");
  }

  const indexResult = await client.callTool(
    { name: "index_repository", arguments: { repoId, repoPath, mode: "incremental", maxFiles: 1000 } },
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

  // 2. scanAll: a JSON file (never indexed) is only matched when scanAll=true.
  const jsonPattern = "compilerOptions"; // present in tsconfig.json, a non-indexed file
  const defaultScan = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: jsonPattern, limit: 200 } })
  ).json;
  const scanAllScan = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: jsonPattern, limit: 200, scanAll: true } })
  ).json;
  const defaultJsonHits = (defaultScan?.matches ?? []).filter((m) => m.filePath.endsWith(".json")).length;
  const scanAllJsonHits = (scanAllScan?.matches ?? []).filter((m) => m.filePath.endsWith(".json")).length;
  if (defaultJsonHits !== 0) {
    throw new Error(`Expected 0 .json matches without scanAll, got ${defaultJsonHits} (json files should not be indexed)`);
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
  const multiPrefix = readJsonTextContent(
    await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "import", filePathPrefix: ["src/", "scripts/"], limit: 500 } })
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

  await client.close();
  console.log("SEARCH_REGEX_TEST_PASSED");
}

main().catch((error) => {
  console.error("SEARCH_REGEX_TEST_FAILED:", error);
  process.exit(1);
});
