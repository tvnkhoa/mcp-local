/**
 * MCP-ISSUE-135 — the server thread's side of the `query_graph` runner (`queryGraphRunner.ts`).
 *
 * `query_graph` used to run its statement on the server thread; a pathological SELECT blocked every session for as long
 * as SQLite computed (300 s+ on 16 Nov), and `timeoutMs` was only compared afterwards. The statement now runs in a
 * forked child process with its own read-only connection, and this client enforces `timeoutMs` by KILLING that child:
 * better-sqlite3 has no interrupt, and a worker thread cannot be stopped mid-statement (`Worker.terminate()` waits for
 * the native call to return), so a process is the smallest unit the server can stop.
 *
 * - **Budget.** The timer starts when the request is posted to a ready child (start-up does not count; it has its own
 *   bound, {@link READY_TIMEOUT_MS}). When it fires the child is killed and the call resolves `timeout` at once.
 * - **Warm child.** One idle child is kept for the next call; a kill starts its replacement at once. The first call
 *   after start-up or an idle exit pays a cold start. More concurrent calls spawn more children, at most {@link MAX_IN_FLIGHT}; beyond that a
 *   call resolves `busy` at once instead of queueing behind statements that may run to their budget.
 * - **Failure.** A child that exits or errors mid-query fails that call (`crashed`); nothing is retried.
 * - **Lifetime.** The idle child exits after {@link IDLE_EXIT_MS}; `dispose()` kills every child. A child whose IPC
 *   channel closes (the server died) exits on its own.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { QueryGraphMessage, QueryGraphRequest, QueryGraphResult } from "./queryGraphRunner.js";

export const MAX_IN_FLIGHT = 3;
export const IDLE_EXIT_MS = 10 * 60_000;
export const READY_TIMEOUT_MS = 30_000;

export type QueryGraphOutcome =
  | { kind: "result"; result: QueryGraphResult }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "busy"; inFlight: number }
  | { kind: "scope"; message: string }
  | { kind: "error"; message: string }
  | { kind: "crashed"; message: string };

/** The part of `ChildProcess` the client uses — a seam for unit tests. */
export interface RunnerChildLike {
  readonly pid?: number | undefined;
  send(message: QueryGraphRequest): boolean;
  on(event: "message", listener: (message: QueryGraphMessage) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnRunner = () => RunnerChildLike;

/** The production spawner: `queryGraphRunner.js` beside this file (also in `dist/bundle/`, see scripts/bundle.mjs). */
export const spawnQueryGraphRunner: SpawnRunner = () =>
  fork(fileURLToPath(new URL("./queryGraphRunner.js", import.meta.url)), [], {
    // No inherited --import/--inspect: the child is a plain statement runner.
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    // Structured clone keeps BLOB columns as bytes (JSON would turn a Buffer into {type,data}).
    serialization: "advanced"
  }) as unknown as RunnerChildLike;

type Slot = {
  child: RunnerChildLike;
  ready: Promise<boolean>;
  /** The call the child is running, if any. */
  current: ((m: QueryGraphMessage | { kind: "gone"; message: string }) => void) | null;
  gone: boolean;
};

export class QueryGraphRunnerClient {
  private idle: Slot | null = null;
  private readonly live = new Set<Slot>();
  private inFlight = 0;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly dbPath: string,
    private readonly opts: { spawn?: SpawnRunner; maxInFlight?: number; idleExitMs?: number; readyTimeoutMs?: number } = {}
  ) {}

  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Pids of the children alive now (busy or idle) — for tests and evidence. */
  get childPids(): number[] {
    return [...this.live].map((s) => s.child.pid).filter((p): p is number => typeof p === "number");
  }

  async run(
    sql: string,
    params: Record<string, string | number | boolean | null>,
    limit: number,
    timeoutMs: number
  ): Promise<QueryGraphOutcome> {
    if (this.disposed) return { kind: "crashed", message: "the query runner is shut down" };
    const max = this.opts.maxInFlight ?? MAX_IN_FLIGHT;
    if (this.inFlight >= max) return { kind: "busy", inFlight: this.inFlight };
    this.inFlight++;
    this.clearIdle();
    const slot = this.idle ?? this.spawnSlot();
    this.idle = null;
    try {
      const ready = await slot.ready;
      if (!ready || slot.gone) {
        this.kill(slot);
        return { kind: "crashed", message: "the query runner process did not start" };
      }
      const outcome = await this.post(slot, { kind: "run", id: this.nextId++, dbPath: this.dbPath, sql, params, limit }, timeoutMs);
      if (outcome.kind === "result" || outcome.kind === "scope" || outcome.kind === "error") this.release(slot);
      return outcome;
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.armIdle();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdle();
    this.idle = null;
    for (const s of [...this.live]) this.kill(s);
  }

  private post(slot: Slot, req: QueryGraphRequest, timeoutMs: number): Promise<QueryGraphOutcome> {
    return new Promise<QueryGraphOutcome>((resolve) => {
      const t0 = performance.now();
      const timer = setTimeout(() => {
        slot.current = null;
        // The statement cannot be interrupted; the process can.
        this.kill(slot);
        // Start the replacement now, so the next call does not pay the cold start a kill caused.
        this.prewarm();
        resolve({ kind: "timeout", elapsedMs: Math.round(performance.now() - t0) });
      }, timeoutMs);
      slot.current = (m) => {
        clearTimeout(timer);
        slot.current = null;
        if (m.kind === "result") resolve({ kind: "result", result: reviveBytes(m.result) });
        else if (m.kind === "error") resolve(m.scope ? { kind: "scope", message: m.message } : { kind: "error", message: m.message });
        else if (m.kind === "gone") resolve({ kind: "crashed", message: m.message });
      };
      try {
        slot.child.send(req);
      } catch (e) {
        slot.current?.({ kind: "gone", message: `the query runner could not take the query: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  private spawnSlot(): Slot {
    const child = (this.opts.spawn ?? spawnQueryGraphRunner)();
    let markReady: (ok: boolean) => void = () => {};
    const slot: Slot = { child, ready: new Promise<boolean>((r) => (markReady = r)), current: null, gone: false };
    const readyTimer = setTimeout(() => markReady(false), this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const onGone = (why: string) => {
      if (slot.gone) return;
      slot.gone = true;
      clearTimeout(readyTimer);
      markReady(false);
      this.live.delete(slot);
      if (this.idle === slot) this.idle = null;
      slot.current?.({ kind: "gone", message: why });
    };
    child.on("message", (m) => {
      if (m.kind === "ready") {
        clearTimeout(readyTimer);
        markReady(true);
        return;
      }
      slot.current?.(m);
    });
    child.on("exit", (code, signal) => onGone(`the query runner process exited mid-query (code ${code ?? "none"}, signal ${signal ?? "none"})`));
    child.on("error", (e) => onGone(`the query runner process failed: ${e.message}`));
    this.live.add(slot);
    return slot;
  }

  private prewarm(): void {
    if (!this.disposed && this.idle === null) this.idle = this.spawnSlot();
  }

  /** Keep one idle child warm; a second one is not worth its memory. */
  private release(slot: Slot): void {
    if (slot.gone) return;
    if (this.idle === null && !this.disposed) this.idle = slot;
    else this.kill(slot);
  }

  private kill(slot: Slot): void {
    slot.current = null;
    this.live.delete(slot);
    if (this.idle === slot) this.idle = null;
    if (!slot.gone) {
      slot.gone = true;
      try {
        slot.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.idle) return;
    const t = setTimeout(() => {
      this.idleTimer = null;
      if (this.idle && this.inFlight === 0) this.kill(this.idle);
    }, this.opts.idleExitMs ?? IDLE_EXIT_MS);
    t.unref();
    this.idleTimer = t;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** Structured clone hands BLOB columns back as Uint8Array; the server thread's path returned Buffer. */
function reviveBytes(result: QueryGraphResult): QueryGraphResult {
  for (const row of result.rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    }
  }
  return result;
}
