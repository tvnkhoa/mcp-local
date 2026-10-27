# Development Guide

Day-to-day work in this workspace: getting running, the build order, the test layers, the gate, and
the failures that will otherwise cost you an afternoon.

New here? [Onboarding](../guides/onboarding.md) is the three-command version. This page is what you keep open
afterwards.

---

## 1. Prerequisites

| | |
|---|---|
| Node | **22** (what CI runs; developed on 22.18) |
| npm | 10+ |
| OS | Windows is the primary platform — CI is `windows-latest`. Nothing is Windows-only by design, but nothing is verified on Linux either |
| Windows extra | **Visual Studio C++ Build Tools**, for `better-sqlite3` and `tree-sitter` in `codebase-index-mcp`. Nothing else in the workspace needs a native build |

No `engines` field is declared anywhere; the Node version is pinned by CI, not by npm.

---

## 2. First run

```bash
npm install            # packages/* only — servers are NOT workspace members
npm run setup          # build packages, then install + build + register every server
npm run verify:all     # the gate
```

`verify:all` exiting 0 means you have a working install. It is credential-free by design, so it means
the same thing here as it does in CI.

### The build order, and why it bites

Servers consume `packages/*/dist` through `file:` dependencies, and `dist/` is **gitignored**. So a
fresh clone cannot build a server until the packages exist:

```bash
npm run build:packages     # tsc -b, ~1.3s incremental — do this first, always
```

`setup` and `mcp:install` run it for you. The other entry points do not; `scripts/lib/manifest.mjs`
catches the resulting `ERR_MODULE_NOT_FOUND` and re-throws it as *"run `npm run build:packages`"*,
which is the whole reason that shim still exists.

Servers are outside the workspace on purpose: npm hoisting would relocate `better-sqlite3`'s native
binary, and a hoisted duplicate package makes `instanceof` fail across package boundaries
([ADR 0001](../decisions/0001-workspace-native-deps.md)).

---

## 3. The script vocabulary

`build` · `typecheck` · `test` · `smoke` for every server; `build` · `typecheck` · `test` · `clean`
for packages. The rule and why it exists are in
[`../reference/conventions.md`](../reference/conventions.md) §4. What follows is what to *run*.

### From the workspace root

| Command | Does |
|---|---|
| `npm run build:packages` | `tsc -b` over all six packages |
| `npm run typecheck:packages` | `tsc -b` with no emit, packages only |
| `npm run clean:packages` | delete every package's `dist/` and build info |
| `npm run typecheck:tests` | the `*.test.ts` each package's build excludes |
| `npm run test:packages` | `npm test --workspaces` |
| `npm run test:scripts` | `node --test "scripts/**/*.test.mjs"` |
| `npm run guard:all` | dependency + convention guards |
| `npm run build:servers` / `typecheck:servers` / `test:servers` / `smoke:servers` | over all six servers |
| `npm run contracts:check` | boot all six over stdio, diff `tools/list` against `contracts/` |
| `npm run generate:check` | fail on generated-file drift |
| `npm run docs:check` | the documentation gate — links, documented tool arguments and names, capability claims, deprecated env names |
| `node scripts/run-servers.mjs <script> [--server <key>] [--continue]` | one script across servers |

`--continue` keeps going after a failure so one run reports every broken server, not just the first.

### Inside a server

```bash
cd <server>
npm run build      # tsc → dist/
npm run typecheck  # tsconfig.json --noEmit && tsconfig.test.json
npm run test
npm run smoke      # real stdio handshake — RUNS dist/, so build first
npm run dev        # tsx, from source
```

---

## 4. The gate

```bash
npm run verify:all     # packages + servers + tool contracts + generated docs. Credential-free.
npm run verify:live    # the four live smoke tests. NEEDS REAL CREDENTIALS.
```

`verify:all` expands to:

```
verify:packages   build:packages → typecheck:tests → test:packages → test:scripts → guard:all
verify:servers    build:servers  → typecheck:servers → test:servers
contracts:check
generate:check
docs:check
```

`docs:check` (`scripts/check-docs.mjs`) is the documentation gate: relative links and anchors,
documented tool arguments against `contracts/`, tool names that must exist, prose capability claims,
and deprecated env names used as instructions. Historical documents are exempt from everything but
the link check — an archived audit that quotes a past defect must not be reported as committing it.
Each of the five checks has been shown to reject a deliberate violation.

`verify:live` reaches real Postgres / OpenObserve / Bitbucket. It is **not** in CI; run it before a
release.

### What CI actually runs, and how it differs

`.github/workflows/ci.yml`, `windows-latest` + Node 22, one job, credential-free:

```
npm ci → build:packages → install:servers → typecheck:tests → test:packages
       → guard:all → build:servers → typecheck:servers → test:servers
       → contracts:check → benchmark:plan:check (in codebase-index-mcp)
```

