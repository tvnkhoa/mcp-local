/**
 * IX-9 U4 — seed-conformance harness: is a seeded worktree index the same index as a full one?
 *
 * Two modes.
 *
 *   Self-test (no arguments; the `test:seed-conformance` script). Proves the comparator on a scratch DB:
 *     (a) one fixture tree (TypeScript + C# + markdown, a git repo) indexed full under two repoIds → the
 *         comparator reports EQUAL, every table and every probe, and the probes are not empty;
 *     (b) the same tree with one function renamed, indexed under a third repoId → the comparator reports
 *         DIFFERENT, in the symbols table and in the probe that names the function (it is not vacuous).
 *
 *   Compare (for IX-9 acceptance):
 *     node scripts/test/test-seed-conformance.mjs --db <index.db> --roots <dir[,dir]> \
 *          --a <repoId> --b <repoId> --probes <probes.json>
 *   starts its own server (dist/index.js) on that DB, compares the two repoIds already indexed in it, prints
 *   the diff and exits 1 on any difference. probes.json: [{ "name"?, "tool", "args" }] — args without repoId.
 *   It refuses a DB under ~/.claude (the live index) — copy it to a scratch dir first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";
import { compareIndexes, formatReport } from "./_seedCompare.mjs";
import "./_indexWait.mjs";

const txt = (r) => (Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(db|roots|a|b|probes)$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument ${argv[i]}`);
    out[m[1]] = argv[++i];
  }
  return out;
}

async function startServer(dbPath, roots, label) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: roots,
      CODEBASE_INDEX_DB_PATH: dbPath,
      CODEBASE_INDEX_LLM_ENABLED: "false",
      CODEBASE_INDEX_MIN_FREE_RAM_MB: "0",
      CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: "false"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: label, version: "0" });
  await client.connect(transport);
  attachServerStderr(transport, label);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const text = txt(r);
    let body = null;
    try { body = JSON.parse(text); } catch { /* error text */ }
    return { body, text, isError: r.isError === true };
  };
  return { client, call };
}

