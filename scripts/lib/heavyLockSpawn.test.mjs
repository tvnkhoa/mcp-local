import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { escapeCmdArgument, planCommand, resolveWindowsCommand } from "./heavyLockSpawn.mjs";

/**
 * heavy-lock.mjs passes every argument to the wrapped command literally (row H-7). Each case runs the
 * real CLI with --no-lock, from a scratch cwd (a redirect would leave a file there), against a program
 * that prints its own argv as JSON.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "heavy-lock.mjs");
const WIN = process.platform === "win32";
const winOnly = WIN ? false : "cmd.exe quoting is Windows-only";

const scratchDirs = [];
function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // left behind
    }
  }
});

/** Every cmd metacharacter alone and in company, quotes, backslashes before quotes, spaces, variables, an empty argument. */
const NASTY = [">", "<", "&", "|", "(", ")", "^", "%", "!", '"', "a b", "%PATH%", "!PATH!", "%%", 'x"y', "trail\\", 'back\\"q', "a&&b", "x|y>z", "()=>{}", "^^", "", "*", "?", ";", ",", "=", "`", "[a]", "tab\there", "ü€"];

/** A scratch dir whose name itself needs quoting, holding echo.js and the batch shim echo-args.cmd. */
function fixtures() {
  const dir = path.join(scratchDir("heavy-lock-quote-"), "dir with spaces & (parens) 100%");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "echo.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(dir, "echo-args.cmd"), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  return dir;
}

function cli(args, { cwd, env = {} }) {
  const full = { ...process.env, MCP_HEAVY_LOCK_SAMPLE: "off", ...env };
  delete full.CI;
  return spawnSync(process.execPath, [CLI, "--no-lock", "--", ...args], { cwd, env: full, encoding: "utf8" });
}

function assertNothingLeft(cwd) {
  assert.deepEqual(fs.readdirSync(cwd), [], "nothing was written to the cwd (no redirect happened)");
}

test("an .exe target (node, whose path has spaces on most machines) gets every argument literally, with no shell", () => {
  const dir = fixtures();
  const cwd = scratchDir("heavy-lock-quote-cwd-");
  const r = cli([process.execPath, path.join(dir, "echo.js"), ...NASTY], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), NASTY);
  assertNothingLeft(cwd);
  if (WIN) assert.equal(planCommand([process.execPath]).via, "direct");
});

test("command[0] is a batch file by full path in a dir named with spaces, & ( ) and %: every argument arrives literally", { skip: winOnly }, () => {
  const dir = fixtures();
  const cwd = scratchDir("heavy-lock-quote-cwd-");
  const r = cli([path.join(dir, "echo-args.cmd"), ...NASTY], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), NASTY);
  assertNothingLeft(cwd);
});

test("a batch file found by name on PATH (as npm is) gets every argument literally through cmd.exe", { skip: winOnly }, () => {
  const dir = fixtures();
  const cwd = scratchDir("heavy-lock-quote-cwd-");
  const env = { PATH: `${dir};${process.env.PATH ?? ""}` };
  assert.equal(planCommand(["echo-args"], { env: { ...process.env, ...env }, cwd }).via, "cmd");
  const r = cli(["echo-args", ...NASTY], { cwd, env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), NASTY);
  assertNothingLeft(cwd);
});

test("a real npm.cmd still runs through the wrapper (the verify:* scripts' shape)", { skip: winOnly }, () => {
  const cwd = scratchDir("heavy-lock-quote-cwd-");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "q", version: "1.0.0", scripts: { show: "node -e \"process.stdout.write(JSON.stringify(process.argv.slice(1)))\" --" } }));
  const r = cli(["npm", "run", "--silent", "show", "a&b", "100%"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  // npm hands the script's extra args to its own shell; what matters here is that npm got them intact.
  assert.match(r.stdout, /a&b/);
  assert.match(r.stdout, /100%/);
  assert.deepEqual(fs.readdirSync(cwd), ["package.json"]);
});

test("the exit code passes through either way; an unknown command fails like cmd says, not with a crash", { skip: winOnly }, () => {
  const cwd = scratchDir("heavy-lock-quote-cwd-");
  assert.equal(cli([process.execPath, "-e", "process.exit(9)"], { cwd }).status, 9);
  const missing = cli(["no-such-command-h7", "x"], { cwd });
  assert.notEqual(missing.status, 0);
  assert.equal(planCommand(["no-such-command-h7"]).via, "cmd", "an unresolved name may be a builtin: cmd decides");
});

test("resolveWindowsCommand: PATHEXT order, a name with an extension tried as is, never the extensionless sibling", () => {
  const dir = scratchDir("heavy-lock-resolve-");
  for (const f of ["tool", "tool.cmd", "tool.exe", "only.bat", "plain.txt"]) fs.writeFileSync(path.join(dir, f), "");
  const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: dir };
  const cwd = scratchDir("heavy-lock-resolve-cwd-");
  assert.equal(resolveWindowsCommand("tool", { env, cwd }), path.join(dir, "tool.exe"));
  assert.equal(resolveWindowsCommand("tool.cmd", { env, cwd }), path.join(dir, "tool.cmd"));
  assert.equal(resolveWindowsCommand("only", { env, cwd }), path.join(dir, "only.bat"));
  assert.equal(resolveWindowsCommand("plain", { env, cwd }), null);
  assert.equal(resolveWindowsCommand(path.join(dir, "tool"), { env, cwd }), path.join(dir, "tool.exe"), "a path: tried only there");
  fs.writeFileSync(path.join(cwd, "tool.cmd"), "");
  assert.equal(resolveWindowsCommand("tool", { env, cwd }), path.join(cwd, "tool.cmd"), "the cwd first, as cmd does");
});

test("escapeCmdArgument: quoted for the program's parser, every metacharacter caret-escaped, twice for a batch file", () => {
  assert.equal(escapeCmdArgument("a b"), '^"a^ b^"');
  assert.equal(escapeCmdArgument('x"y'), '^"x\\^"y^"');
  assert.equal(escapeCmdArgument("trail\\"), '^"trail\\\\^"');
  assert.equal(escapeCmdArgument("%"), '^"^%^"');
  assert.equal(escapeCmdArgument("&", { batch: true }), '^^^"^^^&^^^"');
});
