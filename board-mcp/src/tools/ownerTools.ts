/**
 * The gate-passing write tools — the calls that can carry the owner's words past a gate:
 * new_unit and weigh (a weight lighter than the rubric recommends), advance (a gate phase, or
 * over-budget), acknowledge (always), discover (the owner disposition). Off unless
 * BOARD_WRITE_ENABLED; `commandMap.ts` GATE_PASSING_TOOLS names the same set.
 *
 * The owner's words go in as `gate` → `--gate=<words>`, the session UUID as `--as=<uuid>`; board.mjs
 * then searches ONLY that session's transcript for an owner message holding the words, and records
 * where. `--words` / `--session` / `--uuid` are never taken from the model. What this proves: the
 * owner typed the words in that session. Not that the caller is that session.
 */

import { defineTool, schema, type AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BoardConfig } from "../config/index.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";
import type { BoardRunner } from "../types/index.js";
import {
  ADDS,
  asFlag,
  bool,
  callBoard,
  field,
  flag,
  GATE_REFUSAL_HINT,
  gateWords,
  OVERWRITES,
  phaseId,
  positional,
  repoPath,
  sessionField,
  SHA,
  text,
  UNIT_ID,
  unitId,
  writeGuards,
  yesFlag,
  yesIds
} from "./shared.js";

