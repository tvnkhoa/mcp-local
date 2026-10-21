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
import { WORKSPACE_ROOT, missingToolsMessage, serverEntryPath } from "./manifest.mjs";
import { toConfigPath, writeFileAtomic } from "./jsonc.mjs";
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
  // A server registered before its contract was snapshotted has `tools: []` (see `toolsFor` in
  // packages/manifest/src/servers.ts). Rendering it would install a skill that names no tools and
  // load without complaint — so `mcp:install` reports this instead and `mcp:doctor` fails.
  if (server.tools.length === 0) {
    throw new Error(missingToolsMessage(server.key));
  }
  const src = path.join(WORKSPACE_ROOT, ...server.skillSource.split("/"), "SKILL.md");
  if (!fs.existsSync(src)) {
    throw new Error(`Skill template not found: ${src}`);
  }
  const template = fs.readFileSync(src, "utf-8");
  const entry = toConfigPath(serverEntryPath(server));
  const rendered = template
    .replaceAll("{{KEY}}", server.key)
    .replaceAll("{{DISPLAY_NAME}}", server.displayName)
    .replaceAll("{{TAGLINE}}", server.tagline)
    .replaceAll("{{ENTRY_PATH}}", entry)
    .replaceAll("{{TOOL_NAMESPACE}}", `mcp__${server.key}__*`)
    .replaceAll("{{TOOL_LIST}}", toolList(server))
    .replaceAll("{{ENV_TABLE}}", envTable(server));
  // A misspelt or retired placeholder would otherwise ship verbatim into every agent's context —
  // `{{TOOL_LIST}}` typed as `{{TOOLS}}` installs a skill with no tool reference and no error.
  const leftover = [...new Set(rendered.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
  if (leftover.length) {
    throw new Error(`Skill template ${src} has unknown placeholder(s): ${leftover.join(", ")}`);
  }
  return rendered;
}

/**
 * Where the user-tier Claude Code skill for `key` is installed: `{ global, project }` SKILL.md
 * paths — `~/.claude/skills/<key>/` and this workspace's own `.claude/skills/<key>/`. A skill placed
 * in another repo (`--skill project`) is at {@link repoSkillPath}.
 */
export function skillPaths(key, ctx = {}) {
  const roots = skillRoots(ctx);
  return {
    global: path.join(roots.global, key, "SKILL.md"),
    project: path.join(roots.project, key, "SKILL.md"),
  };
}

/**
 * Whether the installed copy at `file` is what the template renders today:
 * "missing" | "current" | "stale".
 *
 * Presence alone is not health. The skill is rendered from the template AND the manifest (tool
 * list, env table, entry path), so editing any of them — or moving the checkout — leaves an
 * installed copy that still exists and still loads, while telling the agent about tools, flags or
 * paths that are no longer true. Line endings are ignored: a CRLF copy is not a different skill.
 */
export function skillStatus(server, file) {
  if (!fs.existsSync(file)) return "missing";
  const norm = (s) => s.replace(/\r\n/g, "\n");
  return norm(fs.readFileSync(file, "utf-8")) === norm(renderSkillContent(server)) ? "current" : "stale";
}

/**
 * The two user-tier skill directories: `{ global, project }`. `ctx.home` / `ctx.workspaceRoot`
 * exist so tests can point both at a temp directory.
 */
export function skillRoots({ home = os.homedir(), workspaceRoot = WORKSPACE_ROOT } = {}) {
  return {
    global: path.join(home, ".claude", "skills"),
    project: path.join(workspaceRoot, ".claude", "skills"),
  };
}

/** The project-scope skill of `key` in `repo`: `<repo>/.claude/skills/<key>/SKILL.md`. */
export function repoSkillPath(repo, key) {
  return path.join(repo, ".claude", "skills", key, "SKILL.md");
}

/**
 * Whether `content` is a skill this renderer produced for `key`.
 *
 * There is no explicit marker in the output; the signature is what `renderSkillContent` itself
 * writes: the template's frontmatter `name: {{KEY}}` and the `mcp__{{KEY}}__…` tool namespace from
 * `{{TOOL_NAMESPACE}}` / `{{TOOL_LIST}}`. A hand-written skill that happens to mention an MCP tool
 * does not also carry its own directory name as the namespace, so it is not mistaken for one.
 */
export function isRenderedServerSkill(content, key) {
  const norm = content.replace(/\r\n/g, "\n");
  return norm.startsWith(`---\nname: ${key}\n`) && norm.includes(`\`mcp__${key}__`);
}

/**
 * Server skills left behind by a renamed or removed manifest key (P4d).
 *
 * `removeSkill` only ever runs for a key someone names, so a key the manifest stops declaring —
 * S-44's `codebase-index-local`, say — leaves its rendered skill in place. It keeps loading, and
 * keeps telling the agent about a tool namespace no server registers any more.
 *
 * Returns `[{ key, dir }]` for every directory under `roots` whose SKILL.md is a rendered server
 * skill (see `isRenderedServerSkill`) and whose name is not in `knownKeys`. Authoring skills,
 * the workspace's own `.claude/skills/*` and anything hand-made are not rendered, so they never match.
 */
export function findOrphanedSkills(knownKeys, roots = Object.values(skillRoots())) {
  const known = new Set(knownKeys);
  const orphans = [];
  for (const root of roots) {
    let items;
    try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      if (!item.isDirectory() || known.has(item.name)) continue;
      const file = path.join(root, item.name, "SKILL.md");
      let content;
      try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
      if (isRenderedServerSkill(content, item.name)) orphans.push({ key: item.name, dir: path.join(root, item.name) });
    }
  }
  return orphans;
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

/** Where a skill goes: `none`, `project` (one repo's .claude/skills) or `user` (every project). */
export const SKILL_SCOPES = ["none", "project", "user"];

/**
 * Install the skill. `opts.skill` picks the tier:
 *
 *   "user" (default) — the user tier, as before scopes existed:
 *     - the workspace copy (<workspace>/.claude/skills/<key>/)
 *     - the global Claude Code skill (~/.claude/skills/<key>/) — only if Claude Code is present
 *     - a VS Code Copilot prompt (Code/User/prompts/<key>.prompt.md) — only if VS Code is present
 *     - Claude Desktop / OpenCode have no skill system → nothing (no junk dirs)
 *   "project" — `<opts.repo>/.claude/skills/<key>/SKILL.md` only. Nothing global, so the skill's
 *     triggers reach sessions in that repo and nowhere else.
 *   "none" — nothing.
 *
 * A project copy that exists but was not rendered by us (hand-written) is never overwritten.
 * `agents` defaults to [] (workspace copy only) for callers without agent context.
 */
export function installSkill(server, agents = [], opts = {}) {
  const { skill = "user", repo = null, home, workspaceRoot } = opts;
  if (skill === "none") return [];
  const content = renderSkillContent(server);
  const written = [];

  const writeSkillFile = (dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeFileAtomic(dest, content);
    written.push(dest);
  };

  if (skill === "project") {
    if (!repo) throw new Error(`--skill project needs a target repo (--repo <path>) for ${server.key}`);
    const dest = repoSkillPath(repo, server.key);
    const before = fs.existsSync(dest) ? fs.readFileSync(dest, "utf-8") : null;
    if (before !== null && !isRenderedServerSkill(before, server.key)) {
      warn(`${dest} exists and was not rendered by this installer — left as it is.`);
      return [];
    }
    writeSkillFile(dest);
    ok(`Skill installed: ${server.key} (project scope)`);
    ok(`  → ${dest}`);
    if (before !== null && before.replace(/\r\n/g, "\n") !== content.replace(/\r\n/g, "\n")) {
      info(`  The copy changed — if ${toConfigPath(repo)} commits .claude/skills/, review and commit it there.`);
    }
    return written;
  }

  const paths = skillPaths(server.key, { home, workspaceRoot });

  // Workspace copy — always.
  writeSkillFile(paths.project);

  if (agents.some((a) => a.type === "claude-code")) {
    writeSkillFile(paths.global);
  }

  const vscode = agents.find((a) => a.type === "vscode");
  if (vscode) {
    const dir = vscodePromptDir(vscode);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${server.key}.prompt.md`);
    writeFileAtomic(dest, vscodePromptContent(frontmatterDescription(content), skillBody(content)));
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

/**
 * Remove installed skill artifacts for <key>.
 *
 *   opts.scopes  which tiers to remove: "user" (both user-tier dirs and, for any detected VS Code
 *                agent, the Copilot prompt) and/or "project" (the copy in each of `opts.repos`).
 *                Default: both.
 *   opts.repos   repos whose `.claude/skills/<key>/` to remove. A copy there that this installer
 *                did not render is left alone.
 */
export function removeSkill(key, agents = [], opts = {}) {
  const { scopes = ["user", "project"], repos = [], home, workspaceRoot } = opts;
  let removed = 0;
  const rm = (p, isDir) => {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: isDir, force: true }); removed++; }
  };
  if (scopes.includes("user")) {
    const paths = skillPaths(key, { home, workspaceRoot });
    rm(path.dirname(paths.global), true);
    rm(path.dirname(paths.project), true);
    for (const a of agents.filter((x) => x.type === "vscode")) {
      rm(path.join(vscodePromptDir(a), `${key}.prompt.md`), false);
    }
  }
  if (scopes.includes("project")) {
    for (const repo of repos) {
      const file = repoSkillPath(repo, key);
      let content;
      try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
      if (!isRenderedServerSkill(content, key)) {
        warn(`${file} was not rendered by this installer — left in place.`);
        continue;
      }
      rm(file, false);
      try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty: other files stay */ }
      info(`  ${file} removed — if ${toConfigPath(repo)} commits .claude/skills/, commit the deletion there.`);
    }
  }
  if (removed) ok(`Skill removed: ${key} (${removed} location${removed > 1 ? "s" : ""})`);
  else warn(`No installed skill found for ${key}`);
  return removed;
}
