/**
 * P4d: `mcp:doctor` warns about rendered server skills whose key the manifest no longer declares.
 * Temp skill roots only — the real ~/.claude/skills is never read here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SERVERS } from "./manifest.mjs";
import { findOrphanedSkills, isRenderedServerSkill, renderSkillContent } from "./skills.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-orphans-test-"));

function skill(root, dir, content) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "SKILL.md"), content, "utf8");
}

test("a skill rendered for the current key is recognised as a server skill", () => {
  const server = SERVERS[0];
  assert.ok(isRenderedServerSkill(renderSkillContent(server), server.key));
  assert.ok(isRenderedServerSkill(renderSkillContent(server).replace(/\n/g, "\r\n"), server.key), "CRLF copy");
  assert.ok(!isRenderedServerSkill(renderSkillContent(server), `${server.key}-other`));
});

test("only rendered skills with an unknown key are reported, across both roots", () => {
  const globalRoot = path.join(tmp, "global");
  const projectRoot = path.join(tmp, "project");
  const known = SERVERS.map((s) => s.key);
  const server = SERVERS[0];

  // Current skill: known key, never an orphan.
  skill(globalRoot, server.key, renderSkillContent(server));
  // Renamed key: the old render, still installed under the old name — the case to catch.
  const old = `${server.key}-local`;
  skill(globalRoot, old, renderSkillContent(server).replaceAll(server.key, old));
  skill(projectRoot, old, renderSkillContent(server).replaceAll(server.key, old));
  // Hand-written / authoring skills: mention a tool, but are not rendered by us.
  skill(projectRoot, "mcp-security-review", "---\nname: mcp-security-review\n---\nUse `mcp__postgres-mcp__run_read_query`.\n");
  skill(globalRoot, "synced", "---\nname: synced\n---\nnotes\n");
  // A directory with no SKILL.md, and a stray file at the root.
  fs.mkdirSync(path.join(globalRoot, "empty"), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, "README.md"), "x");

  const found = findOrphanedSkills(known, [globalRoot, projectRoot]);
  assert.deepEqual(found.map((o) => o.key), [old, old]);
  assert.deepEqual(found.map((o) => o.dir), [path.join(globalRoot, old), path.join(projectRoot, old)]);
});

test("a missing root is not an error", () => {
  assert.deepEqual(findOrphanedSkills([], [path.join(tmp, "does-not-exist")]), []);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
