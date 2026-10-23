/**
 * The RAW unit file, `checks/board/units/<id>.json`, for `status(unit)`.
 *
 * Raw only: nothing here derives a phase, a wait, a claim or a weight from it — that is
 * `rules.mjs`'s job, and a second copy of it here would drift. The CLI's `status` text is the
 * interpreted view; this is the record it was computed from.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BoardConfig } from "../config/index.js";

/** Same shape the tools validate; repeated here so this module cannot be handed a path. */
const UNIT_ID = /^(screen|family|horizontal|task)--[a-z0-9][a-z0-9-]*$/u;

export async function readUnitFile(config: BoardConfig, unit: string): Promise<unknown> {
  if (!UNIT_ID.test(unit)) return undefined;
  try {
    const raw = await readFile(path.join(config.repoRoot, "checks", "board", "units", `${unit}.json`), "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