It is **not** literally `verify:all`, and the difference matters in both directions:

| | `verify:all` | CI |
|---|---|---|
| `test:scripts` | ✅ | ❌ **not run** |
| `docs:check` | ✅ | ✅ |
| `generate:check` | ✅ | ✅ |
| `install:servers` (`npm ci` per server) | ❌ | ✅ |
| `benchmark:plan:check` | ❌ | ✅ — compact-mode token savings must stay ≥ 40% |

So: run `verify:all` locally before pushing. A green CI does not prove the generated files are in
sync.

`guard:all` runs **without** `--strict`, deliberately: errors block the build, and `size/soft-cap`
stays advisory ([Folder Convention](../reference/folder-convention.md) §5).

### Release readiness — what the gate does not check

`verify:all` proves the code builds, types, tests and boots. It says nothing about whether a release
is *safe to hand over*. Before tagging or handing a server to someone else, confirm by reading:

| | Check |
|---|---|
| Build & runtime | `npm run smoke` works from **built output**, not just `dev` |
| Safety defaults | Least-privilege defaults intact; every write gate still off by default and parsed strictly |
| Bounds | Timeouts and limits bounded *and documented* in the README table |
| Config hygiene | Sensitive config via env only; no secret in code, docs, or a committed default |
| Documentation | README covers setup, run, tool list, and a sample input/output; security limitations named |
| Change hygiene | The diff is minimal and scoped; error messages stayed actionable |

Then `npm run verify:live` for the real backends. Verdict is **ready** or **blocked with a named
blocker** — not "probably fine".

*(Absorbed from the `mcp-release-checklist` authoring skill, archived 2026-08-03. That skill listed
`start` where the vocabulary is `smoke`, and omitted `verify:all`, `verify:live`, `contracts:check`
and `generate:check` entirely — the whole gate. This section is the corrected successor.)*

---

## 5. Test layers

| Layer | Where | Needs a build? | Catches |
|---|---|---|---|
| Package unit | `packages/*/src/**/*.test.ts` | no | primitives, the SDK pipeline, the guards |
| Server unit | `<server>/src/**/*.test.ts` | no (tsx) | tool definitions, response envelopes, config parsing |
| Script unit | `scripts/**/*.test.mjs` | no | agent-config discovery, env aliases, the manifest shim |
| Integration harnesses | `codebase-index-mcp/scripts/test/*.mjs` | **yes** | extraction, graph resolution, the refactor engine |
| Smoke | `<server>/scripts/smoke-test.mjs` | **yes** | module init order, transport wiring, startup failure |
| Contract | `contracts/` via `contracts:check` | **yes** | any change to `tools/list` |
| Live smoke | `verify:live` | yes + credentials | the real backends |

Two properties worth knowing:

- **`@mcp/testing` routes through the real `dispatchToolCall`.** Validation, guards, error mapping
  and profile serialization are production code paths, so a test that passes there cannot pass for a
  reason the server would not reproduce.
- **`contracts:check` is also the boot check.** It starts all six servers over a real stdio
  handshake with placeholder env, which is what catches a module that compiles but cannot load.

Server test files were type-checked by **nothing** before S-39 — each server's build excludes
`*.test.ts` and the root `tsconfig.test.json` covers `packages/` only. Each server now has its own
`tsconfig.test.json` and `typecheck` runs both passes.

---

## 6. Changing something — the loop

| You changed | Then |
|---|---|
| A package | `npm run build:packages` — servers read `dist/`, not source |
| A tool's shape | `contracts:update -- --server <key>`, **read the diff**, `generate:all` |
| An env var | edit `packages/manifest/src/envSpecs/<server>.ts`, then `generate:all` |
| A server's `src/` | `npm run build` in that server, then restart it in your agent (`/mcp`) |
| A file's location | **`rm -rf dist && npm run build`** — see §7 |
| A doc | nothing, unless it is inside `<!-- BEGIN/END GENERATED -->` markers, in which case you edited the wrong file |

### The generated files

```bash
npm run generate:all      # tools → .env.example → README blocks
npm run generate:check    # fails on drift
```

Rendered from `@mcp/manifest`: each server's `.env.example`, the marked blocks in its `README.md`,
and its tool list. Everything outside the markers is preserved byte-for-byte. `mcp:doctor` reports a
stale generated file per server as a warning.

---

## 7. The two things that will waste your afternoon

### `tsc` does not prune `dist/`

After renaming or moving a source file, the old compiled module stays at the old path **and still
loads**. Anything importing by path — the `.mjs` harnesses under `scripts/`, or your own probe
script — silently keeps running the stale code. This has already produced one verification that
reported *"identical"* while executing the previous build.

