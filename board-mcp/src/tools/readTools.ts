/**
 * The read tools — always on. Each runs one board.mjs read subcommand and returns its output.
 *
 * `--json`: status, next, left, check and gate are always passed `--json`. Today board.mjs ignores
 * a flag it does not know and prints text, so `json` is absent and `text` carries the answer. The
 * day wec.aria makes those commands honour `--json`, stdout parses and lands in `json` with no
 * change here. No probe, no flag: the output decides.
 *
 * Annotated read-only. `status` and `check` do write board.mjs's own history cache under
 * `<git common dir>/aria-board/cache/` (a sha's file list, which never changes) — derived state
 * the board keeps for itself, not a board record.
 */

import { ok } from "@mcp/core";
import { annotations, defineTool, schema, type AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BoardConfig } from "../config/index.js";
import { repoRootGuard, sessionUuidGuard } from "../middleware/guards.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";
import { readUnitFile } from "../services/unitFile.js";
import type { BoardRunner } from "../types/index.js";
import { asFlag, callBoard, flag, positional, SESSION_DESCRIPTION, sessionField, unitId, yesFlag, yesIds } from "./shared.js";

const JSON_FLAG = ["--json"];
const SINCE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/u;

export function buildReadTools(config: BoardConfig, run: BoardRunner): readonly AnyToolDefinition[] {
  const guards = [repoRootGuard(config)];

  return [
    defineTool({
      name: "status",
      title: "Board status",
      description:
        "Where every unit is and what is next (board.mjs status), or one unit with `unit`. With `unit`, also returns `unitFile`: the RAW checks/board/units/<id>.json — never interpreted; phase, waits and claims are what `text` says.",
      annotations: annotations.read(),
      inputSchema: schema.object({
        unit: schema.string("A unit id, e.g. screen--review-intent. Omit for every unit."),
        profile: schema.profile()
      }),
      input: z.object({ unit: unitId().optional(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (args) => {
        const result = await callBoard(run, "status", [...(args.unit === undefined ? [] : [args.unit]), ...JSON_FLAG], { parseJson: true });
        if (!result.ok || args.unit === undefined || result.value.ok !== true) return result;
        const unitFile = await readUnitFile(config, args.unit);
        return ok(unitFile === undefined ? result.value : { ...result.value, unitFile });
      }
    }),

    defineTool({
      name: "next",
      title: "Board queue",
      description: "The horizontal queue in order, and the unit to claim next (board.mjs next).",
      annotations: annotations.read(),
      inputSchema: schema.object({ profile: schema.profile() }),
      input: z.object({ profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async () => callBoard(run, "next", JSON_FLAG, { parseJson: true })
    }),

    defineTool({
      name: "left",
      title: "Discoveries left or parked",
      description: "Every discovery left or parked, the due ones first (board.mjs left).",
      annotations: annotations.read(),
      inputSchema: schema.object({ profile: schema.profile() }),
      input: z.object({ profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async () => callBoard(run, "left", JSON_FLAG, { parseJson: true })
    }),

    defineTool({
      name: "check",
      title: "Board check",
      description:
        "Every unit file against the rules — what CI runs (board.mjs check). Findings come back as `ok: false` with the listing in `text`; that is a report, not a failure of the tool.",
      annotations: annotations.read(),
      inputSchema: schema.object({ profile: schema.profile() }),
      input: z.object({ profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async () => callBoard(run, "check", JSON_FLAG, { parseJson: true, findingsExit: true })
    }),

    defineTool({
      name: "assess",
      title: "Weight rubric",
      description:
        "The weight rubric for a kind, and — with `yes` — the weight it recommends (board.mjs assess). `yes: []` means every answer was no.",
      annotations: annotations.read(),
      inputSchema: schema.object(
        {
          kind: schema.enumOf(["screen", "horizontal"], "Unit kind. A family walks every phase and has no rubric."),
          yes: schema.array(schema.string(), "Rubric question ids answered yes. Omit to print the questions only; [] = every answer no.", { maxItems: 20 }),
          profile: schema.profile()
        },
        { required: ["kind"] }
      ),
      input: z.object({ kind: z.enum(["screen", "horizontal"]), yes: yesIds().optional(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (args) => callBoard(run, "assess", [...flag("kind", args.kind), ...(args.yes === undefined ? [] : yesFlag(args.yes))])
    }),

    defineTool({
      name: "gate",
      title: "Last gate run, split",
      description:
        "The last gate run (checks/.last-gate.json) split into failures naming this unit's files and another session's (board.mjs gate). Runs no gate. `ok: false` means some failure names the unit's files.",
      annotations: annotations.read(),
      inputSchema: schema.object({ unit: schema.string("A unit id."), profile: schema.profile() }, { required: ["unit"] }),
      input: z.object({ unit: unitId(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (args) => callBoard(run, "gate", [args.unit, ...JSON_FLAG], { parseJson: true, findingsExit: true })
    }),

    defineTool({
      name: "find",
      title: "Find the owner's words",
      description:
        "The newest message the OWNER wrote, in this repo's transcripts, that contains `words` — prints its --session and --uuid (board.mjs find). Use it to check that words will pass a gate before calling a gate tool with them.",
      annotations: annotations.read(),
      inputSchema: schema.object(
        { words: schema.string("The owner's words, verbatim. Must not start with '-'.", { maxLength: 2000 }), profile: schema.profile() },
        { required: ["words"] }
      ),
      input: z.object({ words: positional(2000), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (args) => callBoard(run, "find", [args.words])
    }),

    defineTool({
      name: "notes",
      title: "Owner notes (read)",
      description:
        "The owner's messages in `session`'s transcript since the unit's phase began, as ## Owner notes rows (board.mjs notes, read form — writes nothing). `notes_write` puts them into the verify file.",
      annotations: annotations.read(),
      inputSchema: schema.object(
        {
          unit: schema.string("A unit id."),
          session: schema.string(SESSION_DESCRIPTION),
          since: schema.string("ISO time to read from; default: when the unit's last phase was done."),
          profile: schema.profile()
        },
        { required: ["unit", "session"] }
      ),
      input: z
        .object({ unit: unitId(), session: sessionField(), since: z.string().regex(SINCE, "an ISO date or time").optional(), profile: responseProfileSchema.optional() })
        .strict(),
      guards: [...guards, sessionUuidGuard()],
      handler: async (args) => callBoard(run, "notes", [args.unit, ...asFlag(args.session), ...flag("since", args.since)])
    })
  ];
}

export { SINCE };
