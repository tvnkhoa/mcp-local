# Architecture — as built

What this workspace *is*, as of 2026-08-03 (post-migration, after the standard-structure refactor
and the SDK builder family).

> This is the **as-built** description. The **design** — the reasoning behind the tier model, the
> rules it implies, and what was deliberately not done — is `architecture/target-architecture.md`,
> whose §9 reconciles that design against reality. Two files, because a design document that is
> silently edited to match whatever shipped stops being a design document.
>
> The name sits awkwardly beside the `architecture/` directory. Kept because the migration plan
> names this path, and a doc nobody can find is worse than one with an awkward name.

---

## 1. Shape

Four independent MCP servers over a six-package platform:

```
packages/            the platform — npm workspace, compiled with tsc -b
  core     tier 0    zero-dependency primitives: env reader, paths, result types
  sdk      tier 1    the ONLY importer of @modelcontextprotocol/sdk
  shared   tier 2    capabilities; must never reach the protocol layer
  testing  tier 3    harness helpers
  cli      tier 4    the guards (`mcp-platform guard …`)
  manifest tier 5    workspace tooling data: which servers exist, their env, their tools

codebase-index-mcp/  43 tools   code graph indexing and analysis      (SQLite, tree-sitter)
postgres-mcp/        17 tools   PostgreSQL, read-only by default      (writes/migrations gated)
observe-mcp/          8 tools   OpenObserve logs and traces           (read-only)
bitbucket-mcp/        8 tools   repos and pull requests               (PR creation gated)
```

**76 tools and 98 env variables** in total (env: 41 / 23 / 23 / 11), both counted from
`@mcp/manifest` rather than by hand:

```bash
node -e "import('@mcp/manifest').then(m => m.SERVERS.forEach(s => console.log(s.key, s.tools.length, s.env.length)))"
```

**Servers are not workspace members.** `workspaces` is `["packages/*"]` only. This is a decision,
not an oversight — see `adr/0001-workspace-native-deps.md`: npm hoisting would relocate
`better-sqlite3`'s native binary, and a hoisted duplicate package makes `instanceof` fail across
package boundaries. The cost is that a fresh clone needs `npm run build:packages` before any server
builds, because servers consume `packages/*/dist` through `file:` dependencies.

## 2. What holds it together

Three mechanisms, in decreasing order of how much they actually prevent:

**The guards** (`packages/cli`) turn the dependency rules into a build failure. `guard deps`
enforces the tier matrix, the single protocol-SDK importer, the zero-dependency tier, one env reader
per server, and that no server imports another server or the tooling packages. `guard convention`
enforces required files and scripts, file size caps, no default exports, and no `console.log`. The
tier matrix lives as data in `packages/cli/src/guards/rules.ts`, so adding a package forces an
explicit decision about what it may import — at review time, not later.

**The contract snapshots** (`contracts/`) pin each server's `tools/list` output. `contracts:check`
boots all four servers over a real stdio handshake with placeholder env, which is the check that
catches a module that compiles but cannot load. A change to a tool's shape is a reviewed diff.

**The generated artifacts.** Each server's `.env.example`, the marked blocks in its `README.md`, and
its tool list are rendered from `@mcp/manifest`. `generate:check` fails on drift. This exists
because before it, answering "what does this server read from the environment?" required booting the
server and proxying `process.env` — no file could answer it.

## 3. The gate

```bash
npm run verify:all     # packages + servers + contracts + generated docs. Credential-free.
npm run verify:live    # the four live smoke tests. NEEDS REAL CREDENTIALS.
```

CI (`.github/workflows/ci.yml`, Windows + Node 22) runs the same steps, credential-free: it adds
`install:servers` and `benchmark:plan:check`, and omits only `test:scripts`. `verify:live` reaches
real Postgres / OpenObserve / Bitbucket and is not in CI; run it before a release.

## 4. Safety posture

Every destructive capability is off by default and gated by an explicit env flag parsed strictly
(exact `"true"` or `"1"` — no trimming, no casing), then guarded by `preview → apply → rollback`
with an HMAC approval token bound to the previewed plan.

| Server | Off by default | Notes |
|---|---|---|
| postgres-mcp | `POSTGRES_WRITE_ENABLED`, `POSTGRES_MIGRATION_ENABLED` | read path permits only `SELECT` / `WITH … SELECT`; **`prod` is force read-only regardless of config**. S-43 renamed all vars to `POSTGRES_*`; every pre-rename name (`CH_*`, `PG_*`, `MCP_DB_*`) is still honoured with a one-time deprecation warning |
| bitbucket-mcp | `BITBUCKET_WRITE_ENABLED` | `create_pull_request` supports `dryRun` |
| codebase-index-mcp | refactor apply requires an HMAC token | `CODEBASE_INDEX_LLM_ENABLED=true` **fails startup by design** |

The no-LLM policy in `codebase-index-mcp` is a hard constraint, verified statically by
`guard:no-llm-runtime`: no LLM client import may exist in `src/`. Every refactor decision is
`decisionSource=rule_engine`, `llmInvolved=false`.

## 5. Inside a server

All four lay out the same nine slots, and a folder exists **only** where the server has that
concern — an empty `prompts/` would advertise a capability that is not there:

```
src/  index.ts
      tools/          declarations + handlers/
      resources/      resources/list + resources/read providers
      prompts/        (none of the four declares one)
      middleware/     guardrails, response serialization, error mapping
      services/       domain logic
      repositories/   persistence
      config/         the only reader of process.env
      types/          shared types + schemas/
```

A call goes `resolve → profile → validate → guards → handle → serialize`, and nothing throws out of
dispatch. Two hooks let a server keep an established contract while adopting the platform:
`formatError` (its own failure envelope) and `renderResult` (its own payload-to-text hop, which for
`codebase-index-mcp` is where telemetry is emitted).

Per-server map, the rule that decides which slot a file belongs in, and the N/A slots:
`refactor/standard-structure-report.md` and [`folder-convention.md`](../reference/folder-convention.md).

## 6. Where to read next

| Question | File |
|---|---|
| How do I get running? | [`onboarding.md`](../guides/onboarding.md) |
| What do I run before committing? | [`development.md`](../development/workflow.md) |
| What are the rules, and which are enforced? | [`conventions.md`](../reference/conventions.md) |
| Where does this file go? / may this import that? | [`folder-convention.md`](../reference/folder-convention.md), [`dependency-rules.md`](../reference/dependency-rules.md) |
| How do I add a tool or a server? | [`tool-development.md`](../servers/tool-development.md), [`server-development.md`](../servers/server-development.md) |
| What is each package for? | [`packages.md`](../reference/packages.md) |
| Why is it shaped this way? | `architecture/target-architecture.md` |
| What did the old repo look like? | `architecture/audit-report.md` (audited at `01c532e`) |
| Why are servers outside the workspace? | [`../decisions/0001-workspace-native-deps.md`](../decisions/0001-workspace-native-deps.md) |
| Why do three SQL token lists differ? | [`../decisions/0002-sql-guardrail-token-lists.md`](../decisions/0002-sql-guardrail-token-lists.md) |
| What happened, step by step? | [`../archive/migration/README.md`](../archive/migration/README.md) |
| What does CI cover, and not? | `migration/ci.md` |
| What is left? | [`backlog.md`](../development/backlog.md) |
