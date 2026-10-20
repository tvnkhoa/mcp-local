/**
 * What every board tool shares: the zod fragments, the flag builder, and one call path.
 *
 * Every value reaches board.mjs as ONE argv element. A flag is built as `--name=<value>`, so a
 * value can never become a second flag; a positional is refused when it starts with `-`, because
 * board.mjs reads every argument starting `--` as a flag.
 */

import type { PlatformError, Result } from "@mcp/core";
import { schema, type Guard, type ToolAnnotations } from "@mcp/sdk";
import { z } from "zod";

import type { BoardConfig } from "../config/index.js";
import { repoRootGuard, sessionUuidGuard, writeEnabledGuard } from "../middleware/guards.js";
import { interpretRun } from "../services/boardCli.js";
import type { BoardResult, BoardRunner } from "../types/index.js";

// --- zod fragments -----------------------------------------------------------

/** No control characters except tab / newline: a NUL cannot cross execFile, a CR is never meant. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

/** Free text for a flag value: the owner's words, a `--why`, a discovery's text. */
export const text = (max = 4000) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() !== "", "must not be blank")
    .refine((s) => !CONTROL.test(s), "must not contain control characters");

/** A positional argument: never empty, never starting with `-` (board.mjs would read it as a flag). */
export const positional = (max = 512) =>
  text(max).refine((s) => !s.startsWith("-"), "must not start with '-' (board.mjs would read it as a flag)");

/** A unit id as board.mjs names them: `screen--…`, `family--…`, `horizontal--…`. */
export const UNIT_ID = /^(screen|family|horizontal)--[a-z0-9][a-z0-9-]*$/u;
export const unitId = () => z.string().max(200).regex(UNIT_ID, "a unit id: screen--…, family--… or horizontal--…");

/** A phase id: P0…P6, F0…F5, H0…H3 (board.json is the authority; this only bounds the shape). */
export const phaseId = () => z.string().regex(/^[PFH]\d{1,2}$/u, "a phase id such as P4, F2 or H1");

/** A repo-relative path for touch / hold / release. */
export const repoPath = () =>
  positional(512).refine((s) => !s.includes(","), "must not contain ','");

/** Rubric question ids, e.g. route, layout. `[]` means every answer was no (`--yes=none`). */
export const yesIds = () => z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/u, "a rubric question id")).max(20);

/** The owner's words for a gate. board.mjs splits on `||` itself; every part must be in one message. */
export const MIN_GATE_PART_CHARS = 8;

/**
 * The owner's words for a gate.
 *
 * board.mjs splits `--gate` on `||`: it searches for the FIRST part, and proves every non-empty
 * part. A blank first part (`"||"`, `" || x"`) makes it search for "" — which matches the newest
 * owner message in the session — and blank parts are dropped from the proof, so `"||"` would pass
 * any gate. So EVERY part must be non-blank, and at least MIN_GATE_PART_CHARS (8) characters after
 * trimming: owner words are a sentence or a chosen option's label, and a two-letter fragment ("ok")
 * sits in nearly every message. A shorter genuine answer is passed from the CLI.
 */
export const gateWords = () =>
  text(4000).refine(
    (s) => s.split("||").every((part) => [...part.trim()].length >= MIN_GATE_PART_CHARS),
    `every ||-separated part must be at least ${MIN_GATE_PART_CHARS} characters after trimming — the owner's words, verbatim, never blank`
  );

/** `session`: validated as a UUID by the `session_uuid` guard, so a bad value is a refusal. */
export const sessionField = () => z.string().max(64);

export const SESSION_DESCRIPTION =
  "Your Claude Code session id — a lowercase UUID, the name of your transcript file. Passed as --as=<uuid>: a claim is named by it, and --gate searches only this session's transcript. Required; a label is refused.";

export const GATE_DESCRIPTION =
  "The owner's words, verbatim, as they typed them or chose them in an AskUserQuestion in THIS session (join several answers from one message with ||; each part at least 8 characters). Passed as --gate=…; board.mjs finds the message and proves the words are in it. The wrapper never takes --words/--session/--uuid.";

export const SHA = /^[0-9a-f]{4,40}$/u;

// --- write tools: annotations, guards, advertised fields ---------------------

/** Writes that add a record and remove nothing. */
export const ADDS: ToolAnnotations = { readOnly: false, idempotent: false, destructive: false, openWorld: false };
/** Writes that may overwrite or drop existing board state. */
export const OVERWRITES: ToolAnnotations = { readOnly: false, idempotent: false, destructive: true, openWorld: false };

/** Every write tool: writes enabled, an absolute root, a session UUID — in that order. */
export const writeGuards = (config: BoardConfig): readonly Guard[] => [writeEnabledGuard(config), repoRootGuard(config), sessionUuidGuard()];

export const field = {
  session: () => schema.string(SESSION_DESCRIPTION),
  unit: (d = "A unit id, e.g. screen--review-intent.") => schema.string(d),
  why: (d: string) => schema.string(d, { maxLength: 4000 }),
  yes: () => schema.array(schema.string(), "Rubric question ids answered yes; [] = every answer no (--yes=none). `assess` lists them.", { maxItems: 20 }),
  gate: () => schema.string(GATE_DESCRIPTION, { maxLength: 4000 })
};

// --- flags -------------------------------------------------------------------

/** `--name=value`, or nothing when the value is absent. */
export const flag = (name: string, value: string | undefined): string[] => (value === undefined ? [] : [`--${name}=${value}`]);

/** `--name`, or nothing. */
export const bool = (name: string, on: boolean | undefined): string[] => (on === true ? [`--${name}`] : []);

/** `--yes=a,b`, or `--yes=none` for an empty answer list. */
export const yesFlag = (yes: readonly string[]): string[] => [`--yes=${yes.length === 0 ? "none" : yes.join(",")}`];

/** `--as=<session uuid>`. */
export const asFlag = (session: string): string[] => [`--as=${session}`];

// --- one call ----------------------------------------------------------------

export interface CallOptions {
  readonly findingsExit?: boolean;
  readonly parseJson?: boolean;
  /** Replaces the generic refusal hint, e.g. for a tool that passes the owner's words. */
  readonly refusalHint?: string;
}

/** Run board.mjs `<command> ...args` and classify the result. */
export async function callBoard(
  run: BoardRunner,
  command: string,
  args: readonly string[],
  options: CallOptions = {}
): Promise<Result<BoardResult, PlatformError>> {
  // The runner never rejects for a CLI failure — it resolves with the exit. A throw here is a
  // defect, and dispatch turns it into internal_error.
  const outcome = await run([command, ...args]);
  const result = interpretRun(outcome, { command, findingsExit: options.findingsExit, parseJson: options.parseJson });
  if (result.ok && result.value.refused === true && options.refusalHint !== undefined) {
    return { ok: true, value: { ...result.value, hint: options.refusalHint } };
  }
  return result;
}

export const GATE_REFUSAL_HINT =
  "The board refused. When `why` is about the owner's words: --gate searched only this session's transcript for a message the OWNER typed (or an AskUserQuestion answer) containing them verbatim — ask the owner, then pass their exact words. `find` shows whether any owner message holds them.";
