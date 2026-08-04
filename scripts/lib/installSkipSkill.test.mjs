/**
 * `--skip-skill` is an opt-out, and it has to stay one.
 *
 * The installer writes the operational skill by default because a registered server without it
 * leaves the agent holding the tools and none of the sequences or guardrails. The flag exists for
 * the one invasive part of that write — `~/.claude/skills/` — for operators who curate their global
 * skills themselves, or who are testing an install against a scratch HOME.
 *
 * Two shapes are pinned: the default must stay *on* (a flag that silently defaults to skipping
 * would ship servers with no skill), and the skip must be scoped to step 4 — env, agent config,
 * verify and smoke are unaffected by it.
 *
 * Source-level assertions, matching `installEnvPreserve.test.mjs`: the alternative is driving the
 * real installer against a real agent config and a real HOME.
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

test("the skill is installed unless asked otherwise — the flag defaults to off", () => {
  assert.equal(parseArgs([], FLAGS).skipSkill, false);
  assert.equal(parseArgs(["--server", "postgres-mcp", "--yes"], FLAGS).skipSkill, false);
});

test("both spellings opt out, and neither disturbs the other flags", () => {
  for (const token of ["--skip-skill", "--no-skill"]) {
    const args = parseArgs([token], FLAGS);
    assert.equal(args.skipSkill, true, `${token} must set skipSkill`);
    assert.equal(args.skipSmoke, false, `${token} must not imply --skip-smoke`);
    assert.equal(args.yes, false, `${token} must not imply --yes`);
  }
});

test("the installer declares the flag and guards the skill step with it", () => {
  assert.match(installer, /skipSkill:\s*\["--skip-skill",\s*"--no-skill"\]/, "expected both tokens in boolFlags");
  assert.match(installer, /if \(ARGS\.skipSkill\)[\s\S]{0,200}installSkill\(server, agents\)/, "step 4 must be guarded");
});

test("skipping the skill does not skip anything else", () => {
  // The regression shape: an early `return` or a wider branch that also swallows verify/smoke.
  for (const call of [/collectEnv\(server,\s*agents\)/, /configureAgent\(agent, server\.key, mcpConfig\)/, /verifyServer\(/]) {
    assert.match(installer, call, `${String(call)} must still run when the skill is skipped`);
  }
  assert.doesNotMatch(
    installer,
    /if \(ARGS\.skipSkill\)\s*\{?\s*return/,
    "--skip-skill must skip the skill step, not the rest of the install"
  );
});

test("the skip path names the way back", () => {
  // A skipped skill is recoverable only if the operator knows which command installs it later.
  assert.match(installer, /mcp:update -- --server \$\{server\.key\}/, "expected the follow-up command in the skip branch");
  assert.match(installer, /--skip-skill/, "expected the flag documented in the usage header");
});
