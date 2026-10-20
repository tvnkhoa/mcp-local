/**
 * Release F — the text and JSON lanes (MCP-ISSUE-076), git-cleared `bin/` source (078) and
 * forward-slash paths (079), end to end over real MCP stdio, on a git fixture.
 *
 * Fixture (a git repo, committed, so the scan's ignore rules come from git itself):
 *   - text files: a CI workflow, a Dockerfile, a Makefile, a shell script, `.env.example`, dotfile
 *     configs, an eval-case `.jsonl` naming `gd-020`;
 *   - secrets: `.env` and `app.session` — never indexed, reported as `secret_file`;
 *   - a binary `.png` — reported as `binary_asset`;
 *   - a pnpm-style workspace: root + `packages/core` (`@fx/core`) + `packages/app` depending on it with
 *     `workspace:*`;
 *   - `tsconfig.json` (JSONC: comments, trailing commas) extending `tsconfig.base.json`, with
 *     `references` and `paths`; `packages/core/tsconfig.json` extending the base two levels up;
 *   - a one-line JSON file over 10 KB (the `likely_minified` shape);
 *   - `packages/dep-lint/bin/guarded.mjs` (tracked source under `bin/`), `bin/notes.txt` (text under
 *     `bin/` — not source, stays out) and a gitignored `build/` output file.
 *
 * Asserts the lanes, the skip report, the separator invariant (no backslash in any path column), and
 * the incremental-indexing conformance: I1 = I2 = 0 after every run, and an incremental run (and a
 * dirty run) over an edit lands on the same graph as a full run.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
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
const DEBUG = process.env.TEXT_JSON_HARNESS_DEBUG === "1";
const dump = (label, v) => { if (DEBUG) console.log(`--- ${label}\n${JSON.stringify(v, null, 1)?.slice(0, 3000)}`); };

const tmpDir = makeTempDir("text-json-lane-");
const repoDir = join(tmpDir, "repo");
const repoId = `text-json-${Date.now()}`;

const oneLine = JSON.stringify({ rows: Array.from({ length: 900 }, (_, i) => `value-number-${i}`) });
const files = {
  ".github/workflows/ci.yml": `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:16-alpine
    steps:
      - uses: actions/checkout@v4
      - run: npm test --workspace @fx/core
`,
  "Dockerfile": `FROM node:22-alpine
WORKDIR /app
COPY . .
# it's the runtime image
CMD ["node", "dist/server.js"]
`,
  "Makefile": `build:\n\techo "building-the-fixture"\n`,
  "scripts/deploy.sh": `#!/bin/sh\necho "deploying gd-020-probe"\n`,
  "evals/cases/guardrails.jsonl": [
    JSON.stringify({ id: "gd-019", rule: "stays in domain", notes: "a short note" }),
    JSON.stringify({ id: "gd-020", rule: "stays in domain", expect: { outcome: "escalated" } })
  ].join("\n") + "\n",
  ".env": "DB_PASSWORD=hunter2-secret-value\n",
  ".env.example": "DB_PASSWORD=\nAPI_BASE_URL=\"https://example.invalid\"\n",
  "app.session": "{\"cookie\":\"bearer-session-token\"}\n",
  ".editorconfig": "root = true\n[*]\nindent_style = space\n",
  ".gitignore": "build/\nnode_modules/\n*.session\n.env\n",
  "package.json": JSON.stringify({ name: "fx-root", private: true, devDependencies: { typescript: "^5.9.0" } }, null, 2),
  "packages/core/package.json": JSON.stringify({ name: "@fx/core", version: "1.0.0", dependencies: { zod: "^3.24.1" } }, null, 2),
  "packages/app/package.json": JSON.stringify({ name: "@fx/app", dependencies: { "@fx/core": "workspace:*", vue: "^3.5.0" }, devDependencies: { vue: "^3.5.0" } }, null, 2),
  "packages/core/src/index.ts": `export function coreValue(): number {\n  return 42;\n}\n`,
  "packages/app/src/main.ts": `import { coreValue } from "../../core/src/index.js";\nexport const doubled = coreValue() * 2;\n`,
  "tsconfig.base.json": `{\n  "compilerOptions": { "strict": true }\n}\n`,
  "tsconfig.json": `{
  // JSONC: a comment, and trailing commas below.
  "extends": "./tsconfig.base",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@core": ["packages/core/src/index.ts"],
      "@/*": ["src/*"],
    },
  },
  "references": [{ "path": "./packages/core" }, { "path": "packages/app" },],
}
`,
  "packages/core/tsconfig.json": `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }\n`,
  "packages/app/tsconfig.json": `{ "extends": "@vue/tsconfig/tsconfig.dom.json" }\n`,
  "data/one-line.json": oneLine,
  "packages/dep-lint/bin/guarded.mjs": `#!/usr/bin/env node\nexport function runGuarded() {\n  return "guarded-run";\n}\n`,
  "packages/dep-lint/bin/notes.txt": "notes that are not source\n",
  "build/out.js": "export const generated = true;\n"
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(repoDir, rel)), { recursive: true });
  writeFileSync(join(repoDir, rel), text, "utf8");
}
// A real PNG header: binary from byte 0.
writeFileSync(join(repoDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));

const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe", windowsHide: true }).toString();
git("init", "-q");
git("config", "user.email", "fixture@example.invalid");
git("config", "user.name", "fixture");
git("config", "core.autocrlf", "false");
git("add", "-A");
git("commit", "-q", "-m", "fixture");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  // The profile is pinned because `auto` picks `large` for a cold-start full run (maxFiles ≥ 8000) and
  // `standard` once the repo has rows, and the two have different per-file literal caps (100 / 200). An
  // unchanged file extracted under one and compared against a full run under the other differs in
  // literal rows for a reason that has nothing to do with incremental indexing.
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repoDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false", CODEBASE_INDEX_LARGE_REPO_PROFILE: "standard" },
  stderr: "pipe"
});
const client = new Client({ name: "text-json-lane", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-text-json-lane");
const call = async (name, args) => js(await client.callTool({ name, arguments: { repoId, ...args } }));
const rows = async (sql, limit = 500) => (await call("query_graph", { sql, limit }))?.rows ?? [];
// query_graph's allow-list has no literal/annotation/docs tables, so those are read straight from the
// server's DB file, read-only (WAL: safe beside the server's writer).
const dbPath = join(tmpDir, "index.db");
const direct = (sql) => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all({ repoId }); } finally { db.close(); }
};

/** I1 / I2 from the incremental-indexing skill, plus the separator invariant (MCP-ISSUE-079). */
async function invariants(label) {
  const i1 = (await rows("select count(*) as n from edges where repo_id = :repoId and from_id not like 'callee:%' and from_id not in (select symbol_id from symbols where repo_id = :repoId)"))[0]?.n;
  const i2 = await rows("select type, count(*) as n from edges where repo_id = :repoId and to_id not like '%:%' and to_id not in (select symbol_id from symbols where repo_id = :repoId) group by type");
  assert(i1 === 0, `${label}: I1 orphaned from_id = 0`, String(i1));
  assert(i2.length === 0, `${label}: I2 dangling to_id = 0`, JSON.stringify(i2));
  // instr(…, char(92)) rather than LIKE '%\%': LIKE has no default escape character, and the intent —
  // "contains a backslash" — reads the same on every SQLite.
  const back = direct(`select 'files' as t, count(*) as n from files where repo_id = :repoId and instr(path, char(92)) > 0
    union all select 'symbols', count(*) from symbols where repo_id = :repoId and instr(file_path, char(92)) > 0
    union all select 'string_literals', count(*) from string_literals where repo_id = :repoId and instr(file_path, char(92)) > 0
    union all select 'code_comments', count(*) from code_comments where repo_id = :repoId and instr(file_path, char(92)) > 0
    union all select 'citations', count(*) from citations where repo_id = :repoId and instr(file_path, char(92)) > 0
    union all select 'docs', count(*) from docs where repo_id = :repoId and instr(file_path, char(92)) > 0
    union all select 'routes', count(*) from routes where repo_id = :repoId and instr(file_path, char(92)) > 0`);
  assert(back.length === 7 && back.every((r) => r.n === 0), `${label}: no backslash in any path column`, JSON.stringify(back));
}

