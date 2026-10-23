/**
 * The tool list against board.mjs itself.
 *
 * Parses the keys of `const commands = { … }` in board.mjs and of the objects `more_commands`
 * (more.mjs), `task_commands` (task.mjs) and `rescope_commands` (rescope.mjs) return, and requires every one to be MAPPED to a tool or EXCLUDED with a reason —
 * so a subcommand wec.aria adds fails here until this server decides what to do with it.
 *
 * Needs the real CLI: BOARD_REPO_ROOT, else the default wec.aria checkout. Neither exists in this
 * workspace's CI, so there it SKIPS, saying so; locally it runs.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { EXCLUDED, EXCLUDED_SCRIPTS, MAPPED } from "./commandMap.js";
import { realBoardRoot } from "./testSupport.test.js";

/** The method keys of the object literal that starts at `opener`, at exactly `indent` spaces. */
export function objectKeys(source: string, opener: RegExp, indent: number): string[] {
  const start = source.search(opener);
  if (start < 0) throw new Error(`no ${opener} in source`);
  const body = source.slice(start);
  const close = body.search(new RegExp(`\\n${" ".repeat(indent - 2)}\\}`, "u"));
  const block = close < 0 ? body : body.slice(0, close);
  const re = new RegExp(`^ {${indent}}(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9_]*))\\(\\) \\{`, "gmu");
  return [...block.matchAll(re)].map((m) => m[1] ?? m[2] ?? "");
}

export function cliCommands(root: string): string[] {
  const board = readFileSync(path.join(root, "checks", "board", "board.mjs"), "utf8").replace(/\r\n/gu, "\n");
  const more = readFileSync(path.join(root, "checks", "board", "more.mjs"), "utf8").replace(/\r\n/gu, "\n");
  // task.mjs (wec.aria e66c0bdf) spreads `task_commands` into `commands` the way more.mjs does.
  const taskFile = path.join(root, "checks", "board", "task.mjs");
  const task = existsSync(taskFile) ? objectKeys(readFileSync(taskFile, "utf8").replace(/\r\n/gu, "\n"), /^export function task_commands\(/mu, 4) : [];
  // rescope.mjs (wec.aria 7d2d814b) is spread into `task_commands` the same way.
  const rescopeFile = path.join(root, "checks", "board", "rescope.mjs");
  const rescope = existsSync(rescopeFile) ? objectKeys(readFileSync(rescopeFile, "utf8").replace(/\r\n/gu, "\n"), /^export function rescope_commands\(/mu, 4) : [];
  return [...objectKeys(board, /^const commands = \{/mu, 2), ...objectKeys(more, /^export function more_commands\(/mu, 4), ...task, ...rescope].sort();
}

test("parsing finds the commands a known snapshot of board.mjs declares", () => {
  const board = "const commands = {\n  new() {\n  },\n\n  status() {\n  },\n  ...more_commands({}),\n}\n";
  assert.deepEqual(objectKeys(board, /^const commands = \{/mu, 2), ["new", "status"]);
  const more = "export function more_commands({ opt }) {\n  return {\n    'queue-spec'() {\n    },\n\n    left() {\n    },\n  }\n}\n";
  assert.deepEqual(objectKeys(more, /^export function more_commands\(/mu, 4), ["queue-spec", "left"]);
});

test("every board.mjs subcommand is mapped to a tool or excluded with a reason", (t) => {
  const root = realBoardRoot();
  if (root === null) {
    t.skip("no board.mjs: set BOARD_REPO_ROOT, or check out wec.aria at D:/1.SourceCode/crm/wec.aria");
    return;
  }
  const cli = cliCommands(root);
  assert.ok(cli.length >= 20, `parsed only ${cli.length} commands — the parser no longer matches board.mjs`);
  const known = [...Object.keys(MAPPED), ...Object.keys(EXCLUDED)].sort();
  const unmapped = cli.filter((c) => !known.includes(c));
  const gone = known.filter((c) => !cli.includes(c));
  assert.deepEqual(unmapped, [], `board.mjs has subcommand(s) this server neither maps nor excludes: ${unmapped.join(", ")} — add each to MAPPED (with a tool) or EXCLUDED (with a reason) in commandMap.ts`);
  assert.deepEqual(gone, [], `commandMap.ts names subcommand(s) board.mjs no longer has: ${gone.join(", ")}`);
});

test("exclusions carry a reason, and the excluded scripts are not subcommands", (t) => {
  for (const [name, why] of Object.entries({ ...EXCLUDED, ...EXCLUDED_SCRIPTS })) assert.ok(why.trim().length > 20, `${name} has no real reason`);
  assert.ok("prune-shots" in EXCLUDED);
  const root = realBoardRoot();
  if (root === null) {
    t.skip("no board.mjs to compare the scripts against");
    return;
  }
  const cli = cliCommands(root);
  for (const script of Object.keys(EXCLUDED_SCRIPTS)) {
    assert.ok(existsSync(path.join(root, "checks", "board", script)), `${script} is listed as excluded but is not on disk`);
    assert.ok(!cli.includes(script.replace(/\.mjs$/u, "")), `${script} is now a subcommand — map it`);
  }
});
