/**
 * The write tools that walk a unit — claim, touch, hold, release, reopen, queue-spec, amend,
 * reserve, notes --write. Off unless BOARD_WRITE_ENABLED. The tools that can carry the owner's
 * words past a gate are in `ownerTools.ts`.
 *
 * Every write tool takes `session` (a UUID, the `session_uuid` guard) and passes it as
 * `--as=<uuid>`: board.mjs names the claim by it. This server writes no unit file and no claim
 * itself — board.mjs does, under its own mutex, by its own rules. Every typed field maps to exactly
 * one CLI flag or positional; nothing is decided here that board.mjs decides.
 */

import { defineTool, schema, type AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BoardConfig } from "../config/index.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";
import type { BoardRunner } from "../types/index.js";
import { SINCE } from "./readTools.js";
import { ADDS, asFlag, bool, callBoard, field, flag, OVERWRITES, phaseId, repoPath, sessionField, text, unitId, writeGuards } from "./shared.js";

const SPEC = /^SPEC-\d{3}$/u;

export function buildWriteTools(config: BoardConfig, run: BoardRunner): readonly AnyToolDefinition[] {
  const guards = writeGuards(config);

  return [
    defineTool({
      name: "claim",
      title: "Claim a unit",
      description: "Take a unit's files for this session, or refresh the claim (board.mjs claim). Refused while another session holds an overlapping file, or the unit waits.",
      annotations: { readOnly: false, idempotent: true, destructive: false, openWorld: false },
      inputSchema: schema.object({ unit: field.unit(), session: field.session(), profile: schema.profile() }, { required: ["unit", "session"] }),
      input: z.object({ unit: unitId(), session: sessionField(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (a) => callBoard(run, "claim", [a.unit, ...asFlag(a.session)])
    }),

    defineTool({
      name: "touch",
      title: "Add a file to a claimed unit",
      description: "A new file joins a unit this session has claimed (board.mjs touch).",
      annotations: ADDS,
      inputSchema: schema.object(
        { unit: field.unit(), path: schema.string("Repo-relative path.", { maxLength: 512 }), session: field.session(), profile: schema.profile() },
        { required: ["unit", "path", "session"] }
      ),
      input: z.object({ unit: unitId(), path: repoPath(), session: sessionField(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (a) => callBoard(run, "touch", [a.unit, a.path, ...asFlag(a.session)])
    }),

    defineTool({
      name: "hold",
      title: "Hold a shared file",
      description: "Take a hotspot or a shared spec for one edit (board.mjs hold); `release` it after the commit. Prints DIRTY when the file already carries changes that are not yours.",
      annotations: { readOnly: false, idempotent: true, destructive: false, openWorld: false },
      inputSchema: schema.object(
        { path: schema.string("Repo-relative path of the hotspot or shared spec.", { maxLength: 512 }), session: field.session(), profile: schema.profile() },
        { required: ["path", "session"] }
      ),
      input: z.object({ path: repoPath(), session: sessionField(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (a) => callBoard(run, "hold", [a.path, ...asFlag(a.session)])
    }),

    defineTool({
      name: "release",
      title: "Release a claim or hold",
      description:
        "Give back this session's claim on a unit, or its hold on a path (board.mjs release). Releasing another session's claim (--force) is the owner's, from the CLI — not offered here.",
      annotations: { readOnly: false, idempotent: false, destructive: true, openWorld: false },
      inputSchema: schema.object(
        { target: schema.string("A unit id or a held path.", { maxLength: 512 }), session: field.session(), profile: schema.profile() },
        { required: ["target", "session"] }
      ),
      input: z
        .object({ target: z.union([unitId(), repoPath()]), session: sessionField(), profile: responseProfileSchema.optional() })
        .strict(),
      guards,
      handler: async (a) => callBoard(run, "release", [a.target, ...asFlag(a.session)])
    }),

    defineTool({
      name: "reopen",
      title: "Reopen a unit",
      description:
        "Walk a unit again from a done phase (board.mjs reopen) — the round's records move into `rounds`, its evidence is renamed *.round-<k>.*. Pass `phase`, or `rebuild: true` for the build phase. At a verify gate, ## Owner notes must be written first (`notes_write`).",
      annotations: OVERWRITES,
      inputSchema: schema.object(
        {
          unit: field.unit(),
          phase: schema.string("The phase to walk again from."),
          rebuild: schema.boolean("Reopen at the build phase (→ --rebuild) instead of naming it."),
          why: field.why("What moved, and why the phases are walked again (→ --why)."),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "why", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          phase: phaseId().optional(),
          rebuild: z.boolean().optional(),
          why: text(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict()
        .refine((a) => (a.phase !== undefined) !== (a.rebuild === true), { path: ["phase"], message: "phase or rebuild: true — exactly one" }),
      guards,
      handler: async (a) =>
        callBoard(run, "reopen", [a.unit, ...(a.phase === undefined ? [] : [a.phase]), ...bool("rebuild", a.rebuild), ...flag("why", a.why), ...asFlag(a.session)])
    }),

    defineTool({
      name: "queue_spec",
      title: "Queue a spec on a landed unit",
      description: "A new spec waits on a LANDED unit; the next reopen takes every waiting spec onto one round (board.mjs queue-spec).",
      annotations: ADDS,
      inputSchema: schema.object(
        { unit: field.unit(), spec: schema.string("SPEC-NNN."), why: field.why("Optional reason (→ --why)."), session: field.session(), profile: schema.profile() },
        { required: ["unit", "spec", "session"] }
      ),
      input: z
        .object({ unit: unitId(), spec: z.string().regex(SPEC, "SPEC-NNN"), why: text().optional(), session: sessionField(), profile: responseProfileSchema.optional() })
        .strict(),
      guards,
      handler: async (a) => callBoard(run, "queue-spec", [a.unit, a.spec, ...flag("why", a.why), ...asFlag(a.session)])
    }),

    defineTool({
      name: "amend",
      title: "Amend a done non-gate phase",
      description: "Re-record a done, NON-gate phase whose evidence was re-written, without a round (board.mjs amend). A gate is never amended — reopen it.",
      annotations: OVERWRITES,
      inputSchema: schema.object(
        { unit: field.unit(), phase: schema.string("The done, non-gate phase."), why: field.why("What changed in its evidence (→ --why)."), session: field.session(), profile: schema.profile() },
        { required: ["unit", "phase", "why", "session"] }
      ),
      input: z
        .object({ unit: unitId(), phase: phaseId(), why: text(), session: sessionField(), profile: responseProfileSchema.optional() })
        .strict(),
      guards,
      handler: async (a) => callBoard(run, "amend", [a.unit, a.phase, ...flag("why", a.why), ...asFlag(a.session)])
    }),

    defineTool({
      name: "reserve",
      title: "Reserve a shared number",
      description: "The next docs/15 row number or migration number, held seven days so two sessions never take the same one (board.mjs reserve).",
      annotations: ADDS,
      inputSchema: schema.object(
        { kind: schema.enumOf(["docs15", "migration"], "Which number."), session: field.session(), profile: schema.profile() },
        { required: ["kind", "session"] }
      ),
      input: z.object({ kind: z.enum(["docs15", "migration"]), session: sessionField(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (a) => callBoard(run, "reserve", [a.kind, ...asFlag(a.session)])
    }),

    defineTool({
      name: "notes_write",
      title: "Write the owner's notes",
      description:
        "Copy the owner's messages since the phase began from `session`'s transcript into the current verify file's ## Owner notes (board.mjs notes --write). Replaces that section.",
      annotations: { readOnly: false, idempotent: true, destructive: true, openWorld: false },
      inputSchema: schema.object(
        {
          unit: field.unit(),
          session: field.session(),
          since: schema.string("ISO time to read from; default: when the unit's last phase was done."),
          profile: schema.profile()
        },
        { required: ["unit", "session"] }
      ),
      input: z
        .object({ unit: unitId(), session: sessionField(), since: z.string().regex(SINCE, "an ISO date or time").optional(), profile: responseProfileSchema.optional() })
        .strict(),
      guards,
      handler: async (a) => callBoard(run, "notes", [a.unit, ...asFlag(a.session), ...flag("since", a.since), "--write"])
    })
  ];
}
