---
name: {{KEY}}
description: "wec.aria's pipeline board (checks/board/board.mjs) via the Board MCP: where every unit is and what is next, the queue, the weight rubric, open or left discoveries, the last gate run split by unit, finding the owner's words for a gate, and - only when enabled - claim a unit, touch/hold/release files, advance a phase, reopen, weigh, acknowledge a commit, record a discovery, reserve a docs/15 or migration number. Triggers on: board status, what is next on the board, which unit should I claim, claim screen--x, advance P4, pass the gate with the owner's words, acknowledge an OFF-BOARD commit, record a discovery, reserve a docs15 number, owner notes. Not for running the portal gate itself or precheck/shoot. Read-only by default (BOARD_WRITE_ENABLED)."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

A thin wrapper: each tool runs one `board.mjs` subcommand and returns `{ ok, json?, text, refused?, why?, hint? }`.
The board's rules are board.mjs's — when it refuses, `refused: true` and `why` is its own sentence.

## Step 0 — Orient

```
health_check                       // repo root found? writes enabled?
status                             // every unit: phase, claims, waits, STALE, OFF-BOARD
next                               // the horizontal queue and the unit to claim
```

## Workflows

**Walk a phase** (writes enabled; `session` = your own session id, a lowercase UUID):

```
status(unit: "screen--review-intent")      // text + the raw unit file
claim(unit, session)
touch(unit, path, session)                 // a new file joins the unit
advance(unit, phase: "P4", session)        // non-gate phase
// then commit the work, its evidence and the unit file together
```

**Pass a gate** — ask the owner first; pass their words verbatim:

```
find(words: "<the owner's words>")         // optional: is there an owner message holding them?
advance(unit, phase: "P5", gate: "<the owner's words>", session)
```

`gate` searches only YOUR session's transcript (session is passed as `--as`). Several answers from
one message join with `||`. A tool result, a summary or your own text never counts.

**After a unit lands:** `check` → `acknowledge(unit, sha, gate, session)` or
`acknowledge(offBoard: true, gate, session)`; or `reopen(unit, phase | rebuild: true, why, session)` —
at a verify gate run `notes_write(unit, session)` first.

**Discoveries:** `discover(unit, text, session)` the moment something is found; dispose with
`discover(unit, id, fixed | to | left + revisit | owner: true + gate | sameAs | cleared, session)`;
`left` lists every left or parked one.

## Guardrails

- Write tools refuse unless `BOARD_WRITE_ENABLED=true`. The read tools always work.
- Every write tool needs `session`: your Claude Code session id (a lowercase UUID). A label is refused.
- Gate-passing tools: `advance` (gate / overBudget), `weigh` and `new_unit` (lighter than the rubric),
  `acknowledge` (always), `discover` (owner). The words go in `gate`; there is no `words`/`uuid` input.
- This proves the owner typed the words in that session's transcript — not that the caller is that session.
- Not offered: `prune-shots`, `precheck.mjs`, `shoot.mjs`, `release --force` (the owner's, from the CLI).
- `check` / `gate` returning `ok: false` without `refused` is a findings report, not a failure.
- A call is killed after `BOARD_CALL_TIMEOUT_MS` (default 30 s).

## Response profiles

`nano | compact | standard | verbose` — `compact` is the default. Only `verbose` is pretty-printed.

## Environment

{{ENV_TABLE}}

## Tools

{{TOOL_LIST}}
