/**
 * Release F — the HTML lane and SVG asset nodes (MCP-ISSUE-077), end to end over real MCP stdio.
 *
 * Fixture (a Vite-shaped app, not a git repo — the plain-walk path):
 *   index.html                 — <link rel=icon href=/favicon.svg>, <link rel=stylesheet>, <script
 *                                type=module src=/src/main.ts>, a CDN script, a commented-out script,
 *                                and an <img src=/logo.png>;
 *   public/favicon.svg         — served from public/ by Vite, written root-absolute in the page;
 *   src/main.ts                — `import iconUrl from "./assets/icon.svg"` and a `?raw` import of it;
 *   src/components/Card.vue    — <img src="../assets/icon.svg"> and <use href="../assets/sprite.svg#home">;
 *   src/assets/{icon,sprite}.svg, a 12 KB one-line svg, a vendor .js and a .png under assets/.
 *
 * Asserts: svg files are module-only asset nodes even under assets/ and public/, the html page's
 * references resolve to files, "who uses icon.svg" lists the .ts import AND the .vue template, the
 * excluded neighbours are reported with their reasons, no backslash path anywhere, and an
 * incremental run lands on the same graph as a full one (I1 = I2 = 0 throughout).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const DEBUG = process.env.HTML_SVG_HARNESS_DEBUG === "1";
const dump = (label, v) => { if (DEBUG) console.log(`--- ${label}\n${JSON.stringify(v, null, 1)?.slice(0, 3000)}`); };

const tmpDir = makeTempDir("html-svg-");
const repoDir = join(tmpDir, "app");
const repoId = `html-svg-${Date.now()}`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>\n`;
const files = {
  "index.html": `<!doctype html>
<html>
  <head>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="./src/styles/app.css">
    <script src="https://cdn.example.invalid/lib.js"></script>
    <!-- <script type="module" src="/src/old.ts"></script> -->
  </head>
  <body>
    <img src="/logo.png" alt="">
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  "public/favicon.svg": svg(`<circle cx="12" cy="12" r="10"/>`),
  "src/main.ts": `import iconUrl from "./assets/icon.svg";
import iconRaw from "./assets/icon.svg?raw";
export function mount(): string {
  return iconUrl + iconRaw.length;
}
`,
  "src/components/Card.vue": `<template>
  <div class="card">
    <img src="../assets/icon.svg" alt="icon" />
    <svg><use href="../assets/sprite.svg#home" /></svg>
    <img src="/static-from-public.svg" />
  </div>
</template>

<script setup lang="ts">
const title = "card";
</script>
`,
  "src/styles/app.css": `.card { color: red; }\n`,
  "src/assets/icon.svg": svg(`<path d="M0 0h24v24H0z"/>`),
  "src/assets/sprite.svg": svg(`<symbol id="home"><path d="M1 1"/></symbol>`),
  "src/assets/big.svg": svg(`<path d="${"M1 1 ".repeat(2600)}"/>`).trimEnd(),
  "src/assets/vendor.js": "export const vendored = 1;\n"
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(repoDir, rel)), { recursive: true });
  writeFileSync(join(repoDir, rel), text, "utf8");
}
writeFileSync(join(repoDir, "src/assets/photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repoDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false", CODEBASE_INDEX_LARGE_REPO_PROFILE: "standard" },
  stderr: "pipe"
});
const client = new Client({ name: "html-svg", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-html-svg");
const call = async (name, args) => js(await client.callTool({ name, arguments: { repoId, ...args } }));
const dbPath = join(tmpDir, "index.db");
const direct = (sql) => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all({ repoId }); } finally { db.close(); }
};

function invariants(label) {
  const i1 = direct("select count(*) as n from edges where repo_id = :repoId and from_id not like 'callee:%' and from_id not in (select symbol_id from symbols where repo_id = :repoId)")[0]?.n;
  const i2 = direct("select type, count(*) as n from edges where repo_id = :repoId and to_id not like '%:%' and to_id not in (select symbol_id from symbols where repo_id = :repoId) group by type");
  assert(i1 === 0, `${label}: I1 = 0`, String(i1));
  assert(i2.length === 0, `${label}: I2 = 0`, JSON.stringify(i2));
  const back = direct(`select (select count(*) from files where repo_id = :repoId and instr(path, char(92)) > 0)
      + (select count(*) from symbols where repo_id = :repoId and instr(file_path, char(92)) > 0)
      + (select count(*) from string_literals where repo_id = :repoId and instr(file_path, char(92)) > 0)
      + (select count(*) from code_comments where repo_id = :repoId and instr(file_path, char(92)) > 0) as n`)[0]?.n;
  assert(back === 0, `${label}: no backslash in any path column`, String(back));
}

const usersOf = (file) => direct(`select distinct s.file_path as fromFile from edges e
  join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
  join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
  where e.repo_id = :repoId and e.type = 'IMPORTS' and t.kind = 'module' and t.file_path = '${file}' order by 1`).map((r) => r.fromFile);

const snapshot = () => JSON.stringify(direct(`select e.type, s1.file_path as f, s1.name as n, s1.line as l,
    coalesce(s2.file_path || '#' || s2.name || '@' || s2.line, e.to_id) as target, e.reason
  from edges e left join symbols s1 on s1.repo_id = e.repo_id and s1.symbol_id = e.from_id
  left join symbols s2 on s2.repo_id = e.repo_id and s2.symbol_id = e.to_id
  where e.repo_id = :repoId order by 1, 2, 3, 4, 5, 6`));

try {
  const indexed = await call("index_repository", { repoPath: repoDir, mode: "full" });
  dump("index", indexed);
  assert(indexed && !indexed.error, "index_repository (full)", JSON.stringify(indexed)?.slice(0, 300));
  assert((indexed?.parseFailures ?? 0) === 0, "no parse failures");
  invariants("full");

  const fileRows = direct("select path, language from files where repo_id = :repoId order by path");
  dump("files", fileRows);
  const lang = Object.fromEntries(fileRows.map((r) => [r.path, r.language]));
  assert(lang["index.html"] === "html", "index.html is indexed as html", JSON.stringify(lang));
  for (const p of ["public/favicon.svg", "src/assets/icon.svg", "src/assets/sprite.svg", "src/assets/big.svg"]) {
    assert(lang[p] === "svg", `${p} is an svg asset node (assets/ and public/ lifted for svg)`);
  }
  assert(!("src/assets/vendor.js" in lang), "a .js under assets/ stays excluded");
  const svgKinds = direct("select s.kind, count(*) as n from symbols s join files f on f.repo_id = s.repo_id and f.path = s.file_path where s.repo_id = :repoId and f.language in ('svg', 'html') group by s.kind");
  assert(svgKinds.length === 1 && svgKinds[0].kind === "module", "svg and html files carry a module symbol only", JSON.stringify(svgKinds));

  const health = await call("health_check", {});
  const skips = health?.latestRun?.skippedByReason ?? [];
  dump("skips", skips);
  assert(skips.some((b) => b.reason === "binary_asset" && b.extension === ".png"), "photo.png reported as binary_asset", JSON.stringify(skips));
  assert(skips.some((b) => b.reason === "excluded_path" && b.extension === ".js"), "assets/vendor.js reported as excluded_path", JSON.stringify(skips));
  assert(!skips.some((b) => b.extension === ".svg" || b.extension === ".html"), "no svg or html file is skipped", JSON.stringify(skips));

  // ── the page's references ───────────────────────────────────────────────────────────────
  const pageEdges = direct(`select e.to_id as toId, t.file_path as toFile, e.reason from edges e
    join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
    where e.repo_id = :repoId and e.type = 'IMPORTS' and s.file_path = 'index.html' order by 2`);
  dump("page edges", pageEdges);
  const targets = pageEdges.map((r) => r.toFile);
  assert(targets.includes("src/main.ts"), "<script src=/src/main.ts> → src/main.ts", JSON.stringify(pageEdges));
  assert(targets.includes("src/styles/app.css"), "<link rel=stylesheet> → src/styles/app.css");
  assert(targets.includes("public/favicon.svg"), "<link rel=icon href=/favicon.svg> → public/favicon.svg");
  assert(pageEdges.length === 3, "no edge for the CDN script, the commented-out script or the .png", JSON.stringify(pageEdges));

  // ── who uses icon.svg ───────────────────────────────────────────────────────────────────
  const iconUsers = usersOf("src/assets/icon.svg");
  assert(iconUsers.includes("src/main.ts") && iconUsers.includes("src/components/Card.vue"),
    "icon.svg is used by the .ts import (incl. ?raw) and the .vue template src", JSON.stringify(iconUsers));
  assert(usersOf("src/assets/sprite.svg").includes("src/components/Card.vue"), "<use href=sprite.svg#home> reaches sprite.svg (fragment cut)");
  const impact = await call("find_impact_files", { filePath: "src/assets/icon.svg", view: "files", profile: "verbose" });
  dump("impact icon.svg", impact);
  const impactText = JSON.stringify(impact);
  assert(impactText.includes("src/main.ts") && impactText.includes("src/components/Card.vue"), "find_impact_files(icon.svg) lists both users", impactText.slice(0, 500));
  const publicTokens = direct("select count(*) as n from edges where repo_id = :repoId and to_id like '%static-from-public%'")[0]?.n;
  assert(publicTokens === 0, "a root-absolute svg in a .vue template (a public URL) makes no edge");

  // ── incremental = full ──────────────────────────────────────────────────────────────────
  const mainPath = join(repoDir, "src/main.ts");
  writeFileSync(mainPath, "\n\n\n" + readFileSync(mainPath, "utf8"), "utf8");
  writeFileSync(join(repoDir, "src/assets/icon.svg"), svg(`<path d="M2 2h20v20H2z"/>`), "utf8");
  const inc = await call("index_repository", { repoPath: repoDir, mode: "incremental" });
  assert(inc && !inc.error, "index_repository (incremental, edited)");
  invariants("incremental");
  const b = snapshot();
  const full = await call("index_repository", { repoPath: repoDir, mode: "full" });
  assert(full && !full.error, "index_repository (full, edited)");
  invariants("full again");
  assert(b === snapshot(), "incremental and full runs produce the same edge set");
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
