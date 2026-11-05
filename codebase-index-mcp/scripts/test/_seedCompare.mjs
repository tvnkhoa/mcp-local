/**
 * IX-9 U4 — the seed-conformance comparator: are two repoIds in one index DB the same index?
 *
 * Used to accept a seeded worktree index against a full index of the same tree (IX-9). Two axes:
 *
 *   1. Rows. Every table of the DB with a `repo_id` column (discovered at run time, so a table the seed
 *      forgets to copy shows up without this file knowing it exists) is read for both repoIds. Each row is
 *      normalised — `repo_id`, rowid-like and clock columns dropped, a symbolId replaced by the symbol's
 *      key (file, kind, name, line), the repoId inside a string replaced by `<repo>` — and the two sides
 *      are compared as multisets: per-table counts plus up to `sample` rows only one side has.
 *   2. Answers. Each probe `{ tool, args }` is called once per repoId (args without repoId); both answers
 *      are normalised the same way (and volatile keys such as durationMs dropped) and deep-compared.
 *
 * Tables skipped by default: index_runs (a seed run and a full run differ by design) and the refactor_*
 * journals. Pass `skipTables` to change it.
 *
 * The DB is opened read-only; the caller owns the server that writes it.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export const DEFAULT_SKIP_TABLES = [/^index_runs$/, /^refactor_/, /^sqlite_/];
/** Columns that differ between two indexes of the same tree without the index being different. */
// repo_path: a seed is compared with a full index of another checkout of the same tree.
const VOLATILE_COLUMN = /^(id|rowid|.*_rowid|run_id|.*_run_id|.*_at|.*_ms|created|updated|indexed|timestamp|repo_path)$/i;
/**
 * A non-symbol id minted from the repoId (literal_id, …): 24 hex, like a symbolId, but with no key to map it to.
 * It is compared as `<derived-id>`; the row's other columns still carry what it names.
 */
const DERIVED_ID = /^[0-9a-f]{24}$/;
/** Keys dropped from tool answers before comparing: clocks, run ids, and freshness against each checkout's HEAD. */
export const DEFAULT_VOLATILE_KEYS = new Set([
  "durationMs", "elapsedMs", "tookMs", "queryMs", "generatedAt", "indexedAt", "lastIndexedAt", "startedAt",
  "finishedAt", "runId", "lastRunId", "requestId", "cacheHit", "staleWarning", "freshness", "staleness"
]);

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Tables with a repo_id column, with their column names. */
export function repoTables(db, skipTables = DEFAULT_SKIP_TABLES) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  const out = [];
  for (const name of names) {
    if (skipTables.some((re) => re.test(name))) continue;
    let cols;
    try { cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map((c) => c.name); }
    catch { continue; } // a virtual table whose module is not loaded here
    if (cols.includes("repo_id")) out.push({ name, cols });
  }
  return out;
}

/** symbolId → stable key for one repo. Shared ids (not namespaced) map to the same key on both sides anyway. */
function symbolKeys(db, repoId) {
  const map = new Map();
  let rows = [];
  try {
    rows = db.prepare("SELECT symbol_id, file_path, kind, name, line FROM symbols WHERE repo_id = ?").all(repoId);
  } catch { /* no symbols table: nothing to map */ }
  for (const r of rows) map.set(r.symbol_id, `sym:${r.file_path}|${r.kind}|${r.name}|${r.line}`);
  return map;
}

function makeNormaliser(repoId, keys, volatileKeys) {
  const repoRe = new RegExp(repoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const scalar = (v) => {
    if (typeof v !== "string") return v;
    if (keys.has(v)) return keys.get(v);
    return v.includes(repoId) ? v.replace(repoRe, "<repo>") : v;
  };
  const deep = (v) => {
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).sort()) if (!volatileKeys.has(k)) o[k] = deep(v[k]);
      return o;
    }
    return scalar(v);
  };
  return { scalar, deep };
}

function rowSignature(row, cols, scalar) {
  const parts = [];
  for (const c of cols) {
    if (c === "repo_id" || VOLATILE_COLUMN.test(c)) continue;
    let v = row[c];
    if (Buffer.isBuffer(v)) v = `blob:${createHash("sha1").update(v).digest("hex")}`;
    v = scalar(v);
    if (typeof v === "string" && c.endsWith("_id") && DERIVED_ID.test(v)) v = "<derived-id>";
    parts.push([c, v]);
  }
  return JSON.stringify(parts);
}

