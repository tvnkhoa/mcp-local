/**
 * board-mcp's shared types: one CLI run, and what a tool answers with.
 */

/** One `node checks/board/board.mjs …` run, as the child process left it. */
export interface BoardRun {
  /** null when the child was killed (timeout) before it exited. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs board.mjs with an args ARRAY (never a shell). Injected so tests can stub it. */
export type BoardRunner = (args: readonly string[]) => Promise<BoardRun>;

/**
 * What every board tool returns.
 *
 * - `ok: true` — exit 0. `text` is the CLI's stdout; `json` is that stdout parsed, when it parses
 *   (the read commands are passed `--json` and the CLI does not honour it yet — see README).
 * - `refused: true` — the CLI refused: non-zero exit, stderr beginning `board: `. `why` is the
 *   CLI's own sentence. A refusal is the board's rule, never the wrapper's.
 * - `ok: false` without `refused` — `check` / `gate` reporting findings (exit 1, no `board: `).
 *
 * Any other non-zero exit is an MCP error (`upstream_error`), not this shape.
 */
export interface BoardResult {
  readonly ok: boolean;
  readonly json?: unknown;
  readonly text: string;
  readonly refused?: boolean;
  readonly why?: string;
  readonly hint?: string;
  /** `status(unit)` only: the RAW unit file, never interpreted. */
  readonly unitFile?: unknown;
}
