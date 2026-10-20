/**
 * MCP-ISSUE-075 — the CSS lane, end to end over real MCP stdio.
 *
 * Fixture: two stylesheets in a temp repo.
 *   src/styles/tokens.css — defines `--text-tertiary` twice (`:root` and a dark-theme override) and
 *                           `.unused-but-styled`;
 *   src/components/card.css — `@import`s tokens.css, uses `var(--text-tertiary)` from `.card-title`
 *                           and from a class-less `body` rule, and `var(--from-js)` which nothing
 *                           in the repo defines;
 *   src/pages/page.css    — uses `var(--text-tertiary)` with no @import, so its impact link is the
 *                           var() edge alone.
 * Asserts: search_symbols by `--text-tertiary` / `.card-title`, get_file_summary lists both kinds,
 * "who uses --text-tertiary" through get_call_chain and find_impact_files from EITHER definition,
 * the unresolved token is kept and labelled, @import resolves, and dead_code_scan reports no CSS
 * symbol. Then an incremental run that appends a third definition must re-fan existing users.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const DEBUG = process.env.CSS_HARNESS_DEBUG === "1";
const dump = (label, v) => { if (DEBUG) console.log(`--- ${label}\n${JSON.stringify(v, null, 1)?.slice(0, 3000)}`); };

const tmpDir = makeTempDir("css-symbols-");
const repoId = `css-symbols-${Date.now()}`;
const files = {
  "src/styles/tokens.css": `/* design tokens */
:root {
  --text-tertiary: #8a8a8a;
  --space-2: 8px;
}

[data-theme="dark"] {
  --text-tertiary: #6b6b6b;
}

.unused-but-styled {
  margin: var(--space-2);
}
`,
  "src/components/card.css": `@import "../styles/tokens.css";

.card {
  padding: var(--space-2);
}

.card .card-title {
  color: var(--text-tertiary);
  border-color: var(--from-js);
}

