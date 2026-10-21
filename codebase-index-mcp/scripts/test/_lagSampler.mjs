/**
 * Event-loop lag sampler for the server's MAIN thread, preloaded into a spawned server with
 * `node --import <file URL of this module> dist/index.js` (release I1b, test:freshness-worker).
 *
 * Test-only and outside `src/`: the server carries no lag hook. A 20 ms interval timer measures how
 * late each tick fires; a tick later than LAG_SAMPLER_REPORT_MS (default 100) is a block and is written
 * to stderr as `[lag-sampler] {"at":<epoch ms>,"blockedMs":<n>}`, which the harness parses. Worker
 * threads inherit `--import`, so the sampler checks `isMainThread` — a busy worker is the point, only
 * the server thread must stay responsive.
 */
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const INTERVAL_MS = 20;
  const REPORT_MS = Number(process.env.LAG_SAMPLER_REPORT_MS ?? 100);
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const blockedMs = now - last - INTERVAL_MS;
    last = now;
    if (blockedMs > REPORT_MS) process.stderr.write(`[lag-sampler] ${JSON.stringify({ at: Date.now(), blockedMs: Math.round(blockedMs) })}\n`);
  }, INTERVAL_MS);
  timer.unref();
}
