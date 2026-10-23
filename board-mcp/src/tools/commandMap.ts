/**
 * Every board.mjs subcommand, and what this server does with it.
 *
 * `commandMap.test.ts` parses the `commands` object in board.mjs, the `more_commands` object in
 * more.mjs and the `task_commands` object in task.mjs, and diffs their keys against MAPPED + EXCLUDED. A subcommand wec.aria adds fails that
 * test until it is mapped to a tool here or excluded with a reason — so the wrapper can never
 * silently fall behind the CLI.
 */

/** CLI subcommand → the tool(s) that run it. */
export const MAPPED: Readonly<Record<string, readonly string[]>> = {
  // read
  status: ["status"],
  next: ["next"],
  left: ["left"],
  check: ["check"],
  assess: ["assess"],
  gate: ["gate"],
  find: ["find"],
  notes: ["notes", "notes_write"],
  // write
  new: ["new_unit"],
  weigh: ["weigh"],
  claim: ["claim"],
  touch: ["touch"],
  hold: ["hold"],
  release: ["release"],
  advance: ["advance"],
  reopen: ["reopen"],
  "queue-spec": ["queue_spec"],
  amend: ["amend"],
  acknowledge: ["acknowledge"],
  discover: ["discover"],
  reserve: ["reserve"],
  // the leader/member day (task.mjs)
  lead: ["lead"],
  assign: ["assign"],
  rescope: ["rescope"],
  report: ["report"],
  accept: ["accept"]
};

/** CLI subcommands deliberately not exposed, with the reason. */
export const EXCLUDED: Readonly<Record<string, string>> = {
  "prune-shots":
    "Deletes evidence/<unit>/shots directories (rmSync recursive) with --write. CLI housekeeping for the owner, not a pipeline step; a model has no reason to run it."
};

/**
 * Scripts beside board.mjs that are NOT subcommands of it, so no tool wraps them. Listed so the
 * README and the test say so explicitly rather than by omission.
 */
export const EXCLUDED_SCRIPTS: Readonly<Record<string, string>> = {
  "precheck.mjs":
    "A separate script (headless Chrome over a unit's routes), not a board.mjs subcommand. It records discoveries itself; run it from the repo.",
  "shoot.mjs":
    "A separate script (playwright-core screenshots, may open a visible window for sign-in), not a board.mjs subcommand."
};

/** CLI flags the wrapper does not pass, with the reason. */
export const UNMAPPED_FLAGS: Readonly<Record<string, string>> = {
  "--words / --session / --uuid":
    "Never accepted from the model. The owner's words go in as --gate=<words> with --as=<session uuid>; board.mjs finds the message itself, in that session's transcript only.",
  "release --force":
    "Releases another session's claim — 'the owner's call' in board.mjs, with no proof of the owner. Left to the CLI, run by the owner.",
  "lead --force":
    "Replaces another session's lead record for the day — 'the owner's call' in board.mjs, with no proof of the owner. Left to the CLI, run by the owner after moving the coordinator lock.",
  "notes --session":
    "notes is passed --as=<session uuid> instead, which board.mjs reads the same way (io.is_session_id)."
};

/** The tools that can carry the owner's words past a gate (each also needs a session UUID). */
export const GATE_PASSING_TOOLS: readonly string[] = [
  "advance", // --gate at a gate phase; --over-budget at P3
  "weigh", // a weight lighter than the rubric recommends
  "new_unit", // a weight lighter than the rubric recommends
  "acknowledge", // always the owner's words
  "discover", // --owner disposition
  "accept" // a gate_by=owner task unit: the owner's words, typed in the leader's session
];
