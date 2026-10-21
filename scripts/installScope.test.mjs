/**
 * Install scope and skill placement, end to end: the real install / update / uninstall / doctor
 * scripts, run as child processes against a TEMP home (HOME, USERPROFILE, APPDATA) and TEMP repos.
 *
 * Every test first proves the child's os.homedir() is the temp home; if it were not, the scripts
 * would write the real ~/.claude.json, so the suite refuses to run rather than risk it. No build:
 * `--skip-build`, and the verify step's "inconclusive" on an unbuilt dist/ is expected and harmless.
 *
 * The guarantee pinned here: a placement the operator chose (local scope, a repo's .mcp.json, a skill
 * in <repo>/.claude/skills/) survives every re-run, update and doctor pass — nothing silently puts
 * the skill back into ~/.claude/skills/ or re-registers the server at user scope.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = (name) => path.join(ROOT, "scripts", name);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "install-scope-test-"));
const fwd = (p) => p.replace(/\\/g, "/");

let n = 0;
/** A fresh machine: a temp home where Claude Code is "installed", and one temp repo. */
function sandbox({ projects = true } = {}) {
  n += 1;
  const base = path.join(TMP, `s${String(n)}`);
  const home = path.join(base, "home");
  const appdata = path.join(base, "appdata");
  const repo = path.join(base, "repo");
  for (const d of [home, appdata, repo]) fs.mkdirSync(d, { recursive: true });
  const state = { mcpServers: {}, projects: projects ? { [fwd(repo)]: { allowedTools: [] } } : {} };
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify(state, null, 2));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appdata, INIT_CWD: repo };
  delete env.CLAUDE_CONFIG_DIR;
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], { env, encoding: "utf8" });
  assert.equal(path.resolve(probe.stdout), path.resolve(home), "the child must see the temp home — refusing to run against the real one");
  return { base, home, appdata, repo, env };
}

function run(sb, script, args) {
  const r = spawnSync(process.execPath, [SCRIPT(script), ...args], { env: sb.env, encoding: "utf8", timeout: 120_000, input: "" });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `${script} ${args.join(" ")} exited ${String(r.status)}\n${out}`);
  return out;
}
const install = (sb, ...args) => run(sb, "install-mcp.mjs", ["--yes", "--skip-build", "--skip-smoke", ...args]);

