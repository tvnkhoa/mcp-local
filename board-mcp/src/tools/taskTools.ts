/**
 * The task-unit tools — the leader/member working day on the board (wec.aria e66c0bdf, task.mjs):
 * lead, assign, report, accept. Off unless BOARD_WRITE_ENABLED, gated like every write tool.
 *
 * Every rule is board.mjs's: who leads (the `lead` record, checked against the SessionStart hook's
 * coordinator lock), who may assign and accept (the leader, never the assignee or a session that
 * ever claimed the unit), which shas a report may name (board.mjs reads their numstat itself and
 * refuses one outside the scope), and which commits stop an accept. Nothing is re-decided here.
 *
 * `session` → `--as=<uuid>` is ASSERTED, not proven: these checks stop a session's mistake, not a
 * session naming another's id. Only the owner's words at a gate are proven, in the transcript.
 * `lead --force` (replace another session's lead record) is the owner's, on the CLI — not mapped.
 */

import { defineTool, schema, type AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BoardConfig } from "../config/index.js";
import { SESSION_ID } from "../middleware/guards.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";
import type { BoardRunner } from "../types/index.js";
import { ADDS, asFlag, callBoard, field, flag, GATE_REFUSAL_HINT, gateWords, OVERWRITES, repoPath, sessionField, SHA, text, unitId, writeGuards } from "./shared.js";

/** `shared`, or `<path>@<sha>` — board.mjs's own shape for a brief's worktree. */
const WORKTREE = /^(shared|[^,\s]+@[0-9a-f]{7,40})$/u;
const uuid = (what: string) => z.string().regex(SESSION_ID, `${what}: a lowercase session UUID`);