/** S1–S3 plus every edge by endpoint names — the comparison the conformance procedure asks for. */
async function snapshot() {
  const s1 = await rows("select kind, count(*) as n from symbols where repo_id = :repoId group by kind order by kind");
  const s2 = await rows("select type, count(*) as n from edges where repo_id = :repoId group by type order by type");
  const s3 = await rows("select type, count(*) as n from edges where repo_id = :repoId and (to_id like 'callee:%' or to_id like 'import:%' or to_id like 'type:%' or to_id like 'property:%' or to_id like 'iface:%') group by type");
  const e = direct(`select e.type, s1.file_path as fromFile, s1.name as fromName, s1.line as fromLine,
      coalesce(s2.file_path || '#' || s2.name || '@' || s2.line, e.to_id) as target, e.reason
    from edges e
    left join symbols s1 on s1.repo_id = e.repo_id and s1.symbol_id = e.from_id
    left join symbols s2 on s2.repo_id = e.repo_id and s2.symbol_id = e.to_id
    where e.repo_id = :repoId order by 1, 2, 3, 4, 5, 6`);
  const l = direct("select file_path, line, value from string_literals where repo_id = :repoId order by 1, 2, 3");
  return JSON.stringify({ s1, s2, s3, e, l });
}

/** The first differing part of two snapshots, for a readable failure. */
function firstDiff(x, y) {
  const a = JSON.parse(x), b = JSON.parse(y);
  for (const key of Object.keys(a)) {
    const left = a[key].map((r) => JSON.stringify(r)), right = b[key].map((r) => JSON.stringify(r));
    const onlyLeft = left.filter((r) => !right.includes(r)), onlyRight = right.filter((r) => !left.includes(r));
    if (onlyLeft.length || onlyRight.length || left.length !== right.length) {
      return `${key}: only-first=${onlyLeft.slice(0, 5).join(" ")} only-second=${onlyRight.slice(0, 5).join(" ")} (${left.length} vs ${right.length})`;
    }
  }
  return "equal";
}

