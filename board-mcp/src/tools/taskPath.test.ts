/**
 * The task-unit tools against the REAL board.mjs (task.mjs, wec.aria e66c0bdf) — in a throwaway git
 * repo, with BOARD_LIVE_DIR, HANDOVER_DIR and a home of its own, so no call writes a real claim,
 * lead record or coordinator lock, or reads a real transcript. The child inherits this process's
 * environment, which is how the overrides reach board.mjs; they are restored after.
 *
 * The four refusals the brief names — assign by a non-leader, claim of a unit assigned to another,
 * report by a non-assignee, self-accept — and one walk from lead to accepted. Skips when the board
 * under test has no task.mjs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { call, configFor, realBoardRoot } from "./testSupport.test.js";

const LEADER = "aaaaaaaa-1111-4111-8111-111111111111";
const MEMBER = "bbbbbbbb-2222-4222-8222-222222222222";
const OTHER = "cccccccc-3333-4333-8333-333333333333";

/** board.mjs's working day: the local date of now less 4 h. */
function workingDay(now = new Date()): string {
  const d = new Date(now.getTime() - 4 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("task tools on a scratch board: four refusals, then lead → assign → claim → report → accept", async (t) => {
  const source = realBoardRoot();
  if (source === null || !existsSync(path.join(source, "checks", "board", "task.mjs"))) {
    t.skip("no board.mjs with task.mjs: set BOARD_REPO_ROOT to a wec.aria checkout at e66c0bdf or later");
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "board-mcp-task-"));
  const root = path.join(tmp, "repo");
  const from = path.join(source, "checks", "board");
  mkdirSync(path.join(root, "checks", "board"), { recursive: true });
  for (const f of readdirSync(from)) if (f.endsWith(".mjs") || f === "board.json") cpSync(path.join(from, f), path.join(root, "checks", "board", f));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.txt"), "a\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=board-mcp@test.invalid", "-c", "user.name=board-mcp test", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-qm", "scratch board");

  const handover = path.join(tmp, "handover");
  mkdirSync(handover, { recursive: true });
  const lock = (id: string) => writeFileSync(path.join(handover, `.coordinator-${workingDay()}-repo`), `${id}\n`);
  const saved = { BOARD_LIVE_DIR: process.env.BOARD_LIVE_DIR, HANDOVER_DIR: process.env.HANDOVER_DIR, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { BOARD_LIVE_DIR: path.join(tmp, "live"), HANDOVER_DIR: handover, HOME: path.join(tmp, "home"), USERPROFILE: path.join(tmp, "home") });
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });
  assert.notEqual(path.resolve(root), path.resolve(source), "never the board under test itself");
  const config = configFor(root, { callTimeoutMs: 60_000 });
  const okCall = async (name: string, args: Record<string, unknown>) => {
    const r = await call(config, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.payload)}`);
    assert.equal(r.payload.ok, true, `${name}: ${JSON.stringify(r.payload)}`);
    return r.payload;
  };
  const refusal = async (name: string, args: Record<string, unknown>, why: RegExp) => {
    const r = await call(config, name, args);
    assert.equal(r.payload.refused, true, `${name} was not refused: ${JSON.stringify(r.payload)}`);
    assert.match(r.payload.why, why);
  };

  lock(LEADER);
  await okCall("lead", { session: LEADER });
  assert.ok(existsSync(path.join(tmp, "live", `leader-${workingDay()}.json`)), "the lead record is in BOARD_LIVE_DIR");
  await okCall("new_unit", { kind: "task", name: "demo", paths: ["src/a.txt"], session: LEADER });
  const brief = { unit: "task--demo", to: MEMBER, goal: "change a.txt", scope: ["src/a.txt"], ruled_out: "none", done_when: "a test", worktree: "shared", gate_by: "leader" };

  await refusal("assign", { ...brief, session: OTHER }, /assign is the leader's/u);
  await okCall("assign", { ...brief, session: LEADER });
  await refusal("claim", { unit: "task--demo", session: OTHER }, /only its assignee claims it/u);
  await okCall("claim", { unit: "task--demo", session: MEMBER });

  // assign reassign (wec.aria 6e9f4564): a T1 unit moves to another session; four refusals.
  const reassign = (unit: string, to: string) => ({ unit, to, reassign: true, why: "member gone", session: LEADER });
  await refusal("assign", reassign("task--demo", OTHER), /holds task--demo's claim since/u);
  await okCall("new_unit", { kind: "task", name: "idle", paths: ["src/a.txt"], session: LEADER });
  await refusal("assign", reassign("task--idle", OTHER), /never assigned — assign it, without --reassign/u);
  await okCall("new_unit", { kind: "task", name: "moved", paths: ["src/a.txt"], session: LEADER });
  await okCall("assign", { ...brief, unit: "task--moved", session: LEADER });
  await refusal("assign", reassign("task--moved", MEMBER), /is already assigned to/u);
  const moved = await okCall("assign", reassign("task--moved", OTHER));
  assert.match(moved.text, /task--moved reassigned by aaaaaaaa.* to cccccccc/u);

  // rescope: the leader's, task units only, add-only, between assign and report.
  await refusal("rescope", { unit: "task--demo", add: ["src/b.txt"], why: "needs b", session: OTHER }, /rescope is the leader's/u);
  await refusal("rescope", { unit: "task--idle", add: ["src/b.txt"], why: "needs b", session: LEADER }, /assign first/u);
  const horizontal = await okCall("new_unit", { kind: "horizontal", name: "wide", paths: ["src/a.txt"], weight: "standard", yes: [], session: LEADER });
  const horizontalId = /(horizontal--[a-z0-9-]+)/u.exec(String(horizontal.text))?.[1] ?? "horizontal--wide";
  await refusal("rescope", { unit: horizontalId, add: ["src/b.txt"], why: "needs b", session: LEADER }, /rescope widens task units only/u);
  const rescoped = await okCall("rescope", { unit: "task--demo", add: ["src/b.txt"], why: "a derived file", session: LEADER });
  assert.match(rescoped.text, /task--demo rescoped by aaaaaaaa.*src\/a\.txt, src\/b\.txt/u);
  const widened = (await okCall("status", { unit: "task--demo" })).unitFile as {
    assigned: { scope: string[] };
    touches: string[];
    events: { what: string; add?: string[] }[];
  };
  assert.deepEqual(widened.assigned.scope, ["src/a.txt", "src/b.txt"]);
  assert.ok(widened.touches.includes("src/b.txt"));
  assert.deepEqual(widened.events.find((e) => e.what === "rescope")?.add, ["src/b.txt"]);

  writeFileSync(path.join(root, "src", "a.txt"), "a2\n");
  git("commit", "-qam", "in scope");
  const sha = git("rev-parse", "--short", "HEAD");
  const evidence = path.join(tmp, "evidence.txt");
  writeFileSync(evidence, "scratch evidence\n");
  const report = { unit: "task--demo", state: "done", shas: [sha], evidence, left: "none" };
  await refusal("report", { ...report, session: OTHER }, /only the assignee reports/u);
  const reported = await okCall("report", { ...report, session: MEMBER });
  assert.match(reported.text, /T2 Verify[\s\S]*src\/a\.txt/u);
  await refusal("rescope", { unit: "task--demo", add: ["src/c.txt"], why: "too late", session: LEADER }, /rescope only at T1/u);
  await refusal("assign", reassign("task--demo", OTHER), /reassign only at T1/u);

  // Self-accept: the member is made leader and accepts its own work.
  lock(MEMBER);
  await refusal("lead", { session: MEMBER }, /--force replaces it/u); // --force is CLI-only: not mapped
  // The owner's CLI moves the lead record (lead --force is not mapped).
  const ownerLead = (id: string) => execFileSync(process.execPath, ["checks/board/board.mjs", "lead", `--as=${id}`, "--force"], { cwd: root, encoding: "utf8" });
  ownerLead(MEMBER);
  await refusal("accept", { unit: "task--demo", verdict: "accepted", why: "mine", session: MEMBER }, /no session accepts its own work/u);
  lock(LEADER);
  ownerLead(LEADER);

  const accepted = await okCall("accept", { unit: "task--demo", verdict: "accepted", why: "read the numstat", session: LEADER });
  assert.match(accepted.text, /accepted by aaaaaaaa.* LANDED/u);
  const today = await okCall("status", { today: true });
  assert.match(today.text, /task--demo · LANDED · bbbbbbbb.* accept accepted by aaaaaaaa/u);
  const mine = await okCall("status", { today: true, by: MEMBER });
  assert.match(mine.text, /task--demo · LANDED · bbbbbbbb.* by bbbbbbbb/u);
});
