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

test("repoId comes from the project root, not a subfolder cwd (wec.aria's R12 install)", () => {
  const run = (cwd, projectDir) => {
    const env = { ...process.env, GREP_TO_MCP_MAX: "5", TMP: os.tmpdir() };
    delete env.GREP_TO_MCP_REPO_ID;
    delete env.CLAUDE_PROJECT_DIR;
    if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
    const event = { session_id: `r-${String(Date.now())}-${String(Math.random())}`, cwd, tool_name: "Grep", tool_input: { pattern: "kb_version_ids" } };
    return JSON.parse(execFileSync(process.execPath, [HOOK], { input: JSON.stringify(event), env }).toString()).hookSpecificOutput.additionalContext;
  };
  assert.match(run("D:/x/wec.aria/packages/core", "D:/x/wec.aria"), /repoId: "wec\.aria"/);
  assert.match(run("D:/x/wec.aria", undefined), /repoId: "wec\.aria"/, "no CLAUDE_PROJECT_DIR: the event cwd");
});

/**
 * Outside the project the repoId names an index that does not hold the files. Seen live: from
 * `cd ~/.claude/skills && grep … *\/SKILL.md` and from a `grep -n` on
 * ~/.claude/skills/postgres-mcp/SKILL.md, the hook suggested query_docs with filePath "*\/SKILL.md".
 */
const WHERE = { projectDir: "D:/x/wec.aria", cwd: "D:/x/wec.aria", env: { HOME: "C:/Users/me" } };
const w = (cmd, where = WHERE) => suggestionFor(parseShellSearch(cmd), "wec.aria", where);

test("quiet when the command cd's outside the project, the target resolves outside it, or the path is a glob", () => {
  // The two live cases.
  assert.equal(w('cd ~/.claude/skills && grep -n "^## Setup" */SKILL.md'), null, "cd outside + glob");
  assert.equal(w('grep -n "^## Setup" ~/.claude/skills/postgres-mcp/SKILL.md'), null, "target under the home dir");
  // One condition at a time.
  assert.equal(w("cd ~/.claude/skills && grep -rn kb_version_ids ."), null, "cd outside, no glob");
  assert.equal(w("cd ../other-repo && grep -rn kb_version_ids src"), null, "relative cd that leaves the project");
  assert.equal(w("cd $SOMEWHERE && grep -rn kb_version_ids src"), null, "cd to a target that cannot be resolved");
  assert.equal(w('grep -n "^## 3.7" D:/x/other/docs/10-canonical-model.md'), null, "absolute path in another repo");
  assert.equal(w("grep -rn kb_version_ids ../other-repo/src"), null, "relative path that climbs out");
  assert.equal(w('grep -n "^## 3.7" docs/*.md'), null, "* glob inside the project");
  assert.equal(w('grep -n "^## 3.7" docs/1?-canonical-model.md'), null, "? glob");
  assert.equal(w('grep -n "^## 3.7" docs/[01]0-canonical-model.md'), null, "[ glob");
  assert.equal(w('grep -n "^## 3.7" docs/{a,b}.md'), null, "{ glob");
  assert.equal(
    suggestionFor({ tool: "Grep", pattern: "^## 3.7", paths: ["**/*.md"], filesOnly: false }, "wec.aria", WHERE),
    null,
    "Grep tool glob"
  );
});

test("control: inside the project it still suggests, however the path is spelled", () => {
  assert.match(w('grep -n "^## 3.7" docs/10-canonical-model.md'), /mode: "section", filePath: "docs\/10-canonical-model.md"/);
  assert.match(w("cd packages/core && grep -rn kb_version_ids ."), /query: "kb_version_ids"/, "cd that stays inside");
  assert.match(w('grep -n "^## 3.7" d:\\x\\wec.aria\\docs\\10-canonical-model.md'), /query_docs/, "backslashes, other drive case");
  assert.match(w("grep -rn kb_version_ids /d/x/wec.aria/packages"), /search_symbols/, "Git Bash drive path");
  assert.match(w("grep -rn kb_version_ids .", { ...WHERE, cwd: "D:/x/wec.aria/packages/core" }), /search_symbols/, "relative to a subfolder cwd");
});

test("the hook process stays quiet outside CLAUDE_PROJECT_DIR, and falls back to the event cwd without it", () => {
  const run = (event, projectDir) => {
    const env = { ...process.env, GREP_TO_MCP_MAX: "5", TMP: os.tmpdir() };
    delete env.GREP_TO_MCP_REPO_ID;
    delete env.CLAUDE_PROJECT_DIR;
    if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
    const e = { session_id: `o-${String(Date.now())}-${String(Math.random())}`, tool_name: "Bash", ...event };
    return execFileSync(process.execPath, [HOOK], { input: JSON.stringify(e), env }).toString();
  };
  const skills = path.join(os.homedir(), ".claude", "skills").replace(/\\/g, "/");
  const target = `${skills}/postgres-mcp/SKILL.md`;
  assert.equal(run({ cwd: "D:/x/wec.aria", tool_input: { command: `grep -n "^## Setup" ${target}` } }, "D:/x/wec.aria"), "");
  assert.equal(
    run({ cwd: "D:/x/wec.aria", tool_input: { command: 'cd ~/.claude/skills && grep -rn kb_version_ids .' } }, undefined),
    "",
    "no CLAUDE_PROJECT_DIR: the event cwd is the project"
  );
  const inside = run({ cwd: "D:/x/wec.aria", tool_input: { command: 'grep -n "^## 3.7" docs/10-canonical-model.md' } }, "D:/x/wec.aria");
  assert.match(JSON.parse(inside).hookSpecificOutput.additionalContext, /query_docs/);
});

test("quiet for a grep that filters a pipe (no path after a `|`), including inside $( … )", () => {
  // wec.aria's live case: the hook suggested query_docs on its own test-run filter.
  assert.equal(w('node --test x.mjs 2>&1 | grep -E "^# (tests|pass|fail)"'), null);
  assert.equal(w("git log --oneline | grep kb_version_ids"), null);
  assert.equal(w('n=$(git status --porcelain | grep -c "^ M")'), null);
  assert.equal(w("cat docs/10-canonical-model.md | rg kb_version_ids"), null);
  // Controls: a grep that names its files still searches the repo, before or after a pipe or ||.
  assert.match(w("grep -n kb_version_ids packages/core/audit/index.ts"), /search_symbols/);
  assert.match(w("git status | head -1; grep -rn kb_version_ids packages"), /search_symbols/);
  assert.match(w("false || grep -rn kb_version_ids packages"), /search_symbols/, "|| is an OR, not a pipe");
  assert.match(w("echo x | grep -rn kb_version_ids packages"), /search_symbols/, "a piped grep WITH a path still reads files");
});