body {
  color: var(--text-tertiary);
}
`,
  // No @import: its only link to tokens.css is the var() use, so impact must come from USES_CSS_VAR.
  "src/pages/page.css": `.page-footer {
  color: var(--text-tertiary);
}
`
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(tmpDir, rel)), { recursive: true });
  writeFileSync(join(tmpDir, rel), text, "utf8");
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "css-symbols", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-css-symbols");
const call = async (name, args) => js(await client.callTool({ name, arguments: { repoId, ...args } }));

try {
  const indexed = await call("index_repository", { repoPath: tmpDir, mode: "full" });
  dump("index", indexed);
  assert(indexed && !indexed.error, "index_repository (full)", JSON.stringify(indexed)?.slice(0, 300));
  assert((indexed?.parseFailures ?? 0) === 0, "no parse failures", JSON.stringify(indexed)?.slice(0, 300));

  // ── search ──────────────────────────────────────────────────────────────────────────────
  const byVar = await call("search_symbols", { query: "--text-tertiary", limit: 10 });
  dump("search --text-tertiary", byVar);
  const varRows = (byVar?.results ?? byVar?.symbols ?? []).filter((r) => r.name === "--text-tertiary");
  assert(varRows.length === 2, "search_symbols('--text-tertiary') finds both definition sites", JSON.stringify(byVar)?.slice(0, 500));
  assert(varRows.every((r) => r.kind === "css_variable"), "as kind css_variable");

  const byClass = await call("search_symbols", { query: ".card-title", limit: 10 });
  dump("search .card-title", byClass);
  const classRows = byClass?.results ?? byClass?.symbols ?? [];
  assert(classRows[0]?.name === ".card-title" && classRows[0]?.kind === "css_class", "search_symbols('.card-title') ranks the class first", JSON.stringify(byClass)?.slice(0, 500));

  const byBare = await call("search_symbols", { query: "card-title", limit: 10 });
  assert((byBare?.results ?? byBare?.symbols ?? []).some((r) => r.name === ".card-title"), "search_symbols('card-title') finds it without the dot", JSON.stringify(byBare)?.slice(0, 300));

  // ── file summary ────────────────────────────────────────────────────────────────────────
  const summary = await call("get_file_summary", { filePath: "src/styles/tokens.css" });
  dump("file summary", summary);
  const summaryText = JSON.stringify(summary);
  assert(summaryText.includes("--text-tertiary") && summaryText.includes("--space-2") && summaryText.includes(".unused-but-styled"),
    "get_file_summary(tokens.css) lists the variables and the class", summaryText.slice(0, 500));

  // ── who uses --text-tertiary ────────────────────────────────────────────────────────────
  const defs = varRows.map((r) => r.symbolId);
  for (const [i, symbolId] of defs.entries()) {
    const chain = await call("get_call_chain", { symbolId, direction: "callers", depth: 1 });
    dump(`call chain ${i}`, chain);
    const chainText = JSON.stringify(chain);
    assert(chainText.includes(".card-title") && chainText.includes("card.css"),
      `get_call_chain(callers) from definition #${i + 1} lists .card-title`, chainText.slice(0, 500));
  }
  for (const view of ["files", "surface"]) {
    const impact = await call("find_impact_files", { filePath: "src/styles/tokens.css", view, profile: "verbose" });
    dump(`impact ${view}`, impact);
    assert(JSON.stringify(impact).includes("src/pages/page.css"), `find_impact_files(tokens.css, view:"${view}") lists page.css (var() use only)`, JSON.stringify(impact)?.slice(0, 500));
    if (view === "surface") {
      const callers = impact?.callers ?? [];
      assert(callers.some((c) => c.callerName === ".card-title" && c.symbolAffected === "--text-tertiary" && (c.edgeTypes ?? []).includes("USES_CSS_VAR")),
        "the surface names .card-title as a USES_CSS_VAR caller of --text-tertiary", JSON.stringify(callers).slice(0, 500));
    }
  }

  // ── labelled tokens and @import, read straight from the graph ───────────────────────────
  const edges = await call("query_graph", {
    sql: "select e.type, e.to_id as toId, e.reason, e.confidence from edges e where e.repo_id = :repoId and e.type in ('USES_CSS_VAR','IMPORTS') order by e.type, e.to_id",
    limit: 100
  });
  dump("edges", edges);
  const rows = edges?.rows ?? [];
  const fromJs = rows.filter((r) => r.toId === "cssvar:--from-js");
  assert(fromJs.length === 1 && fromJs[0].reason === "unresolved css variable token", "an undefined variable stays a labelled cssvar: token", JSON.stringify(fromJs));
  const multi = rows.filter((r) => r.type === "USES_CSS_VAR" && /2 definitions/.test(r.reason ?? ""));
  assert(multi.length === 6, "uses of --text-tertiary fan out to both definitions (3 users × 2 defs)", JSON.stringify(multi));
  const imp = rows.filter((r) => r.type === "IMPORTS");
  assert(imp.length === 1 && !String(imp[0].toId).startsWith("import:"), "@import resolves to the tokens.css module", JSON.stringify(imp));

  // ── dead code ──────────────────────────────────────────────────────────────────────────
  const dead = await call("dead_code_scan", { limit: 200, profile: "verbose" });
  dump("dead", dead);
  assert(!/css_(variable|class)|unused-but-styled|--space-2/.test(JSON.stringify(dead)), "dead_code_scan reports no CSS symbol", JSON.stringify(dead)?.slice(0, 500));

  // ── incremental: a third definition appended must reach the existing users ──────────────
  appendFileSync(join(tmpDir, "src/styles/tokens.css"), `\n.brand {\n  --text-tertiary: #777;\n}\n`, "utf8");
  const inc = await call("index_repository", { repoPath: tmpDir, mode: "incremental" });
  assert(inc && !inc.error, "index_repository (incremental)", JSON.stringify(inc)?.slice(0, 300));
  const after = await call("query_graph", {
    sql: "select count(*) as n from edges e where e.repo_id = :repoId and e.type = 'USES_CSS_VAR' and e.reason like '%3 definitions%'",
    limit: 1
  });
  dump("after incremental", after);
  assert((after?.rows?.[0]?.n ?? 0) === 9, "after an incremental run, users are bound to all three definitions (3 users × 3 defs)", JSON.stringify(after));

  // Full-vs-incremental: a full run over the same tree must land on the same CSS graph.
  const snapshot = async () => (await call("query_graph", {
    sql: "select e.type, s1.name as fromName, s1.line as fromLine, s2.name as toName, s2.line as toLine, e.to_id like 'cssvar:%' as token, e.reason from edges e left join symbols s1 on s1.repo_id = e.repo_id and s1.symbol_id = e.from_id left join symbols s2 on s2.repo_id = e.repo_id and s2.symbol_id = e.to_id where e.repo_id = :repoId order by 1,2,3,4,5,6,7",
    limit: 500
  }))?.rows ?? [];
  const incrementalGraph = JSON.stringify(await snapshot());
  const full = await call("index_repository", { repoPath: tmpDir, mode: "full" });
  assert(full && !full.error, "index_repository (full, again)");
  const fullGraph = JSON.stringify(await snapshot());
  assert(incrementalGraph === fullGraph, "incremental and full runs produce the same CSS edge set", `${incrementalGraph.slice(0, 300)} vs ${fullGraph.slice(0, 300)}`);
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
