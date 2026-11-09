import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { callLabel, startLoopWatchdog } from "./loopWatchdog.js";

test("callLabel names the tool and the repo it targets", () => {
  assert.equal(callLabel("search_regex", { repoId: "wec.aria", pattern: "x" }), "search_regex repoId=wec.aria");
  assert.equal(callLabel("index_status", { runId: "r1" }), "index_status");
});

test("a threshold of 0 is a no-op watchdog", async () => {
  const dog = startLoopWatchdog({ thresholdMs: 0 });
  dog.begin("x")();
  await dog.stop();
});

/**
 * The real thing, in a child process so its stderr can be read: block the thread for 1.5 s with two calls in
 * flight and expect one stall line naming both (longest-running first), then one line when the thread is back.
 */
test("a blocked thread is reported once, naming the calls in flight, and its end is reported", () => {
  const script = `
    import { startLoopWatchdog } from ${JSON.stringify(new URL("./loopWatchdog.ts", import.meta.url).href)};
    const dog = startLoopWatchdog({ thresholdMs: 400, pollMs: 50 });
    const endA = dog.begin("search_regex repoId=big");
    await new Promise((r) => setTimeout(r, 100));
    const endB = dog.begin("index_status");
    const ended = dog.begin("done_call"); ended();
    await new Promise((r) => setTimeout(r, 300));
    const until = Date.now() + 1500;
    while (Date.now() < until) {}            // the stall
    await new Promise((r) => setTimeout(r, 400));
    endA(); endB();
    await dog.stop();
  `;
  const run = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stderr.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { msg: string; fields: Record<string, unknown> });
  const stalls = lines.filter((l) => l.msg === "event_loop_stall");
  const ends = lines.filter((l) => l.msg === "event_loop_stall_ended");
  assert.equal(stalls.length, 1, run.stderr);
  assert.equal(ends.length, 1, run.stderr);
  const inFlight = stalls[0]!.fields["inFlight"] as { call: string; runningMs: number }[];
  assert.deepEqual(inFlight.map((c) => c.call), ["search_regex repoId=big", "index_status"]);
  assert.ok((stalls[0]!.fields["lagMs"] as number) >= 400);
  assert.ok((ends[0]!.fields["stalledMs"] as number) >= 1000, JSON.stringify(ends[0]));
});
