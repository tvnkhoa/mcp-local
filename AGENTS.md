# AGENTS.md

Cross-agent entry point for the `mcp-local` workspace: four MCP servers on a six-package platform.

**This file points; it does not copy.** [`CLAUDE.md`](CLAUDE.md) is the full agent guide, and
[`docs/README.md`](docs/README.md) is the documentation portal. Everything below is either a hard
constraint or a link to the one document that owns the topic.

## Where to look

| You need | Read |
|---|---|
| Full agent guidance — commands, architecture, MCP-first rules | [`CLAUDE.md`](CLAUDE.md) |
| The documentation portal | [`docs/README.md`](docs/README.md) |
| Get running from a fresh clone | [`docs/guides/onboarding.md`](docs/guides/onboarding.md) |
| The day-to-day loop and the gate | [`docs/development/workflow.md`](docs/development/workflow.md) |
| Add or change a server / a tool | [`docs/servers/README.md`](docs/servers/README.md) |
| Every rule, and what enforces it | [`docs/reference/conventions.md`](docs/reference/conventions.md) |
| MCP-first operating policy for code analysis | `.claude/rules/mcp-hard-mode.md` |
| The largest server's internals | [`codebase-index-mcp/CLAUDE.md`](codebase-index-mcp/CLAUDE.md) |

## The gate

```bash
npm run verify:all     # packages + servers + tool contracts + generated docs. Credential-free.
```

Run this before committing — **not** a hand-assembled sequence of per-package commands. What it
expands to, and the two directions in which CI differs from it, are in
[`docs/development/workflow.md`](docs/development/workflow.md) §4.

## Hard constraints

These four are the ones an agent can violate without noticing.

| Constraint | Effect |
|---|---|
| **No runtime LLM in `codebase-index-mcp`** | `CODEBASE_INDEX_LLM_ENABLED=true` fails start-up by design; `npm run guard:no-llm-runtime` verifies statically that no LLM client is imported. Never relax this |
| **Path allowlist** | `CODEBASE_INDEX_ALLOWED_ROOTS` is the only required env var in the workspace. Always pass the **exact** `repoPath` string `list_repositories` returned — do not change drive-letter casing or slash style |
| **`postgres-mcp` is read-only by default** | Only `SELECT` / `WITH … SELECT`, single statement. Writes and migrations are off unless their env flag is set, and **`prod` is force read-only regardless of config** |
| **Generated files are not editable** | Each server's `.env.example`, its README's `<!-- BEGIN/END GENERATED -->` blocks, and its tool list are rendered from `packages/manifest`. Edit the manifest, then `npm run generate:all` |

Full statements: [`CLAUDE.md`](CLAUDE.md) §"Critical Constraints" and
[`docs/reference/conventions.md`](docs/reference/conventions.md).

## Environment variables

**Do not look for a list here.** All **98** are declared once, in
`packages/manifest/src/envSpecs/<server>.ts`, and rendered into two places that cannot drift:

- `<server>/.env.example` — every variable the server reads, with its default
- the generated env table in each `<server>/README.md`

```bash
node -e "import('@mcp/manifest').then(m => m.SERVERS.forEach(s => console.log(s.key, s.env.length)))"
```

This file previously hand-listed 21 of the 98, which is how it came to name variables that S-43 had
renamed. The generated tables are the single source of truth.

## Per-server documentation

| Server | Docs |
|---|---|
| `codebase-index` | [README](codebase-index-mcp/README.md) — 43-tool catalogue and MCP host configuration · [CLAUDE.md](codebase-index-mcp/CLAUDE.md) — internals, graph model, extractor rules · [decision tree](codebase-index-mcp/docs/decision-tree.md) · [examples](codebase-index-mcp/docs/examples.md) · [issue registry](codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md) |
| `postgres-mcp` | [README](postgres-mcp/README.md) · [issue registry](postgres-mcp/docs/mcp-postgres-issue-registry.md) |
| `observe-mcp` | [README](observe-mcp/README.md) |
| `bitbucket-mcp` | [README](bitbucket-mcp/README.md) |

Manual MCP host configuration — both profiles — is in
[`codebase-index-mcp/README.md`](codebase-index-mcp/README.md) §"MCP Host Configuration", though
`npm run setup` writes it for you.

## Filing a defect

Use a stable id (`MCP-ISSUE-NNN`, `PG-XXX-NNN`) in the registry for the affected server, linked above.
Record: scenario · tool attempted · expected vs actual · impact · workaround · enhancement proposal.
The rule for when logging is mandatory is in `.claude/rules/mcp-hard-mode.md`.
