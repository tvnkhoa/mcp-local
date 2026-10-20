/**
 * The only place board-mcp starts a process.
 *
 * `execFile(process.execPath, [board.mjs, ...args])` — an args ARRAY and no shell, so owner words
 * carrying backticks, `$`, `||`, quotes or Vietnamese text reach board.mjs byte-for-byte. The cwd
 * is `BOARD_REPO_ROOT`; the child inherits this process's environment (board.mjs reads the
 * owner's transcripts under the home directory, and git from PATH).
 *
 * Nothing here knows a board rule. It runs the CLI and classifies the exit.
 *
 * Timeout: past BOARD_CALL_TIMEOUT_MS (default 120 s — board.mjs's README measures `status` /
 * `check` at 56–120 s on a cold history cache) the child gets SIGTERM. A write killed inside
 * board.mjs's `with_lock` leaves its mutex directory behind; board.mjs breaks a lock older than
 * 30 s, so the next write may wait up to that long.
 */

import { execFile } from "node:child_process";

import { err, ok, timeoutError, upstreamError, type PlatformError, type Result } from "@mcp/core";

import { boardCliPath, type BoardConfig } from "../config/index.js";
import type { BoardResult, BoardRun, BoardRunner } from "../types/index.js";

/** stdout/stderr cap per run. `status` over ~40 units prints well under 1 MiB. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The prefix board.mjs puts on every refusal (`console.error(\`board: ${e.message}\`)`). */
export const REFUSAL_PREFIX = "board: ";

export interface RunnerOptions {
  /**
   * The child's environment. Omitted (the server always omits it): the child inherits this
   * process's. A test passes one to point board.mjs's home directory — and so its transcripts — at
   * a scratch folder.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export function createBoardRunner(config: BoardConfig, options: RunnerOptions = {}): BoardRunner {
  const cli = boardCliPath(config);
  return (args) =>
    new Promise<BoardRun>((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        {
          cwd: config.repoRoot,
          ...(options.env === undefined ? {} : { env: options.env }),
          timeout: config.callTimeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8",
          shell: false
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }
          const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null };
          // Node also kills the child when output passes maxBuffer — that is not a timeout.
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve({ exitCode: null, stdout: "", stderr: `board.mjs printed more than ${MAX_OUTPUT_BYTES} bytes; the run was stopped.`, timedOut: false });
            return;
          }
          const timedOut = e.killed === true && e.signal !== null && e.signal !== undefined;
          if (typeof e.code === "number") {
            resolve({ exitCode: e.code, stdout, stderr, timedOut });
            return;
          }
          // Spawn failure (ENOENT on the cwd…): no exit code to classify.
          resolve({ exitCode: null, stdout, stderr: stderr || `${e.code ?? "spawn_error"}: ${e.message}`, timedOut });
        }
      );
    });
}

/** Last `max` characters, for an error detail that must stay bounded. */
const tail = (s: string, max = 2000): string => (s.length > max ? `…${s.slice(-max)}` : s);

const trimEnd = (s: string): string => s.replace(/\s+$/u, "");

/** The text of the LAST stderr line starting `board: `, without the prefix, or null. */
export function refusalLine(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/u).filter((l) => l.startsWith(REFUSAL_PREFIX));
  const last = lines.at(-1);
  return last === undefined ? null : trimEnd(last.slice(REFUSAL_PREFIX.length));
}

/** stdout parsed as JSON, or undefined. Only an object or array counts — a bare number is text. */
export function parseJsonOutput(stdout: string): unknown {
  const t = stdout.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

export interface InterpretOptions {
  readonly command: string;
  /** Exit 1 with no `board: ` line is a findings report, not a failure (`check`, `gate`). */
  readonly findingsExit?: boolean;
  /** Try to parse stdout as JSON (the read commands that are passed `--json`). */
  readonly parseJson?: boolean;
}

/**
 * Classify one run:
 *   exit 0                                  → { ok: true, text, json? }
 *   exit 1, a stderr line starting `board: ` → { ok: false, refused: true, why: the last such line }
 *   exit 1, no stderr, findings command     → { ok: false, text } (the findings)
 *   killed by the timeout                   → `timeout` error
 *   anything else                           → `upstream_error`
 */
export function interpretRun(run: BoardRun, options: InterpretOptions): Result<BoardResult, PlatformError> {
  const text = trimEnd(run.stdout);
  if (run.timedOut) {
    return err(timeoutError(`board.mjs ${options.command} did not finish within BOARD_CALL_TIMEOUT_MS and was killed.`, { stdout: tail(text), stderr: tail(run.stderr) }));
  }
  if (run.exitCode === 0) {
    const json = options.parseJson === true ? parseJsonOutput(run.stdout) : undefined;
    return ok(json === undefined ? { ok: true, text } : { ok: true, json, text });
  }
  const stderr = run.stderr.replace(/^﻿/u, "");
  // board.mjs refuses with `console.error(\`board: ${msg}\`)` then exit(1). Git or Node may print
  // warnings first, so the LAST line starting `board: ` is the refusal — and only on exit 1.
  const refusal = run.exitCode === 1 ? refusalLine(stderr) : null;
  if (refusal !== null) {
    return ok({
      ok: false,
      refused: true,
      why: refusal,
      text,
      hint: "The board refused — its own rule, not the wrapper's. Read `why`; fix what it names and call again."
    });
  }
  if (options.findingsExit === true && run.exitCode === 1 && stderr.trim() === "") {
    return ok({ ok: false, text, hint: `board.mjs ${options.command} exited 1: the findings are in \`text\`.` });
  }
  return err(
    upstreamError(`board.mjs ${options.command} failed (exit ${run.exitCode ?? "none"}) without a board refusal.`, {
      stderr: tail(stderr),
      stdout: tail(text)
    })
  );
}
