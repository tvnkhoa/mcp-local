import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseShellSearch, suggestionFor } from "./grep-to-mcp.mjs";

/**
 * The grep→MCP hook: suggests only for search shapes one MCP call answers better, stays quiet
 * otherwise, and never blocks. Cases are real wec.aria grep shapes from the transcript miner.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "grep-to-mcp.mjs");
const s = (cmd) => suggestionFor(parseShellSearch(cmd), "wec.aria");

test("snake_case and camel/Pascal identifiers suggest search_symbols / search_regex", () => {
  assert.match(s('grep -rn "kb_version_ids" packages/'), /search_symbols\(repoId: "wec.aria", query: "kb_version_ids"/);
  assert.match(s("rg 'useScopeStore\\b' packages/portal"), /query: "useScopeStore"/);
  assert.match(s("grep -rn RetrievalHits packages"), /query: "RetrievalHits"/);
});

test("grep -l suggests files mode", () => {
  assert.match(s('grep -rl "tenant_profile" packages'), /outputMode: "files"/);
});

test("a heading, a table row or a sed -n range of a doc suggests query_docs", () => {
  assert.match(s('grep -n "^## 3.7" docs/10-canonical-model.md'), /mode: "section", filePath: "docs\/10-canonical-model.md"/);
  assert.match(s("grep -n '^| 737 ' docs/15-decision-log.md"), /query_docs/);
  assert.match(s("sed -n 120,180p docs/10-canonical-model.md"), /by heading, not by line range/);
});

test("quiet for prose, broad regexes, transcripts, logs and non-doc sed", () => {
  assert.equal(s('grep -rn "a stage threw" packages'), null);
  assert.equal(s('grep -rn "fetch|await|import" packages'), null);
  assert.equal(s('grep -c "tool_use" ~/.claude/projects/x/abc.jsonl'), null);
  assert.equal(s("sed -n 1,40p packages/core/turn/index.ts"), null);
  assert.equal(s("ls -la"), null);
});

test("the hook process never blocks: exit 0, JSON with additionalContext and no permission decision", () => {
  const event = { session_id: `t-${String(Date.now())}`, cwd: "D:/x/wec.aria", tool_name: "Grep", tool_input: { pattern: "kb_version_ids" } };
  const out = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(event), env: { ...process.env, GREP_TO_MCP_MAX: "5", TMP: os.tmpdir() } }).toString();
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /search_symbols/);
  assert.equal("permissionDecision" in parsed.hookSpecificOutput, false);

  const garbage = execFileSync(process.execPath, [HOOK], { input: "not json" }).toString();
  assert.equal(garbage, "", "malformed input: silent, still exit 0");
});
