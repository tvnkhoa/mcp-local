import assert from "node:assert/strict";
import test from "node:test";

import type { BoardRunner } from "../types/index.js";
import { call, configFor, SESSION, stubRepo } from "./testSupport.test.js";

/** assign gains `reassign` + `why` (wec.aria 6e9f4564): the args, and the CLI's refusals passed through. */

const LEADER = SESSION;
const MEMBER = "bbbbbbbb-2222-4222-8222-222222222222";
const config = configFor(stubRepo());

const recording = (seen: string[][]): BoardRunner => async (args) => {
  seen.push([...args]);
  return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
};
const refusing = (why: string): BoardRunner => async () => ({ exitCode: 1, stdout: "", stderr: `board: ${why}\n`, timedOut: false });

test("assign reassign sends only unit, --reassign, --to, --why and --as", async () => {
  const seen: string[][] = [];
  const r = await call(config, "assign", { unit: "task--demo", to: MEMBER, reassign: true, why: "member gone", session: LEADER }, recording(seen));
  assert.equal(r.payload.ok, true, JSON.stringify(r.payload));
  assert.deepEqual(seen[0]?.slice(-5), ["task--demo", "--reassign", `--to=${MEMBER}`, "--why=member gone", `--as=${LEADER}`]);
  assert.ok(!seen[0]?.some((a) => /^--(goal|scope|ruled-out|done-when|worktree|gate-by)/u.test(a)));
});

test("assign reassign ignores brief fields passed with it", async () => {
  const seen: string[][] = [];
  await call(config, "assign", { unit: "task--demo", to: MEMBER, reassign: true, why: "w", goal: "g", scope: ["a"], session: LEADER }, recording(seen));
  assert.ok(!seen[0]?.some((a) => a.startsWith("--goal") || a.startsWith("--scope")));
});

test("plain assign still needs the full brief and does not send --reassign", async () => {
  const missing = await call(config, "assign", { unit: "task--demo", to: MEMBER, session: LEADER });
  assert.equal(missing.isError, true);
  const seen: string[][] = [];
  const brief = { unit: "task--demo", to: MEMBER, goal: "g", scope: ["a"], ruled_out: "none", done_when: "d", worktree: "shared", gate_by: "leader", session: LEADER };
  await call(config, "assign", brief, recording(seen));
  assert.ok(seen[0]?.includes("--goal=g"));
  assert.ok(!seen[0]?.includes("--reassign"));
});

test("reassign without why is refused before any process runs", async () => {
  const seen: string[][] = [];
  const r = await call(config, "assign", { unit: "task--demo", to: MEMBER, reassign: true, session: LEADER }, recording(seen));
  assert.equal(r.isError, true);
  assert.equal(seen.length, 0);
});

for (const why of [
  "task--demo has landed — reassign only at T1",
  "task--demo is at T0 Brief, never assigned — assign it, without --reassign",
  "task--demo is already assigned to bbbbbbbb-2222-4222-8222-222222222222",
  "cccccccc-3333-4333-8333-333333333333 holds task--demo's claim since 2026-10-27T01:00:00Z"
]) {
  test(`CLI refusal passes through verbatim: ${why.slice(0, 40)}`, async () => {
    const r = await call(config, "assign", { unit: "task--demo", to: MEMBER, reassign: true, why: "w", session: LEADER }, refusing(why));
    assert.equal(r.payload.refused, true);
    assert.ok(String(r.payload.why).includes(why), JSON.stringify(r.payload));
  });
}
