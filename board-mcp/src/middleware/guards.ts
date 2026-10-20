/**
 * board-mcp's declared gates. A security review reads these, not the handler bodies.
 *
 *   write_enabled — every write tool: refused unless BOARD_WRITE_ENABLED is exactly true / 1.
 *   session_uuid  — every tool that passes `--as`: `session` must be a Claude Code session id
 *                   (a lowercase UUID, exactly what board.mjs `io.is_session_id` accepts). It is
 *                   passed as `--as=<uuid>`, which is what makes `--gate` search ONLY that
 *                   session's transcript. A label, a missing value or anything else is refused.
 *   repo_root     — every tool: BOARD_REPO_ROOT must be absolute before any process starts.
 *
 * What the session guard proves, and what it does not: board.mjs proves the owner TYPED the
 * `--gate` words in that session's transcript. Nothing here proves the caller IS that session —
 * any process that knows a session id can name it.
 */

import { err, ok, policyViolation } from "@mcp/core";
import { defineGuard, featureFlagGuard, type Guard } from "@mcp/sdk";

import { rootProblem, type BoardConfig } from "../config/index.js";

/** board.mjs `io.is_session_id`, verbatim: a lowercase 8-4-4-4-12 hex id. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function writeEnabledGuard(config: BoardConfig): Guard {
  return featureFlagGuard(
    "write_enabled",
    () => config.writeEnabled,
    "Board writes are disabled: set BOARD_WRITE_ENABLED=true to let this server run board.mjs write subcommands. The read tools (status, next, left, check, assess, gate, find, notes) work without it."
  );
}

export function sessionUuidGuard(): Guard {
  return defineGuard("session_uuid", ({ input, toolName }) => {
    const session = (input as { session?: unknown } | null)?.session;
    if (typeof session === "string" && SESSION_ID.test(session)) return ok(undefined);
    return err(
      policyViolation(
        `${toolName} needs \`session\`: your Claude Code session id, a lowercase UUID (the name of your transcript file). It is passed as --as=<uuid>, so a claim names that session and --gate searches only that session's transcript. A label or anything else is refused.`,
        { guard: "session_uuid" }
      )
    );
  });
}

export function repoRootGuard(config: BoardConfig): Guard {
  return defineGuard("repo_root", () => {
    const problem = rootProblem(config);
    return problem === null ? ok(undefined) : err(policyViolation(problem, { guard: "repo_root" }));
  });
}
