#!/usr/bin/env node
/**
 * Run one command inside the machine-wide heavy-check lock (`scripts/lib/heavyLock.mjs`).
 *
 * The root `verify:*` scripts wrap their step chains with this, so `npm run verify:all` waits for
 * another session's gate instead of racing it. Exit code is the command's; 75 when the lock times out; 76 when
 * the run stopped waiting because an ancestor that was alive when it began waiting died (its session is
 * gone — e.g. TaskStop killed the shell but not this child). Neither code means the check failed.
 *
 * Usage:
 *   node scripts/heavy-lock.mjs [--no-lock] -- <command> [args...]
 *   node scripts/heavy-lock.mjs status [--json]
 *
 * The lock is first come, first served (H-2): a caller takes a ticket on arrival and only the oldest
 * live ticket may take the lock, however often the others poll.
 *
 * `status` is read-only (it only removes registry entries of dead waiters and silent tickets): the
 * holder and every waiter in ticket order with its position, each with its pid, command, cwd, since when, whether it is alive, whether a recorded ancestor
 * is gone (`launcher gone (session alive)`) and whether its whole recorded chain up to the session is
 * gone (`ORPHAN`). For a holder flagged either way it keeps the first sighting in `<lock>.orphan.json`
 * (`orphanSince`) and, after
 * `MCP_HEAVY_LOCK_ORPHAN_MINUTES` (default 10), prints `taskkill /PID <pid> /T /F` — a command a leader
 * runs only on the owner's yes. It kills nothing and never frees a lock whose holder lives.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

import { formatHeavyLockStatus, heavyLockStatus, holdHeavyLockOrExit } from "./lib/heavyLock.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "status") {
  const status = await heavyLockStatus();
  console.log(argv.includes("--json") ? JSON.stringify(status, null, 2) : formatHeavyLockStatus(status));
  process.exit(0);
}
const sep = argv.indexOf("--");
const own = sep === -1 ? [] : argv.slice(0, sep);
const command = sep === -1 ? argv : argv.slice(sep + 1);

if (command.length === 0) {
  console.error("usage: node scripts/heavy-lock.mjs [--no-lock] -- <command> [args...]\n       node scripts/heavy-lock.mjs status [--json]");
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
