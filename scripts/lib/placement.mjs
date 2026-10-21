// Where a server is registered and where its skill lives — and where an install should put them.
//
// Claude Code has three registration scopes:
//   user     ~/.claude.json  mcpServers                     every project on the machine
//   local    ~/.claude.json  projects["<repo>"].mcpServers  one repo, private to this machine
//   project  <repo>/.mcp.json mcpServers                    one repo, shared through the repo
// and a skill is read from ~/.claude/skills/<key>/ (every project) or <repo>/.claude/skills/<key>/.
//
// The rule every entry point keeps: a placement the operator chose is never silently undone. A
// re-run of the installer, `mcp:update` and `mcp:doctor` FIND the current placement and keep or
// report it; only an explicit `--scope` / `--skill` (or an interactive answer) moves a server.

import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "./manifest.mjs";
import { comparablePath, projectMcpJson, readLocalEntries, readServerEntries, readServerEntry } from "./agents.mjs";
import { repoSkillPath, skillPaths } from "./skills.mjs";
import { readJsonc } from "./jsonc.mjs";

function loadJsoncOrEmpty(file) {
  try { return readJsonc(file); } catch { return {}; }
}

/** Registration scopes, in the order the prompt lists them. */
export const SCOPES = ["user", "local", "project"];

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * A checkout of this workspace (the main one, or a worktree of it). Its `.claude/skills/<key>/` is
 * the user tier's workspace copy, not a project placement — otherwise a worktree would read the main
 * checkout's copy as "moved to a project" and keep re-installing there.
 */
export function isWorkspaceCheckout(dir, workspaceRoot = WORKSPACE_ROOT) {
  return comparablePath(dir) === comparablePath(workspaceRoot) ||
    fs.existsSync(path.join(dir, "packages", "manifest", "src", "servers.ts"));
}

/** The configured value of a repo-bound server's repo env var, from any entry that has one. */
export function repoBoundValue(server, entries) {
  const name = server.repoBound?.envVar;
  if (!name) return null;
  for (const e of entries) {
    const env = e?.env ?? e?.environment ?? {};
    if (typeof env[name] === "string" && env[name] !== "") return env[name];
  }
  return null;
}

/**
 * Repos worth looking in for a local/project placement — bounded, never a disk scan: every project
 * Claude Code has opened (the `projects` keys of ~/.claude.json), the configured value of a
 * repo-bound server's env var, and any `extra` the caller names (`--repo`). Existing directories
 * only, one entry per path however it is spelled.
 */
export function candidateRepos(server, agents, extra = []) {
  const out = new Map();
  const add = (p) => {
    if (typeof p !== "string" || p === "" || !isDir(p)) return;
    const k = comparablePath(p);
    if (!out.has(k)) out.set(k, p);
  };
  const cc = agents.find((a) => a.type === "claude-code");
  const entries = [];
  if (cc) {
    const state = loadJsoncOrEmpty(cc.configPath);
    for (const p of Object.keys(state.projects ?? {})) add(p);
    entries.push(...readLocalEntries(cc, server.key).map((l) => l.entry));
  }
  for (const a of agents) entries.push(...readServerEntries(a, server.key).map((r) => r.entry));
  add(repoBoundValue(server, entries));
  for (const p of extra) add(p);
  return [...out.values()];
}

/**
 * Every placement of `server` that exists now:
 *   registrations  [{ scope: "user", agent, name, entry }]           — any detected agent's root bucket
 *                  [{ scope: "local", repo, entry }]                  — Claude Code projects[...]
 *                  [{ scope: "project", repo, entry }]                — <repo>/.mcp.json
 *   skills         [{ scope: "user", where: "global" | "workspace", file }]
 *                  [{ scope: "project", repo, file }]
 * `repos` bounds where local/project placements are looked for (see candidateRepos). Local
 * entries are read from every project key regardless, and repeated spellings collapse to one.
 */
export function findPlacements(server, { agents, repos = [], home, workspaceRoot = WORKSPACE_ROOT }) {
  const key = server.key;
  const registrations = [];
  for (const agent of agents) {
    for (const r of readServerEntries(agent, key)) registrations.push({ scope: "user", agent, name: r.name, entry: r.entry });
  }
  const cc = agents.find((a) => a.type === "claude-code");
  if (cc) {
    const seen = new Set();
    for (const l of readLocalEntries(cc, key)) {
      const k = comparablePath(l.repo);
      if (seen.has(k)) continue;
      seen.add(k);
      registrations.push({ scope: "local", repo: l.repo, entry: l.entry });
    }
  }
  for (const repo of repos) {
    const entry = readServerEntry(projectMcpJson(repo), key);
    if (entry) registrations.push({ scope: "project", repo, entry });
  }

  const skills = [];
  const user = skillPaths(key, { home, workspaceRoot });
  if (fs.existsSync(user.global)) skills.push({ scope: "user", where: "global", file: user.global });
  if (fs.existsSync(user.project)) skills.push({ scope: "user", where: "workspace", file: user.project });
  for (const repo of repos) {
    if (isWorkspaceCheckout(repo, workspaceRoot)) continue;
    const file = repoSkillPath(repo, key);
    if (fs.existsSync(file)) skills.push({ scope: "project", repo, file });
  }
  return { registrations, skills };
}

