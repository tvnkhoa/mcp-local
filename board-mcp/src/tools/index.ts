/**
 * The board-mcp tool table: health_check, the read tools, the write tools, the task-unit tools.
 *
 * A thin wrapper over `node checks/board/board.mjs <cmd> …` (see `commandMap.ts` for which
 * subcommand each tool runs and which are excluded). Separated from `index.ts` so the table can be
 * built against a stub runner.
 */

import { existsSync } from "node:fs";

import { err, isPlatformError, ok, upstreamError } from "@mcp/core";
import { createHealthCheckTool, registerTool } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";

import { BOARD_CLI_RELATIVE, boardCliPath, describeConfig, rootProblem, type BoardConfig } from "../config/index.js";
import { mapError, type MappedError } from "../middleware/errors.js";
import { createBoardRunner } from "../services/boardCli.js";
import type { BoardRunner } from "../types/index.js";
import { GATE_PASSING_TOOLS } from "./commandMap.js";
import { buildOwnerWordTools } from "./ownerTools.js";
import { buildReadTools } from "./readTools.js";
import { buildTaskTools } from "./taskTools.js";
import { buildWriteTools } from "./writeTools.js";

/**
 * `mapError`, plus the refusals dispatch and the guards raise. A `PlatformError` keeps its code;
 * the bounded stdout/stderr tails an `upstream_error` / `timeout` carries are forwarded as
 * `detail` — board.mjs output holds no credential (it prints unit ids, paths and shas).
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    const details = error.details as { stderr?: unknown; stdout?: unknown } | undefined;
    const detail = [details?.stderr, details?.stdout].filter((x): x is string => typeof x === "string" && x !== "").join("\n---\n");
    return detail === "" ? { code: error.code, message: error.message } : { code: error.code, message: error.message, detail };
  }
  return mapError(error);
}

export function buildTools(config: BoardConfig, run: BoardRunner = createBoardRunner(config)): readonly AnyToolDefinition[] {
  return registerTool([
    createHealthCheckTool({
      serverName: "board-mcp",
      version: "0.1.0",
      describeConfig: () => ({ ...describeConfig(config), gatePassingTools: GATE_PASSING_TOOLS }),
      probe: async () => {
        const problem = rootProblem(config);
        if (problem !== null) return err(upstreamError(problem));
        if (!existsSync(boardCliPath(config))) return err(upstreamError(`No ${BOARD_CLI_RELATIVE} under BOARD_REPO_ROOT.`));
        return ok({ cli: BOARD_CLI_RELATIVE, found: true });
      }
    }),
    buildReadTools(config, run),
    buildWriteTools(config, run),
    buildOwnerWordTools(config, run),
    buildTaskTools(config, run)
  ]);
}
