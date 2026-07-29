# Continuous Integration

**Step** — S-05 (with S-02, S-03 and S-04, which it depends on)
**Workflow** — `.github/workflows/ci.yml`, `windows-latest`, Node 22

Before this, the repository had no CI. The documented gate was five commands typed by hand, and it
covered one of the four servers.

---

## What runs

```
npm ci                     # workspace packages
npm run build:packages     # servers consume packages/*/dist via file: deps — must come first
npm run install:servers    # npm ci in each server (not workspace members)
npm run typecheck:tests
npm run test:packages      # core 28, shared 50, sdk 50, testing 16, cli 13
npm run guard:all          # dependency-tier + convention + file-size guards
npm run build:servers
npm run typecheck:servers
npm run test:servers       # codebase-index 26 scripts, postgres 53, observe 41, bitbucket 25
npm run contracts:check    # boots all four over stdio, diffs tools/list
npm run benchmark:plan:check   # compact-mode token savings ≥ 40%
```

Locally the same set is `npm run verify:all` plus the benchmark gate.

## What it does **not** cover

**No live backends.** There is no Postgres, no OpenObserve and no Bitbucket in CI, and **no secrets
are configured**. Nothing in the pipeline can reach a real system.

That has one concrete consequence worth stating plainly: **`npm run smoke:servers` does not run in
CI.** The four `scripts/smoke-test.mjs` files are live integration tests — they authenticate, query
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

`codebase-index-mcp` had ~25 individually-invoked `test:*` scripts and no aggregate. Its `test` is
now `scripts/run-tests.mjs`, which **discovers** the list from its own `package.json` rather than
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
| `verify:all` | `verify:packages` + `verify:servers` + `contracts:check` — credential-free |
| `verify:live` | `smoke:servers` — **needs credentials** |
