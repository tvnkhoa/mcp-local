/**
 * MCP-ISSUE-121: a watchdog that names a stalled server thread.
 *
 * On 5 Nov the HTTP server stopped answering for 5+ minutes with the process alive and almost idle, and nothing in
 * its log said what the thread was doing — the telemetry line of a call is written when the call ends, so a call that
 * never ends leaves no trace. This module keeps a small shared-memory record of the calls in flight and a heartbeat
 * the server thread refreshes every {@link HEARTBEAT_MS}. A worker thread, which keeps running while the server thread
 * is blocked, reads both: when the heartbeat is older than the threshold it writes ONE line to stderr naming the
 * calls in flight, and one more when the thread is back.
 *
 * The worker writes with `fs.writeSync(2, …)`: a worker's `process.stderr` is forwarded through the server thread's
 * event loop, which is exactly the thing that is stuck.
 *
 * Shared layout (all little-endian, one SharedArrayBuffer):
 *   BigInt64[0]                heartbeat, epoch ms
 *   per slot i (SLOTS of them), at SLOT_BASE + i * SLOT_BYTES:
 *     BigInt64                 startedAt epoch ms, 0 = free (written last on begin, first on end)
 *     Int32                    sequence number of the call
 *     Int32                    label byte length
 *     LABEL_BYTES              UTF-8 label ("search_regex repoId=wec.aria")
 */

import { Worker } from "node:worker_threads";

const HEARTBEAT_MS = 250;
const SLOTS = 64;
const LABEL_BYTES = 112;
const SLOT_BYTES = 8 + 4 + 4 + LABEL_BYTES;
const SLOT_BASE = 8;
const BUFFER_BYTES = SLOT_BASE + SLOTS * SLOT_BYTES;

export interface LoopWatchdogOptions {
  /** Report when the server thread has not run for this long. */
  readonly thresholdMs: number;
  /** How often the worker looks (default: a quarter of the threshold, at most 1 s). */
  readonly pollMs?: number;
  /** Logger name in the emitted line. */
  readonly name?: string;
}

/** What the server thread holds: mark a call in flight, and stop. */
export interface LoopWatchdog {
  /** Record a call in flight; returns the function that ends it. Never throws. */
  begin(label: string): () => void;
  stop(): Promise<void>;
}

/** A call's label: the tool name plus the repo it names, when it names one — enough to find it in the log. */
export function callLabel(toolName: string, args: Record<string, unknown>): string {
  const repoId = typeof args["repoId"] === "string" ? ` repoId=${args["repoId"]}` : "";
  return `${toolName}${repoId}`;
}

/**
 * The worker's body, as source: an `eval` worker keeps this one file (no sibling `.js` that a build or a deploy copy
 * could leave behind). It reads the layout constants from workerData.
 */
const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { sab, thresholdMs, pollMs, name, slots, slotBase, slotBytes, labelBytes } = workerData;
const view = new DataView(sab);
const big = new BigInt64Array(sab, 0, 1);
const decoder = new TextDecoder();
let stalledSince = 0;
let worst = 0;
function inFlight(now) {
  const out = [];
  for (let i = 0; i < slots; i++) {
    const off = slotBase + i * slotBytes;
    const started = Number(view.getBigInt64(off, true));
    if (started === 0) continue;
    const seq = view.getInt32(off + 8, true);
    const len = Math.min(view.getInt32(off + 12, true), labelBytes);
    const label = decoder.decode(new Uint8Array(sab, off + 16, Math.max(0, len)).slice());
    out.push({ call: label, seq, runningMs: now - started });
  }
  return out.sort((a, b) => b.runningMs - a.runningMs);
}
function line(level, msg, fields) {
  try {
    fs.writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level, name, msg, fields }) + "\\n");
  } catch {}
}
setInterval(() => {
  const now = Date.now();
  const beat = Number(Atomics.load(big, 0));
  const lagMs = now - beat;
  if (lagMs >= thresholdMs) {
    worst = Math.max(worst, lagMs);
    if (stalledSince === 0) {
      stalledSince = beat;
      line("warn", "event_loop_stall", { lagMs, thresholdMs, inFlight: inFlight(now) });
    }
  } else if (stalledSince !== 0) {
    line("info", "event_loop_stall_ended", { stalledMs: Math.max(worst, beat - stalledSince), inFlight: inFlight(now) });
    stalledSince = 0;
    worst = 0;
  }
}, pollMs);
`;

/** Start the watchdog. A threshold of 0 (or less) returns a no-op watchdog. */
export function startLoopWatchdog(options: LoopWatchdogOptions): LoopWatchdog {
  if (!(options.thresholdMs > 0)) {
    return { begin: () => () => {}, stop: async () => {} };
  }
  const sab = new SharedArrayBuffer(BUFFER_BYTES);
  const view = new DataView(sab);
  const big = new BigInt64Array(sab, 0, 1);
  const encoder = new TextEncoder();
  const beat = (): void => {
    Atomics.store(big, 0, BigInt(Date.now()));
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref();

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      thresholdMs: options.thresholdMs,
      pollMs: options.pollMs ?? Math.max(50, Math.min(1000, Math.floor(options.thresholdMs / 4))),
      name: options.name ?? "codebase-index-mcp",
      slots: SLOTS,
      slotBase: SLOT_BASE,
      slotBytes: SLOT_BYTES,
      labelBytes: LABEL_BYTES
    },
    // Plain CommonJS: no loader or preload of the parent (tsx, --import probes) is needed, and inheriting one would
    // make the worker's start depend on it.
    execArgv: [],
    // The watchdog must never be what keeps a process alive, nor what takes it down.
    stdout: false,
    stderr: false
  });
  worker.unref();
  worker.on("error", () => {
    /* a dead watchdog only loses diagnostics */
  });

  let seq = 0;
  const begin = (label: string): (() => void) => {
    try {
      for (let i = 0; i < SLOTS; i++) {
        const off = SLOT_BASE + i * SLOT_BYTES;
        if (view.getBigInt64(off, true) !== 0n) continue;
        const bytes = encoder.encode(label).subarray(0, LABEL_BYTES);
        new Uint8Array(sab, off + 16, LABEL_BYTES).set(bytes);
        view.setInt32(off + 8, ++seq, true);
        view.setInt32(off + 12, bytes.length, true);
        view.setBigInt64(off, BigInt(Date.now()), true);
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          view.setBigInt64(off, 0n, true);
        };
      }
    } catch {
      // diagnostics only
    }
    return () => {}; // more than SLOTS calls in flight: the extra ones go unnamed
  };

  return {
    begin,
    stop: async () => {
      clearInterval(heartbeat);
      await worker.terminate();
    }
  };
}
