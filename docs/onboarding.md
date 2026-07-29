# Onboarding

From a fresh clone to four working MCP servers.

---

## Three commands

```bash
npm install            # workspace packages (packages/* only — see note below)
npm run setup          # build packages, then install + build + register every server
npm run verify:all     # the gate: packages, servers, tool contracts, generated docs
```

`verify:all` exiting 0 means you have a working install. It is credential-free by design, so it
means the same thing here as it does in CI.

**Why `npm install` is not enough on its own.** `workspaces` covers `packages/*` only — servers are
deliberately outside it (`adr/0001-workspace-native-deps.md`: hoisting relocates `better-sqlite3`'s
native binary, and a hoisted duplicate makes `instanceof` fail across package boundaries). So each
server has its own `node_modules`, and `npm run setup` is what installs them. `setup` also runs
`build:packages` first, because servers consume `packages/*/dist` through `file:` dependencies — a
fresh clone cannot build a server before the packages exist.

### If `npm run setup` fails on `better-sqlite3`

Windows needs Visual Studio C++ Build Tools to compile it. Install those, or switch
`codebase-index-mcp` to the JS-only SQLite backend. Nothing else in the workspace needs a native
build.

---

## Then: point it at your code

`codebase-index-mcp` refuses to touch anything outside an explicit allowlist. It is the only
required environment variable in the workspace:

```
CODEBASE_INDEX_ALLOWED_ROOTS=D:/1.SourceCode/mcp-local,D:/1.SourceCode/crm
```

Comma-separated absolute paths. Once indexing, **always pass the exact `repoPath` string that
`list_repositories` returns** — do not change drive-letter casing or slash style. A mismatch is
rejected by the allowlist, and the error looks like a permissions problem rather than a formatting
one.

The other three servers need credentials, all via env, none in code. Each server's `.env.example` is
generated from the manifest and lists every variable it reads.

---

## Checking your install

```bash
npm run mcp:doctor      # per-server: build, config, env, skill, generated files, start
```

Never prints secrets.

### Running one server against several environments

Register the same server more than once, with a suffix per backend, and each registration carries
its own credentials:

```
observe-mcp-ssdev_au        →  the dev OpenObserve
observe-mcp-wecrm_au_prod   →  the prod OpenObserve
```

This is supported, not a workaround. Doctor recognises `<key>` and `<key>-<suffix>`, **names every
instance it found**, and runs the env and start checks once per instance — because starting one of
them proves nothing about a sibling with different credentials:

```
PASS  config  registered in Claude Code as observe-mcp-ssdev_au, observe-mcp-wecrm_au_prod
PASS  env observe-mcp-ssdev_au required env keys present
PASS  env observe-mcp-wecrm_au_prod required env keys present
PASS  start observe-mcp-ssdev_au responded to initialize
PASS  start observe-mcp-wecrm_au_prod responded to initialize
```

Instances are listed by name rather than counted, so a registration you did not expect is visible
rather than quietly absorbed into the total. Read that line — it is the only place an orphaned or
misnamed entry shows up.

Until 2026-07-29 doctor matched the exact manifest key only, and reported this setup as
`config not registered` → env skipped → `start` **FAIL**, because it launched the process with no
credentials at all. If you see that on an install you believe is fine, check you are on a build
that includes the fix.

---

## Running things

```bash
# the gate — run this before every commit
npm run verify:all

# before a release only: reaches real Postgres / OpenObserve / Bitbucket
npm run verify:live

# narrower
npm run verify:packages
npm run verify:servers
npm run contracts:check
npm run guard:all
node scripts/run-servers.mjs <build|typecheck|test|smoke> [--server <key>]
```

Inside `codebase-index-mcp`, `npm run test` runs everything — unit tests first, then the integration
harnesses, since a compile-level break should not wait behind 29 of them.

---

## Two things that will waste your afternoon

**`tsc` does not prune `dist/`.** After renaming or moving a source file, the old compiled module
stays at the old path and still loads. Anything importing by path — the `.mjs` harnesses under
`scripts/`, or your own probe script — will silently keep running the stale code. This has already
produced one verification that reported "identical" while executing the previous build. When you
have moved files: `rm -rf dist && npm run build`. There is no `clean` script for servers.

**Generated files are not editable.** Each server's `.env.example`, the `<!-- BEGIN/END GENERATED -->`
blocks in its `README.md`, and its tool list come from `@mcp/manifest`. Edit
`packages/manifest/src/envSpecs/<server>.ts` (or `servers.ts`), then `npm run generate:all`.
`generate:check` runs inside `verify:all` and fails on drift, so a hand-edit will be caught — but
only after you have made it twice.

---

## Adding a server

```bash
npm run new:server -- --key <name>
```

Scaffolds from `templates/server/`, then builds, tests, and smoke-tests it. Then, by hand:

1. add an entry to `packages/manifest/src/servers.ts`
2. add its env contract as `packages/manifest/src/envSpecs/<name>.ts`
3. add a tier row in `packages/cli/src/guards/rules.ts` if it introduces a package

The installer, doctor, skill generator, and every root aggregate pick it up from the manifest — none
of them needs editing. The scaffold deliberately does *not* write the manifest entry: `servers.ts`
throws without a generated tool list, the tool list comes from `contracts/`, and the snapshot needs a
built server. See the `mcp-skill-authoring` skill.

---

## Where to go next

| | |
|---|---|
| What is this, as built? | `architecture.md` |
| What are the rules, and which are enforced? | `conventions.md` |
| Why is it shaped this way? | `architecture/target-architecture.md` |
| How do I use the codebase-index tools well? | `../.claude/rules/mcp-hard-mode.md` |
| Largest server's internals | `../codebase-index-mcp/CLAUDE.md` |
| Known server-side defects | `../codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` |
