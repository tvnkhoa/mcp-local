# Continuous Integration

What CI runs, what it deliberately does not, and the script vocabulary that makes the root
aggregates work.

**Workflow** — `.github/workflows/ci.yml`, `windows-latest`, Node 22
**Introduced by** — migration step S-05 (with S-02, S-03, S-04). That record is now in
`docs/archive/migration/status.md`; **this file is current-state and is maintained.**

Before this, the repository had no CI. The documented gate was five commands typed by hand, and it
covered one of the four servers.

---

## What runs

```
npm ci                     # workspace packages
npm run build:packages     # servers consume packages/*/dist via file: deps — must come first
npm run install:servers    # npm ci in each server (not workspace members)
npm run typecheck:tests
npm run test:packages      # all six packages (see note below for current counts)
npm run guard:all          # dependency-tier + convention + file-size guards
npm run build:servers
npm run typecheck:servers
npm run test:servers       # all four servers (see note below for current counts)
npm run contracts:check    # boots all four over stdio, diffs tools/list
npm run benchmark:plan:check   # compact-mode token savings ≥ 40%
```

Locally the same set is **`npm run verify:all` minus `install:servers` and `benchmark:plan:check`, plus
`test:scripts` and `generate:check`** — see [`development.md`](./workflow.md) §4 for the difference in
both directions.

### Test counts — re-derive, do not read

Counts here went stale twice (the `@mcp/sdk` suite roughly doubled and `@mcp/manifest` was added
without this list noticing). Measured **2026-08-03**:

| Packages | | Servers | |
|---|---|---|---|
| `@mcp/core` | 28 | `codebase-index` | 34 `test:*` scripts (32 harnesses + unit + integration) |
| `@mcp/sdk` | 97 | `postgres-mcp` | 64 |
| `@mcp/shared` | 50 | `observe-mcp` | 56 |
| `@mcp/manifest` | 26 | `bitbucket-mcp` | 25 |
| `@mcp/cli` | 20 | | |
| `@mcp/testing` | 16 | | |

```bash
npm run test:packages          # per-package totals
npm run test:servers           # per-server totals
```

## What it does **not** cover

**No live backends.** There is no Postgres, no OpenObserve and no Bitbucket in CI, and **no secrets
are configured**. Nothing in the pipeline can reach a real system.

That has one concrete consequence worth stating plainly: **`npm run smoke:servers` does not run in
CI.** The four `<server>/scripts/smoke-test.mjs` files are live integration tests — they authenticate, query
real data, and in bitbucket-mcp's case exercise a `create_pull_request` dry run. They need
credentials, so they stay a local step:

```bash
npm run verify:live      # requires real credentials in the environment
```

`verify:all` is deliberately credential-free so that it means the same thing on a fresh clone, on a
developer's machine, and in CI. Adding the live smoke tests to it would make the workspace's main
gate fail for anyone without production access.

### What covers the gap

`generate:check` sits alongside it and is pure comparison: it re-renders every generated file
(`.env.example`, the README blocks, the tool lists) from the manifest and fails if the committed
copy differs. No server is started, so it costs milliseconds.

`contracts:check` is the credential-free boot check. It starts **all four servers over a real stdio
MCP handshake** with placeholder environment values synthesized from `@mcp/manifest`,
completes `initialize`, and calls `tools/list`. A server that compiles but cannot load fails here.

That is not a hypothetical: two bugs in this migration were temporal-dead-zone `const` errors that
passed typecheck and passed every unit test, and only appeared when the module was actually
executed. Boot coverage is the reason CI can be trusted at all without live backends.

What remains genuinely untested by CI: real query execution, real authentication, real API
pagination, and the EF Core migration tooling (which shells out to `dotnet`). Those are what
`verify:live` is for, and they should be run before a release.

## `verify:live` stays local — decided 2026-08-03

**No credential goes into CI. Not in `ci.yml`, and not in a second workflow either.**

A `verify-live.yml` was written on 2026-08-03 for backlog B-05 — separate workflow, weekly schedule,
secrets in a `live-backends` environment, fail-fast when a secret name is unset — and **deleted the
same day, without ever running.**

B-05 assumed the credential-free main gate was the thing worth protecting, so a *separate*
credentialed workflow was an acceptable price. The decision taken instead is stronger: the live
credentials — an RDS connection string, an OpenObserve basic-auth header, a Bitbucket API token —
are not copied into GitHub at all. Each one added is another place to leak from, another rotation
obligation, and another audience. The credential-free property then becomes something this repo
*has* rather than something it maintains.

That trade is only available because this workspace has one operator on one machine. A team would
need the second workflow, and reopening this needs that to have changed.

**What it costs, stated plainly.** Nothing exercises real query execution, real authentication, real
API pagination, or the EF Core migration tooling until somebody runs `npm run verify:live` with
credentials in the local environment. A broken client path stays invisible until that happens. This
is the residual risk B-05 existed to remove, and here it is **accepted rather than solved** — the
release checklist is the whole mechanism.

What CI still covers regardless: `contracts:check` boots all four servers over a real stdio
handshake with placeholder env on every push, so a module that compiles but cannot load is caught.
The gap is specifically *reaching a backend*, not loading its client.

## Why Windows

`better-sqlite3` and `tree-sitter` build natively, and the path normalization this workspace does —
drive letters, slash direction, the allowlist matching in `codebase-index-mcp` — is Windows-specific
behaviour that a Linux runner would not exercise. Matching the development environment was worth
more than portability here. A Linux matrix entry can be added later; it is deliberately not part of
S-05.

## Script vocabulary (S-02 / S-03)

CI needs every server to answer to the same commands. All four now have:

| Script | Meaning |
|---|---|
| `build` | compile to `dist/` |
| `typecheck` | no emit |
| `test` | the package's own suite, credential-free |
| `smoke` | live end-to-end check, **needs credentials** |

`codebase-index-mcp` had a couple of dozen individually-invoked `test:*` scripts and no aggregate (34
today, of which 32 are integration harnesses). Its `test` is
now `codebase-index-mcp/scripts/run-tests.mjs`, which **discovers** the list from its own `package.json` rather than
hard-coding it — a chain of `&&`s falls silently behind the first time someone adds a test script
and forgets to append it. `benchmark:plan:check` is explicitly excluded there, with the reason
recorded in the script, and runs as its own CI step.

`bitbucket-mcp`'s `smoke-test` was renamed to `smoke`; the old name is kept as an alias.

## Root aggregates (S-04)

The servers are deliberately **not** npm workspace members — their native dependencies must not be
hoisted or deduplicated — so `npm run --workspaces` cannot reach them. `scripts/run-servers.mjs` is
the equivalent, driven by the same `@mcp/manifest` the installer and doctor use, so a
newly registered server is covered without editing the runner or the workflow.

It reports a missing script rather than skipping quietly, and `--continue` runs every server before
reporting so one CI run names every broken package instead of only the first.

| Root script | Runs |
|---|---|
| `verify:packages` | build + typecheck:tests + test + guards, for `packages/*` |
| `verify:servers` | build + typecheck + test, for all four servers |
| `verify:all` | `verify:packages` + `verify:servers` + `contracts:check` + **`generate:check`** — credential-free |
| `verify:live` | `smoke:servers` — **needs credentials** |
