// Pure parts of `replay.mjs perf` — no I/O, no clock. The methodology they implement is frozen in
// replay.mjs's header; scripts/adoption/perf-lib.test.mjs pins them.

/** Linear-interpolation percentile (type 7, the numpy/Excel default) of a numeric list; null when empty. */
export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const h = (xs.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return xs[lo] + (xs[hi] - xs[lo]) * (h - lo);
}

export const median = (values) => percentile(values, 50);

export const sum = (values) => values.reduce((a, v) => a + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);

/** Token estimate, frozen: ceil(UTF-8 bytes / 4). Not a tokenizer — a stable proxy for both sides. */
export const tokensOf = (bytes) => Math.ceil(bytes / 4);

/** Lines of the hit region a follow-up read shows: the hit line and the next 29. */
export const FOLLOW_UP_LINES = 30;

/**
 * Shape of the grep run for one pattern, frozen:
 *  - doc-shaped ranks (`docs: true`, r2 + r4): `git grep -n`, then ONE region read of the first hit
 *    (`sed -n 'L,L+29p' <file>`) — a doc grep is followed by reading the section. Always -n, because
 *    the read needs a line number.
 *  - every other rank: the shape the pattern was originally asked with (replay-perf-shapes.json):
 *    "files" → `git grep -l`, "lines" → `git grep -n`. No follow-up.
 */
export function grepPlan(rankDef, shape) {
  if (rankDef?.docs) return { listFlag: '-n', followUp: 'region' };
  return { listFlag: shape === 'files' ? '-l' : '-n', followUp: null };
}

/** The pattern as git grep -P reads it: grep's BRE alternation `\|` becomes `|`, as the replay's toJsRegex does. */
export const toPcre = (pattern) => pattern.replace(/\\\|/g, '|');

/** First `path:line:` hit in `git grep -n` stdout, or null. Paths may contain ':' on no platform we index, so split on the first two. */
export function firstHit(stdout) {
  for (const line of String(stdout).split('\n')) {
    const m = /^(.+?):(\d+):/.exec(line);
    if (m) return { file: m[1], line: Number(m[2]) };
  }
  return null;
}

/** `git grep -n` / `-l` stdout → the set of repo-relative files it names. */
export function filesOfGrep(stdout, listFlag) {
  const out = new Set();
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    if (listFlag === '-l') out.add(line.replace(/\\/g, '/'));
    else {
      const m = /^(.+?):\d+:/.exec(line);
      if (m) out.add(m[1].replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * Fields a grep sequence cannot produce. The "more context" flag is set when ANY row of the MCP
 * response carries one of these with a non-null value: the enclosing symbol of a hit, the doc
 * section/heading a hit sits in, or a resolved citation/link target.
 */
export const CONTEXT_FIELDS = ['enclosingSymbol', 'section', 'sectionTitle', 'heading', 'headingPath', 'breadcrumb', 'target', 'resolvedTarget', 'resolvedPath'];

export function rowsOf(payload) {
  if (!payload || typeof payload !== 'object') return [];
  for (const k of ['files', 'matches', 'results']) if (Array.isArray(payload[k])) return payload[k];
  return [];
}

export function hasExtraContext(payload) {
  return rowsOf(payload).some((r) => r && typeof r === 'object' && CONTEXT_FIELDS.some((f) => r[f] !== undefined && r[f] !== null && r[f] !== ''));
}

/** Recall of `got` against the grep-equivalent baseline set (1 when the baseline is empty). */
export function recallOf(baseline, got) {
  if (baseline.size === 0) return 1;
  let n = 0;
  for (const f of baseline) if (got.has(f)) n++;
  return n / baseline.size;
}

/**
 * Who wins a pattern, frozen. score > 0 favours MCP, < 0 favours grep:
 *   time    = log2(grep ms / MCP warm ms)
 *   tokens  = log2((grep tokens + 1) / (MCP tokens + 1))
 *   recall  = -2 when the MCP call misses (recall < 0.9 and no docs hit), else 0
 *   context = +1 when the MCP response carries a CONTEXT_FIELDS field, else 0
 * The reason names every component with |value| >= 1, largest first.
 */
export function advantage({ grepMs, mcpMs, grepTokens, mcpTokens, mcpHit, extraContext }) {
  const parts = {
    time: grepMs > 0 && mcpMs > 0 ? Math.log2(grepMs / mcpMs) : 0,
    tokens: Math.log2((grepTokens + 1) / (mcpTokens + 1)),
    recall: mcpHit ? 0 : -2,
    context: extraContext ? 1 : 0
  };
  const score = parts.time + parts.tokens + parts.recall + parts.context;
  const words = {
    time: (v) => (v > 0 ? `MCP ${fmtX(2 ** v)} faster` : `grep ${fmtX(2 ** -v)} faster`),
    tokens: (v) => (v > 0 ? `MCP ${fmtX(2 ** v)} fewer tokens` : `grep ${fmtX(2 ** -v)} fewer tokens`),
    recall: () => 'MCP misses files grep finds',
    context: () => 'MCP adds context grep cannot (enclosing symbol / section / target)'
  };
  const reason = Object.entries(parts)
    .filter(([, v]) => Math.abs(v) >= 1)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => words[k](v))
    .join('; ');
  return { score: round(score, 2), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 2)])), reason: reason || 'close on every axis' };
}