/** One line per placement, for the installer's "found" note and the doctor. */
export function describePlacement(p) {
  if (p.scope === "user") return p.agent ? `user scope (${p.agent.name}: ${p.name})` : `user tier (${p.file})`;
  if (p.scope === "local") return `local scope for ${p.repo}`;
  return p.file ? `project (${p.file})` : `project scope (${path.join(p.repo, ".mcp.json")})`;
}

/**
 * What an install should do when the operator has not said, and what it found:
 *
 *   registration  `flags.scope` when given; else the existing local/project registration (kept,
 *                 with its repo); else an existing user-scope one (kept); else the default —
 *                 `local` for a repo-bound server, `user` otherwise.
 *   skill         `flags.skill` when given; else an existing project skill (kept, with its repo);
 *                 else an existing user-tier skill; else the default — `project` when the
 *                 registration is local/project, `user` otherwise.
 *   repo          `flags.repo`; else the repo of a kept placement; else the repo-bound env value;
 *                 else `cwd`. Only meaningful when scope ≠ user or skill = project.
 *
 * Returns { scope, skill, repo, notes } — `notes` say what was kept and why, for printing.
 * Pure: the inputs are the flags and a `findPlacements` result.
 */
export function planPlacement(server, { flags = {}, existing, envRepo = null, cwd = process.cwd() }) {
  const notes = [];
  const regs = existing.registrations;
  const nonUser = regs.find((r) => r.scope !== "user");
  const userReg = regs.find((r) => r.scope === "user");
  const projSkill = existing.skills.find((s) => s.scope === "project");
  const userSkill = existing.skills.find((s) => s.scope === "user");
  let repo = flags.repo ?? null;

  let scope = flags.scope ?? null;
  if (!scope) {
    if (nonUser) {
      scope = nonUser.scope;
      repo ??= nonUser.repo;
      notes.push(`Keeping the existing ${describePlacement(nonUser)} — pass --scope to move it.`);
    } else if (userReg) {
      scope = "user";
      notes.push("Keeping the existing user-scope registration — pass --scope to move it.");
    } else {
      scope = server.repoBound ? "local" : "user";
    }
  }

  let skill = flags.skill ?? null;
  if (!skill) {
    if (projSkill) {
      skill = "project";
      repo ??= projSkill.repo;
      notes.push(`Keeping the existing project skill (${projSkill.file}) — pass --skill to move it.`);
    } else if (userSkill) {
      skill = "user";
      if (scope !== "user") notes.push("Keeping the existing user-tier skill — pass --skill to move it.");
    } else {
      skill = scope === "user" ? "user" : "project";
    }
  }

  repo ??= envRepo ?? cwd;
  return { scope, skill, repo, notes };
}

/**
 * Placements that the chosen plan supersedes and would otherwise leave behind:
 *   - a Claude Code user-scope registration, when the plan registers at local/project scope
 *     (left in place, it keeps reaching every project — the reason to move in the first place)
 *   - the user-tier skill copies, when the plan puts the skill in a project
 * Returns [{ kind: "registration" | "skill", placement }]. The caller asks before removing; nothing
 * here writes.
 *
 * The opposite moves (to user scope while a local/project placement exists) are not offered for
 * removal: those placements live in a repo or are narrower than the new one, so they are reported,
 * not deleted — see {@link shadowedBy}.
 */
export function superseded(plan, existing) {
  const out = [];
  if (plan.scope !== "user") {
    for (const r of existing.registrations) {
      if (r.scope === "user" && r.agent?.type === "claude-code") out.push({ kind: "registration", placement: r });
    }
  }
  if (plan.skill === "project") {
    for (const s of existing.skills) if (s.scope === "user") out.push({ kind: "skill", placement: s });
  }
  return out;
}

/** Placements the plan leaves alone that will still apply alongside it — printed as warnings. */
export function shadowedBy(plan, existing) {
  const same = (a, b) => a && b && comparablePath(a) === comparablePath(b);
  const regs = existing.registrations.filter((r) =>
    r.scope !== "user" && !(r.scope === plan.scope && same(r.repo, plan.repo)));
  const skills = existing.skills.filter((s) =>
    s.scope === "project" && !(plan.skill === "project" && same(s.repo, plan.repo)));
  return [...regs, ...skills];
}
