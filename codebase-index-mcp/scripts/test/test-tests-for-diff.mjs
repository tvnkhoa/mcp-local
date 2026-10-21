/**
 * R11 (wec.aria release G, MCP-ISSUE-080): link_tests_to_source(forWorkingTreeDiff: true) over real
 * stdio, against a temp git monorepo with two packages and two vitest configs.
 *
 *   packages/core  vitest.config.ts   node:  include test/**\/*.test.ts, exclude **\/*.dom.test.ts
 *   packages/ui    vitest.config.mts  dom:   include src/**\/*.dom.test.ts
 *   tools/         a node:test file (runner unknown, `node --test` hint)
 *
 * Scenarios, each on a fresh working tree:
 *   A. a core file edit → its direct test, a test two hops out, a ui test through the workspace
 *      import `@fx/core/ledger`, the node:test file; a *.dom.test.ts in core excluded by the node
 *      config with the reason; one command per package; a 0.42/0.5 name link dropped and counted.
 *   B. a .vue edit → the test that reaches it through Panel.vue (import + USES_COMPONENT).
 *   C. an edited test file → listed as "changed itself", with its command.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const short = (v) => JSON.stringify(v)?.slice(0, 900);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { stdio: "pipe" });

const FIXTURE = {
  ".gitignore": ".index/\nnode_modules/\n",
  "package.json": JSON.stringify({ name: "fixmono", private: true, packageManager: "pnpm@9.0.0" }, null, 2),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/core/package.json": JSON.stringify({
    name: "@fx/core", type: "module",
    exports: { ".": "./src/index.ts", "./ledger": { types: "./src/ledger.ts", default: "./src/ledger.ts" } },
    devDependencies: { vitest: "^4.0.0" }
  }, null, 2),
  "packages/core/vitest.config.ts": `import { defineConfig } from 'vitest/config'
// node environment; the DOM suite lives in packages/ui
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/*.dom.test.ts', '**/node_modules/**'],
  },
})
`,
  "packages/core/src/ledger.ts": `export function appendEntry(entries: string[], entry: string): string[] {
  return [...entries, entry];
}
`,
  "packages/core/src/format.ts": `import { appendEntry } from './ledger.js';
export function formatLedger(entries: string[]): string {
  return appendEntry(entries, 'end').join(',');
}
`,
  "packages/core/src/index.ts": `export * from './ledger.js';\n`,
  "packages/core/src/auditLedgerWriter.ts": `export const auditLedgerWriterVersion = 1;\n`,
  "packages/core/test/ledger.test.ts": `import { appendEntry } from '../src/ledger.js';
export const t = appendEntry([], 'a');
`,
  "packages/core/test/format.test.ts": `import { formatLedger } from '../src/format.js';
export const t = formatLedger([]);
`,
  "packages/core/test/ledger.dom.test.ts": `import { appendEntry } from '../src/ledger.js';
export const t = appendEntry([], 'dom');
`,
  "packages/ui/package.json": JSON.stringify({
    name: "@fx/ui", type: "module",
    dependencies: { "@fx/core": "workspace:*" },
    scripts: { test: "vitest run" }
  }, null, 2),
  "packages/ui/vitest.config.mts": `export default {
  test: { include: ['src/**/*.dom.test.ts'], environment: 'jsdom' },
}
`,
  "packages/ui/src/useLedger.ts": `import { appendEntry } from '@fx/core/ledger';
export function useLedger(): string[] {
  return appendEntry([], 'ui');
}
`,
  "packages/ui/src/useLedger.dom.test.ts": `import { useLedger } from './useLedger.js';
export const t = useLedger();
`,
  "packages/ui/src/Badge.vue": `<script setup lang="ts">
const label = 'badge'
</script>

<template>
  <span class="badge">{{ label }}</span>
</template>
`,
  "packages/ui/src/Panel.vue": `<script setup lang="ts">
import Badge from './Badge.vue'
</script>

<template>
  <div class="panel"><Badge /></div>
</template>
`,
  "packages/ui/src/panel.dom.test.ts": `import Panel from './Panel.vue';
