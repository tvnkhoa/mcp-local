/**
 * PY-5..PY-9 — Python gaps G1-G4 (plan v3), through the real server over stdio.
 *
 * The fixture (`fixtures/python-gaps/`) is a src-layout package copied to a temp dir and indexed with
 * `mode: "full"`, then re-indexed incrementally after one file is touched so the rebuilt-whole passes are
 * proven to land where a full run does. Each assertion names the item it proves:
 *   PY-5  a `Protocol` subclass is kind interface; explicit (`class M(Executor)`) and structural implementers
 *         (own + inherited methods cover the Protocol's members, sub-Protocols included) get IMPLEMENTS;
 *         an attributes-only Protocol has none; a call through a Protocol-typed parameter dispatches.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";
import { waitForIndexJob } from "./_indexWait.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "python-gaps");

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const tmpDir = makeTempDir("py-gaps-");
const repoDir = path.join(tmpDir, "repo");
fs.cpSync(FIXTURE, repoDir, { recursive: true });
const repoId = `py-gaps-${Date.now()}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repoDir, CODEBASE_INDEX_DB_PATH: path.join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "py-gaps-test", version: "0.1.0" });
const REQUEST = { timeout: 300_000 };
await client.connect(transport, REQUEST);
attachServerStderr(transport, "test-python-gaps");

const call = async (name, args) => js(await client.callTool({ name, arguments: args }, undefined, REQUEST));
const sql = async (query) => (await call("query_graph", { repoId, sql: query, limit: 500, profile: "verbose" }))?.rows ?? [];
const index = async (mode) => {
  const first = await call("index_repository", { wait: true, repoId, repoPath: repoDir, mode });
  return (await waitForIndexJob((runId) => call("index_status", { runId }), first)) ?? first;
};
const loadSymbols = () => sql(
  `select s.symbol_id as id, s.name, s.kind, replace(s.file_path, char(92), '/') as file, p.name as parent
   from symbols s left join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
   where s.repo_id = :repoId`
);
const loadEdges = () => sql(
  `select e.type, e.to_id as toId, e.reason, e.confidence, f.name as fromName, replace(f.file_path, char(92), '/') as fromFile,
          t.name as toName, replace(t.file_path, char(92), '/') as toFile, t.kind as toKind, tp.name as toParent
   from edges e
   join symbols f on f.repo_id = e.repo_id and f.symbol_id = e.from_id
   left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
   left join symbols tp on tp.repo_id = t.repo_id and tp.symbol_id = t.parent_symbol_id
   where e.repo_id = :repoId`
);
const implementsKey = (edges) => edges.filter((e) => e.type === "IMPLEMENTS").map((e) => `${e.fromName}->${e.toName ?? e.toId}:${e.reason}`).sort();

try {
  const run = await index("full");
  assert(run?.state === "ok" || run?.status === "ok" || run?.runId, "full index of the fixture finished", run);
  const symbols = await loadSymbols();
  const edges = await loadEdges();
  const sym = (file, name, kind) => symbols.find((s) => s.file === file && s.name === name && (!kind || s.kind === kind));
  const show = (pred) => edges.filter(pred).map((e) => `${e.type} ${e.fromName}@${e.fromFile} -> ${e.toName ?? e.toId}@${e.toFile ?? ""} (${e.reason})`);

  // ── PY-5 ──
  const PORTS = "src/flow/ports.py";
  assert(sym(PORTS, "Executor")?.kind === "interface", "PY-5 class Executor(Protocol) is kind interface", sym(PORTS, "Executor"));
  assert(sym(PORTS, "BatchExecutor")?.kind === "interface", "PY-5 class BatchExecutor(Executor, Protocol) is kind interface");
  assert(sym(PORTS, "Named")?.kind === "interface", "PY-5 typing_extensions.Protocol is a Protocol too");
  assert(sym(PORTS, "Store")?.kind === "class", "PY-5 an ordinary class stays kind class");
  assert(sym(PORTS, "run", "method")?.parent === "Executor", "PY-5 a Protocol member keeps its owner", sym(PORTS, "run"));
  const impl = (from, to) => edges.find((e) => e.type === "IMPLEMENTS" && e.fromName === from && e.toName === to && e.toFile === PORTS);
  assert(impl("ManualExecutor", "Executor")?.reason === "base_list protocol", "PY-5 class ManualExecutor(Executor) → IMPLEMENTS Executor (explicit)", show((e) => e.type === "IMPLEMENTS"));
  assert(impl("MockExecutor", "Executor")?.reason === "structural protocol", "PY-5 MockExecutor (run + close, no base) → IMPLEMENTS Executor (structural)");
  assert(impl("SyncExecutor", "Executor")?.reason === "structural protocol", "PY-5 SyncExecutor (close inherited from BaseExec) → IMPLEMENTS Executor");
  assert(impl("BatchRunner", "BatchExecutor") && impl("BatchRunner", "Executor"), "PY-5 BatchRunner covers BatchExecutor and its parent Executor");
  assert(!impl("MockExecutor", "BatchExecutor"), "PY-5 a sub-Protocol's own member is required (MockExecutor has no run_batch)");
  assert(!impl("HalfExecutor", "Executor"), "PY-5 HalfExecutor (run, no close) is not an implementer");
  assert(!edges.some((e) => e.type === "IMPLEMENTS" && e.toName === "Named"), "PY-5 an attributes-only Protocol has no structural implementers");
  assert(!edges.some((e) => e.type === "IMPLEMENTS" && (e.fromName === "Store" || e.fromName === "BaseExec")), "PY-5 a class covering only part of a Protocol implements nothing");

  const found = await call("find_implementations", { repoId, interfaceName: "Executor", profile: "verbose" });
  const foundNames = JSON.stringify(found);
  assert(["MockExecutor", "ManualExecutor", "SyncExecutor", "BatchRunner"].every((n) => foundNames.includes(n)) && !foundNames.includes("HalfExecutor"),
    "PY-5 find_implementations(Executor) lists mock / manual / sync / batch, not half", foundNames.slice(0, 800));

  const PIPE = "src/flow/pipeline.py";
  const driveCalls = edges.filter((e) => e.type === "CALLS" && e.fromName === "drive" && e.fromFile === PIPE);
  assert(driveCalls.some((e) => e.toName === "run" && e.toParent === "Executor"), "PY-5 executor.run() on a Protocol-typed parameter → Executor.run", driveCalls);
  assert(["MockExecutor", "ManualExecutor", "SyncExecutor", "BatchRunner"].every((c) => driveCalls.some((e) => e.toName === "run" && e.toParent === c && e.reason === "interface-dispatch")),
    "PY-5 the call dispatches to each implementer's run", driveCalls.map((e) => `${e.toParent}.${e.toName} (${e.reason})`));

  // ── PY-7 ──
  const fixtureOf = (testName, testFile) => edges.filter((e) => e.type === "CALLS" && e.fromName === testName && e.fromFile === testFile && e.toName === "stage");
  const unitStage = fixtureOf("test_runs", "tests/unit/test_smoke.py");
  assert(unitStage.length === 1 && unitStage[0].toFile === "tests/unit/conftest.py" && unitStage[0].reason === "resolved pytest fixture (nearest conftest)",
    "PY-7 test_runs(stage) in tests/unit/ → tests/unit/conftest.py stage (nearest conftest wins over tests/ and tests/other/)", unitStage);
  const rootStage = fixtureOf("test_root", "tests/test_root_smoke.py");
  assert(rootStage.length === 1 && rootStage[0].toFile === "tests/conftest.py", "PY-7 test_root(stage) in tests/ → tests/conftest.py stage", rootStage);
  assert(edges.some((e) => e.type === "CALLS" && e.fromName === "stage" && e.fromFile === "tests/unit/conftest.py" && e.toName === "FixStage" && e.toFile === "src/flow/stages/fix.py"),
    "PY-7 the fixture's own call FixStage() → the FixStage class", show((e) => e.fromFile === "tests/unit/conftest.py"));
  const linkRows = (r) => r?.links ?? r?.results ?? r?.pairs ?? [];
  const fromTest = linkRows(await call("link_tests_to_source", { repoId, filePath: "tests/unit/test_smoke.py", profile: "verbose" }));
  const fixLink = fromTest.find((l) => (l.sourceFile ?? "").replace(/\\/g, "/") === "src/flow/stages/fix.py");
  assert(fixLink && (fixLink.reasons ?? []).includes("fixture_trace"), "PY-7 link_tests_to_source maps the fixture-only test_smoke.py → fix.py (default minScore)", fromTest);
  assert(!fromTest.some((l) => (l.sourceFile ?? "").replace(/\\/g, "/") === "src/flow/stages/draft.py"), "PY-7 the overridden root fixture's source (draft.py) is not linked to test_smoke.py", fromTest);
  const fromSource = linkRows(await call("link_tests_to_source", { repoId, filePath: "src/flow/stages/fix.py", profile: "verbose" }));
  assert(fromSource.some((l) => (l.testFile ?? "").replace(/\\/g, "/") === "tests/unit/test_smoke.py"), "PY-7 probing fix.py finds the fixture-only test_smoke.py", fromSource);

  // Scoped re-index: touch one implementer; the rebuilt-whole IMPLEMENTS set must not move.
  const before = implementsKey(edges);
  fs.appendFileSync(path.join(repoDir, "src", "flow", "executors", "mock.py"), "\n# touched\n");
  const inc = await index("incremental");
  assert(inc?.state === "ok" || inc?.status === "ok" || inc?.runId, "incremental re-index finished", inc);
  const after = implementsKey(await loadEdges());
  assert(JSON.stringify(after) === JSON.stringify(before), "PY-5 an incremental run lands on the full run's IMPLEMENTS set", { before, after });
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