export function buildTaskTools(config: BoardConfig, run: BoardRunner): readonly AnyToolDefinition[] {
  const guards = writeGuards(config);

  return [
    defineTool({
      name: "lead",
      title: "Lead today",
      description:
        "Record this session as the leader of the working day (board.mjs lead; the day runs 04:00–04:00 local). Refused when the SessionStart hook's coordinator lock names another session, or another session already leads — replacing it (--force) is the owner's, on the CLI.",
      annotations: { readOnly: false, idempotent: true, destructive: false, openWorld: false },
      inputSchema: schema.object({ session: field.session(), profile: schema.profile() }, { required: ["session"] }),
      input: z.object({ session: sessionField(), profile: responseProfileSchema.optional() }).strict(),
      guards,
      handler: async (a) => callBoard(run, "lead", asFlag(a.session))
    }),

    defineTool({
      name: "assign",
      title: "Assign a task unit",
      description:
        "The leader assigns a task unit at T0 to a member session with its brief (board.mjs assign): T0 Brief → T1 Build. Refused unless `session` leads today. Only the assignee may then claim and report it.",
      annotations: ADDS,
      inputSchema: schema.object(
        {
          unit: field.unit("A task unit id, task--…"),
          to: schema.string("The member's session id, a lowercase UUID (→ --to). Never the leader's own."),
          goal: schema.string("What the member delivers (→ --goal).", { maxLength: 2000 }),
          scope: schema.array(schema.string(), "Repo-relative paths the member may change, within the unit's files (→ --scope=a,b). The overlap is symmetric: a wider directory passes.", { maxItems: 100 }),
          ruled_out: schema.string("What the member is not to try; 'none' is an answer (→ --ruled-out).", { maxLength: 2000 }),
          done_when: schema.string("The evidence that makes it done (→ --done-when).", { maxLength: 2000 }),
          worktree: schema.string("'shared', or '<path>@<sha>' for the member's own worktree (→ --worktree).", { maxLength: 512 }),
          gate_by: schema.enumOf(["owner", "leader"], "Who passes the acceptance gate (→ --gate-by). owner: accept needs the owner's words typed in the leader's session."),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "to", "goal", "scope", "ruled_out", "done_when", "worktree", "gate_by", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          to: uuid("to"),
          goal: text(2000),
          scope: z.array(repoPath()).min(1).max(100),
          ruled_out: text(2000),
          done_when: text(2000),
          worktree: z.string().max(512).regex(WORKTREE, "'shared' or '<path>@<sha>'"),
          gate_by: z.enum(["owner", "leader"]),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict(),
      guards,
      handler: async (a) =>
        callBoard(run, "assign", [
          a.unit,
          ...flag("to", a.to),
          ...flag("goal", a.goal),
          ...flag("scope", a.scope.join(",")),
          ...flag("ruled-out", a.ruled_out),
          ...flag("done-when", a.done_when),
          ...flag("worktree", a.worktree),
          ...flag("gate-by", a.gate_by),
          ...asFlag(a.session)
        ])
    }),

    defineTool({
      name: "rescope",
      title: "Widen a task unit's scope",
      description:
        "The leader widens an assigned task unit's scope (board.mjs rescope): add-only, and only between assign and report (T1) — never at T0, never once reported. Refused unless `session` leads today. The added paths fall under accept's unreported-commit check from the assign's HEAD on; the assign is not re-baselined.",
      annotations: ADDS,
      inputSchema: schema.object(
        {
          unit: field.unit("A task unit id, task--…"),
          add: schema.array(schema.string(), "Repo-relative paths the member may now also change (→ --add=a,b). Add-only; a path containing ',' cannot be expressed.", { minItems: 1, maxItems: 100 }),
          why: schema.string("What made the scope too narrow (→ --why).", { maxLength: 2000 }),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "add", "why", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          add: z.array(repoPath()).min(1).max(100),
          why: text(2000),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict(),
      guards,
      handler: async (a) => callBoard(run, "rescope", [a.unit, ...flag("add", a.add.join(",")), ...flag("why", a.why), ...asFlag(a.session)])
    }),

    defineTool({
      name: "report",
      title: "Report a task unit",
      description:
        "The assignee reports its task unit (board.mjs report). state=done (needs `shas` and `evidence`): T1 → T2 Verify; blocked / needs_owner stay at T1. board.mjs reads each sha's numstat itself and refuses a merge, an unknown sha, or one touching a file outside the assigned scope.",
      annotations: ADDS,
      inputSchema: schema.object(
        {
          unit: field.unit("A task unit id, task--…"),
          state: schema.enumOf(["done", "blocked", "needs_owner"], "→ --state."),
          shas: schema.array(schema.string(), "The commits to accept, short or full (→ --shas=a,b). Required when done.", { maxItems: 50 }),
          evidence: schema.string("The output file the leader reads, absolute or repo-relative; must be on disk (→ --evidence). Required when done.", { maxLength: 1024 }),
          left: schema.string("What is left; 'none' is an answer (→ --left).", { maxLength: 2000 }),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "state", "left", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          state: z.enum(["done", "blocked", "needs_owner"]),
          shas: z.array(z.string().regex(SHA, "a commit sha (4-40 hex)")).max(50).optional(),
          evidence: text(1024).optional(),
          left: text(2000),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict(),
      guards,
      handler: async (a) =>
        callBoard(run, "report", [
          a.unit,
          ...flag("state", a.state),
          ...flag("shas", a.shas === undefined || a.shas.length === 0 ? undefined : a.shas.join(",")),
          ...flag("evidence", a.evidence),
          ...flag("left", a.left),
          ...asFlag(a.session)
        ])
    }),

    defineTool({
      name: "accept",
      title: "Accept or reject a task unit",
      description:
        "The leader accepts (T2, T3 → landed) or rejects (back to T1 with the reason) a reported task unit (board.mjs accept). Refused to a session that does not lead today, is the assignee, or ever claimed the unit; refused while a commit since the assign changed the scope unreported. A gate_by=owner unit needs `gate`: the owner's words typed in THIS (the leader's) session.",
      // Overwrites: a rejection sends T1/T2 back to active/pending.
      annotations: OVERWRITES,
      inputSchema: schema.object(
        {
          unit: field.unit("A task unit id, task--…"),
          verdict: schema.enumOf(["accepted", "rejected"], "→ --verdict."),
          why: field.why("What the leader checked, or what is wrong (→ --why)."),
          gate: field.gate(),
          session: field.session(),
          profile: schema.profile()
        },
        { required: ["unit", "verdict", "why", "session"] }
      ),
      input: z
        .object({
          unit: unitId(),
          verdict: z.enum(["accepted", "rejected"]),
          why: text(),
          gate: gateWords().optional(),
          session: sessionField(),
          profile: responseProfileSchema.optional()
        })
        .strict(),
      guards,
      handler: async (a) =>
        callBoard(run, "accept", [a.unit, ...flag("verdict", a.verdict), ...flag("why", a.why), ...flag("gate", a.gate), ...asFlag(a.session)], { refusalHint: GATE_REFUSAL_HINT })
    })
  ];
}
