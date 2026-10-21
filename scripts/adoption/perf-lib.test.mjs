import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advantage, filesOfGrep, firstHit, grepPlan, hasExtraContext, median, percentile, recallOf, renderLaneTable,
  renderWins, summarize, toPcre, tokensOf, topWins
} from './perf-lib.mjs';

test('percentile interpolates linearly (type 7) and median is p50', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 90), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
  assert.equal(percentile([10, null, 20, NaN], 50), 15, 'non-numbers are ignored');
});

test('token estimate is ceil(bytes / 4)', () => {
  assert.equal(tokensOf(0), 0);
  assert.equal(tokensOf(1), 1);
  assert.equal(tokensOf(8), 2);
  assert.equal(tokensOf(9), 3);
});

test('grep plan: doc ranks always -n + region read; other ranks follow the frozen shape', () => {
  assert.deepEqual(grepPlan({ docs: true }, 'files'), { listFlag: '-n', followUp: 'region' });
  assert.deepEqual(grepPlan({ docs: false }, 'files'), { listFlag: '-l', followUp: null });
  assert.deepEqual(grepPlan({ docs: false }, 'lines'), { listFlag: '-n', followUp: null });
  assert.equal(toPcre('a\\|b\\|c'), 'a|b|c');
});

test('git grep stdout parsing', () => {
  const out = 'docs/a.md:12:| 72 | x\ndocs/b.md:3:y\n';
  assert.deepEqual(firstHit(out), { file: 'docs/a.md', line: 12 });
  assert.equal(firstHit(''), null);
  assert.deepEqual([...filesOfGrep(out, '-n')], ['docs/a.md', 'docs/b.md']);
  assert.deepEqual([...filesOfGrep('x/y.ts\nz.ts\n', '-l')], ['x/y.ts', 'z.ts']);
  assert.equal(recallOf(new Set(['a', 'b']), new Set(['a'])), 0.5);
  assert.equal(recallOf(new Set(), new Set()), 1);
});

test('extra-context flag is mechanical: a CONTEXT_FIELDS field with a value on any row', () => {
  assert.equal(hasExtraContext({ files: [{ filePath: 'a', matchCount: 2, firstLine: 1 }] }), false);
  assert.equal(hasExtraContext({ matches: [{ filePath: 'a', enclosingSymbol: null }] }), false);
  assert.equal(hasExtraContext({ matches: [{ filePath: 'a', enclosingSymbol: { name: 'f' } }] }), true);
  assert.equal(hasExtraContext({ results: [{ filePath: 'a', heading: 'Status' }] }), true);
  assert.equal(hasExtraContext(null), false);
});

test('advantage: sign, components and reason', () => {
  const m = advantage({ grepMs: 80, mcpMs: 10, grepTokens: 4000, mcpTokens: 249, mcpHit: true, extraContext: false });
  assert.equal(m.parts.time, 3);
  assert.equal(m.parts.tokens, 4);
  assert.ok(m.score > 0);
  assert.match(m.reason, /^MCP 16x fewer tokens; MCP 8\.0x faster$/);
  const g = advantage({ grepMs: 20, mcpMs: 40, grepTokens: 10, mcpTokens: 10, mcpHit: false, extraContext: false });
  assert.ok(g.score < 0);
  assert.match(g.reason, /MCP misses files grep finds/);
  assert.match(g.reason, /grep 2\.0x faster/);
});

const row = (id, rank, grepMs, warmMs, coldMs, grepTokens, tokens, hit) => ({
  id, rank, pattern: `p${id}|x`, grep: { ms: grepMs, tokens: grepTokens, calls: rank === 2 ? 2 : 1 },
  mcp: { stdio: { warmMs, coldMs, tokens, hit, extraContext: false } }
});

test('summary, table and wins render from per-pattern rows', () => {
  const rows = [row(1, 1, 50, 10, 300, 100, 20, true), row(2, 1, 30, 20, 400, 50, 60, true), row(3, 2, 40, 5, 200, 900, 30, false)];
  const s = summarize(rows, 'stdio');
  assert.equal(s.n, 3);
  assert.equal(s.grepMs.median, 40);
  assert.equal(s.warmMs.median, 10);
  assert.equal(s.coldMs.p90, 380);
  assert.equal(s.grepTokens.total, 1050);
  assert.equal(s.grepCalls, 4);
  assert.equal(s.mcpHits, 2);
  const md = renderLaneTable(rows, [{ rank: 1, name: 'snake' }, { rank: 2, name: 'md' }], 'stdio', 'stdio lane');
  assert.match(md, /\| r1 snake \| 2 \| 40\.0 \/ 48\.0 \|/);
  assert.match(md, /\| \*\*total\*\* \| 3 \|/);
  const w = topWins(rows, 'stdio', 1);
  assert.equal(w.grep[0].id, 2);
  assert.equal(w.mcp[0].id, 3, "a miss costs 2, but 8x time and 29x tokens outweigh it");
  assert.match(renderWins(w), /p2\\\|x/, 'pipes in patterns are escaped for markdown');
});