export function buildOwnerWordTools(config: BoardConfig, run: BoardRunner): readonly AnyToolDefinition[] {
  const guards = writeGuards(config);
  const gateCall = { refusalHint: GATE_REFUSAL_HINT };

  return [
    defineTool({
      name: "new_unit",
      title: "New unit",
      description:
        "Make a unit (board.mjs new). kind=screen: `route` + `weight` + `yes`. kind=family: `route` only (a family walks every phase). kind=horizontal: `name` + `paths` + `weight` + `yes`, optionally `after` | `before` and `about`. A weight lighter than the rubric recommends needs `gate` (the owner's words).",
      // Overwrites: `before` rewires another unit's `after` (the named unit now follows this one).
      annotations: OVERWRITES,
      inputSchema: schema.object(
        {
          kind: schema.enumOf(["screen", "family", "horizontal"], "Unit kind."),
          route: schema.string("screen / family: the route, e.g. /review/intent."),
          name: schema.string("horizontal: the pattern's name, e.g. dates (→ --horizontal=dates)."),
          paths: schema.array(schema.string(), "horizontal: repo-relative paths it owns (→ --paths=a,b).", { maxItems: 100 }),
          weight: schema.enumOf(["light", "standard", "full"], "screen / horizontal: the weight the owner picked."),
          yes: field.yes(),
          after: field.unit("horizontal: queue after this unit (→ --after)."),
          before: field.unit("horizontal: insert before this unit (→ --before)."),
          about: schema.string("horizontal: one line on the wave (→ --about).", { maxLength: 500 }),
          gate: field.gate(),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["kind", "session"] }
      ),
      input: z
        .object({
          kind: z.enum(["screen", "family", "horizontal"]),
          route: positional(200).refine((s) => s.startsWith("/"), "a route starts with /").optional(),
          name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u, "lowercase letters, digits and -").max(100).optional(),
          paths: z.array(repoPath()).min(1).max(100).optional(),
          weight: z.enum(["light", "standard", "full"]).optional(),
          yes: yesIds().optional(),
          after: unitId().optional(),
          before: unitId().optional(),
          about: text(500).optional(),
          gate: gateWords().optional(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict()
        .superRefine((a, ctx) => {
          const need = (cond: boolean, path: string, message: string) => {
            if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
          };
          if (a.kind === "horizontal") {
            need(a.name !== undefined, "name", "required for kind=horizontal");
            need(a.paths !== undefined, "paths", "required for kind=horizontal");
            need(a.route === undefined, "route", "not for kind=horizontal — use name + paths");
            need(!(a.after !== undefined && a.before !== undefined), "before", "after or before, not both");
          } else {
            need(a.route !== undefined, "route", `required for kind=${a.kind}`);
            for (const k of ["name", "paths", "after", "before", "about"] as const) need(a[k] === undefined, k, "only for kind=horizontal");
          }
          if (a.kind === "family") {
            for (const k of ["weight", "yes", "gate"] as const) need(a[k] === undefined, k, "a family walks every phase — no weight");
          } else {
            need(a.weight !== undefined, "weight", `required for kind=${a.kind}`);
            need(a.yes !== undefined, "yes", "required: the rubric answered ([] = every answer no)");
          }
        }),
      guards,
      handler: async (a) => {
        const args =
          a.kind === "horizontal"
            ? [`--horizontal=${a.name ?? ""}`, `--paths=${(a.paths ?? []).join(",")}`, ...flag("after", a.after), ...flag("before", a.before), ...flag("about", a.about)]
            : [a.route ?? "", ...bool("family", a.kind === "family")];
        const weight = a.kind === "family" ? [] : [...flag("weight", a.weight), ...yesFlag(a.yes ?? [])];
        return callBoard(run, "new", [...args, ...weight, ...flag("gate", a.gate), ...asFlag(a.session)], gateCall);
      }
    }),

    defineTool({
      name: "weigh",
      title: "Change a unit's weight",
      description:
        "Change a unit's weight (board.mjs weigh). Heavier adds phases (one before a phase already done walks the unit again from it); lighter drops the phases still to do. Lighter than the rubric recommends needs `gate`.",
      annotations: OVERWRITES,
      inputSchema: schema.object(
        {
          unit: field.unit(),
          weight: schema.enumOf(["light", "standard", "full"], "The new weight."),
          yes: field.yes(),
          why: field.why("Why the weight changes (→ --why)."),
          gate: field.gate(),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "weight", "yes", "why", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          weight: z.enum(["light", "standard", "full"]),
          yes: yesIds(),
          why: text(),
          gate: gateWords().optional(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict(),
      guards,
      handler: async (a) =>
        callBoard(run, "weigh", [a.unit, a.weight, ...yesFlag(a.yes), ...flag("why", a.why), ...flag("gate", a.gate), ...asFlag(a.session)], gateCall)
    }),

    defineTool({
      name: "advance",
      title: "Advance a phase",
      description:
        "Mark the unit's CURRENT phase done (board.mjs advance) — the only way a phase becomes done. At a gate phase pass `gate`: the owner's words, which board.mjs proves are in an owner message of THIS session's transcript. `overBudget` (P3) also needs `gate`. Then commit the work, its evidence and the unit file together.",
      annotations: ADDS,
      inputSchema: schema.object(
        {
          unit: field.unit(),
          phase: schema.string("The current phase id, e.g. P4 or H2. No phase is skipped."),
          gate: field.gate(),
          overBudget: schema.boolean("P3 only: ## UX over Run 2's budget, with the owner's words in `gate` (→ --over-budget)."),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "phase", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          phase: phaseId(),
          gate: gateWords().optional(),
          overBudget: z.boolean().optional(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict()
        .refine((a) => a.overBudget !== true || a.gate !== undefined, { path: ["gate"], message: "overBudget is the owner's: pass their words in gate" }),
      guards,
      handler: async (a) =>
        callBoard(run, "advance", [a.unit, a.phase, ...bool("over-budget", a.overBudget), ...flag("gate", a.gate), ...asFlag(a.session)], gateCall)
    }),

    defineTool({
      name: "acknowledge",
      title: "Acknowledge a commit (owner)",
      description:
        "The owner's word that a commit which moved a landed unit's files needs no phase walked again (board.mjs acknowledge). `unit` + `sha`, or `offBoard: true` for every OFF-BOARD commit on every landed unit (or on `unit`). Always needs `gate`.",
      annotations: ADDS,
      inputSchema: schema.object(
        {
          unit: field.unit("The landed unit (required unless offBoard; optional with offBoard)."),
          sha: schema.string("The commit (4–40 hex)."),
          offBoard: schema.boolean("Every OFF-BOARD commit on landed units, in one pass (→ --off-board)."),
          gate: field.gate(),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["gate", "session"] }
      ),
      input: z
        .object({
          unit: unitId().optional(),
          sha: z.string().regex(SHA, "4–40 lowercase hex").optional(),
          offBoard: z.boolean().optional(),
          gate: gateWords(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict()
        .refine((a) => (a.offBoard === true ? a.sha === undefined : a.unit !== undefined && a.sha !== undefined), {
          path: ["sha"],
          message: "unit + sha, or offBoard: true (with an optional unit and no sha)"
        }),
      guards,
      handler: async (a) => {
        const target = a.offBoard === true ? ["--off-board", ...(a.unit === undefined ? [] : [a.unit])] : [a.unit ?? "", a.sha ?? ""];
        return callBoard(run, "acknowledge", [...target, ...flag("gate", a.gate), ...asFlag(a.session)], gateCall);
      }
    }),

    defineTool({
      name: "discover",
      title: "Record or dispose of a discovery",
      description:
        "Record a discovery (`text`), or dispose of one (`id`) — board.mjs discover. One disposition at most: `fixed` (sha), `to` (unit | SPEC-NNN | BACKLOG§n), `left` + `revisit`, `owner: true` + `gate` (the owner's words), `sameAs` (<unit>#<id>) or `cleared`. A gate and a unit's last phase refuse while one is open.",
      annotations: ADDS,
      inputSchema: schema.object(
        {
          unit: field.unit(),
          id: schema.string("An existing discovery to dispose of, e.g. d2. Omit to record a new one with `text`."),
          text: schema.string("What was found (→ --text).", { maxLength: 4000 }),
          fixed: schema.string("Disposition: the commit that fixed it (→ --fixed)."),
          to: schema.string("Disposition: a unit not past its first phase, SPEC-NNN or BACKLOG§n (→ --to)."),
          left: schema.string("Disposition: why it stays as it is (→ --left); needs `revisit`.", { maxLength: 4000 }),
          revisit: schema.string("With `left`: YYYY-MM-DD, a unit id, SPEC-NNN or BACKLOG§n (→ --revisit)."),
          owner: schema.boolean("Disposition: the owner decided — needs `gate` (→ --owner)."),
          sameAs: schema.string("Disposition: the same thing as <unit>#<id> (→ --same-as)."),
          cleared: schema.string("Disposition: what no longer finds it (→ --cleared).", { maxLength: 4000 }),
          gate: field.gate(),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          id: z.string().regex(/^d\d+$/u, "a discovery id such as d2").optional(),
          text: text().optional(),
          fixed: z.string().regex(SHA, "4–40 lowercase hex").optional(),
          to: positional(200).optional(),
          left: text().optional(),
          revisit: positional(200).optional(),
          owner: z.boolean().optional(),
          sameAs: z
            .string()
            .max(200)
            .refine((s) => {
              const [u, d] = s.split("#");
              return UNIT_ID.test(u ?? "") && /^d\d+$/u.test(d ?? "");
            }, "<unit>#<id>, e.g. screen--review-intent#d2")
            .optional(),
          cleared: text().optional(),
          gate: gateWords().optional(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict()
        .superRefine((a, ctx) => {
          if (a.owner === true && a.gate === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gate"], message: "owner: true is the owner's words — pass them in gate" });
          if (a.gate !== undefined && a.owner !== true) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gate"], message: "gate is only for the owner disposition (owner: true)" });
          if (a.id === undefined && a.text === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "text to record a discovery, or id to dispose of one" });
        }),
      guards,
      handler: async (a) =>
        callBoard(
          run,
          "discover",
          [
            a.unit,
            ...(a.id === undefined ? [] : [a.id]),
            ...flag("text", a.text),
            ...flag("fixed", a.fixed),
            ...flag("to", a.to),
            ...flag("left", a.left),
            ...flag("revisit", a.revisit),
            ...bool("owner", a.owner),
            ...flag("same-as", a.sameAs),
            ...flag("cleared", a.cleared),
            ...flag("gate", a.gate),
            ...asFlag(a.session)
          ],
          gateCall
        )
    })
  ];
}
