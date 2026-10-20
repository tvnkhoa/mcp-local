/**
 * The only place board-mcp starts a process.
 *
 * `execFile(process.execPath, [board.mjs, ...args])` — an args ARRAY and no shell, so owner words
 * carrying backticks, `$`, `||`, quotes or Vietnamese text reach board.mjs byte-for-byte. The cwd
 * is `BOARD_REPO_ROOT`; the child inherits this process's environment (board.mjs reads the
 * owner's transcripts under the home directory, and git from PATH).
 *
 * Nothing here knows a board rule. It runs the CLI and classifies the exit.
 */

import { execFile } from "node:child_process";

import { err, ok, timeoutError, upstreamError, type PlatformError, type Result } from "@mcp/core";

import { boardCliPath, type BoardConfig } from "../config/index.js";
import type { BoardResult, BoardRun, BoardRunner } from "../types/index.js";

/** stdout/stderr cap per run. `status` over ~40 units prints well under 1 MiB. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The prefix board.mjs puts on every refusal (`console.error(\`board: ${e.message}\`)`). */
export const REFUSAL_PREFIX = "board: ";

export function createBoardRunner(config: BoardConfig): BoardRunner {
  const cli = boardCliPath(config);
  return (args) =>
    new Promise<BoardRun>((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        {
          cwd: config.repoRoot,
          timeout: config.callTimeoutMs,
          killSignal: "SIGKILL",
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
          const timedOut = e.killed === true && e.signal !== null && e.signal !== undefined;
          if (typeof e.code === "number") {
            resolve({ exitCode: e.code, stdout, stderr, timedOut });
            return;
          }
          // Spawn failure (ENOENT on the cwd, maxBuffer exceeded…): no exit code to classify.
          resolve({ exitCode: null, stdout, stderr: stderr || `${e.code ?? "spawn_error"}: ${e.message}`, timedOut });
        }
      );
    });
}

/** Last `max` characters, for an error detail that must stay bounded. */
const tail = (s: string, max = 2000): string => (s.length > max ? `…${s.slice(-max)}` : s);

const trimEnd = (s: string): string => s.replace(/\s+$/u, "");

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
 *   non-zero, stderr starts `board: `       → { ok: false, refused: true, why }
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
  const stderr = run.stderr.replace(/^﻿/u, "").trimStart();
  if (run.exitCode !== null && stderr.startsWith(REFUSAL_PREFIX)) {
    return ok({
      ok: false,
      refused: true,
      why: trimEnd(stderr.slice(REFUSAL_PREFIX.length)),
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