```bash
rm -rf dist && npm run build      # there is no `clean` script for servers
npm run mcp:doctor                # reports "WARN dist stale build output: …" (backlog B-12)
```

Run the doctor after any rename, before you trust a measurement.

### Generated files are not editable

Editing `<server>/.env.example` or a `<!-- BEGIN/END GENERATED -->` block by hand works right up
until the next `generate:all` silently reverts it. `generate:check` catches it — but only inside
`verify:all`, and **not in CI**, so a hand-edit can survive a push. Edit
`packages/manifest/src/envSpecs/<server>.ts` instead.

---

## 8. Debugging

**Nothing may write to stdout.** On a stdio transport, stdout *is* the protocol channel — a stray
write corrupts the stream. `console.log` is a guard finding; the injected `@mcp/core` logger writes
to stderr, and `createMcpServer` redirects `console.*` to stderr on start (`protectStdout`, default
true).

```ts
ctx.logger.info("event_name", { field: value });   // already scoped with tool + requestId
```

Redaction happens in the logger, not at each call site, so it cannot be forgotten. Never return a
credential from `describeConfig` — it reaches both stderr and the `health_check` payload. Report
whether a secret is *present*, not what it is.

### When a server will not start

1. `npm run mcp:doctor -- --server <key>` — `build` / `config` / `env` / `skill` / `start`, and it
   never prints a secret value.
2. `npm run smoke` in the server — a real handshake, with the failure in the open.
3. `npm run contracts:check` — boots all four with placeholder env; if this passes and your agent
   does not, the problem is configuration, not code.
4. Read the `config` line from the doctor. A server registered under an unexpected
   `<key>-<suffix>` shows up there and nowhere else.

### Common failures

| Symptom | Cause |
|---|---|
| `ERR_MODULE_NOT_FOUND` on `@mcp/manifest` | packages not built — `npm run build:packages` |
| A server builds but a script fails to import from `dist/` | stale `dist/` — `rm -rf dist && npm run build` |
| `contracts:check` red after an unrelated change | you edited a tool description or schema; read the diff before re-snapshotting |
| `generate:check` red | a hand-edit to a generated file, or a manifest change without `generate:all` |
| `tier/unknown-package` | a new package with no row in `packages/cli/src/guards/rules.ts` |
| `codebase-index` rejects a path | pass the **exact** `repoPath` string `list_repositories` returned — do not change drive-letter casing or slash style |
| `better-sqlite3` fails to build | install VS C++ Build Tools — there is no fallback backend (MCP-ISSUE-061(j)) |

---

## 9. Working with the MCP servers themselves

This repo is indexed by its own `codebase-index` server. `.claude/rules/mcp-hard-mode.md` is the
operating policy — MCP-first for code analysis, with `search_regex` / `get_symbol_source` in place of
grep and `read_file`, and `rename_assist` / `refactor_replace_preview` in place of hand-editing many
files.

Registered repoIds: **`mcp-local`** (this workspace) and **`codebase-index-mcp`** (the sub-project).

Keep `watch_repo` off unless actively debugging, and stop it immediately after.

### One shared codebase-index over HTTP (R4)

By default every Claude session spawns its own `codebase-index` over stdio, so the index runtime sits in
memory once per session. Served over HTTP instead, one process on `127.0.0.1` answers them all:

```bash
node scripts/install-mcp.mjs --server codebase-index --transport http   # env file + http registration
node scripts/serve-http.mjs --server codebase-index                      # run it (foreground)
node scripts/serve-http.mjs --server codebase-index --task print         # the logon task; --task register adds it
npm run mcp:doctor -- --server codebase-index                            # [http]: 401 without the token, initialize with it
node scripts/install-mcp.mjs --server codebase-index --transport stdio  # back to one process per session
```

- The installer moves the server's env into `~/.claude/mcp/http/codebase-index.env.json`, adding
  `CODEBASE_INDEX_HTTP_PORT` (default 7341) and a generated `CODEBASE_INDEX_HTTP_TOKEN`; the Claude Code
  entry becomes `{ type: "http", url, headers: { Authorization } }`. Re-runs keep both. The stdio entry it
  replaced is kept in `~/.claude/mcp/stdio/codebase-index.json` (never overwritten by an http one), which is
  where the `code-stdio` profile of `~/.claude/mcp/build-profiles.mjs` takes its entry from.
- **The logon task** (`--task register`) is registered from an XML definition (`schtasks /Create /XML`, no
  elevation), not from `schtasks` flags. Triggers: the current user's logon, plus daily 08:00 with
  `StartWhenAvailable` (a missed 08:00 runs on wake). Settings: `IgnoreNew` for a second instance, and
  not stopped or refused on battery, no execution limit. The flag form refuses to start on battery, kills the
  server when the laptop leaves AC (the 26 Oct outage), caps a run at 72 h and cuts `/TR` at 261
  characters (the `--log` path). It does not run all day by design: a shutdown ends the server, the next
  logon or morning starts it. No repetition, restart loop or service. A task first registered from an
  elevated prompt has an ACL that gives its user read only, so a normal prompt gets "Access is denied" on
  `/F` (and on `/Delete`): delete it once from an elevated prompt, then `--task register` replaces it freely.
