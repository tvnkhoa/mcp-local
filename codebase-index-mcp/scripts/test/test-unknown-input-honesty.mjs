/**
 * MCP-ISSUE-060 — a question the server cannot answer must not come back as a confident answer.
 *
 * The audit's most damaging finding was not a wrong number, it was a well-formed empty result that
 * asserted its own reliability. Measured before this suite existed:
 *
 *   get_call_chain(repoId:"bogus", symbolId:<real id from another repo>)
 *     → {"edges":[], "coverage":{"confidence":"high", ...}}
 *   find_impact_files(filePath:"src/does/not/exist.ts")
 *     → {"totalImpactedCount":0, "graphHealth":{"note":"graph data complete"},
 *        "reliabilitySummary":{"medianConfidence":1}}
 *   query_graph(repoId:"bogus", ...)          → {"rowCount":1,"rows":[{"c":0}]}
 *   find_symbol_at_line(filePath:"nope.ts")   → an object with no `symbol` key and no hint
 *
 * An agent reading any of those stops looking. Silence would have been safer; "high" is worse than
 * an error. This suite pins that every repoId-taking tool refuses an unknown repo, and — separately —
 * that the refusal arrives with the ERROR code for a bad input rather than as a plausible zero.
 *
 * It also pins the precedence that a first attempt at this fix got wrong: the check is a guard, so it
 * runs AFTER zod validation. A structurally invalid call must still answer VALIDATION_ERROR rather
 * than being pre-empted by a complaint about one field.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => (Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "");
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const tmpDir = makeTempDir("input-honesty-");
const repoId = `honesty-${Date.now()}`;
mkdirSync(join(tmpDir, "src"), { recursive: true });
writeFileSync(join(tmpDir, "src", "a.ts"), "export function alpha(): number { return 1; }\n", "utf8");
writeFileSync(join(tmpDir, "src", "b.ts"), "import { alpha } from './a.js';\nexport function beta(): number { return alpha(); }\n", "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir,
    CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"),
    CODEBASE_INDEX_LLM_ENABLED: "false"
  },
  stderr: "pipe"
});
const client = new Client({ name: "input-honesty-test", version: "0.1.0" });
await client.connect(transport);

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  // ── 1. An unknown repoId is refused, by every tool that takes one ─────────────────────────
  const BOGUS = "no-such-repo-xyz";
  const unknownRepoCalls = [
    ["get_call_chain", { repoId: BOGUS, symbolId: "0123456789abcdef01234567", direction: "callers" }],
    ["get_dependency_graph", { repoId: BOGUS, filePath: "src/a.ts" }],
    ["find_impact_files", { repoId: BOGUS, filePath: "src/a.ts" }],
    ["query_graph", { repoId: BOGUS, sql: "select count(*) as c from symbols where repo_id = :repoId" }],
    ["find_symbol_at_line", { repoId: BOGUS, filePath: "src/a.ts", line: 1 }],
    ["get_folder_summary", { repoId: BOGUS, folderPath: "src" }],
    ["get_file_summary", { repoId: BOGUS, filePath: "src/a.ts" }],
    ["route_map", { repoId: BOGUS }],
    ["search_symbols", { repoId: BOGUS, query: "alpha", strategy: "name" }],
    ["get_symbol_context_pack", { repoId: BOGUS, name: "alpha" }],
    ["dead_code_scan", { repoId: BOGUS }],
    ["detect_changes", { repoId: BOGUS }]
  ];

  for (const [name, args] of unknownRepoCalls) {
    const res = await client.callTool({ name, arguments: args });
    const body = js(res);
    const isError = res?.isError === true;
    assert(isError, `${name}: an unknown repoId is an error, not an empty result`, JSON.stringify(body)?.slice(0, 160));
    if (isError) {
      assert(
        typeof body?.message === "string" && body.message.includes(BOGUS),
        `${name}: the message names the repoId that could not be resolved`,
        JSON.stringify(body)?.slice(0, 160)
      );
    }
    // The specific trap: a confident empty answer. Never acceptable for a repo that does not exist.
    const raw = txt(res);
    assert(
      !raw.includes('"confidence":"high"') && !raw.includes('"graph data complete"'),
      `${name}: does not assert confidence about a repo that does not exist`,
      raw.slice(0, 160)
    );
  }

  // ── 2. Precedence: validation still comes first ───────────────────────────────────────────
  const badShape = await client.callTool({
    name: "get_call_chain",
    arguments: { repoId: BOGUS, symbolId: 12345, direction: "sideways" }
  });
  const badShapeBody = js(badShape);
  assert(
    badShapeBody?.code === "VALIDATION_ERROR",
    "a malformed call answers VALIDATION_ERROR, not a complaint about repoId",
    JSON.stringify(badShapeBody)?.slice(0, 200)
  );

  // ── 3. The exemptions are real ────────────────────────────────────────────────────────────
  const health = await client.callTool({ name: "health_check", arguments: { repoId: BOGUS } });
  assert(
    health?.isError !== true,
    "health_check still answers for an unregistered repo — that is how an agent learns to index",
    txt(health).slice(0, 160)
  );

  // ── 4. A real repoId is untouched ─────────────────────────────────────────────────────────
  const good = js(await client.callTool({ name: "search_symbols", arguments: { repoId, query: "alpha", strategy: "name" } }));
  assert((good?.count ?? 0) > 0, "a valid repoId still returns results", JSON.stringify(good)?.slice(0, 160));
  assert(
    Array.isArray(good?.symbols) && typeof good.symbols[0]?.symbolId === "string",
    "search_symbols carries symbolId at the default profile, so the next call can chain",
    JSON.stringify(good?.symbols?.[0] ?? null)
  );

  // ── 5. An unindexed FILE is distinguished from an empty one ───────────────────────────────
  const ghost = js(await client.callTool({ name: "find_impact_files", arguments: { repoId, filePath: "src/never-existed.ts" } }));
  assert(
    ghost?.fileIndexed === false,
    "a path absent from the index says so, instead of reporting zero dependents",
    JSON.stringify(ghost)?.slice(0, 200)
  );

  // ── 6. Truncation is reported at every profile, not only nano ─────────────────────────────
  for (const profile of ["nano", "compact", "standard", "verbose"]) {
    const routes = js(await client.callTool({ name: "route_map", arguments: { repoId, profile } }));
    assert(
      routes !== null && "hasMore" in routes,
      `route_map(${profile}) reports whether the list is a page`,
      JSON.stringify(routes)?.slice(0, 160)
    );
  }
} finally {
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
