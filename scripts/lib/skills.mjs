// Render a server's operational SKILL.md from its hand-authored template + the
// manifest, then install it into both the global and project skill directories.
//
// Template placeholders (filled from the manifest):
//   {{KEY}}             server key (e.g. postgres-mcp)
//   {{DISPLAY_NAME}}    human name
//   {{TAGLINE}}         one-line summary
//   {{ENTRY_PATH}}      absolute path to dist/index.js (forward slashes)
//   {{TOOL_NAMESPACE}}  mcp__<key>__*
//   {{TOOL_LIST}}       bullet list of tool names
//   {{ENV_TABLE}}       markdown table of env vars (name / required / secret / notes)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT, serverEntryPath } from "./manifest.mjs";
import { toConfigPath } from "./jsonc.mjs";
import { ok, warn, info } from "./log.mjs";

function envTable(server) {
  const esc = (s) => String(s).replaceAll("|", "\\|");
  const rows = server.env.map((e) => {
    const req = e.required ? "yes" : e.group ? "one-of" : "no";
    const kind = e.secret ? "secret" : "";
    const note = e.note || (e.default !== undefined ? `default: \`${e.default || "(empty)"}\`` : "");
    return `| \`${e.name}\` | ${req} | ${kind} | ${esc(note)} |`;
  });
  return [
    "| Env var | Required | Kind | Notes |",
    "|---------|----------|------|-------|",
    ...rows,
  ].join("\n");
}

function toolList(server) {
  return server.tools.map((t) => `- \`mcp__${server.key}__${t}\``).join("\n");
}

export function renderSkillContent(server) {
  const src = path.join(WORKSPACE_ROOT, ...server.skillSource.split("/"), "SKILL.md");
  if (!fs.existsSync(src)) {
    throw new Error(`Skill template not found: ${src}`);
  }
  const template = fs.readFileSync(src, "utf-8");
  const entry = toConfigPath(serverEntryPath(server));
  return template
    .replaceAll("{{KEY}}", server.key)
    .replaceAll("{{DISPLAY_NAME}}", server.displayName)
    .replaceAll("{{TAGLINE}}", server.tagline)
    .replaceAll("{{ENTRY_PATH}}", entry)
    .replaceAll("{{TOOL_NAMESPACE}}", `mcp__${server.key}__*`)
    .replaceAll("{{TOOL_LIST}}", toolList(server))
    .replaceAll("{{ENV_TABLE}}", envTable(server));
}

// Strip our YAML frontmatter, return the markdown body only.
function skillBody(content) {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end === -1 ? content : content.slice(end + 4).trimStart();
}

function frontmatterDescription(content) {
  const m = content.match(/^description:\s*"?([^\n"]+)"?/m);
  return m ? m[1].trim() : "";
}

// VS Code Copilot reusable-prompt format (frontmatter subset it reads).
function vscodePromptContent(description, body) {
  return ["---", `description: "${description.replace(/"/g, "'")}"`, "---", "", body].join("\n");
}

// VS Code prompts live in <...>/Code/User/prompts (sibling of settings.json).
function vscodePromptDir(agent) {
  return path.join(path.dirname(agent.configPath), "prompts");
}

// Install the skill for the detected agents:
//   - project copy (<workspace>/.claude/skills/<key>/) — always, useful for the repo
//   - global Claude Code skill (~/.claude/skills/<key>/) — only if Claude Code is present
//   - VS Code Copilot prompt (Code/User/prompts/<key>.prompt.md) — only if VS Code is present
//   - Claude Desktop / OpenCode have no skill system → nothing (no junk dirs)
// `agents` defaults to [] (project copy only) for callers without agent context.
export function installSkill(server, agents = []) {
  const content = renderSkillContent(server);
  const written = [];

  const writeSkillDir = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "SKILL.md");
    fs.writeFileSync(dest, content, "utf-8");
    written.push(dest);
  };

  // Project copy — always.
  writeSkillDir(path.join(WORKSPACE_ROOT, ".claude", "skills", server.key));

  if (agents.some((a) => a.type === "claude-code")) {
    writeSkillDir(path.join(os.homedir(), ".claude", "skills", server.key));
  }

  const vscode = agents.find((a) => a.type === "vscode");
  if (vscode) {
    const dir = vscodePromptDir(vscode);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${server.key}.prompt.md`);
    fs.writeFileSync(dest, vscodePromptContent(frontmatterDescription(content), skillBody(content)), "utf-8");
    written.push(dest);
  }

  for (const a of agents) {
    if (a.type === "claude" || a.type === "opencode") {
      info(`${a.name}: no skill system — MCP server config is the integration point`);
    }
  }

  if (written.length) { ok(`Skill installed: ${server.key}`); written.forEach((w) => ok(`  → ${w}`)); }
  return written;
}

// Remove installed skill artifacts for <key>: both skill dirs and, for any
// detected VS Code agent, the Copilot prompt file.
export function removeSkill(key, agents = []) {
  let removed = 0;
  const rm = (p, isDir) => {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: isDir, force: true }); removed++; }
  };
  rm(path.join(os.homedir(), ".claude", "skills", key), true);
  rm(path.join(WORKSPACE_ROOT, ".claude", "skills", key), true);
  for (const a of agents.filter((x) => x.type === "vscode")) {
    rm(path.join(vscodePromptDir(a), `${key}.prompt.md`), false);
  }
  if (removed) ok(`Skill removed: ${key} (${removed} location${removed > 1 ? "s" : ""})`);
  else warn(`No installed skill found for ${key}`);
  return removed;
}
