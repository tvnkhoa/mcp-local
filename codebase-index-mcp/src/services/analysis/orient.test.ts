import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent, normalizeIntent } from "./orient.js";

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

/**
 * Release I2 (MCP-ISSUE-083): the wec.aria reviewer's phrasings, verbatim. The named tool must be FIRST
 * in what the handler returns — the handler keeps the first rule's tools first — with its key argument.
 */
function firstTool(intent: string): { ruleId: string; tool: string; args: Record<string, unknown> } {
  const { matches } = classifyIntent(intent);
  const rule = matches[0]!;
  const first = rule.recommendedTools[0]!;
  return { ruleId: rule.id, tool: first.tool, args: first.args ?? {} };
}

const R9: [string, Record<string, string>][] = [
  ["what breaks in Aria if VehicleController.GetListOwnedVehicle changes", { name: "GetListOwnedVehicle" }],
  ["who calls the wec.be endpoint /customers/global-search", { name: "<the action serving /customers/global-search>" }],
  ["đổi endpoint GetHistory ở wec.be thì Aria hỏng gì", { name: "GetHistory" }],
  ["impact of changing a wec.be controller action on other repos", {}]
];

const R11 = [
  "which tests should I run for my uncommitted change",
  "tests for my diff",
  "chạy test nào cho thay đổi hiện tại",
  "what tests cover the files I just edited"
];

const R4: [string, string][] = [
  ["where is kb_version_ids defined in docs/10", "kb_version_ids"],
  ["canonical name for proposed_tag_change", "proposed_tag_change"],
  ["tên này có trong docs/10 không: claim_kind", "claim_kind"],
  ["which docs/10 section defines tenant_id", "tenant_id"]
];

const R5: [string, Record<string, string>][] = [
  ["who cites decision #737", { target: "decision #737" }],
  ["what references adr/0021", { target: "adr/0021" }],
  ["ai trích dẫn docs/15 #116", { target: "docs/15 #116" }],
  ["what does CLAUDE.md cite", { filePath: "CLAUDE.md" }]
];

test("R9 phrasings route to get_cross_repo_impact(direction:'inbound') first, with the seed", () => {
  for (const [intent, seed] of R9) {
    const got = firstTool(intent);
    assert.equal(got.ruleId, "endpoint-consumers", intent);
    assert.equal(got.tool, "get_cross_repo_impact", intent);
    assert.equal(got.args.direction, "inbound", intent);
    for (const [k, v] of Object.entries(seed)) assert.equal(got.args[k], v, `${intent}: ${k}`);
  }
  const caveats = classifyIntent(R9[0]![0]).matches[0]!.caveats.join(" ");
  assert.match(caveats, /ambiguous/);
  assert.match(caveats, /endpoint contract/);
});

test("R11 phrasings route to link_tests_to_source(forWorkingTreeDiff:true) first", () => {
  for (const intent of R11) {
    const got = firstTool(intent);
    assert.equal(got.ruleId, "tests-for-diff", intent);
    assert.equal(got.tool, "link_tests_to_source", intent);
    assert.equal(got.args.forWorkingTreeDiff, true, intent);
  }
  assert.match(classifyIntent(R11[0]!).matches[0]!.recommendedTools[0]!.why, /nothing is executed/);
});

test("R4 phrasings route to query_docs(mode:'term') first, with the name as query", () => {
  for (const [intent, query] of R4) {
    const got = firstTool(intent);
    assert.equal(got.ruleId, "doc-term", intent);
    assert.equal(got.tool, "query_docs", intent);
    assert.equal(got.args.mode, "term", intent);
    assert.equal(got.args.query, query, intent);
  }
});

test("R5 phrasings route to query_docs(mode:'cites') first, with target or filePath", () => {
  for (const [intent, seed] of R5) {
    const got = firstTool(intent);
    assert.equal(got.ruleId, "doc-citations", intent);
    assert.equal(got.tool, "query_docs", intent);
    assert.equal(got.args.mode, "cites", intent);
    for (const [k, v] of Object.entries(seed)) assert.equal(got.args[k], v, `${intent}: ${k}`);
  }
});

test("Vietnamese matches with or without diacritics", () => {
  assert.equal(firstTool("ai trich dan docs/15 #116").args.mode, "cites");
  assert.equal(firstTool("doi endpoint GetHistory o wec.be thi Aria hong gi").tool, "get_cross_repo_impact");
  assert.equal(firstTool("chay test nao cho thay doi hien tai").args.forWorkingTreeDiff, true);
  assert.equal(firstTool("TÊN NÀY có trong docs/10 không: claim_kind").args.mode, "term");
  assert.equal(normalizeIntent("Trích Dẫn đổi"), "trich dan doi");
});

test("the existing rules still win their own phrasings", () => {
  const cases: [string, string, string][] = [
    ["rename symbol fooBar", "rename", "rename_assist"],
    ["rename VehicleController.GetListOwnedVehicle", "rename", "rename_assist"],
    ["blast radius of changing file src/foo.ts", "blast-radius", "find_impact_files"],
    ["what breaks if I change parseConfig", "blast-radius", "find_impact_files"],
    ["which tests cover src/foo.ts", "tests", "link_tests_to_source"],
    ["which tests", "tests", "link_tests_to_source"],
    ["list endpoints", "endpoint-inventory", "route_map"],
    ["where is the definition of fooBar", "find-symbol", "search_symbols"],
    ["which doc describes the decision record", "docs-search", "query_docs"],
    ["find references to fooBar", "find-symbol", "search_symbols"],
    ["detect circular dependency cycle", "circular-deps", "detect_circular_dependencies"]
  ];
  for (const [intent, ruleId, tool] of cases) {
    const got = firstTool(intent);
    assert.equal(got.ruleId, ruleId, intent);
    assert.equal(got.tool, tool, intent);
  }
  // "who calls X" without an endpoint signal matches no rule — unchanged (generic discovery).
  assert.equal(classifyIntent("who calls fooBar").fallback, true);
  // The plain tests rule is unchanged; its first entry was already the working-tree mode.
  assert.equal(firstTool("which tests").args.forWorkingTreeDiff, true);
  assert.equal(firstTool("which doc describes the decision record").args.mode, "search");
});
