/**
 * Release C (R5 citations, R6 invariant markers, code comments as prose) over real stdio and git.
 *
 * A temp repo carries its own `.codebase-index/citations.json` (the server ships no pattern), a
 * decision-log table, an ADR, a commented TS file and an invariant marker. Asserts: a shorthand
 * target resolves to its table row and lists every citer (docs and code, with the enclosing symbol);
 * a file's own citations resolve (testName anchor); comment prose is searchable; change_impact names
 * the invariant a test-file edit touches; and a committed config change re-scans UNCHANGED files.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
const posix = (p) => String(p).replace(/\\/g, "/");

const repo = makeTempDir("citations-");
const repoId = `cit-${Date.now()}`;
mkdirSync(join(repo, ".index"), { recursive: true });
mkdirSync(join(repo, ".codebase-index"), { recursive: true });
mkdirSync(join(repo, "docs", "adr"), { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "test"), { recursive: true });
// Format v1.1: `scan.codeStrings` opts the `owner: '…'` literal in checks/steps.mjs into the scan.
const config = (extra = [], scan = { codeStrings: ["owner"] }) => JSON.stringify({
  version: 1,
  scan,
  citations: [
    { id: "decision-row", pattern: "(?<![\\w/-])`?(?:docs/)?15`? #(\\d{1,4}[a-z]?)(?!\\w)", target: "docs/15-decision-log.md", anchor: { kind: "tableRow", column: 1, value: "{1}" } },
    { id: "adr", pattern: "\\badr/(\\d{4})\\b", target: "docs/adr/{1}-*.md", anchor: { kind: "file" } },
    { id: "inv", pattern: "<!--inv:by=test:([^#>]+)#([^>]*?)-->", target: "{1}", anchor: { kind: "testName", value: "{2}" } },
    ...extra
  ]
}, null, 1);
writeFileSync(join(repo, ".gitignore"), ".index/\n");
writeFileSync(join(repo, ".codebase-index", "citations.json"), config());
writeFileSync(join(repo, "docs", "15-decision-log.md"), "# 15 — Decision log\n\n| # | Date | Decision |\n|---|---|---|\n| 1 | 2026-10-01 | First |\n| 2 | 2026-10-02 | **Retry once, then escalate** (src/turn.ts) |\n");
writeFileSync(join(repo, "docs", "adr", "0021-boundaries.md"), "# ADR-0021 — Package boundaries\n\nKnowledge imports contracts only (`15` #2).\n");
writeFileSync(join(repo, "src", "turn.ts"), "export function runTurn(): number {\n  // A stage threw before the reply, so retry once (docs/15 #2).\n  return 1;\n}\n");
mkdirSync(join(repo, "checks"), { recursive: true });
// The `owner:` literal on line 3 cites row 2 (codeStrings). `note:` is another property, and the
// comment cites a different row, so neither one adds to the '15 #2' list.
writeFileSync(join(repo, "checks", "steps.mjs"), "// Gate steps (see docs/15 #1).\nexport const STEPS = [\n  { id: 'retry', owner: 'docs/15 #2 (retry rule)', note: 'docs/15 #2 is not an owner' },\n];\n");
writeFileSync(join(repo, "test", "tools.test.ts"), "import { it } from 'node:test';\nit('has no identity key', () => {});\n");
writeFileSync(join(repo, "CLAUDE.md"), "# Rules\n\nNo identity key in tools. <!--inv:by=test:test/tools.test.ts#has no identity key-->\nSee adr/0021.\n");
writeFileSync(join(repo, "NOTES.md"), "# Notes\n\nNothing cites anything here.\n");
git(repo, "init", "-q");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "one");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repo, CODEBASE_INDEX_DB_PATH: join(repo, ".index", "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "test-citations", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-citations");
const docs = async (args) => js(await client.callTool({ name: "query_docs", arguments: { repoId, profile: "standard", ...args } }));

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: repo, mode: "full" } });

  const row = await docs({ mode: "cites", target: "15 #2" });
  const r0 = row?.resolved?.[0];
  assert(r0?.status === "resolved" && posix(r0.file) === "docs/15-decision-log.md" && r0.line === 6 && /Retry once/.test(r0.text ?? ""), "shorthand '15 #2' resolves to its table row, with the row text", JSON.stringify(r0));
  const citers = (row?.citedBy ?? []).map((c) => posix(c.filePath)).sort();
  assert(JSON.stringify(citers) === JSON.stringify(["checks/steps.mjs", "docs/adr/0021-boundaries.md", "src/turn.ts"]), "every citer is listed: a doc (backticked form), a code comment and an owner string", JSON.stringify(row?.citedBy));
  const fromOwner = (row?.citedBy ?? []).filter((c) => posix(c.filePath) === "checks/steps.mjs");
  assert(fromOwner.length === 1 && fromOwner[0].line === 3, "codeStrings: the `owner:` literal is a citer at its own line (3); the `note:` literal is not", JSON.stringify(fromOwner));
  // Paths are stored with the scan's separator; the response must always be forward-slashed (wec.aria
  // release D: `checks\gate\steps.mjs` came back raw and a forward-slash filter missed it).
  assert((row?.citedBy ?? []).every((c) => !c.filePath.includes("\\")), "citedBy paths are forward-slashed as returned", JSON.stringify(row?.citedBy?.map((c) => c.filePath)));
  const fromCode = (row?.citedBy ?? []).find((c) => posix(c.filePath) === "src/turn.ts");
  assert(fromCode?.enclosingSymbol?.name === "runTurn" && fromCode?.line === 2, "a code-comment citation carries its line and enclosing symbol", JSON.stringify(fromCode));

  const adr = await docs({ mode: "cites", target: "adr/0021" });
  assert(posix(adr?.resolved?.[0]?.file) === "docs/adr/0021-boundaries.md" && (adr?.citedBy ?? []).some((c) => posix(c.filePath) === "CLAUDE.md"), "an adr glob target resolves to its one file; CLAUDE.md cites it", JSON.stringify(adr)?.slice(0, 400));

  const byPath = await docs({ mode: "cites", target: "test/tools.test.ts" });
  assert(byPath?.matchedAs === "filePath" && (byPath?.citedBy ?? []).some((c) => c.patternId === "inv"), "a file path target lists the invariant marker that names it", JSON.stringify(byPath)?.slice(0, 400));

  const turn = await docs({ mode: "cites", target: "src/turn.ts" });
  assert((turn?.mentionedIn ?? []).some((m) => posix(m.filePath) === "docs/15-decision-log.md"), "a path target lists the doc sections whose prose names the file", JSON.stringify(turn)?.slice(0, 400));

  const from = await docs({ mode: "cites", filePath: "CLAUDE.md" });
  const inv = (from?.citations ?? []).find((c) => c.patternId === "inv");
  // `line` is where the citation sits in CLAUDE.md; `targetLine` is where it points. Release C spread
  // the resolution over the row and reported the target's line as `line` (wec.aria acceptance).
  assert(inv?.status === "resolved" && inv?.line === 3 && inv?.targetLine === 2 && posix(inv?.targetFile) === "test/tools.test.ts", "a file's own citation keeps its own line (3) and resolves its target line (it() at 2)", JSON.stringify(inv));
  const adrCite = (from?.citations ?? []).find((c) => c.patternId === "adr");
  assert(adrCite?.line === 4 && adrCite?.targetLine === 1 && posix(adrCite?.targetFile) === "docs/adr/0021-boundaries.md", "a file-anchor citation: line 4 in CLAUDE.md, target line 1", JSON.stringify(adrCite));

  const none = await docs({ mode: "cites", target: "15 #99" });
  assert(none?.resolved?.[0]?.status === "anchor_not_found" && none?.citedByCount === 0, "an unknown row is anchor_not_found, never a guess", JSON.stringify(none?.resolved));

  const prose = await docs({ mode: "search", query: "stage threw" });
  const cc = (prose?.codeComments ?? [])[0];
  assert(cc && posix(cc.filePath) === "src/turn.ts" && cc.enclosingSymbol?.name === "runTurn", "comment prose is searchable, with its enclosing symbol", JSON.stringify(prose?.codeComments));

  const health = js(await client.callTool({ name: "health_check", arguments: { repoId } }));
  assert(health?.citations?.configPresent === true && health?.citations?.stored?.["decision-row"] === 4 && health?.citations?.stored?.inv === 1, "health_check reports the config and the stored citations", JSON.stringify(health?.citations));

  // change_impact: editing the invariant's test file names the invariant.
  writeFileSync(join(repo, "test", "tools.test.ts"), "import { it } from 'node:test';\nit('has no identity key', () => { /* changed */ });\n");
  const ci = js(await client.callTool({ name: "change_impact", arguments: { repoId, profile: "compact" } }));
  const touched = (ci?.citationsTouched ?? []).find((t) => posix(t.changedFile) === "test/tools.test.ts");
  assert(touched && touched.citedBy.some((c) => c.patternId === "inv" && posix(c.filePath) === "CLAUDE.md"), "change_impact: a test-file edit lists the invariant that names it", JSON.stringify(ci?.citationsTouched));
  // Release G (R11, wec.aria acceptance): an edited test is a test to run, not "no linked test", and
  // every listed link clears the 0.7 floor on its own link score.
  const self = (ci?.testsToRun ?? []).find((t) => posix(t.testFile) === "test/tools.test.ts");
  assert(self?.reasons?.includes("changed itself") && !(ci?.residualRisk?.untestedChangedFiles ?? []).some((f) => posix(f) === "test/tools.test.ts"), "change_impact: an edited test file is listed as 'changed itself', not untested", JSON.stringify({ testsToRun: ci?.testsToRun, residualRisk: ci?.residualRisk }));
  assert((ci?.testsToRun ?? []).every((t) => typeof t.linkScore === "number" && t.linkScore >= 0.7), "change_impact: every row carries linkScore >= 0.7", JSON.stringify(ci?.testsToRun));
  git(repo, "checkout", "--", "test/tools.test.ts");

  // A committed config change re-scans UNCHANGED files: NOTES.md is never edited.
  writeFileSync(join(repo, "NOTES.md"), "# Notes\n\nNothing cites anything here. TODO-42\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "notes");
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: repo, mode: "incremental" } });
  writeFileSync(join(repo, ".codebase-index", "citations.json"), config([{ id: "todo", pattern: "\\bTODO-(\\d+)\\b", target: "NOTES.md", anchor: { kind: "file" } }]));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "config");
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: repo, mode: "incremental" } });
  const todo = await docs({ mode: "cites", target: "TODO-42" });
  assert((todo?.citedBy ?? []).some((c) => posix(c.filePath) === "NOTES.md"), "an edited citations.json re-scans unchanged files", JSON.stringify(todo)?.slice(0, 300));

  // Without scan.codeStrings the same, unchanged steps.mjs cites nothing from its strings.
  writeFileSync(join(repo, ".codebase-index", "citations.json"), config([], {}));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "no codeStrings");
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: repo, mode: "incremental" } });
  const off = await docs({ mode: "cites", target: "15 #2" });
  const offCiters = (off?.citedBy ?? []).map((c) => posix(c.filePath)).sort();
  assert(JSON.stringify(offCiters) === JSON.stringify(["docs/adr/0021-boundaries.md", "src/turn.ts"]), "without codeStrings, string literals are not scanned (steps.mjs is no citer)", JSON.stringify(off?.citedBy));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
