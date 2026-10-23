# board-mcp

A thin MCP wrapper over wec.aria's pipeline board CLI, `checks/board/board.mjs`. Each tool runs
one subcommand — `node checks/board/board.mjs <cmd> …args` — through `child_process.execFile` with
an **args array, never a shell**, cwd `BOARD_REPO_ROOT`. No board rule is re-implemented here:
phases, waits, claims, weights, discoveries and the owner-words proof are all board.mjs's, and its
`README.md` is the protocol.

## Commands

```bash
npm run build          # tsc -> dist/
npm run typecheck
npm run test           # node:test over src/**/*.test.ts
npm run smoke          # stdio handshake + read-only calls (needs a build; forces BOARD_WRITE_ENABLED=false)
npm run dev            # tsx, no build
```

**After an upgrade, restart the Claude Code session — `/mcp` is not enough.** A reconnect starts the
new server, but the session keeps the OLD schema of tools it already holds: seen live on 23 Oct 2026,
`status` still lacked `today`/`by` after `/mcp` (a call passing `today` still worked — the server had it).
New tools appear; changed parameters of existing ones need a new session.

## Configuration (env)

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BOARD_REPO_ROOT` | **yes** | — | Absolute path; the CLI runs with this as its cwd. e.g. D:/1.SourceCode/crm/wec.aria |
| `BOARD_WRITE_ENABLED` | no | `false` | The board's write subcommands (new, claim, advance, acknowledge, …) are DISABLED unless exactly true or 1. The tools are still advertised; the gate is enforced when they are called. |
| `BOARD_CALL_TIMEOUT_MS` | no | `120000` *(code)* | Per-call timeout for one board.mjs run; the child gets SIGTERM past it. status and check take ~3 s on a warm history cache and 56–120 s on a cold one. A write killed mid-lock leaves board.mjs's mutex held up to 30 s. |

3 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->

`BOARD_REPO_ROOT` is checked for being absolute when a tool runs (a non-absolute value is refused
with `policy_violation`, and `health_check` reports degraded), not at start-up — the contract
snapshot boots the server with a placeholder that is not a path.

## Tools

<!-- BEGIN GENERATED: tool-list -->

27 tools, namespaced `mcp__board-mcp__<tool>`:

- `accept`
- `acknowledge`
- `advance`
- `amend`
- `assess`
- `assign`
- `check`
- `claim`
- `discover`
- `find`
- `gate`
- `health_check`
- `hold`
- `lead`
- `left`
- `new_unit`
- `next`
- `notes`
- `notes_write`
- `queue_spec`
- `release`
- `reopen`
- `report`
- `reserve`
- `status`
- `touch`
- `weigh`

<!-- END GENERATED: tool-list -->

| Tool | board.mjs | Kind |
|---|---|---|
| `status` | `status [<unit>]` · `status --today [--by=<uuid>]` | read |
| `next` / `left` / `check` | `next` / `left` / `check` | read |
| `assess` | `assess --kind=… [--yes=…]` | read |
| `gate` | `gate <unit>` | read |
| `find` | `find <words>` | read |
| `notes` | `notes <unit> --as=<uuid> [--since]` | read |
| `new_unit` | `new <route> [--family]` · `new --horizontal=… --paths=…` · `new --task=… --paths=…` | write |
| `weigh` `claim` `touch` `hold` `release` `advance` `reopen` `queue_spec` `amend` `acknowledge` `discover` `reserve` | the subcommand of the same name (`queue-spec`) | write |
| `notes_write` | `notes <unit> --as=<uuid> --write` | write |
| `lead` `assign` `report` `accept` | the subcommand of the same name (task.mjs, wec.aria e66c0bdf) | write |

### Task units — the leader/member day

A `task--<slug>` unit is one member's item on the working day (`new_unit` kind `task`: `name` +
`paths`, no weight). `lead` records the session that leads today (board.mjs checks it against the
SessionStart hook's coordinator lock); `assign` (the leader: `to`, `goal`, `scope`, `ruled_out`,
`done_when`, `worktree`, `gate_by`) moves T0 → T1; only the assignee may `claim` and `report` it
(`state: done` with `shas` + `evidence` → T2 — board.mjs reads each sha's numstat and refuses one
outside the scope); `accept` (the leader, never the assignee or a session that ever claimed it)
lands it or sends it back to T1. `status` with `today: true` lists the day's activity, `by` one
session's. Every rule is board.mjs's; the tools only map fields to flags.

**`session` is asserted, not proven.** board.mjs's leader / assignee / self-accept checks stop a
session's mistake — assigning as a member, accepting its own work — not a session that passes
another session's id. Only the owner's words at a gate are proven, in the transcript.

### Output

Every board tool answers `{ ok, json?, text, refused?, why?, hint? }`:

- **exit 0** → `ok: true`, `text` = stdout.
- **exit 1 with a stderr line starting `board: `** → `ok: false, refused: true, why: <the CLI's sentence>`
  — the LAST such line, since git or Node may print warnings before it.
  A refusal is the board's rule; read `why`, fix what it names, call again.
- **`check` / `gate` exit 1 with no `board: ` line** → `ok: false` with the findings in `text` —
  a report, not a failure.
- **any other non-zero exit** (a stack trace, git failing) → MCP error `upstream_error`, stderr tail
  in `detail`. Output past 8 MiB is stopped → `upstream_error`. Past `BOARD_CALL_TIMEOUT_MS`
  (default 120 s: board.mjs measures `status` / `check` at 56–120 s on a cold history cache) the
  child gets SIGTERM → `timeout`. A write killed inside board.mjs's `with_lock` leaves its mutex
  directory behind; board.mjs breaks a lock older than 30 s, so the next write may wait that long.
