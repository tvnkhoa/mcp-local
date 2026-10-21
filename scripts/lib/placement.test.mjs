/**
 * `planPlacement` / `superseded` / `shadowedBy` — the install decision, as pure functions over a
 * `findPlacements` result. The end-to-end behaviour against a temp HOME is in
 * scripts/installScope.test.mjs; this file covers the decision table without spawning anything.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { planPlacement, shadowedBy, superseded } from "./placement.mjs";

const general = { key: "postgres-mcp" };
const bound = { key: "board-mcp", repoBound: { envVar: "BOARD_REPO_ROOT" } };
const none = { registrations: [], skills: [] };
const cc = { name: "Claude Code", type: "claude-code" };

test("fresh install: repo-bound → local + project skill in the env repo; general → user + user", () => {
  assert.deepEqual(
    planPlacement(bound, { existing: none, envRepo: "D:/x/aria", cwd: "D:/elsewhere" }),
    { scope: "local", skill: "project", repo: "D:/x/aria", notes: [] }
  );
  const g = planPlacement(general, { existing: none, cwd: "D:/elsewhere" });
  assert.deepEqual([g.scope, g.skill], ["user", "user"]);
  assert.equal(planPlacement(bound, { existing: none, cwd: "D:/cwd" }).repo, "D:/cwd", "no env value: the cwd");
});

test("an existing local/project registration and project skill are kept, with their repo", () => {
  const existing = {
    registrations: [{ scope: "local", repo: "D:/x/aria", entry: {} }],
    skills: [{ scope: "project", repo: "D:/x/aria", file: "D:/x/aria/.claude/skills/board-mcp/SKILL.md" }],
  };
  const p = planPlacement(bound, { existing, envRepo: "D:/other", cwd: "D:/cwd" });
  assert.deepEqual([p.scope, p.skill, p.repo], ["local", "project", "D:/x/aria"]);
  assert.equal(p.notes.length, 2, "both kept placements are announced");

  // Same for a general server: a project skill is not moved back to the user tier.
  const g = planPlacement(general, {
    existing: { registrations: [{ scope: "user", agent: cc, name: "postgres-mcp", entry: {} }], skills: [{ scope: "project", repo: "D:/r", file: "f" }] },
    cwd: "D:/cwd",
  });
  assert.deepEqual([g.scope, g.skill, g.repo], ["user", "project", "D:/r"]);
});

test("an existing user-scope registration is kept too — no silent move in either direction", () => {
  const existing = { registrations: [{ scope: "user", agent: cc, name: "board-mcp", entry: {} }], skills: [{ scope: "user", where: "global", file: "g" }] };
  const p = planPlacement(bound, { existing, envRepo: "D:/x/aria" });
  assert.deepEqual([p.scope, p.skill], ["user", "user"]);
});

test("flags win over what was found", () => {
  const existing = { registrations: [{ scope: "local", repo: "D:/x/aria", entry: {} }], skills: [] };
  const p = planPlacement(bound, { flags: { scope: "project", skill: "none", repo: "D:/y" }, existing });
  assert.deepEqual([p.scope, p.skill, p.repo], ["project", "none", "D:/y"]);
});

test("superseded: a move to local/project offers the Claude Code user entry and the user-tier skill; nothing else", () => {
  const userReg = { scope: "user", agent: cc, name: "board-mcp", entry: {} };
  const desktop = { scope: "user", agent: { name: "Claude Desktop", type: "claude" }, name: "board-mcp", entry: {} };
  const global = { scope: "user", where: "global", file: "g" };
  const existing = { registrations: [userReg, desktop], skills: [global] };
  assert.deepEqual(
    superseded({ scope: "local", skill: "project", repo: "D:/r" }, existing).map((s) => s.placement),
    [userReg, global]
  );
  assert.deepEqual(superseded({ scope: "user", skill: "user", repo: "D:/r" }, existing), [], "nothing to retire when staying at user scope");
});

test("shadowedBy: placements left alone that still apply are reported", () => {
  const existing = {
    registrations: [{ scope: "local", repo: "D:/a", entry: {} }, { scope: "project", repo: "D:/b", entry: {} }],
    skills: [{ scope: "project", repo: "D:/a", file: "fa" }],
  };
  const left = shadowedBy({ scope: "local", skill: "project", repo: "D:/a" }, existing);
  assert.deepEqual(left.map((p) => `${p.scope}:${p.repo}`), ["project:D:/b"]);
});
