#!/usr/bin/env node
/**
 * Run one command inside the machine-wide heavy-check lock (`scripts/lib/heavyLock.mjs`).
 *
 * The root `verify:*` scripts wrap their step chains with this, so `npm run verify:all` waits for
 * another session's gate instead of racing it. Exit code is the command's; 75 when the lock times out.
 *
 * Usage:
 *   node scripts/heavy-lock.mjs [--no-lock] -- <command> [args...]
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

import { holdHeavyLockOrExit } from "./lib/heavyLock.mjs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? [] : argv.slice(0, sep);
const command = sep === -1 ? argv : argv.slice(sep + 1);

if (command.length === 0) {
  console.error("usage: node scripts/heavy-lock.mjs [--no-lock] -- <command> [args...]");
  process.exit(2);
}

const lock = await holdHeavyLockOrExit({ cmd: command.join(" "), noLock: own.includes("--no-lock") });
// `npm` is `npm.cmd` on Windows, which needs a shell; a shell joins arguments with bare spaces, so
// quote the ones that contain any.
const args = process.platform === "win32" ? command.slice(1).map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : command.slice(1);
const result = spawnSync(command[0], args, { stdio: "inherit", shell: process.platform === "win32" });
if (lock.acquired) lock.release();

if (result.error !== undefined) {
  console.error(`could not start ${command[0]}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
