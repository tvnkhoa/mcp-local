/**
 * PY-1..PY-4 — the Python lane end to end, through the real server over stdio.
 *
 * The fixture (`fixtures/python-src/`) is a src-layout package copied to a temp dir and indexed with
 * `mode: "full"`. Each assertion names the construct it proves:
 *   PY-1  methods keep their class through @staticmethod / @classmethod / @property / a pydantic validator;
 *         EXTENDS to BaseModel / Protocol (external, still a token) and to an in-repo base (resolved);
 *         alias, relative, TYPE_CHECKING and every-name imports are emitted.
 *   PY-2  `pkg.mod` → pkg/mod.py, `..mod.name` → the module, `from pkg import f` → pkg/__init__.py,
 *         stdlib / third-party → external boundary.
 *   PY-3  self. / cls. / cls() / super() / typed parameter / self.<field> / module alias / re-exported name /
 *         import alias / registry-dict and partial() references → the right definitions.
 *   PY-4  tests/unit/test_pricing.py ↔ src/shop/pricing.py; a conftest fixture → the test using it.
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
const FIXTURE = path.join(here, "fixtures", "python-src");

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const tmpDir = makeTempDir("py-edges-");
const repoDir = path.join(tmpDir, "repo");
fs.cpSync(FIXTURE, repoDir, { recursive: true });
const repoId = `py-edges-${Date.now()}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repoDir, CODEBASE_INDEX_DB_PATH: path.join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "py-edges-test", version: "0.1.0" });
// Generous timeouts: on a loaded machine the server alone has taken over 60 s to start.
const REQUEST = { timeout: 300_000 };
await client.connect(transport, REQUEST);
attachServerStderr(transport, "test-python-edges");

const call = async (name, args) => js(await client.callTool({ name, arguments: args }, undefined, REQUEST));
const sql = async (query) => (await call("query_graph", { repoId, sql: query, limit: 500, profile: "verbose" }))?.rows ?? [];

try {
  const first = await call("index_repository", { wait: true, repoId, repoPath: repoDir, mode: "full" });
  const run = await waitForIndexJob((runId) => call("index_status", { runId }), first);
  assert(run?.state === "ok" || first?.status === "ok" || first?.runId, "full index of the fixture finished", run ?? first);

  const symbols = await sql(
    `select s.symbol_id as id, s.name, s.kind, replace(s.file_path, char(92), '/') as file, p.name as parent
     from symbols s left join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
     where s.repo_id = :repoId`
  );
  const sym = (file, name, kind) => symbols.find((s) => s.file === file && s.name === name && (!kind || s.kind === kind));
  const edges = await sql(
    `select e.type, e.to_id as toId, e.reason, f.name as fromName, replace(f.file_path, char(92), '/') as fromFile,
            t.name as toName, replace(t.file_path, char(92), '/') as toFile, t.kind as toKind
     from edges e
     join symbols f on f.repo_id = e.repo_id and f.symbol_id = e.from_id
     left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
     where e.repo_id = :repoId`
  );
  const has = (pred) => edges.some(pred);
  const show = (pred) => edges.filter(pred).map((e) => `${e.type} ${e.fromName}@${e.fromFile} -> ${e.toName ?? e.toId}@${e.toFile ?? ""} (${e.reason})`);

  // ── PY-1 ──
  const P = "src/shop/pricing.py", M = "src/shop/models.py", S = "src/shop/core/service.py", R = "src/shop/core/registry.py", I = "src/shop/__init__.py";
  assert(sym(P, "zero", "method")?.parent === "Calculator", "PY-1 @staticmethod keeps its class", sym(P, "zero"));
  assert(sym(P, "build", "method")?.parent === "Calculator", "PY-1 @classmethod keeps its class", sym(P, "build"));
  assert(sym(P, "doubled", "method")?.parent === "Calculator", "PY-1 @property keeps its class", sym(P, "doubled"));
  assert(sym(M, "non_negative", "method")?.parent === "Item", "PY-1 pydantic @field_validator keeps its class", sym(M, "non_negative"));
  assert(sym(P, "price_of", "function") && !sym(P, "price_of", "function").parent, "PY-1 module function is a parentless function");
  assert(has((e) => e.type === "EXTENDS" && e.fromName === "Item" && e.toId === "base:BaseModel"), "PY-1 EXTENDS BaseModel (external base stays a token)", show((e) => e.type === "EXTENDS"));
  assert(has((e) => e.type === "EXTENDS" && e.fromName === "PricePort" && e.toId === "base:Protocol"), "PY-1 EXTENDS Protocol");
  assert(has((e) => e.type === "EXTENDS" && e.fromName === "Service" && e.toName === "Base" && e.toFile === M), "PY-1 EXTENDS an in-repo base resolves to the class", show((e) => e.type === "EXTENDS"));

  // ── PY-2 ──
  const imports = (file) => edges.filter((e) => e.type === "IMPORTS" && e.fromFile === file);
  const importsFile = (from, to) => imports(from).some((e) => e.toFile === to);
  assert(importsFile(S, P), "PY-2 `import shop.pricing as pr` → src/shop/pricing.py (src layout root)", imports(S));
  assert(importsFile(S, I), "PY-2 `from shop import price_of` → src/shop/__init__.py (name falls back to the package)", imports(S));
  assert(importsFile(S, M), "PY-2 `if TYPE_CHECKING:` import → src/shop/models.py", imports(S));
  assert(importsFile(R, P), "PY-2 relative `from ..pricing import price_of as p, apply_discount` → pricing.py", imports(R));
  assert(importsFile(I, P) && importsFile(I, M), "PY-2 `from .pricing import …` in __init__ → sibling modules", imports(I));
  assert(imports(R).filter((e) => e.toFile === P).length >= 1 && imports(R).some((e) => e.toId === "import:functools.partial" && e.reason === "external boundary"),
    "PY-2 stdlib import is an external boundary", imports(R));
  assert(importsFile("tests/unit/test_pricing.py", P), "PY-2 test module import → pricing.py", imports("tests/unit/test_pricing.py"));

  // ── PY-3 ──
  const calls = (fromName, fromFile) => edges.filter((e) => e.type === "CALLS" && e.fromName === fromName && e.fromFile === fromFile);
  const callsTo = (fromName, fromFile, toName, toFile) => calls(fromName, fromFile).some((e) => e.toName === toName && e.toFile === toFile);
  assert(callsTo("run", S, "helper", S), "PY-3 self.helper() → Service.helper", calls("run", S));
  assert(callsTo("run", S, "make", S), "PY-3 Service.make() → Service.make", calls("run", S));
  assert(callsTo("make", S, "create", S), "PY-3 cls.create() → Service.create", calls("make", S));
  assert(callsTo("create", S, "Service", S), "PY-3 cls(...) → the Service class", calls("create", S));
  assert(callsTo("run", S, "total", P), "PY-3 self.calc.total() (self.calc = calc: Calculator) → Calculator.total", calls("run", S));
  assert(callsTo("summarize", S, "total", P), "PY-3 typed parameter calc.total() → Calculator.total", calls("summarize", S));
  assert(callsTo("run", S, "price_of", P), "PY-3 pr.price_of() / re-exported price_of() → pricing.price_of", calls("run", S));
  assert(callsTo("helper", S, "describe", M), "PY-3 super().describe() → Base.describe up the EXTENDS chain", calls("helper", S));
  assert(!calls("__init__", S).some((e) => e.toName === "__init__"), "PY-3 super().__init__() over a dataclass base binds no repo __init__", calls("__init__", S));
  assert(callsTo("build", P, "zero", P), "PY-3 cls.zero() → Calculator.zero", calls("build", P));
  assert(callsTo("doubled", P, "total", P), "PY-3 self.total() in a @property → Calculator.total", calls("doubled", P));
  assert(callsTo("total", P, "price_of_cents", P), "PY-3 module function call → same-file function", calls("total", P));
  assert(callsTo("registry.py", R, "price_of", P), "PY-3 registry dict value `p` (import alias) → price_of reference", calls("registry.py", R));
  assert(callsTo("registry.py", R, "apply_discount", P), "PY-3 partial(apply_discount, 1) → apply_discount reference", calls("registry.py", R));
  assert(!edges.some((e) => e.type === "CALLS" && /^callee:(len|print|append|get)$/.test(e.toId)), "PY-3 builtins are not emitted");
  // Both base orders, so a lookup in symbol-id order cannot pass by luck.
  const MRO = "src/shop/mro.py";
  const goCalls = (cls) => edges.filter((e) => e.type === "CALLS" && e.fromFile === MRO && e.fromName === "go" && symbols.some((s) => s.file === MRO && s.name === "go" && s.parent === cls));
  const goOf = (cls) => symbols.find((s) => s.file === MRO && s.name === "go" && s.parent === cls)?.id;
  const runTargets = async (cls) => (await sql(`select p.name as owner from edges e join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id join symbols p on p.repo_id = t.repo_id and p.symbol_id = t.parent_symbol_id where e.repo_id = :repoId and e.type = 'CALLS' and e.from_id = '${goOf(cls)}' and t.name = 'run'`)).map((r) => r.owner);
  assert(JSON.stringify(await runTargets("ZetaFirst")) === '["Zeta"]', "PY-3 self.run() in class ZetaFirst(Zeta, Alpha) → Zeta.run (base-list order)", await runTargets("ZetaFirst"));
  assert(JSON.stringify(await runTargets("AlphaFirst")) === '["Alpha"]', "PY-3 self.run() in class AlphaFirst(Alpha, Zeta) → Alpha.run (base-list order)", await runTargets("AlphaFirst"));
  assert(callsTo("go", MRO, "total", P), "PY-3 Optional[Calculator] parameter → Calculator.total", goCalls("ZetaFirst"));
  assert(!edges.some((e) => e.fromFile === MRO && /^callee:(list|Optional)\./.test(e.toId)), "PY-3 list[...] / Optional[...] never become a receiver class", show((e) => e.fromFile === MRO));
  // Stacked route decorators, one written twice: two routes, not three (the store has no unique key).
  const routes = await sql(`select http_method as method, route_template as template, handler_name as handler from routes where repo_id = :repoId and replace(file_path, char(92), '/') = 'src/shop/api.py' order by http_method`);
  assert(JSON.stringify(routes.map((r) => `${r.method} ${r.template} ${r.handler}`)) === '["GET /items items","POST /items items"]',
    "PY-1 stacked FastAPI decorators → one route per distinct method, duplicates dropped", routes);
  const orphans = await sql(`select count(*) n from edges where repo_id = :repoId and from_id not like 'callee:%' and from_id not in (select symbol_id from symbols where repo_id = :repoId)`);
  assert(orphans[0]?.n === 0, "PY-1 a def under a syntax error (broken.py) leaves no edge without its source symbol", orphans);

  // ── PY-4 ──
  const T = "tests/unit/test_pricing.py";
  const links = (await call("link_tests_to_source", { repoId, filePath: T, minScore: 0.4, profile: "verbose" }));
  const linkRows = links?.links ?? links?.results ?? links?.pairs ?? [];
  assert(linkRows.some((l) => (l.sourceFile ?? "").replace(/\\/g, "/") === P), "PY-4 link_tests_to_source maps test_pricing.py → pricing.py", links);
  const fromSource = await call("link_tests_to_source", { repoId, filePath: P, minScore: 0.4, profile: "verbose" });
  const fromSourceRows = fromSource?.links ?? fromSource?.results ?? fromSource?.pairs ?? [];
  assert(fromSourceRows.some((l) => (l.testFile ?? "").replace(/\\/g, "/") === T), "PY-4 probing pricing.py finds test_pricing.py", fromSource);
  assert(callsTo("test_price_of", T, "sample_item", "tests/conftest.py"), "PY-4 conftest fixture sample_item → the test requesting it", calls("test_price_of", T));

  // ── tool-level probe: get_call_chain lists real callees ──
  const runId = sym(S, "run", "method")?.id;
  const chain = await call("get_call_chain", { repoId, symbolId: runId, direction: "callees", depth: 2, profile: "verbose" });
  const chainText = JSON.stringify(chain);
  assert(/"total"|Calculator\.total|total/.test(chainText) && /helper/.test(chainText) && /price_of/.test(chainText), "get_call_chain(Service.run) lists helper, total, price_of", chainText.slice(0, 800));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
