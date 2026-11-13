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
          t.name as toName, replace(t.file_path, char(92), '/') as toFile, t.kind as toKind, tp.name as toParent, fp.name as fromParent
   from edges e
   join symbols f on f.repo_id = e.repo_id and f.symbol_id = e.from_id
   left join symbols fp on fp.repo_id = f.repo_id and fp.symbol_id = f.parent_symbol_id
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

  // ── PY-5b: inherited bodies are dispatch targets ──
  const shutdownDispatch = edges.filter((e) => e.type === "CALLS" && e.fromName === "shutdown" && e.fromFile === PIPE && e.reason === "interface-dispatch");
  assert(shutdownDispatch.some((e) => e.toName === "close" && e.toParent === "BaseExec" && e.toFile === "src/flow/executors/base.py"),
    "PY-5b executor.close() dispatches to BaseExec.close, which SyncExecutor inherits", shutdownDispatch.map((e) => `${e.toParent}.${e.toName}`));
  const DEFAULTS = "src/flow/defaults.py";
  const finish = edges.filter((e) => e.type === "CALLS" && e.fromName === "finish" && e.fromFile === DEFAULTS && e.toName === "footer");
  const finishTo = finish.map((e) => `${e.toParent}:${e.reason}`).sort();
  assert(finish.some((e) => e.toParent === "Renderer" && e.reason !== "interface-dispatch"), "PY-5b r.footer() → Renderer.footer", finishTo);
  assert(finish.some((e) => e.toParent === "RendererDefaults" && e.reason === "interface-dispatch"),
    "PY-5b Page (no override) → the sub-Protocol's default RendererDefaults.footer", finishTo);
  assert(finish.some((e) => e.toParent === "Fancy" && e.reason === "interface-dispatch"), "PY-5b Fancy's own override is dispatched", finishTo);
  assert(!finish.some((e) => e.toParent === "Stray" || e.toParent === "Page"), "PY-5b no edge to a non-implementer (Stray) or a class without the method (Page)", finishTo);

  // ── PY-5c: a Protocol is bound by the caller's import ──
  const A_SINK = "src/flow/a_sinks/ports.py", Z_SINK = "src/flow/z_sinks/ports.py";
  const emitOf = (fromName) => edges.filter((e) => e.type === "CALLS" && e.fromName === fromName && e.toName === "emit")
    .map((e) => `${e.toParent}@${e.toFile}:${e.reason}`).sort();
  const sendTo = emitOf("send");
  assert(sendTo.some((t) => t.startsWith(`Sink@${Z_SINK}`)) && sendTo.some((t) => t === `TextSink@${Z_SINK}:interface-dispatch`),
    "PY-5c sink.emit() with Sink imported from z_sinks → z_sinks Sink.emit, dispatched to TextSink", sendTo);
  assert(!sendTo.some((t) => t.includes(A_SINK)), "PY-5c … and nothing in a_sinks (the same-named Protocol sorting first)", sendTo);
  const sendIntTo = emitOf("send_int");
  assert(sendIntTo.some((t) => t.startsWith(`Sink@${A_SINK}`)) && sendIntTo.some((t) => t === `IntSink@${A_SINK}:interface-dispatch`) && !sendIntTo.some((t) => t.includes(Z_SINK)),
    "PY-5c control: the caller importing a_sinks binds a_sinks Sink → IntSink only", sendIntTo);

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

  // ── PY-8 ──
  const CONSUMER = "src/flow/consumer.py", IMPL = "src/flow/helpers/impl.py", API = "src/flow/helpers/api.py";
  const starImport = edges.find((e) => e.type === "IMPORTS" && e.fromFile === CONSUMER && e.toFile === API);
  assert(starImport?.reason === "resolved python star import", "PY-8 `from .helpers.api import *` → api.py, marked as a star import", show((e) => e.type === "IMPORTS" && e.fromFile === CONSUMER));
  const useCalls = () => edges.filter((e) => e.type === "CALLS" && e.fromName === "use" && e.fromFile === CONSUMER);
  assert(useCalls().some((e) => e.toName === "normalize" && e.toFile === IMPL) && !useCalls().some((e) => e.toFile === "src/flow/alt.py"),
    "PY-8 normalize() via the star import → helpers/impl.py (re-exported by api.py), not the alt.py decoy", useCalls());
  assert(useCalls().some((e) => e.toName === "check" && e.toParent === "Formatter" && e.toFile === IMPL),
    "PY-8 Formatter.check() on a star-imported class → impl.py Formatter.check", useCalls());
  // ── PY-8b: `__all__` ──
  assert(symbols.find((s) => s.file === API && s.kind === "module")?.id && (await sql(
    `select signature from symbols where repo_id = :repoId and kind = 'module' and replace(file_path, char(92), '/') = '${API}'`
  ))[0]?.signature === "__all__:normalize,Formatter", "PY-8b api.py's __all__ is recorded on its module symbol");
  const PLAIN = "src/flow/helpers/plain.py", ALT = "src/flow/alt.py";
  const plainCalls = edges.filter((e) => e.type === "CALLS" && e.fromName === "use_plain" && e.fromFile === "src/flow/consumer_plain.py");
  const plainTo = (name) => plainCalls.filter((e) => e.toName === name).map((e) => e.toFile);
  assert(plainTo("shown").includes(PLAIN), "PY-8b no __all__: a public name (shown) binds through the star import", plainCalls);
  assert(JSON.stringify(plainTo("slugify")) === JSON.stringify([ALT]),
    "PY-8b slugify, imported by api.py but not in its __all__, does not bind impl.py", plainCalls);
  assert(JSON.stringify(plainTo("_hidden")) === JSON.stringify([ALT]),
    "PY-8b no __all__: a private name (_hidden) is not star-exported by plain.py", plainCalls);
  assert(JSON.stringify(plainTo("_private")) === JSON.stringify([ALT]),
    "PY-8b no __all__: a private name plain.py imports (_private) is not re-exported", plainCalls);
  const useKey = (list) => list.filter((e) => e.type === "CALLS" && ((e.fromName === "use" && e.fromFile === CONSUMER) || e.fromName === "use_plain"))
    .map((e) => `${e.fromName}:${e.toName}@${e.toFile}`).sort();

  // ── PY-6 ──
  const ENGINE = "src/flow/engine.py", STAGING = "src/flow/staging.py", FIX = "src/flow/steps/fix_step.py", DRAFT = "src/flow/steps/draft_step.py";
  const engineCalls = (fromName) => edges.filter((e) => e.type === "CALLS" && e.fromName === fromName && e.fromFile === ENGINE && e.toName === "run");
  const stepImpl = (from) => edges.find((e) => e.type === "IMPLEMENTS" && e.fromName === from && e.toName === "Step");
  assert(stepImpl("FixStep") && stepImpl("DraftStep"), "PY-6 FixStep / DraftStep structurally implement Step (signature fits)", show((e) => e.type === "IMPLEMENTS" && e.toName === "Step"));
  assert(!stepImpl("Worker"), "PY-6 Worker.run(job: str) -> str is not a Step.run(ctx: Ctx) -> Outcome: no IMPLEMENTS");
  const go = engineCalls("go");
  assert(go.some((e) => e.toParent === "Step" && e.toFile === STAGING), "PY-6 self.factory(sid)().run(ctx) → Step.run (return annotation → Callable alias → Step)", go);
  assert(go.some((e) => e.toParent === "FixStep" && e.toFile === FIX && e.reason === "interface-dispatch") &&
    go.some((e) => e.toParent === "DraftStep" && e.toFile === DRAFT && e.reason === "interface-dispatch"),
    "PY-6 the run path reaches FixStep.run and DraftStep.run through the stage Protocol", go.map((e) => `${e.toParent}.${e.toName} (${e.reason})`));
  assert(!go.some((e) => e.toParent === "Worker"), "PY-6 the dispatch skips Worker.run");
  assert(engineCalls("built").some((e) => e.toParent === "Step"), "PY-6 step = make_fix() (-> Step); step.run() → Step.run", engineCalls("built"));
  const drive = engineCalls("drive");
  assert(drive.some((e) => e.toParent === "FixStep" && e.reason === "resolved callee by receiver type"), "PY-6 untyped param `item` takes FixStep from its one same-file caller (1 hop)", drive);
  const withDefault = edges.filter((e) => e.type === "CALLS" && e.fromName === "with_default" && e.fromFile === ENGINE && e.toName === "run");
  assert(withDefault.some((e) => e.toParent === "FixStep"), "PY-6 `step=FixStep()` default types the parameter", withDefault);
  const unknown = edges.filter((e) => e.type === "CALLS" && e.fromName === "unknown" && e.fromFile === ENGINE && e.toName === "run");
  assert(unknown.length > 0 && unknown.every((e) => e.reason === "resolved callee by name (untyped receiver)" && e.confidence < 0.7),
    "PY-6 an untyped receiver with no caller is a flagged low-confidence candidate (< 0.7)", unknown);

  // ── PY-6b: cross-file, multi-hop callers; a candidate set ──
  const HOPS = "src/flow/hops/apply.py", LIGHTS = "src/flow/hops/lights.py";
  const CALLER_TYPED = "resolved callee by caller argument type (untyped receiver)";
  const hopCalls = (fromName, toName) => edges.filter((e) => e.type === "CALLS" && e.fromName === fromName && e.fromFile === HOPS && e.toName === toName);
  const applyRun = hopCalls("apply_step", "run");
  const applyKey = (list) => list.filter((e) => e.type === "CALLS" && e.fromFile === HOPS && (e.toName === "run" || e.toName === "blink"))
    .map((e) => `${e.fromName}->${e.toParent}.${e.toName}:${e.reason}:${e.confidence}`).sort();
  assert(applyRun.some((e) => e.toParent === "FixStep" && e.toFile === FIX && e.reason === CALLER_TYPED),
    "PY-6b step.run() in apply_step → FixStep.run, from fix_now's argument in callers.py (cross-file, 1 hop)", applyRun);
  assert(applyRun.some((e) => e.toParent === "DraftStep" && e.toFile === DRAFT && e.reason === CALLER_TYPED),
    "PY-6b … and DraftStep.run, through relay's untyped parameter (cross-file, 2 hops)", applyRun);
  assert(applyRun.length === 2 && applyRun.every((e) => e.reason === CALLER_TYPED && e.confidence < 0.7),
    "PY-6b the set is exactly {FixStep.run, DraftStep.run}, each flagged < 0.7 — not Worker.run, not a name pick", applyRun.map((e) => `${e.toParent}:${e.reason}:${e.confidence}`));
  assert(!applyRun.some((e) => e.toParent === "FakeStep"), "PY-6b a test's double (tests/test_hops_double.py FakeStep) does not type production apply_step", applyRun);
  const pokeBlink = hopCalls("poke", "blink");
  assert(pokeBlink.length === 1 && pokeBlink[0].toFile === LIGHTS && pokeBlink[0].reason === "resolved callee by name (untyped receiver)" && pokeBlink[0].confidence < 0.7,
    "PY-6b no caller types `widget`: widget.blink() stays ONE flagged name candidate — no set of every same-named method", pokeBlink);
  assert(!edges.some((e) => e.type === "CALLS" && e.reason === "resolved callee by name (untyped receiver)" && e.fromFile === HOPS && e.fromName === "apply_step"),
    "PY-6b the caller-typed set replaces apply_step's name pick (no leftover name row)");
  assert(!edges.some((e) => e.type === "CALLS" && e.fromName === "unknown" && e.fromFile === ENGINE && e.toName === "run" && e.reason === CALLER_TYPED),
    "PY-6b a receiver no caller types stays a name candidate (unknown(thing): > 8 `run` methods, no set)");
  // MCP-ISSUE-128 row #12 (a): a traversal over a 0.6 untyped-receiver row is standing on a name guess.
  const traceUnknown = await call("trace_execution_flow", { repoId, entrySymbolId: sym(ENGINE, "unknown", "function")?.id, maxDepth: 1, profile: "compact" });
  assert(traceUnknown?.coverage?.confidence && traceUnknown.coverage.confidence !== "high" &&
    (traceUnknown.coverage.knownGaps ?? []).some((g) => /resolved by callee NAME only/.test(g)),
    "(a) trace_execution_flow over unknown()'s untyped-receiver row reports coverage below high, naming the name-only hop", traceUnknown?.coverage);
  const traceApply = await call("trace_execution_flow", { repoId, entrySymbolId: sym(HOPS, "apply_step", "function")?.id, maxDepth: 1, profile: "compact" });
  assert(!(traceApply?.coverage?.knownGaps ?? []).some((g) => /resolved by callee NAME only/.test(g)),
    "(a) control: apply_step's caller-typed rows are not counted as name-only", traceApply?.coverage);
  const kwRun = hopCalls("kw_trap", "run");
  assert(kwRun.length === 1 && kwRun[0].toParent === "FixStep" && kwRun[0].reason === CALLER_TYPED,
    "review #6: keyword-only `step` after *rest takes step=FixStep(), not the third positional Worker()", kwRun);
  // review #3: the hinted untyped row duplicating a proven one is demoted, not kept beside it.
  const bothPing = edges.filter((e) => e.type === "CALLS" && e.fromName === "both" && e.fromFile === "src/flow/hops/dup.py" && e.toName === "ping");
  assert(bothPing.length === 1 && bothPing[0].reason === "resolved callee by receiver type",
    "review #3: p.ping() (typed) and q.ping() (untyped) in one caller → one CALLS row to Pinger.ping, the proven one", bothPing);
  // ── Row #16 (MCP-ISSUE-128 open items): class calls, constructor arguments, the same-file bind ──
  const CC = "src/flow/hops/classcall.py", SAME = "src/flow/hops/samefile.py";
  const rowsOf = (file, parent, fromName, toName) => edges.filter((e) => e.type === "CALLS" && e.fromFile === file && (e.fromParent ?? "") === parent && e.fromName === fromName && e.toName === toName);
  const tos = (list) => list.map((e) => `${e.toParent ?? ""}.${e.toName}:${e.reason}:${e.confidence}`).sort();
  const flip = rowsOf(CC, "Switch", "flip", "blink");
  assert(JSON.stringify(tos(flip)) === JSON.stringify([`Lamp.blink:${CALLER_TYPED}:0.65`]),
    "#16 item 1: Switch.flip(BlinkSwitch(), Lamp()) types `light` from the 2nd argument (the 1st is self) → Lamp.blink", tos(flip));
  assert(!flip.some((e) => e.toParent === "BlinkSwitch"), "#16 item 1 negative: the explicit self (BlinkSwitch, which has blink) does not type `light`", tos(flip));
  const flipStatic = rowsOf(CC, "Switch", "flip_static", "blink");
  assert(JSON.stringify(tos(flipStatic)) === JSON.stringify([`Led.blink:${CALLER_TYPED}:0.65`]),
    "#16 item 1: a @staticmethod class call is not shifted — Switch.flip_static(Led()) → Led.blink", tos(flipStatic));
  const flipCls = rowsOf(CC, "Switch", "flip_cls", "blink");
  assert(JSON.stringify(tos(flipCls)) === JSON.stringify([`Lamp.blink:${CALLER_TYPED}:0.65`]),
    "#16 item 1: a @classmethod class call is not shifted — Switch.flip_cls(Lamp()) → Lamp.blink", tos(flipCls));
  const initBlink = rowsOf(CC, "Holder", "__init__", "blink");
  assert(JSON.stringify(tos(initBlink)) === JSON.stringify([`Led.blink:${CALLER_TYPED}:0.65`]),
    "#16 item 2: Holder(Led()) types __init__'s untyped `light` → Led.blink", tos(initBlink));
  const laterBlink = rowsOf(CC, "Holder", "later", "blink");
  assert(JSON.stringify(tos(laterBlink)) === JSON.stringify([`Led.blink:${CALLER_TYPED}:0.65`]),
    "#16 item 2: self.light = light in __init__, then self.light.blink() → Led.blink", tos(laterBlink));
  const bareLater = rowsOf(CC, "Bare", "later", "blink");
  assert(bareLater.length === 1 && bareLater[0].reason === "resolved callee by name (untyped receiver)" && bareLater[0].confidence < 0.7,
    "#16 item 2 negative: a class no caller constructs with a typed argument keeps ONE flagged name pick", tos(bareLater));
  const sameGo = rowsOf(SAME, "GoS", "go", "ping");
  assert(JSON.stringify(tos(sameGo)) === JSON.stringify([`PingerS.ping:${CALLER_TYPED}:0.65`]),
    "#16 item 3: x.ping() beside a same-file PingerS.ping is typed by drive_s's r.go(PingerS()) (PY-6b now sees it), not bound 'same-file' 0.9", tos(sameGo));
  const sameGoT = rowsOf(SAME, "GoT", "go", "ping");
  assert(JSON.stringify(tos(sameGoT)) === JSON.stringify(["PingerS.ping:resolved callee by name (untyped receiver):0.6"]),
    "#16 item 3: y.ping() with no typing caller is a flagged untyped receiver (0.6), not 'resolved callee same-file' 0.9", tos(sameGoT));
  const driveGo = rowsOf(SAME, "", "drive_s", "go");
  assert(JSON.stringify(tos(driveGo)) === JSON.stringify(["GoS.go:resolved callee by receiver type:0.9"]),
    "#16 item 3: r.go(...) keeps its same-file 1-hop type from main_s's drive_s(GoS()) (proven, unchanged)", tos(driveGo));
  const driveHelper = rowsOf(SAME, "", "drive_s", "helper");
  assert(driveHelper.length === 1 && driveHelper[0].reason === "resolved callee same-file" && driveHelper[0].confidence === 0.9,
    "#16 item 3 negative: a bare function call helper() still binds same-file at 0.9", tos(driveHelper));
  const againGo = rowsOf(SAME, "GoS", "again", "go");
  assert(againGo.length === 1 && againGo[0].toParent === "GoS" && againGo[0].confidence >= 0.9,
    "#16 item 3 negative: self.go(...) is proven (qualified token), not flagged", tos(againGo));
  // review #4: C3, not breadth-first.
  const mroM = edges.filter((e) => e.type === "CALLS" && e.fromName === "use_mro" && e.toName === "m");
  assert(mroM.length === 1 && mroM[0].toParent === "A", "review #4: d.m() with class D(B, C), class B(A) → A.m (C3), not C.m (breadth-first)", mroM);
  // review #5: extend / append.
  const exportedSig = (await sql(`select signature from symbols where repo_id = :repoId and kind = 'module'
    and replace(file_path, char(92), '/') = 'src/flow/hops/exported.py'`))[0]?.signature;
  assert(exportedSig === "__all__:one,two,three", "review #5: __all__.extend / .append are read", exportedSig);
  const chain = await call("get_call_chain", { repoId, symbolId: sym(ENGINE, "go", "method")?.id, direction: "callees", depth: 3, profile: "verbose" });
  const chainEdges = chain?.edges ?? [];
  assert(chainEdges.some((e) => e.toName === "run" && (e.toFilePath ?? "").replace(/\\/g, "/") === FIX), "PY-6 get_call_chain(Engine.go) reaches FixStep.run",
    chainEdges.map((e) => `${e.fromName}->${e.toName}@${e.toFilePath} (${e.reason})`));

  // ── review fixes ──
  const shutdownCalls = edges.filter((e) => e.type === "CALLS" && e.fromName === "shutdown" && e.fromFile === PIPE && e.toName === "close");
  assert(shutdownCalls.some((e) => e.toParent === "Executor" && e.toFile === PORTS) && !shutdownCalls.some((e) => e.toParent === "Store"),
    "review: executor.close() → Executor.close, not Store.close in the same file", shutdownCalls);
  const GREET = "src/flow/greeting.py";
  const shout = edges.filter((e) => e.type === "CALLS" && e.fromName === "shout" && e.fromFile === GREET);
  assert(shout.some((e) => e.toName === "greet" && e.toParent === "Greeter"), "review: self.greet() in class Loud(Greeter) → the Protocol's default Greeter.greet", shout);
  assert(edges.some((e) => e.type === "IMPLEMENTS" && e.fromName === "IntBox" && e.toName === "Box" && e.reason === "structural protocol"),
    "review: IntBox.put(item: int) fits Box[T].put(item: T) (TypeVar binds anything)", show((e) => e.type === "IMPLEMENTS" && e.fromFile === GREET));

  // ── PY-9 ──
  const q = await call("search_symbols", { repoId, query: "FixStep.run", strategy: "name", profile: "verbose" });
  const qRows = q?.symbols ?? q?.results ?? [];
  assert(qRows.length === 1 && qRows[0].name === "run" && (qRows[0].filePath ?? "").replace(/\\/g, "/") === FIX,
    "PY-9 search_symbols(\"FixStep.run\") → exactly FixStep.run", q);
  const qPkg = await call("search_symbols", { repoId, query: "steps.fix_step.FixStep.run", strategy: "name", profile: "verbose" });
  assert((qPkg?.symbols ?? []).some((s) => (s.filePath ?? "").replace(/\\/g, "/") === FIX), "PY-9 a module-qualified path matches on its last two segments", qPkg);
  const ranked = await call("search_symbols", { repoId, query: "Step.run", strategy: "name", ranked: true, profile: "verbose" });
  const rankedRows = ranked?.candidates ?? [];
  assert(rankedRows.length === 1 && rankedRows[0].qualifiedName === "Step.run" && rankedRows[0].matchType === "exact",
    "PY-9 ranked search_symbols(\"Step.run\") → the Protocol member only, exact", ranked);
  const noOwner = await call("search_symbols", { repoId, query: "Nope.run", strategy: "name", profile: "verbose" });
  assert(!(noOwner?.symbols ?? []).some((s) => s.name === "run"), "PY-9 an unknown owner does not fall back to every `run`", noOwner);

  // Scoped re-index: touch one implementer; the rebuilt-whole IMPLEMENTS set must not move.
  const before = implementsKey(edges);
  fs.appendFileSync(path.join(repoDir, "src", "flow", "executors", "mock.py"), "\n# touched\n");
  const inc = await index("incremental");
  assert(inc?.state === "ok" || inc?.status === "ok" || inc?.runId, "incremental re-index finished", inc);
  const edgesAfter = await loadEdges();
  const after = implementsKey(edgesAfter);
  assert(JSON.stringify(after) === JSON.stringify(before), "PY-5 an incremental run lands on the full run's IMPLEMENTS set", { before, after });

  // PY-8 scoped: touch the consumer (its star token is re-read) and, separately, a file it does not import
  // (its star import is then read from the resolved row's reason).
  const useBefore = useKey(edges);
  fs.appendFileSync(path.join(repoDir, "src", "flow", "consumer.py"), "\n# touched\n");
  await index("incremental");
  const useAfterConsumer = useKey(await loadEdges());
  fs.appendFileSync(path.join(repoDir, "src", "flow", "alt.py"), "\n# touched\n");
  await index("incremental");
  const useAfterAlt = useKey(await loadEdges());
  assert(JSON.stringify(useAfterConsumer) === JSON.stringify(useBefore) && JSON.stringify(useAfterAlt) === JSON.stringify(useBefore),
    "PY-8 / PY-8b incremental runs land on the full run's star-import targets (__all__ filter included)", { useBefore, useAfterConsumer, useAfterAlt });

  // PY-6b scoped: touch the callee's file (its anchors are re-extracted and re-resolved), then the callers'
  // file (the anchors are unchanged rows the rebuild re-reads); both land on the full run's set.
  const hopsBefore = applyKey(edges);
  fs.appendFileSync(path.join(repoDir, "src", "flow", "hops", "apply.py"), "\n# touched\n");
  await index("incremental");
  const hopsAfterApply = applyKey(await loadEdges());
  fs.appendFileSync(path.join(repoDir, "src", "flow", "hops", "callers.py"), "\n# touched\n");
  await index("incremental");
  const hopsAfterCallers = applyKey(await loadEdges());
  assert(JSON.stringify(hopsAfterApply) === JSON.stringify(hopsBefore) && JSON.stringify(hopsAfterCallers) === JSON.stringify(hopsBefore),
    "PY-6b incremental runs land on the full run's candidate sets", { hopsBefore, hopsAfterApply, hopsAfterCallers });

  // Row #16 scoped: touch the class-call callers' file, then the callees' file; both land on the full run.
  const row16Key = (list) => list.filter((e) => e.type === "CALLS" && [CC, SAME].includes(e.fromFile))
    .map((e) => `${e.fromParent ?? ""}.${e.fromName}->${e.toParent ?? ""}.${e.toName ?? e.toId}:${e.reason}:${e.confidence}`).sort();
  const row16Before = row16Key(edges);
  fs.appendFileSync(path.join(repoDir, "src", "flow", "hops", "use_classcall.py"), "\n# touched\n");
  await index("incremental");
  const row16AfterCallers = row16Key(await loadEdges());
  fs.appendFileSync(path.join(repoDir, "src", "flow", "hops", "classcall.py"), "\n# touched\n");
  fs.appendFileSync(path.join(repoDir, "src", "flow", "hops", "samefile.py"), "\n# touched\n");
  await index("incremental");
  const row16AfterCallees = row16Key(await loadEdges());
  assert(JSON.stringify(row16AfterCallers) === JSON.stringify(row16Before) && JSON.stringify(row16AfterCallees) === JSON.stringify(row16Before),
    "#16 incremental runs land on the full run's class-call / constructor / same-file rows", { row16Before, row16AfterCallers, row16AfterCallees });

  // review #1: an anchor carrying pyargs (drive2's `r.go(Pinger())`) must not feed callers from the target a
  // previous run moved it to. Switch main2 from GoB to GoA in relay2_main.py only (relay2.py unchanged), then
  // compare the scoped run with a full run.
  const RELAY2 = ["src/flow/hops/relay2.py", "src/flow/hops/relay2_types.py"];
  const relayKey = (list) => list.filter((e) => e.type === "CALLS" && RELAY2.includes(e.fromFile))
    .map((e) => `${e.fromParent ?? ""}.${e.fromName}->${e.toParent}.${e.toName}:${e.reason}:${e.confidence}`).sort();
  fs.writeFileSync(path.join(repoDir, "src", "flow", "hops", "relay2_main.py"),
    "from .relay2 import drive2\nfrom .relay2_types import GoA\n\n\ndef main2() -> None:\n    drive2(GoA())\n");
  await index("incremental");
  const relayScoped = relayKey(await loadEdges());
  await index("full");
  const relayFull = relayKey(await loadEdges());
  assert(JSON.stringify(relayScoped) === JSON.stringify(relayFull) && relayFull.some((k) => k.startsWith(".drive2->GoA.go:resolved callee by caller argument type")) &&
    ["GoA", "GoB"].every((c) => relayFull.includes(`${c}.go->Pinger.ping:resolved callee by name (untyped receiver):0.6`)),
    "review #1: scoped run after retyping drive2's caller lands on the full run (anchor pyargs not read)", { relayScoped, relayFull });

  // PY-6b scoped, callers gone: the typing calls are removed from callers.py only (apply.py unchanged, so its
  // anchor row is the one a previous run moved). It must come back to the name pick a full run gives.
  fs.writeFileSync(path.join(repoDir, "src", "flow", "hops", "callers.py"), "def nothing():\n    return None\n");
  await index("incremental");
  const hopsScoped = applyKey(await loadEdges());
  await index("full");
  const hopsFull = applyKey(await loadEdges());
  const scopedApply = hopsScoped.filter((k) => k.startsWith("apply_step->"));
  assert(scopedApply.length === 1 && scopedApply[0].includes(":resolved callee by name (untyped receiver):0.6") && JSON.stringify(hopsScoped) === JSON.stringify(hopsFull),
    "PY-6b callers removed in a scoped run: apply_step's anchor returns to the full run's single name pick", { hopsScoped, hopsFull });
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
