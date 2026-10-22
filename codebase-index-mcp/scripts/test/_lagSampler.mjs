/**
 * Event-loop lag sampler for the server's MAIN thread, preloaded into a spawned server with
 * `node --import <file URL of this module> dist/index.js` (release I1b, test:freshness-worker).
 *
 * Test-only and outside `src/`: the server carries no lag hook. A 20 ms interval timer measures how
 * late each tick fires; a tick later than LAG_SAMPLER_REPORT_MS (default 100) is a block and is written
 * to stderr as `[lag-sampler] {"at":<epoch ms>,"blockedMs":<n>}`, which the harness parses. Every
 * LAG_SAMPLER_HEARTBEAT_MS (default 500) it also writes `[lag-sampler] {"at":…,"heartbeat":true,"maxMs":<n>}`
 * — the worst lag since the last heartbeat — so a harness can tell "no block" from "no sampler", and
 * must assert heartbeats inside its window (release J: a live script reported 0 blocks from a list its
 * parser never filled). Worker
 * threads inherit `--import`, so the sampler checks `isMainThread` — a busy worker is the point, only
 * the server thread must stay responsive.
 */
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const INTERVAL_MS = 20;
  const REPORT_MS = Number(process.env.LAG_SAMPLER_REPORT_MS ?? 100);
  const HEARTBEAT_MS = Number(process.env.LAG_SAMPLER_HEARTBEAT_MS ?? 500);
  let last = performance.now();
  let lastBeat = last;
  let maxSinceBeat = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const blockedMs = now - last - INTERVAL_MS;
    last = now;
    maxSinceBeat = Math.max(maxSinceBeat, blockedMs);
    if (blockedMs > REPORT_MS) process.stderr.write(`[lag-sampler] ${JSON.stringify({ at: Date.now(), blockedMs: Math.round(blockedMs) })}\n`);
    if (now - lastBeat >= HEARTBEAT_MS) {
      process.stderr.write(`[lag-sampler] ${JSON.stringify({ at: Date.now(), heartbeat: true, maxMs: Math.round(Math.max(0, maxSinceBeat)) })}\n`);
      lastBeat = now;
      maxSinceBeat = 0;
    }
  }, INTERVAL_MS);
  timer.unref();
}
