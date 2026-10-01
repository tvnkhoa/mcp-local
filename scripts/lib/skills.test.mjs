/**
 * The rendered operational skills must not cite a tool, or a parameter of one, that does not exist.
 *
 * This is the failure mode the skills have actually had: `find_impact_files(changedFiles:)` (a
 * parameter the `.strict()` schema rejects), `create_pull_request(source, destination)` (the real
 * names are `sourceBranch` / `destinationBranch`), `list_repositories(workspace?)` (no such
 * argument). Each one reads plausibly and is only caught when a model follows the skill and the
 * server refuses the call. The authority is the committed contract snapshot in `contracts/`, which
 * `contracts:check` already holds to what the live server advertises.
 *
 * What is checked is every `tool_name(arg, arg: value, arg?)` call shape inside a code span or a
 * fenced block. Prose mentions of a tool name are not parsed — they are not instructions to call it
 * with particular arguments.
 *
 * Plus the renderer's own contract: no placeholder survives, the frontmatter `name` is the server
 * key (the skill directory name), and the description fits the 1024-character limit skills have.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SERVERS } from "./manifest.mjs";
import { renderSkillContent, skillStatus } from "./skills.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** tool name -> { server, params:Set } for every server, own server first when names collide. */
function loadContracts() {
  const byServer = new Map();
  for (const s of SERVERS) {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", `${s.key}.json`), "utf8"));
    const tools = new Map();
    for (const t of c.tools) tools.set(t.name, new Set(Object.keys(t.inputSchema?.properties ?? {})));
    byServer.set(s.key, tools);
  }
  return byServer;
}

/** The text of every fenced block and inline code span. */
function codeText(md) {
  const parts = [];
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of md.matchAll(fence)) parts.push(m[1]);
  const prose = md.replace(fence, "");
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) parts.push(m[1]);
  return parts.join("\n");
}

/**
 * Top-level argument list of the call whose `(` is at `open`, or null when it does not close soon.
 * A call wrapped across lines in a fenced block is still checked; `//` comments are skipped.
 */
function argsAt(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < Math.min(text.length, open + 600); i += 1) {
    const c = text[i];
    if (quote) { if (c === quote || c === "\n") quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function splitTopLevel(args) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const c of args) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth += 1;
    if (")]}".includes(c)) depth -= 1;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** [{ tool, params[] }] for every snake_case call shape in the skill's code. */
function callShapes(md) {
  const code = codeText(md);
  const calls = [];
  for (const m of code.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)) {
    const args = argsAt(code, m.index + m[1].length);
    const params = [];
    for (const piece of args === null ? [] : splitTopLevel(args)) {
      const p = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*(?::|$)/.exec(piece);
      if (p) params.push(p[1]);
    }
    calls.push({ tool: m[1], params });
  }
  return calls;
}

const contracts = loadContracts();

for (const server of SERVERS) {
  test(`${server.key}: every tool call shape in the skill matches the contract`, () => {
    const md = renderSkillContent(server);
    const problems = [];
    for (const { tool, params } of callShapes(md)) {
      const own = contracts.get(server.key).get(tool);
      const schema = own ?? [...contracts.values()].map((t) => t.get(tool)).find(Boolean);
      if (!schema) { problems.push(`unknown tool ${tool}()`); continue; }
      for (const p of params) {
        if (!schema.has(p)) problems.push(`${tool}(${p}) — not a parameter of ${tool}`);
      }
    }
    assert.deepEqual([...new Set(problems)], [], `stale tool references in ${server.skillSource}/SKILL.md`);
  });

  test(`${server.key}: the rendered skill is complete and well-formed`, () => {
    const md = renderSkillContent(server);
    assert.doesNotMatch(md, /\{\{[A-Z_]+\}\}/, "an unsubstituted placeholder survived rendering");
    assert.match(md, new RegExp(`^---\\nname: ${server.key}\\n`), "frontmatter name must be the server key");
    const description = /^description:\s*"([^\n]*)"\s*$/m.exec(md)?.[1] ?? "";
    assert.ok(description.length > 0, "frontmatter needs a double-quoted description");
    assert.ok(!description.includes('"'), "a description with an inner double quote breaks the VS Code prompt export");
    assert.ok(description.length <= 1024, `description is ${String(description.length)} chars; skills allow 1024`);
  });
}

test("renderSkillContent refuses a server with no generated tool list", () => {
  // `toolsFor` returns [] for a server registered before its contract was snapshotted, instead of
  // throwing at import. The renderer is what stops that reaching an installed skill: a SKILL.md
  // naming no tools would load cleanly and mislead every agent that read it.
  const fake = { ...SERVERS[0], key: "probe-mcp", tools: [] };
  assert.throws(
    () => renderSkillContent(fake),
    (e) =>
      /"probe-mcp" has no generated tool list/.test(e.message) &&
      e.message.includes("npm run contracts:update -- --server probe-mcp")
  );
});

test("renderSkillContent refuses a placeholder the renderer does not know", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "scripts", ".skill-test-"));
  try {
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: {{KEY}}\n---\n{{TOOL_LSIT}}\n", "utf8");
    const fake = { ...SERVERS[0], skillSource: path.relative(ROOT, dir).replaceAll("\\", "/") };
    assert.throws(() => renderSkillContent(fake), /TOOL_LSIT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skillStatus distinguishes missing, current and stale copies", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "scripts", ".skill-test-"));
  try {
    const server = SERVERS[0];
    const file = path.join(dir, "SKILL.md");
    assert.equal(skillStatus(server, file), "missing");
    fs.writeFileSync(file, renderSkillContent(server), "utf8");
    assert.equal(skillStatus(server, file), "current");
    fs.writeFileSync(file, renderSkillContent(server).replace(/\n/g, "\r\n"), "utf8");
    assert.equal(skillStatus(server, file), "current", "a CRLF checkout is not a stale skill");
    fs.writeFileSync(file, "---\nname: old\n---\n", "utf8");
    assert.equal(skillStatus(server, file), "stale");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