const fmtX = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}x`;
export const round = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Summary of a set of per-pattern rows for one MCP lane; `lane` picks the MCP measurement. */
export function summarize(rows, lane) {
  const m = (r) => r.mcp?.[lane];
  const ok = rows.filter((r) => m(r) && !m(r).error);
  return {
    n: rows.length,
    grepMs: { median: median(rows.map((r) => r.grep.ms)), p90: percentile(rows.map((r) => r.grep.ms), 90) },
    warmMs: { median: median(ok.map((r) => m(r).warmMs)), p90: percentile(ok.map((r) => m(r).warmMs), 90) },
    coldMs: { median: median(ok.map((r) => m(r).coldMs)), p90: percentile(ok.map((r) => m(r).coldMs), 90) },
    grepTokens: { median: median(rows.map((r) => r.grep.tokens)), total: sum(rows.map((r) => r.grep.tokens)) },
    mcpTokens: { median: median(ok.map((r) => m(r).tokens)), total: sum(ok.map((r) => m(r).tokens)) },
    grepCalls: sum(rows.map((r) => r.grep.calls)),
    mcpCalls: ok.length,
    mcpHits: ok.filter((r) => m(r).hit).length,
    extraContext: ok.filter((r) => m(r).extraContext).length,
    docsExtraContext: ok.filter((r) => m(r).docs?.extraContext).length,
    docsCalls: ok.filter((r) => m(r).docs).length,
    errors: rows.length - ok.length
  };
}

const ms = (v) => (v === null ? '–' : v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const tok = (v) => (v === null ? '–' : String(Math.round(v)));

/** One markdown table: a row per rank plus a totals row, for one MCP lane. */
export function renderLaneTable(rows, ranks, lane, laneLabel) {
  const head = [
    `**${laneLabel}**`,
    '',
    '| rank | n | grep ms med / p90 | MCP warm ms med / p90 | MCP cold ms med / p90 | grep tok med / total | MCP tok med / total | calls grep / MCP | MCP hits | +context |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  const line = (label, s) =>
    `| ${label} | ${s.n} | ${ms(s.grepMs.median)} / ${ms(s.grepMs.p90)} | ${ms(s.warmMs.median)} / ${ms(s.warmMs.p90)} | ${ms(s.coldMs.median)} / ${ms(s.coldMs.p90)} | ` +
    `${tok(s.grepTokens.median)} / ${tok(s.grepTokens.total)} | ${tok(s.mcpTokens.median)} / ${tok(s.mcpTokens.total)} | ${s.grepCalls} / ${s.mcpCalls} | ${s.mcpHits}/${s.n - s.errors}${s.errors ? ` (${s.errors} err)` : ''} | ${s.extraContext}${s.docsCalls ? ` (query_docs ${s.docsExtraContext}/${s.docsCalls})` : ''} |`;
  const body = [];
  for (const r of ranks) {
    const rs = rows.filter((x) => x.rank === r.rank);
    if (rs.length) body.push(line(`r${r.rank} ${r.name}`, summarize(rs, lane)));
  }
  body.push(line('**total**', summarize(rows, lane)));
  return [...head, ...body].join('\n');
}

/** The k patterns each side wins most clearly, by `advantage` against `lane`'s warm time. */
export function topWins(rows, lane, k = 5) {
  const scored = rows
    .filter((r) => r.mcp?.[lane] && !r.mcp[lane].error)
    .map((r) => ({ id: r.id, rank: r.rank, pattern: r.pattern, ...advantage({ grepMs: r.grep.ms, mcpMs: r.mcp[lane].warmMs, grepTokens: r.grep.tokens, mcpTokens: r.mcp[lane].tokens, mcpHit: r.mcp[lane].hit, extraContext: r.mcp[lane].extraContext }) }));
  const byScore = [...scored].sort((a, b) => a.score - b.score || a.id - b.id);
  return { grep: byScore.slice(0, k), mcp: byScore.slice(-k).reverse() };
}

export function renderWins(wins) {
  const fmt = (w) => `| #${w.id} r${w.rank} | \`${String(w.pattern).replace(/\|/g, '\\|').slice(0, 60)}\` | ${w.score} | ${w.reason} |`;
  return [
    '| grep wins | pattern | score | reason |', '|---|---|---:|---|', ...wins.grep.map(fmt), '',
    '| MCP wins | pattern | score | reason |', '|---|---|---:|---|', ...wins.mcp.map(fmt)
  ].join('\n');
}