function multiset(rows, cols, scalar) {
  const m = new Map();
  for (const r of rows) {
    const s = rowSignature(r, cols, scalar);
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

function onlyIn(a, b, sample) {
  const out = [];
  for (const [sig, n] of a) {
    const extra = n - (b.get(sig) ?? 0);
    if (extra > 0) { out.push(extra > 1 ? `${sig} ×${extra}` : sig); if (out.length >= sample) break; }
  }
  return out;
}

/**
 * Compare the rows of two repoIds in one DB.
 * @returns {{ tables: Array<{table, countA, countB, onlyA: string[], onlyB: string[], equal: boolean}>, equal: boolean }}
 */
export function compareRows(dbPath, repoA, repoB, { sample = 5, skipTables = DEFAULT_SKIP_TABLES } = {}) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const keysA = symbolKeys(db, repoA);
    const keysB = symbolKeys(db, repoB);
    const nA = makeNormaliser(repoA, keysA, DEFAULT_VOLATILE_KEYS);
    const nB = makeNormaliser(repoB, keysB, DEFAULT_VOLATILE_KEYS);
    const tables = [];
    for (const { name, cols } of repoTables(db, skipTables)) {
      const stmt = db.prepare(`SELECT * FROM ${quoteIdent(name)} WHERE repo_id = ?`);
      const rowsA = stmt.all(repoA);
      const rowsB = stmt.all(repoB);
      const mA = multiset(rowsA, cols, nA.scalar);
      const mB = multiset(rowsB, cols, nB.scalar);
      const oA = onlyIn(mA, mB, sample);
      const oB = onlyIn(mB, mA, sample);
      tables.push({ table: name, countA: rowsA.length, countB: rowsB.length, onlyA: oA, onlyB: oB, equal: rowsA.length === rowsB.length && oA.length === 0 && oB.length === 0 });
    }
    return { tables, equal: tables.every((t) => t.equal), keysA, keysB };
  } finally {
    db.close();
  }
}

/** First difference between two normalised JSON values, as a path. */
function firstDiff(a, b, path = "$") {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return { path, a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, a: "array?", b: "array?" };
  const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`);
    if (d) return d;
  }
  return null;
}

const clip = (v) => { const s = JSON.stringify(v); return s && s.length > 160 ? `${s.slice(0, 160)}…` : s; };

/**
 * Compare tool answers per probe.
 * @param {(tool: string, args: object) => Promise<{ body: any, text: string, isError: boolean }>} call
 * @param {Array<{ tool: string, args?: object, name?: string }>} probes
 */
export async function compareProbes(call, repoA, repoB, probes, { keysA = new Map(), keysB = new Map(), volatileKeys = DEFAULT_VOLATILE_KEYS } = {}) {
  const nA = makeNormaliser(repoA, keysA, volatileKeys);
  const nB = makeNormaliser(repoB, keysB, volatileKeys);
  const results = [];
  for (const [i, p] of probes.entries()) {
    const label = p.name ?? `${p.tool}#${i}`;
    const ra = await call(p.tool, { ...(p.args ?? {}), repoId: repoA });
    const rb = await call(p.tool, { ...(p.args ?? {}), repoId: repoB });
    const a = { isError: ra.isError, answer: nA.deep(ra.body ?? ra.text) };
    const b = { isError: rb.isError, answer: nB.deep(rb.body ?? rb.text) };
    const diff = firstDiff(a, b);
    results.push({ probe: label, equal: !diff, empty: !ra.isError && isEmptyAnswer(ra.body), diff: diff ? `${diff.path}: A=${clip(diff.a)} B=${clip(diff.b)}` : null });
  }
  return { probes: results, equal: results.every((r) => r.equal) };
}

/** A probe whose answer is empty proves little; the caller is told so. */
function isEmptyAnswer(body) {
  if (!body || typeof body !== "object") return false;
  for (const k of ["results", "matches", "symbols", "files"]) if (Array.isArray(body[k])) return body[k].length === 0;
  if (typeof body.count === "number") return body.count === 0;
  return false;
}

/** The full comparison, printed as a readable diff. */
export async function compareIndexes({ dbPath, repoA, repoB, probes, call, sample = 5, skipTables }) {
  const rows = compareRows(dbPath, repoA, repoB, { sample, skipTables });
  const answers = await compareProbes(call, repoA, repoB, probes, { keysA: rows.keysA, keysB: rows.keysB });
  return { equal: rows.equal && answers.equal, tables: rows.tables, probes: answers.probes };
}

export function formatReport(result, repoA, repoB) {
  const lines = [`seed-conformance: A=${repoA} B=${repoB} → ${result.equal ? "EQUAL" : "DIFFERENT"}`];
  for (const t of result.tables) {
    lines.push(`  ${t.equal ? "=" : "≠"} table ${t.table}: ${t.countA} vs ${t.countB}`);
    for (const r of t.onlyA) lines.push(`      only A: ${r}`);
    for (const r of t.onlyB) lines.push(`      only B: ${r}`);
  }
  for (const p of result.probes) {
    lines.push(`  ${p.equal ? "=" : "≠"} probe ${p.probe}${p.empty ? " (empty answer on A — proves little)" : ""}${p.diff ? ` — ${p.diff}` : ""}`);
  }
  return lines.join("\n");
}
