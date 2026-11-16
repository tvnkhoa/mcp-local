/**
 * childTree.mjs (row P1): a runner's children die with it — on process.exit, on a hard kill (through the
 * watchdog), when the shell above it is killed (the orphan stop), and the watchdog leaves nothing behind
 * after a normal exit. Each case starts a real runner
 * process with a child that has a grandchild, so "the tree" is tested, not one pid.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { isAlive, treeKillCommand, WATCH_POLL_MS } from "./childTree.mjs";

const LIB = pathToFileURL(path.join(import.meta.dirname, "childTree.mjs")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Start a runner: it tracks one child, which starts one grandchild; both idle forever. `then` is the code the
 * runner runs once both are up ("exit": process.exit(3) while the child runs; "wait": nothing, it waits;
 * "finish": it kills nothing and returns normally after the child is stopped from outside).
 * Resolves `{ runner, child, grandchild, watcher, pidFile }` (pids).
 */
async function startRunner(dir, then, lockFile = null, { viaShell = false } = {}) {
  const pids = path.join(dir, "pids.json");
  const grandFile = path.join(dir, "grand.txt");
  const childCode = `const {spawn}=require("node:child_process");const fs=require("node:fs");const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(grandFile)},String(g.pid));setInterval(()=>{},1000);`;
  const runnerCode = `
import fs from "node:fs";
import { createChildTracker } from ${JSON.stringify(LIB)};
const t = createChildTracker({ name: "test", stopWhenOrphaned: ${String(viaShell)} });
${lockFile === null ? "" : `t.setLock({ acquired: true, path: ${JSON.stringify(lockFile)}, token: "tok-1" });`}
const running = t.run(process.execPath, ["-e", ${JSON.stringify(childCode)}], { capture: true });
while (!fs.existsSync(${JSON.stringify(grandFile)}) || fs.readFileSync(${JSON.stringify(grandFile)}, "utf8") === "") await new Promise((r) => setTimeout(r, 50));
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ runner: process.pid, child: t.livePids()[0], grandchild: Number(fs.readFileSync(${JSON.stringify(grandFile)}, "utf8")), watcher: t.watcherPid, pidFile: t.pidFile }));
${then === "exit" ? "process.exit(3);" : then === "finish" ? "await running;" : "setInterval(() => {}, 1000);"}
`;
  const script = path.join(dir, "runner.mjs");
  fs.writeFileSync(script, runnerCode);
  // viaShell: a non-node shell between this test and the runner (no libuv job object), as a tool call's shell is.
  const proc = !viaShell
    ? spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true })
    : process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", process.execPath, script], { stdio: "ignore", windowsHide: true })
      : spawn("sh", ["-c", `"${process.execPath}" "${script}"; true`], { stdio: "ignore" });
  assert.ok(await waitFor(() => fs.existsSync(pids)), "the runner started its child and grandchild");
  return { proc, ...JSON.parse(fs.readFileSync(pids, "utf8")) };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "childtree-"));
}

const exited = (proc) => new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", r)));

test("treeKillCommand is taskkill /T /F with an argv array on Windows", () => {
  assert.deepEqual(treeKillCommand(1234, "win32"), ["taskkill", ["/PID", "1234", "/T", "/F"]]);
  assert.equal(treeKillCommand(1234, "linux"), null);
});

test("process.exit in the runner kills the child tree; the watchdog then exits", async () => {
  const dir = tmp();
  const r = await startRunner(dir, "exit");
  await exited(r.proc);
  assert.ok(await waitFor(() => !isAlive(r.child) && !isAlive(r.grandchild)), "child and grandchild are gone");
  assert.ok(await waitFor(() => !isAlive(r.watcher)), "the watchdog exited");
  assert.equal(fs.existsSync(r.pidFile), false, "the pid file is removed");
});

test("a hard kill of the runner: the watchdog kills the registered tree and clears the lock file", async () => {
  const dir = tmp();
  const lockFile = path.join(dir, "heavy.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ token: "tok-1", pid: 1 }));
  const r = await startRunner(dir, "wait", lockFile);
  assert.ok(isAlive(r.child) && isAlive(r.grandchild));
  process.kill(r.runner, "SIGKILL"); // TerminateProcess on Windows: no handler in the runner runs
  await exited(r.proc);
  assert.ok(await waitFor(() => !isAlive(r.child) && !isAlive(r.grandchild)), "child and grandchild are gone");
  assert.ok(await waitFor(() => !isAlive(r.watcher)), "the watchdog exited");
  assert.equal(fs.existsSync(lockFile), false, "the holder file naming the runner's token is removed");
});

test("the watchdog leaves another token's lock file alone", async () => {
  const dir = tmp();
  const lockFile = path.join(dir, "heavy.lock");
  const r = await startRunner(dir, "wait", lockFile);
  fs.writeFileSync(lockFile, JSON.stringify({ token: "someone-else", pid: 1 }));
  process.kill(r.runner, "SIGKILL");
  await exited(r.proc);
  assert.ok(await waitFor(() => !isAlive(r.watcher)), "the watchdog exited");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "someone-else");
});

test("a normal exit: the watchdog exits on its own and kills nothing it was not given", async () => {
  const dir = tmp();
  const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const r = await startRunner(dir, "finish");
  process.kill(r.child, "SIGKILL"); // the child ends; the runner then returns normally
  await exited(r.proc);
  assert.equal(r.proc.exitCode, 0);
  assert.ok(await waitFor(() => !isAlive(r.watcher), 2_000 + 4 * WATCH_POLL_MS), "the watchdog exited on its own");
  assert.equal(fs.existsSync(r.pidFile), false, "the pid file is removed");
  assert.ok(isAlive(bystander.pid), "a process the runner never registered is untouched");
  bystander.kill("SIGKILL");
  if (isAlive(r.grandchild)) process.kill(r.grandchild, "SIGKILL");
});

test("the shell above the runner is killed: the runner kills its tree and exits (orphan stop)", async () => {
  const r = await startRunner(tmp(), "wait", null, { viaShell: true });
  // The lineage read is a process-table read (PowerShell on Windows): give it time before the kill.
  await sleep(6_000);
  process.kill(r.proc.pid, "SIGKILL"); // the shell only: on Windows TerminateProcess, no /T
  assert.ok(await waitFor(() => !isAlive(r.runner), 15_000), "the runner noticed and exited");
  assert.ok(await waitFor(() => !isAlive(r.child) && !isAlive(r.grandchild)), "child and grandchild are gone");
  assert.ok(await waitFor(() => !isAlive(r.watcher)), "the watchdog exited");
});
