/**
 * `--skip-skill` is an opt-out, and it has to stay one — now as an alias of `--skill none`.
 *
 * The installer writes the operational skill by default because a registered server without it
 * leaves the agent holding the tools and none of the sequences or guardrails. The flag exists for
 * operators who curate their skills themselves, or who are testing an install against a scratch HOME.
 *
 * Two shapes are pinned: the default must stay *on* (a flag that silently defaults to skipping
 * would ship servers with no skill), and the skip must be scoped to the skill step — env, agent
 * config, verify and smoke are unaffected by it. The behaviour itself is driven end to end against
 * a temp HOME in `scripts/installScope.test.mjs`; these are the source-level pins.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installer = fs.readFileSync(path.join(ROOT, "scripts/install-mcp.mjs"), "utf8");

const FLAGS = { yes: ["--yes", "-y"], skipSmoke: ["--skip-smoke"], skipSkill: ["--skip-skill", "--no-skill"] };
const VALUES = { scope: ["--scope"], skill: ["--skill"], repo: ["--repo"] };

test("the skill is installed unless asked otherwise — the flag defaults to off", () => {
  assert.equal(parseArgs([], FLAGS).skipSkill, false);
  assert.equal(parseArgs(["--server", "postgres-mcp", "--yes"], FLAGS).skipSkill, false);
  assert.equal(parseArgs([], FLAGS, VALUES).skill, null, "no --skill: the installer decides from placement and defaults");
});

test("both spellings opt out, and neither disturbs the other flags", () => {
  for (const token of ["--skip-skill", "--no-skill"]) {
    const args = parseArgs([token], FLAGS, VALUES);
    assert.equal(args.skipSkill, true, `${token} must set skipSkill`);
    assert.equal(args.skipSmoke, false, `${token} must not imply --skip-smoke`);
    assert.equal(args.yes, false, `${token} must not imply --yes`);
    assert.equal(args.scope, null, `${token} must not imply a scope`);
  }
});

test("value flags take `--flag v` and `--flag=v`, and do not swallow --server", () => {
  const a = parseArgs(["--scope", "local", "--skill=project", "--repo", "D:/x/repo", "--server", "board-mcp", "-y"], FLAGS, VALUES);
  assert.deepEqual([a.scope, a.skill, a.repo, a.servers, a.yes], ["local", "project", "D:/x/repo", ["board-mcp"], true]);
});

test("the installer declares the flags and treats --skip-skill as --skill none", () => {
  assert.match(installer, /skipSkill:\s*\["--skip-skill",\s*"--no-skill"\]/, "expected both tokens in boolFlags");
  assert.match(installer, /\{ scope: \["--scope"\], skill: \["--skill"\], repo: \["--repo"\][^}]*\}/, "expected the value flags");
  assert.match(installer, /skill: ARGS\.skipSkill \? "none"/, "--skip-skill must map to --skill none");
  assert.match(installer, /if \(plan\.skill === "none"\)[\s\S]{0,400}installSkill\(server, agents, \{ skill: plan\.skill, repo: plan\.repo \}\)/, "the skill step must be guarded");
});

test("skipping the skill does not skip anything else", () => {
  // The regression shape: an early `return` or a wider branch that also swallows verify/smoke.
  for (const call of [/collectEnv\(server,\s*agents\)/, /registerServer\(server, agents, plan, mcpConfig\)/, /configureAgent\(agent, server\.key, mcpConfig\)/, /verifyServer\(/]) {
    assert.match(installer, call, `${String(call)} must still run when the skill is skipped`);
  }
  assert.doesNotMatch(
    installer,
    /if \(plan\.skill === "none"\)\s*\{?\s*return/,
    "--skill none must skip the skill step, not the rest of the install"
  );
});

test("the skip path names the way back", () => {
  // A skipped skill is recoverable only if the operator knows which command installs it later.
  assert.match(installer, /install-mcp\.mjs --server \$\{server\.key\} --skill project\|user/, "expected the follow-up command in the skip branch");
  assert.match(installer, /--skip-skill/, "expected the flag documented in the usage header");
});
