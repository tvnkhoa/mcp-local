import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent } from "./orient.js";

/**
 * `orient` is a static routing table, so its advice goes stale silently when a tool is fixed.
 * These pin the two rules that did: the rename route (MCP-ISSUE-060, fixed 2026-09-17 — the
 * rename_assist preview is repo-wide now) and the docs-search caveat (MCP-ISSUE-061 Stage 4 —
 * prose sections are indexed now).
 */

test("rename routes to rename_assist(emitPreview:true) and no longer warns against it", () => {
  const { matches, fallback } = classifyIntent("rename symbol fooBar");
  assert.equal(fallback, false);
  const rule = matches[0];
  assert.equal(rule.id, "rename");
  assert.equal(rule.recommendedTools[0].tool, "rename_assist");
  assert.deepEqual(rule.recommendedTools[0].args, { emitPreview: true });
  const text = JSON.stringify(rule);
  assert.doesNotMatch(text, /do NOT use rename_assist/i);
  assert.doesNotMatch(text, /MCP-ISSUE-060, open/);
});

test("docs-search no longer claims prose is unindexed", () => {
  const { matches } = classifyIntent("which doc describes the decision record");
  const rule = matches.find((m) => m.id === "docs-search");
  assert.ok(rule, "docs-search rule should match");
  assert.equal(rule.recommendedTools[0].tool, "query_docs");
  assert.doesNotMatch(rule.caveats.join(" "), /no indexer writes 'prose'/);
});