try {
  const indexed = await call("index_repository", { repoPath: repoDir, mode: "full" });
  dump("index", indexed);
  assert(indexed && !indexed.error, "index_repository (full)", JSON.stringify(indexed)?.slice(0, 300));
  assert((indexed?.parseFailures ?? 0) === 0, "no parse failures", JSON.stringify(indexed)?.slice(0, 300));
  await invariants("full A");

  // ── what is in the index, at which language ─────────────────────────────────────────────
  const fileRows = await rows("select path, language from files where repo_id = :repoId order by path");
  dump("files", fileRows);
  const lang = Object.fromEntries(fileRows.map((r) => [r.path, r.language]));
  for (const p of [".github/workflows/ci.yml", "Dockerfile", "Makefile", "scripts/deploy.sh", "evals/cases/guardrails.jsonl", ".env.example", ".editorconfig", ".gitignore"]) {
    assert(lang[p] === "text", `${p} is indexed as text`, String(lang[p]));
  }
  for (const p of ["package.json", "packages/core/package.json", "tsconfig.json", "tsconfig.base.json", "data/one-line.json"]) {
    assert(lang[p] === "json", `${p} is indexed as json`, String(lang[p]));
  }
  assert(lang["packages/dep-lint/bin/guarded.mjs"] === "javascript", "tracked source under bin/ is indexed (MCP-ISSUE-078)", JSON.stringify(Object.keys(lang)));
  assert(!("packages/dep-lint/bin/notes.txt" in lang), "a non-source file under bin/ stays out");
  assert(!("build/out.js" in lang), "gitignored build output stays out");
  for (const p of [".env", "app.session", "logo.png"]) assert(!(p in lang), `${p} is not indexed`);

  const textSymbols = await rows("select s.kind, count(*) as n from symbols s join files f on f.repo_id = s.repo_id and f.path = s.file_path where s.repo_id = :repoId and f.language in ('text', 'json') group by s.kind");
  assert(textSymbols.length === 1 && textSymbols[0].kind === "module", "text and json files carry a module symbol and nothing else", JSON.stringify(textSymbols));

  // ── skip report: secrets, binaries ──────────────────────────────────────────────────────
  const health = await call("health_check", {});
  dump("health", health);
  const skips = health?.latestRun?.skippedByReason ?? indexed?.skippedByReason ?? [];
  const has = (reason, extension) => skips.some((b) => b.reason === reason && b.extension === extension);
  // `.env` / `app.session` are gitignored here (as in wec.aria), so git drops them first; the filter's
  // own secret_file reason is pinned by the fileFilter unit tests and by the untracked copy below.
  assert(has("gitignored", ".env") && has("gitignored", ".session"), "the secret files are reported (gitignored)", JSON.stringify(skips));
  assert(has("binary_asset", ".png"), "logo.png is reported as binary_asset", JSON.stringify(skips));
  assert(has("excluded_path", ".txt"), "bin/notes.txt is reported as excluded_path", JSON.stringify(skips));
  assert(!skips.some((b) => b.reason === "unknown_extension" && [".yml", ".json", ".jsonl", ".sh", "Dockerfile", "Makefile", ".example", ".editorconfig"].includes(b.extension)),
    "no text/json extension is left as unknown_extension", JSON.stringify(skips));
  assert(!skips.some((b) => b.reason === "likely_minified"), "one-line JSON is not judged minified", JSON.stringify(skips));

  // ── search: literals and regex reach the text files ─────────────────────────────────────
  const lit = await call("search_literals", { query: "gd-020", limit: 20 });
  dump("literals gd-020", lit);
  const litText = JSON.stringify(lit);
  assert(litText.includes("evals/cases/guardrails.jsonl"), "search_literals('gd-020') hits the .jsonl eval case", litText.slice(0, 400));
  const litPg = await call("search_literals", { query: "postgres:16-alpine", limit: 5 });
  assert(JSON.stringify(litPg).includes(".github/workflows/ci.yml"), "a YAML plain scalar is a literal (postgres:16-alpine)", JSON.stringify(litPg).slice(0, 300));
  const litDocker = await call("search_literals", { query: "dist/server.js", limit: 5 });
  assert(JSON.stringify(litDocker).includes("Dockerfile"), "a Dockerfile string is a literal", JSON.stringify(litDocker).slice(0, 300));
  const secretLit = direct("select count(*) as n from string_literals where repo_id = :repoId and (value like '%hunter2%' or value like '%bearer-session%')");
  assert(secretLit[0]?.n === 0, "no literal from a secret file");

  const rx = await call("search_regex", { pattern: "deploying gd-020", limit: 10 });
  dump("regex", rx);
  assert(JSON.stringify(rx).includes("scripts/deploy.sh"), "search_regex finds a shell script without scanAll", JSON.stringify(rx).slice(0, 400));
  const rxLine = await call("search_regex", { pattern: "value-number-899", limit: 5 });
  assert(JSON.stringify(rxLine).includes("data/one-line.json"), "search_regex reads the one-line JSON file", JSON.stringify(rxLine).slice(0, 300));

  // ── package.json: npm tokens and the workspace edge ─────────────────────────────────────
  const deps = await rows(`select s.file_path as fromFile, e.to_id as toId, e.reason, t.file_path as toFile
    from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
    where e.repo_id = :repoId and e.type = 'DEPENDS_ON' order by 1, 2`);
  dump("deps", deps);
  const dep = (from, to) => deps.find((d) => d.fromFile === from && d.toId === to);
  assert(dep("packages/core/package.json", "npm:zod")?.reason === "npm dependency (^3.24.1)", "DEPENDS_ON npm:zod, labelled with section and range", JSON.stringify(deps));
  assert(dep("package.json", "npm:typescript")?.reason === "npm devDependency (^5.9.0)", "devDependencies are labelled as such");
  assert(deps.filter((d) => d.fromFile === "packages/app/package.json" && d.toId === "npm:vue").length === 1, "a package in two sections is one edge");
  assert(!!dep("packages/app/package.json", "npm:@fx/core"), "the workspace dependency keeps its npm: token");
  const ws = deps.filter((d) => d.fromFile === "packages/app/package.json" && d.toFile === "packages/core/package.json");
  assert(ws.length === 1 && /^workspace package @fx\/core \(workspace:\*\)$/.test(ws[0].reason ?? ""), "workspace edge app → packages/core/package.json", JSON.stringify(ws));

  // ── tsconfig: extends / references / paths ──────────────────────────────────────────────
  const tsEdges = await rows(`select s.file_path as fromFile, e.to_id as toId, t.file_path as toFile, e.reason
    from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
    where e.repo_id = :repoId and e.type = 'IMPORTS' and s.file_path like '%tsconfig%' order by 1, 2`);
  dump("tsconfig edges", tsEdges);
  const ts = (from, toFile) => tsEdges.some((r) => r.fromFile === from && r.toFile === toFile);
  assert(ts("tsconfig.json", "tsconfig.base.json"), "extends './tsconfig.base' resolves to tsconfig.base.json", JSON.stringify(tsEdges));
  assert(ts("packages/core/tsconfig.json", "tsconfig.base.json"), "extends '../../tsconfig.base.json' resolves");
  assert(ts("tsconfig.json", "packages/core/tsconfig.json") && ts("tsconfig.json", "packages/app/tsconfig.json"), "references resolve to each package's tsconfig.json");
  assert(ts("tsconfig.json", "packages/core/src/index.ts"), "a non-glob paths target resolves to its file");
  assert(tsEdges.some((r) => r.fromFile === "tsconfig.json" && r.toId === "import:./src/*" && /tsconfig paths glob/.test(r.reason ?? "")), "a glob paths target is a labelled token");
  assert(tsEdges.some((r) => r.fromFile === "packages/app/tsconfig.json" && r.toId === "import:@vue/tsconfig/tsconfig.dom.json" && r.reason === "npm_package"), "a package extends is labelled npm_package");

  // ── no-op incremental on a clean tree ───────────────────────────────────────────────────
  const noop = await call("index_repository", { repoPath: repoDir, mode: "incremental" });
  dump("noop", noop);
  assert(noop && !noop.error, "index_repository (incremental, clean tree)");
  const lastRun = await rows("select mode, skip_reason as skipReason from index_runs where repo_id = :repoId order by finished_at desc", 1);
  assert(!!lastRun[0]?.skipReason, "the no-op incremental run is fast-skipped with a skip_reason", JSON.stringify(lastRun));
  await invariants("no-op incremental");

  // ── controlled edit → incremental B, dirty B′, full C ───────────────────────────────────
  const edit = () => {
    const corePath = join(repoDir, "packages/core/src/index.ts");
    writeFileSync(corePath, "\n\n\n" + readFileSync(corePath, "utf8"), "utf8");
    const corePkg = join(repoDir, "packages/core/package.json");
    writeFileSync(corePkg, JSON.stringify({ name: "@fx/core", version: "1.1.0", dependencies: { zod: "^3.25.0" } }, null, 2), "utf8");
    const appPkg = join(repoDir, "packages/app/package.json");
    writeFileSync(appPkg, JSON.stringify({ name: "@fx/app", dependencies: { "@fx/core": "^1.1.0", vue: "^3.5.0" } }, null, 2), "utf8");
    writeFileSync(join(repoDir, "scripts/deploy.sh"), `#!/bin/sh\necho "deploying gd-021-probe"\n`, "utf8");
  };
  edit();
  const inc = await call("index_repository", { repoPath: repoDir, mode: "incremental" });
  assert(inc && !inc.error, "index_repository (incremental, edited)", JSON.stringify(inc)?.slice(0, 300));
  await invariants("incremental B");
  const b = await snapshot();
  const wsAfter = await rows(`select e.reason from edges e join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id where e.repo_id = :repoId and e.type = 'DEPENDS_ON' and t.file_path = 'packages/core/package.json'`);
  assert(wsAfter.length === 1 && wsAfter[0].reason === "workspace package @fx/core (^1.1.0)", "a plain range on a local package is still a workspace edge, recomputed", JSON.stringify(wsAfter));

  const dirty = await call("index_repository", { repoPath: repoDir, mode: "dirty" });
  assert(dirty && !dirty.error, "index_repository (dirty, edited)", JSON.stringify(dirty)?.slice(0, 300));
  await invariants("dirty B′");
  const bPrime = await snapshot();

  const full = await call("index_repository", { repoPath: repoDir, mode: "full" });
  assert(full && !full.error, "index_repository (full C, edited)");
  await invariants("full C");
  const c = await snapshot();
  assert(b === c, "incremental B = full C (symbols, edges by type, unresolved, every edge, literals)", firstDiff(b, c));
  assert(bPrime === c, "dirty B′ = full C", firstDiff(bPrime, c));

  // ── a pre-v7 Windows row (backslash path) is pruned, not kept beside its new twin ───────
  {
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        // As an older build wrote it: the path with backslashes AND ids minted from that spelling (here,
        // just different ids). The schema migration rewrites such rows at start-up; this is the run-time
        // fallback for one written after it — the prune must drop it, not keep it beside its new twin.
        db.prepare(`update files set path = replace(path, '/', char(92)) where repo_id = ? and path = 'scripts/deploy.sh'`).run(repoId);
        db.prepare(`update symbols set file_path = replace(file_path, '/', char(92)), symbol_id = 'legacy' || substr(symbol_id, 7) where repo_id = ? and file_path = 'scripts/deploy.sh'`).run(repoId);
        db.prepare(`update string_literals set file_path = replace(file_path, '/', char(92)), literal_id = 'legacy' || substr(literal_id, 7) where repo_id = ? and file_path = 'scripts/deploy.sh'`).run(repoId);
      })();
    } finally { db.close(); }
  }
  const seeded = direct("select count(*) as n from files where repo_id = :repoId and instr(path, char(92)) > 0")[0]?.n;
  assert(seeded === 1, "seeded one backslash file row (as an older build on Windows wrote it)", String(seeded));
  const migrate = await call("index_repository", { repoPath: repoDir, mode: "incremental" });
  dump("migrate", migrate);
  assert(migrate && !migrate.error, "index_repository (incremental over a backslash row)");
  await invariants("after backslash migration");
  const deployRows = direct("select path from files where repo_id = :repoId and replace(path, char(92), '/') = 'scripts/deploy.sh'");
  assert(deployRows.length === 1 && deployRows[0].path === "scripts/deploy.sh", "the file is stored once, with forward slashes", JSON.stringify(deployRows));

  // ── an untracked secret file reaches the filter itself → secret_file ────────────────────
  writeFileSync(join(repoDir, "deploy.key"), "-----BEGIN PRIVATE KEY-----\nabc\n", "utf8");
  const full2 = await call("index_repository", { repoPath: repoDir, mode: "full" });
  assert(full2 && !full2.error, "index_repository (full, with an untracked .key)");
  const health2 = await call("health_check", {});
  const skips2 = health2?.latestRun?.skippedByReason ?? [];
  assert(skips2.some((b2) => b2.reason === "secret_file" && b2.extension === ".key"), "an untracked private key is reported as secret_file", JSON.stringify(skips2));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