- `status` with `unit` adds `unitFile`: the **raw** `checks/board/units/<id>.json`. Raw only —
  phase, waits and claims are what `text` says; deriving them here would duplicate `rules.mjs`.

### `--json` — waiting on wec.aria

`status`, `next`, `left`, `check` and `gate` are **always passed `--json`**. board.mjs today
ignores a flag it does not know and prints text, so `json` is absent and `text` carries the
answer. Once wec.aria makes those commands honour `--json`, their stdout parses and lands in
`json` with no change here: the output decides, there is no probe and no flag. (If board.mjs ever
starts *refusing* unknown flags before it supports `--json`, these five calls will refuse — drop
`JSON_FLAG` in `src/tools/readTools.ts`.)

## Gates and sessions

**Writes are off** unless `BOARD_WRITE_ENABLED` is exactly `true` or `1` (`write_enabled` guard,
`policy_violation`). The read tools always work.

**Every write tool takes `session`**: the caller's Claude Code session id, a lowercase UUID (board.mjs
`io.is_session_id`). It is passed as `--as=<uuid>` — a claim is named by it, and `--gate` then
searches **only that session's transcript**. A label, an upper-case id or anything else is refused
(`session_uuid` guard); a missing one is a `validation_error`. Claims a session made through the
CLI under a label are not this session's. Requiring the UUID on every write tool, not only the
gate-passing ones, was agreed with wec.aria (the board's owner).

**Gate-passing tools** — the calls that can carry the owner's words past a gate:

| Tool | When the words are needed |
|---|---|
| `advance` | `gate` at a gate phase; `overBudget` (P3) also needs `gate` |
| `weigh` | a weight lighter than the rubric recommends |
| `new_unit` | a weight lighter than the rubric recommends |
| `acknowledge` | always (one sha, or `offBoard: true`) |
| `discover` | the `owner: true` disposition |
| `accept` | a `gate_by: owner` task unit — the owner's words typed in the leader's own session |

The owner's words go in as `gate` → `--gate=<words>` (join several answers from one message with
`||`). **This server refuses a blank `||` part** (`"||"`, `" || "`, `"a||"`): every message
contains `""`, so a blank part proves nothing. board.mjs refuses it too since wec.aria 704eb34f
(docs/15 #755); the check here is defence in depth. **Whether short words prove anything is the
CLI's rule**, not this server's: board.mjs accepts a part under 8 characters only as a whole line of
the owner's message (`Đồng ý` alone on a line), which only it can see — so `"ok"` is passed through
and board.mjs decides. The wrapper **never** accepts `--words`, `--session` or `--uuid` from the model: board.mjs
finds the message itself. This server never writes a unit file or a claim — board.mjs does.

**What this proves, and what it does not.** board.mjs proves the OWNER typed those words (or chose
them in an AskUserQuestion) in that session's transcript. Nothing proves the caller *is* that
session: any process that knows a session id can name it.

## Not exposed

| board.mjs | Why |
|---|---|
| `prune-shots` | Deletes `evidence/<unit>/shots` directories with `--write`. CLI housekeeping for the owner, not a pipeline step. |
| `precheck.mjs` | A separate script (headless Chrome over a unit's routes), not a board.mjs subcommand. |
| `shoot.mjs` | A separate script (playwright-core screenshots; may open a window for sign-in), not a subcommand. |
| `release --force` | Releases another session's claim — "the owner's call" with no proof of the owner. Run it from the CLI. |
| `lead --force` | Replaces another session's lead record for the day — the owner's, after moving the coordinator lock. Run it from the CLI. |
| `--words --session --uuid` | Never from the model; `--gate` + `--as=<uuid>` instead. |

`src/tools/commandMap.ts` holds this list, and `commandMap.test.ts` parses the `commands`,
`more_commands` and `task_commands` keys out of board.mjs / more.mjs / task.mjs: a subcommand wec.aria adds fails that test until
it is mapped or excluded with a reason. The test needs a wec.aria checkout (`BOARD_REPO_ROOT`, or
`D:/1.SourceCode/crm/wec.aria`) and skips without one, as in this workspace's CI.

## Tests

- `tools.test.ts` — the table, annotations, guards, argument mapping, no `words`/`uuid` inputs,
  flag-injection refusals; every call through dispatch against a stub board.mjs that echoes argv.
- `services/boardCli.test.ts` — exit classification; refusal / crash / findings / timeout end to
  end; arg round-trip of Vietnamese text, backticks, `$`, `\`, `||`, quotes and `%VAR%`.
- `commandMap.test.ts` — the tool list against board.mjs's own subcommands.
- `writePath.test.ts` — the REAL board.mjs on a scratch git repo (board code + units copied into a
  temp dir): claim, a second session refused, a gate refused without the owner's words, release.
  **No write subcommand ever runs against wec.aria itself** — its board is shared by several sessions.
- `taskPath.test.ts` — the task tools on the REAL board.mjs in a scratch repo, with `BOARD_LIVE_DIR`,
  `HANDOVER_DIR` and a home of its own set for the child: assign by a non-leader, claim of another's
  assigned unit, report by a non-assignee and self-accept refused; lead → assign → claim → report →
  accept → `status` today. Skips when the board under test has no `task.mjs`.
