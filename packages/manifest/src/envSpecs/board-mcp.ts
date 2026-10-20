/**
 * `board-mcp`'s environment contract — 3 vars.
 *
 * The server is a thin wrapper over one CLI (`checks/board/board.mjs` in the repo named by
 * `BOARD_REPO_ROOT`), so it needs only where that repo is, whether the write subcommands may run,
 * and how long one CLI call may take.
 *
 * `BOARD_REPO_ROOT` is checked for absoluteness when a tool runs, not at start-up: the contract
 * snapshot boots every server with a non-path placeholder for it, and a server that refused to
 * start on that would fail `contracts:check` for a reason unrelated to its contract. `health_check`
 * reports a bad root as degraded.
 */

import type { EnvField } from "../types.js";

export const boardEnv: readonly EnvField[] = [
  // --- Target ------------------------------------------------------------------
  {
    name: "BOARD_REPO_ROOT",
    required: true,
    kind: "path",
    section: "Target",
    prompt: "Absolute path of the repository whose checks/board/board.mjs this server wraps",
    note: "Absolute path; the CLI runs with this as its cwd. e.g. D:/1.SourceCode/crm/wec.aria"
  },

  // --- Write gate --------------------------------------------------------------
  {
    name: "BOARD_WRITE_ENABLED",
    required: false,
    default: "false",
    section: "Write gate",
    note: "The board's write subcommands (new, claim, advance, acknowledge, …) are DISABLED unless exactly true or 1. The tools are still advertised; the gate is enforced when they are called."
  },

  // --- Limits ------------------------------------------------------------------
  {
    name: "BOARD_CALL_TIMEOUT_MS",
    required: false,
    codeDefault: "120000",
    kind: "number",
    section: "Limits",
    note: "Per-call timeout for one board.mjs run; the child gets SIGTERM past it. status and check take ~3 s on a warm history cache and 56–120 s on a cold one. A write killed mid-lock leaves board.mjs's mutex held up to 30 s."
  }
];