export const t = Panel;
`,
  // A name-only neighbour of auditLedgerWriter.ts and ledger.ts: scores 0.5 / 0.42, imports nothing.
  "packages/ui/src/auditLedgerWriterFlow.dom.test.ts": `export const unrelated = 1;\n`,
  "tools/package.json": JSON.stringify({ name: "fx-tools", type: "module" }, null, 2),
  "tools/ledger-check.test.mjs": `import test from 'node:test';
import { appendEntry } from '../packages/core/src/ledger.ts';
test('ledger', () => appendEntry([], 'x'));
`
};

const tmpDir = makeTempDir("tests-for-diff-");
mkdirSync(join(tmpDir, ".index"), { recursive: true });
for (const [rel, body] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(tmpDir, rel)), { recursive: true });
  writeFileSync(join(tmpDir, rel), body);
}
git(tmpDir, "init", "-q");
git(tmpDir, "add", ".");
git(tmpDir, "commit", "-q", "-m", "fixture");

const repoId = `tfd-${Date.now()}`;
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir,
    CODEBASE_INDEX_DB_PATH: join(tmpDir, ".index", "index.db"),
    CODEBASE_INDEX_LLM_ENABLED: "false",
    CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS: "60000"
  },
  stderr: "pipe"
});
const client = new Client({ name: "test-tests-for-diff", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-tests-for-diff");

const call = async (args) => js(await client.callTool({ name: "link_tests_to_source", arguments: { repoId, forWorkingTreeDiff: true, ...args } }));
const testOf = (r, f) => (r?.tests ?? []).find((t) => t.testFile === f);
const reset = () => { git(tmpDir, "checkout", "--", "."); git(tmpDir, "clean", "-fdq", "-e", ".index"); };

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  // ── clean tree ──
  const clean = await call({});
  assert(clean?.changedFiles?.count === 0 && clean?.testCount === 0 && /clean/.test(clean?.hint ?? ""), "clean tree: no tests, and the hint says the tree is clean", short(clean));

  // ── A. a core file edit ──
  appendFileSync(join(tmpDir, "packages/core/src/ledger.ts"), "export const ledgerEdited = true;\n");
  appendFileSync(join(tmpDir, "packages/core/src/auditLedgerWriter.ts"), "export const edited = 2;\n");
  const a = await call({});
  if (process.env.TFD_DUMP) console.log(JSON.stringify(a, null, 2));
  const direct = testOf(a, "packages/core/test/ledger.test.ts");
  assert(direct && direct.why.some((w) => w === "imports packages/core/src/ledger.ts") && direct.runner === "vitest" && direct.package === "@fx/core", "A: direct test listed with why 'imports …' and its package", short(direct));
  const twoHop = testOf(a, "packages/core/test/format.test.ts");
  assert(twoHop && twoHop.depth === 2 && /via packages\/core\/src\/format\.ts/.test(twoHop.why[0]), "A: a test two hops out is listed 'via' the intermediate file", short(twoHop));
  const viaWs = testOf(a, "packages/ui/src/useLedger.dom.test.ts");
  assert(viaWs && /workspace package specifier '@fx\/core\/ledger'/.test(viaWs.why.join(" ")) && viaWs.package === "@fx/ui", "A: a ui test reaches the core file through the workspace import @fx/core/ledger", short(viaWs));
  const nodeTest = testOf(a, "tools/ledger-check.test.mjs");
  assert(nodeTest && nodeTest.runner === "unknown" && nodeTest.hint === "node --test tools/ledger-check.test.mjs", "A: a node:test file is runner unknown with a node --test hint", short(nodeTest));
  const dom = testOf(a, "packages/core/test/ledger.dom.test.ts");
  assert(dom && /excluded by "\*\*\/\*\.dom\.test\.ts"/.test(dom.excludedReason ?? ""), "A: core *.dom.test.ts is reached but excluded by the node config, with the reason", short(dom));
  assert((a?.excluded ?? []).some((e) => e.testFile === "packages/core/test/ledger.dom.test.ts"), "A: … and listed in `excluded`", short(a?.excluded));
  const cmds = a?.runPlan?.commands ?? [];
  const coreCmd = cmds.find((c) => c.package === "@fx/core");
  assert(coreCmd?.command === "cd packages/core && ./node_modules/.bin/vitest run test/format.test.ts test/ledger.test.ts", "A: one core command, files relative to the package root", short(coreCmd));
  assert(coreCmd?.configFile === "packages/core/vitest.config.ts" && coreCmd?.configStatus === "read", "A: the core command names the config it read", short(coreCmd));
  const uiCmd = cmds.find((c) => c.package === "@fx/ui");
  assert(uiCmd?.command === "cd packages/ui && ./node_modules/.bin/vitest run src/useLedger.dom.test.ts", "A: one ui command under the dom config", short(uiCmd));
  assert(cmds.length === 2, "A: exactly two commands (one per package)", short(cmds.map((c) => c.command)));
  assert(!testOf(a, "packages/ui/src/auditLedgerWriterFlow.dom.test.ts"), "A: a 0.42/0.5 name link is NOT listed", short(a?.tests?.map((t) => t.testFile)));
  assert(a?.minScore === 0.7 && a?.belowMinScore >= 1, "A: it is dropped and counted in belowMinScore (minScore 0.7)", short({ minScore: a?.minScore, belowMinScore: a?.belowMinScore }));
  const nameWhys = (a?.tests ?? []).flatMap((t) => t.why).filter((w) => w.startsWith("name link score"));
  assert(nameWhys.every((w) => Number(/score ([\d.]+)/.exec(w)?.[1]) >= 0.7), "A: every listed name link is >= minScore", short(nameWhys));
  assert(a?.note?.includes("Nothing was executed"), "A: the answer says nothing ran");
  const nano = js(await client.callTool({ name: "link_tests_to_source", arguments: { repoId, forWorkingTreeDiff: true, profile: "nano" } }));
  assert(Array.isArray(nano?.commands) && nano.commands.length === 2 && typeof nano?.belowMinScore === "number", "A: nano carries the commands and belowMinScore", short(nano));
  reset();

  // ── B. a .vue edit ──
  writeFileSync(join(tmpDir, "packages/ui/src/Badge.vue"), FIXTURE["packages/ui/src/Badge.vue"].replace("'badge'", "'badge-edited'"));
  const b = await call({});
  const panel = testOf(b, "packages/ui/src/panel.dom.test.ts");
  assert(panel && panel.depth === 2 && /via packages\/ui\/src\/Panel\.vue/.test(panel.why[0]), "B: a .vue edit reaches the test through Panel.vue", short(panel));
  assert(/USES_COMPONENT|imports packages\/ui\/src\/Badge\.vue/.test(panel?.why?.[0] ?? ""), "B: the last hop is the component edge or the .vue import", short(panel?.why));
  const bCmd = (b?.runPlan?.commands ?? []).find((c) => c.package === "@fx/ui");
  assert(bCmd?.command === "cd packages/ui && ./node_modules/.bin/vitest run src/panel.dom.test.ts", "B: the ui command", short(b?.runPlan));
  reset();

  // ── C. an edited test file ──
  appendFileSync(join(tmpDir, "packages/core/test/ledger.test.ts"), "export const more = 1;\n");
  const c = await call({});
  const self = testOf(c, "packages/core/test/ledger.test.ts");
  assert(self && self.why.includes("changed itself") && self.depth === 0, "C: a changed test file is listed as 'changed itself'", short(c?.tests));
  const cCmd = (c?.runPlan?.commands ?? []).find((x) => x.package === "@fx/core");
  assert(cCmd?.command === "cd packages/core && ./node_modules/.bin/vitest run test/ledger.test.ts", "C: … with its command", short(c?.runPlan));
  reset();

  // ── input contract ──
  const bad = await client.callTool({ name: "link_tests_to_source", arguments: { repoId, forWorkingTreeDiff: true, filePath: "x.ts" } });
  assert(bad?.isError === true || /exclusive/.test(txt(bad)), "filePath + forWorkingTreeDiff is refused", txt(bad).slice(0, 200));
  const legacy = js(await client.callTool({ name: "link_tests_to_source", arguments: { repoId, filePath: "packages/core/src/ledger.ts" } }));
  assert(Array.isArray(legacy?.links), "without forWorkingTreeDiff the pair listing is unchanged", short(legacy));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