// ── Compare mode ────────────────────────────────────────────────────────────────────────────
async function compareMode(opts) {
  for (const k of ["db", "roots", "a", "b", "probes"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const dbPath = resolve(opts.db);
  if (dbPath.toLowerCase().startsWith(join(homedir(), ".claude").toLowerCase())) {
    throw new Error(`refusing ${dbPath}: that is the live index; copy it to a scratch dir first`);
  }
  const probes = JSON.parse(readFileSync(opts.probes, "utf8"));
  const { client, call } = await startServer(dbPath, opts.roots, "seed-conformance");
  try {
    const result = await compareIndexes({ dbPath, repoA: opts.a, repoB: opts.b, probes, call });
    console.log(formatReport(result, opts.a, opts.b));
    return result.equal ? 0 : 1;
  } finally {
    await Promise.race([client.close().catch(() => {}), sleep(5000)]);
  }
}

// ── Self-test mode ──────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

const FIXTURE = {
  "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
  "src/orders.ts": [
    'import { formatTotal } from "./format";',
    "export interface OrderLine { sku: string; qty: number; price: number }",
    "export class OrderService {",
    "  computeOrderTotal(lines: OrderLine[]): number {",
    "    return lines.reduce((s, l) => s + l.qty * l.price, 0);",
    "  }",
    "  describeOrder(lines: OrderLine[]): string {",
    "    return formatTotal(this.computeOrderTotal(lines));",
    "  }",
    "}",
    ""
  ].join("\n"),
  "src/format.ts": "export function formatTotal(n: number): string {\n  return `$${n.toFixed(2)}`;\n}\n",
  "src/Billing/Invoice.cs": [
    "namespace Shop.Billing;",
    "public interface IInvoiceSink { void Send(Invoice invoice); }",
    "public class Invoice {",
    "    public decimal Amount { get; set; }",
    "    public void Post(IInvoiceSink sink) { sink.Send(this); }",
    "}",
    ""
  ].join("\n"),
  "docs/billing.md": [
    "# Billing",
    "",
    "## Order totals",
    "",
    "`computeOrderTotal` sums qty × price for each line; `formatTotal` prints it.",
    "",
    "## Invoices",
    "",
    "An `Invoice` is posted to an `IInvoiceSink`.",
    ""
  ].join("\n")
};

const PROBES = [
  { name: "symbols:computeOrderTotal", tool: "search_symbols", args: { query: "computeOrderTotal", strategy: "name", limit: 10 } },
  { name: "symbols:Invoice", tool: "search_symbols", args: { query: "Invoice", strategy: "name", limit: 10 } },
  { name: "docs:order totals", tool: "query_docs", args: { mode: "search", query: "order totals", limit: 10 } },
  { name: "docs:section Invoices", tool: "query_docs", args: { mode: "section", filePath: "docs/billing.md", headingPrefix: "Invoices" } },
  { name: "regex:reduce", tool: "search_regex", args: { pattern: "reduce\\(", limit: 10 } }
];

function writeRepo(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "fixture");
}

async function selfTest() {
  const root = makeTempDir("seed-conformance-");
  const treeDir = join(root, "tree");
  const mutantDir = join(root, "mutant");
  writeRepo(treeDir, FIXTURE);
  writeRepo(mutantDir, { ...FIXTURE, "src/orders.ts": FIXTURE["src/orders.ts"].replaceAll("computeOrderTotal", "computeOrderSum") });
  mkdirSync(join(root, ".index"), { recursive: true });
  const dbPath = join(root, ".index", "index.db");
  const stamp = Date.now();
  const idA = `sc-a-${stamp}`, idB = `sc-b-${stamp}`, idM = `sc-m-${stamp}`;

  const { client, call } = await startServer(dbPath, root, "test-seed-conformance");
  try {
    for (const [id, dir] of [[idA, treeDir], [idB, treeDir], [idM, mutantDir]]) {
      const r = await call("index_repository", { repoId: id, repoPath: dir, mode: "full", docsMode: "on", wait: true });
      assert(r.body?.state === "ok", `${id} indexed full`, r.text.slice(0, 200));
    }

    // (a)
    const same = await compareIndexes({ dbPath, repoA: idA, repoB: idB, probes: PROBES, call });
    console.log(formatReport(same, idA, idB));
    assert(same.equal, "(a) full vs full of one tree: EQUAL");
    const tableNames = same.tables.map((t) => t.table);
    for (const t of ["symbols", "edges", "files"]) assert(tableNames.includes(t), `(a) table ${t} is compared`, tableNames.join(","));
    assert(same.tables.some((t) => /doc/i.test(t.table) && t.countA > 0), "(a) a docs table is compared and not empty", tableNames.join(","));
    assert(same.tables.find((t) => t.table === "symbols")?.countA > 0 && same.tables.find((t) => t.table === "edges")?.countA > 0, "(a) symbols and edges are not empty");
    assert(same.probes.every((p) => !p.empty), "(a) no probe answer is empty", same.probes.filter((p) => p.empty).map((p) => p.probe).join(","));

    // (b)
    const diff = await compareIndexes({ dbPath, repoA: idA, repoB: idM, probes: PROBES, call });
    console.log(formatReport(diff, idA, idM));
    assert(!diff.equal, "(b) a renamed function: DIFFERENT");
    assert(diff.tables.find((t) => t.table === "symbols")?.equal === false, "(b) ... in the symbols table");
    assert(diff.probes.find((p) => p.probe === "symbols:computeOrderTotal")?.equal === false, "(b) ... and in the probe that names it");
    assert(diff.probes.find((p) => p.probe === "symbols:Invoice")?.equal === true, "(b) ... and not in a probe it does not touch");
  } catch (error) {
    assert(false, "harness ran to the end", error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    await Promise.race([client.close().catch(() => {}), sleep(5000)]);
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

const argv = process.argv.slice(2);
let code;
try {
  code = argv.length ? await compareMode(parseArgs(argv)) : await selfTest();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  code = 2;
}
process.exit(code);