- The server listens only when started with `--transport http`; an HTTP port in a stdio entry's env is
  ignored. It binds 127.0.0.1, refuses a foreign `Host`/`Origin` (403) and a missing token (401).
- Shared across clients: the store, the watchers and the refresh worker. Per client: the protocol
  session and refactor previews — a preview made by one client process is refused to another
  (`PREVIEW_OWNED_BY_ANOTHER_SESSION`; MCP-ISSUE-108, below). A client leaving does not stop a watcher or the
  process.
- **Dev cycle changes:** after `npm run build`, `/mcp` reconnects to the *running* process; it does not
  restart it. Run `node scripts/serve-http.mjs --server <key> --restart` to load a new build: it kills the
  tree that owns the port, `schtasks /Run`s the task, waits for a new listener and prints `old -> new` pid
  (`schtasks /End` does not stop the supervisor).
  `mcp:doctor`'s `[running]` check reports a served process older than `dist/`.

#### After the served process restarts

- **No `/mcp` is needed** (MCP-ISSUE-103). At initialize the transport records each session id with the
  sha256 of the bearer that opened it, in `<state dir>/http-sessions.json`. The state dir is
  `.codebase-index-state` beside the index DB. After a restart, a request carrying that id and that bearer is
  re-adopted. A different bearer (the token rotated) gets 404 and must re-initialize. Every client shares the
  one bearer, so this proves the caller holds the server's token, nothing more.
- **Previews survive because ownership is per client process** (MCP-ISSUE-108), not because the session does.
  Claude Code does not resend its old session id after a restart; it silently initializes a new session. A
  refactor preview or rollback is owned by the client process — its pid (resolved from the loopback socket),
  that process's start time (so a reused pid is someone else) and the bearer — so the new session of the same
  Claude process still applies and rolls back what it made before the restart. Another Claude session is
  another process and is refused, before and after a restart. If the pid or its start time cannot be resolved,
  the owner falls back to the session id, which a restart does not keep (fail closed). Resuming a conversation
  in a new Claude process (`claude --resume` / `--continue`, or any restart of Claude) is a new pid: it cannot
  apply the old process's previews; make new ones (previews expire after 30 min anyway). Over stdio the owner
  is the server's parent process.
- **The approval secret persists** (MCP-ISSUE-104). `serve-http` creates
  `~/.claude/mcp/http/codebase-index.approval-secret` on first start: 64 hex characters, owner-only
  (`icacls /inheritance:r /grant:r <user>:F` on Windows). It reuses the file and passes it as
  `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` unless the env file sets one, so approval tokens outlive a
  restart. Over HTTP the server refuses to start without a secret; over stdio it generates one per process.
  Deleting the file invalidates every outstanding token.
- **Watchers are not restored, by policy.** The index is watchless by default
  (`CODEBASE_INDEX_WATCH_AUTO_START_ENABLED=false`, *Watch Usage Playbook* in `.claude/rules/mcp-hard-mode.md`).
  A `watch_repo` started before the restart is gone; start it again if the debug session still needs it.
- **In-flight runs are not resumed.** A run cut off by the restart wrote no run record, so the next query's
  freshness gate sees the tree as unindexed and starts its refresh again. Its marker
  (`running-<repo>-<pid>-<n>.json`) names a dead pid and is ignored (MCP-ISSUE-101 part 5). The exception is an
  explicit `index_repository` with `mode: "full"` on a clean tree: the gate cannot tell it was cut off, so run
  it again.
- **After switching a server's transport (stdio ↔ http), restart each Claude session.** `/mcp` reconnect
  only re-dials the new entry; it does not reap the old stdio child, which stays alive under the session
  (seen on the R4 rollout: a stdio `dist/index.js` still running after the http switch) and keeps its own
  index runtime in memory. To tell which process answered, compare `health_check.server.pid` /
  `buildAt` with the served process.

---

## 10. Before you commit

```bash
npm run verify:all
```

Then read [Contribution Guide](../../CONTRIBUTING.md) for the commit and review conventions.

---

## Related

- [Onboarding](../guides/onboarding.md) · [Contribution Guide](../../CONTRIBUTING.md)
- [Server Development Guide](../servers/server-development.md) · [Tool Development Guide](../servers/tool-development.md)
- [Conventions](../reference/conventions.md) — every rule, sorted by what enforces it
- `docs/development/ci.md` — what CI covers and what it deliberately does not