const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.home, ".claude.json"), "utf8"));
const localEntry = (sb, key, repo = sb.repo) => {
  const projects = state(sb).projects ?? {};
  const k = Object.keys(projects).find((p) => fwd(p).toLowerCase() === fwd(repo).toLowerCase());
  return k ? projects[k].mcpServers?.[key] : undefined;
};
const globalSkill = (sb, key) => path.join(sb.home, ".claude", "skills", key, "SKILL.md");
const repoSkill = (sb, key, repo = sb.repo) => path.join(repo, ".claude", "skills", key, "SKILL.md");
const mcpJson = (repo) => {
  try { return JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8")); } catch { return null; }
};

/** A rendered-looking skill, enough for the "was this rendered by us" check. */
const fakeRendered = (key) => `---\nname: ${key}\ndescription: x\n---\n\n- \`mcp__${key}__health_check\`\n`;

test("board-mcp (repo-bound), fresh: local scope + project skill, nothing at user scope", () => {
  const sb = sandbox();
  const out = install(sb, "--server", "board-mcp", "--repo", sb.repo);
  assert.ok(localEntry(sb, "board-mcp"), "registered under projects[<repo>].mcpServers");
  assert.equal(state(sb).mcpServers["board-mcp"], undefined, "not at user scope");
  assert.ok(fs.existsSync(repoSkill(sb, "board-mcp")), "skill in <repo>/.claude/skills");
  assert.equal(fs.existsSync(globalSkill(sb, "board-mcp")), false, "no ~/.claude/skills copy");
  assert.match(out, /Register: local/);
});

test("the owner's hand-moved setup survives a re-run with --yes and no flags", () => {
  const sb = sandbox();
  // What the owner did by hand: `claude mcp add -s local` in the repo, the skill moved into the repo.
  const s = state(sb);
  s.projects[fwd(sb.repo)].mcpServers = {
    "board-mcp": { command: "node", args: ["D:/old/board-mcp/dist/index.js"], env: { BOARD_REPO_ROOT: fwd(sb.repo), BOARD_WRITE_ENABLED: "true" } },
  };
  fs.writeFileSync(path.join(sb.home, ".claude.json"), JSON.stringify(s));
  fs.mkdirSync(path.dirname(repoSkill(sb, "board-mcp")), { recursive: true });
  fs.writeFileSync(repoSkill(sb, "board-mcp"), fakeRendered("board-mcp"));

  const out = install(sb, "--server", "board-mcp");
  assert.match(out, /Keeping the existing local scope/);
  assert.match(out, /Keeping the existing project skill/);
  assert.equal(state(sb).mcpServers["board-mcp"], undefined, "not re-registered at user scope");
  assert.equal(fs.existsSync(globalSkill(sb, "board-mcp")), false, "skill not put back into ~/.claude/skills");
  assert.equal(localEntry(sb, "board-mcp").env.BOARD_WRITE_ENABLED, "true", "the configured env is kept");
  assert.match(fs.readFileSync(repoSkill(sb, "board-mcp"), "utf8"), /mcp__board-mcp__/, "project copy re-rendered in place");

  // update and doctor: same guarantee.
  const upd = run(sb, "update-mcp.mjs", ["--server", "board-mcp", "--skip-build"]);
  assert.equal(state(sb).mcpServers["board-mcp"], undefined, "update does not register at user scope");
  assert.equal(fs.existsSync(globalSkill(sb, "board-mcp")), false, "update does not write ~/.claude/skills");
  assert.ok(fs.existsSync(repoSkill(sb, "board-mcp")));
  assert.match(upd, /\(project scope\)/);
  const doc = spawnSync(process.execPath, [SCRIPT("mcp-doctor.mjs"), "--server", "board-mcp", "--skip-start"], { env: sb.env, encoding: "utf8", timeout: 120_000 });
  assert.match(doc.stdout, /config\s+registered in Claude Code at local scope/);
  assert.match(doc.stdout, /skill\s+installed at project /);
  assert.doesNotMatch(doc.stdout, /not installed/);
  assert.equal(fs.existsSync(globalSkill(sb, "board-mcp")), false, "doctor writes nothing");
});

test("a general server whose skill was moved into a repo keeps it there on re-run", () => {
  const sb = sandbox();
  const s = state(sb);
  s.mcpServers["bitbucket-mcp"] = { command: "node", args: ["x"], env: {} };
  fs.writeFileSync(path.join(sb.home, ".claude.json"), JSON.stringify(s));
  fs.mkdirSync(path.dirname(repoSkill(sb, "bitbucket-mcp")), { recursive: true });
  fs.writeFileSync(repoSkill(sb, "bitbucket-mcp"), fakeRendered("bitbucket-mcp"));

  install(sb, "--server", "bitbucket-mcp");
  assert.ok(state(sb).mcpServers["bitbucket-mcp"], "user scope kept");
  assert.equal(fs.existsSync(globalSkill(sb, "bitbucket-mcp")), false, "no global copy written");
  assert.match(fs.readFileSync(repoSkill(sb, "bitbucket-mcp"), "utf8"), /mcp__bitbucket-mcp__/);
});

test("explicit move from user scope: --scope local --skill project retires the user-scope entry and the global skill", () => {
  const sb = sandbox();
  const s = state(sb);
  s.mcpServers["board-mcp"] = { command: "node", args: ["x"], env: { BOARD_REPO_ROOT: fwd(sb.repo) } };
  fs.writeFileSync(path.join(sb.home, ".claude.json"), JSON.stringify(s));
  fs.mkdirSync(path.dirname(globalSkill(sb, "board-mcp")), { recursive: true });
  fs.writeFileSync(globalSkill(sb, "board-mcp"), fakeRendered("board-mcp"));

  // Without flags a re-run keeps user scope (nothing moves silently in either direction)…
  install(sb, "--server", "board-mcp", "--skill", "none");
  assert.ok(state(sb).mcpServers["board-mcp"]);
  assert.equal(localEntry(sb, "board-mcp"), undefined);

  // …with them, it moves; the repo defaults from BOARD_REPO_ROOT.
  install(sb, "--server", "board-mcp", "--scope", "local", "--skill", "project");
  assert.equal(state(sb).mcpServers["board-mcp"], undefined, "user-scope entry removed");
  assert.equal(localEntry(sb, "board-mcp").env.BOARD_REPO_ROOT, fwd(sb.repo));
  assert.equal(fs.existsSync(globalSkill(sb, "board-mcp")), false, "global skill removed");
  assert.ok(fs.existsSync(repoSkill(sb, "board-mcp")));
});

test("local scope writes every spelling Claude Code holds for the repo, and uninstall removes them all", () => {
  const sb = sandbox();
  const s = state(sb);
  const upper = fwd(sb.repo);
  const lower = upper.replace(/^([A-Za-z]):/, (_m, d) => `${d.toLowerCase()}:`);
  const flipped = upper.replace(/^([A-Za-z]):/, (_m, d) => `${d === d.toLowerCase() ? d.toUpperCase() : d.toLowerCase()}:`);
  if (process.platform !== "win32" || flipped === upper) return; // drive-letter spellings are a Windows thing
  s.projects = { [upper]: {}, [flipped]: {} };
  fs.writeFileSync(path.join(sb.home, ".claude.json"), JSON.stringify(s));
  install(sb, "--server", "board-mcp", "--repo", sb.repo, "--skill", "none");
  const after = state(sb).projects;
  assert.ok(after[upper].mcpServers["board-mcp"] && after[flipped].mcpServers["board-mcp"], `both spellings: ${lower}`);

  run(sb, "uninstall-mcp.mjs", ["--server", "board-mcp", "--scope", "local"]);
  const gone = state(sb).projects;
  assert.equal(gone[upper].mcpServers["board-mcp"], undefined);
  assert.equal(gone[flipped].mcpServers["board-mcp"], undefined);
});

test("--scope project writes <repo>/.mcp.json (no backup files in the repo) and leaves ~/.claude.json alone", () => {
  const sb = sandbox();
  const before = fs.readFileSync(path.join(sb.home, ".claude.json"), "utf8");
  const out = install(sb, "--server", "board-mcp", "--scope", "project", "--repo", sb.repo);
  assert.ok(mcpJson(sb.repo)?.mcpServers?.["board-mcp"], ".mcp.json entry");
  assert.deepEqual(fs.readdirSync(sb.repo).filter((f) => f.includes(".backup.")), []);
  assert.equal(fs.readFileSync(path.join(sb.home, ".claude.json"), "utf8"), before, "~/.claude.json untouched");
  assert.match(out, /machine/, "warns that absolute paths make it machine-specific");
  assert.ok(fs.existsSync(repoSkill(sb, "board-mcp")), "default skill for a non-user scope is project");

  // Re-run without flags keeps project scope — the repo is found through ~/.claude.json projects.
  const again = install(sb, "--server", "board-mcp");
  assert.match(again, /Keeping the existing project scope/);
  assert.equal(state(sb).mcpServers["board-mcp"], undefined);
  assert.equal(localEntry(sb, "board-mcp"), undefined);
});

test("--skip-skill is --skill none: no skill anywhere; bad or conflicting flags are refused", () => {
  const sb = sandbox();
  install(sb, "--server", "board-mcp", "--repo", sb.repo, "--skip-skill");
  assert.equal(fs.existsSync(repoSkill(sb, "board-mcp")), false);
  assert.equal(fs.existsSync(globalSkill(sb, "board-mcp")), false);

  const conflict = spawnSync(process.execPath, [SCRIPT("install-mcp.mjs"), "--yes", "--skip-build", "--server", "board-mcp", "--skip-skill", "--skill", "user"], { env: sb.env, encoding: "utf8" });
  assert.notEqual(conflict.status, 0, "--skip-skill with --skill user is refused");
  const bad = spawnSync(process.execPath, [SCRIPT("install-mcp.mjs"), "--yes", "--skip-build", "--server", "board-mcp", "--scope", "global"], { env: sb.env, encoding: "utf8" });
  assert.notEqual(bad.status, 0, "an unknown scope is refused");
});

test("uninstall per scope: --scope user leaves a local registration and a project skill alone; no --scope removes them", () => {
  const sb = sandbox();
  install(sb, "--server", "board-mcp", "--repo", sb.repo);
  run(sb, "uninstall-mcp.mjs", ["--server", "board-mcp", "--scope", "user"]);
  assert.ok(localEntry(sb, "board-mcp"));
  assert.ok(fs.existsSync(repoSkill(sb, "board-mcp")));

  run(sb, "uninstall-mcp.mjs", ["--server", "board-mcp"]);
  assert.equal(localEntry(sb, "board-mcp"), undefined);
  assert.equal(fs.existsSync(repoSkill(sb, "board-mcp")), false);

  // project scope
  install(sb, "--server", "board-mcp", "--scope", "project", "--repo", sb.repo, "--skill", "none");
  run(sb, "uninstall-mcp.mjs", ["--server", "board-mcp", "--scope", "project", "--repo", sb.repo]);
  assert.equal(mcpJson(sb.repo).mcpServers["board-mcp"], undefined);
});

test("a hand-written skill in the repo is never overwritten or deleted", () => {
  const sb = sandbox();
  fs.mkdirSync(path.dirname(repoSkill(sb, "board-mcp")), { recursive: true });
  fs.writeFileSync(repoSkill(sb, "board-mcp"), "---\nname: board-mcp\n---\nmine\n");
  install(sb, "--server", "board-mcp", "--repo", sb.repo);
  assert.equal(fs.readFileSync(repoSkill(sb, "board-mcp"), "utf8"), "---\nname: board-mcp\n---\nmine\n");
  run(sb, "uninstall-mcp.mjs", ["--server", "board-mcp"]);
  assert.ok(fs.existsSync(repoSkill(sb, "board-mcp")));
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
