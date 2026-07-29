# mcp-local

A workspace of four independent local MCP servers with a single, data-driven installer,
a health **doctor**, and auto-generated native Claude Code skills. Each server has its own
`package.json` / `tsconfig.json` / `dist/` — this is **not** a monorepo with shared packages.
All are TypeScript 5.7+ ESM built on `@modelcontextprotocol/sdk`.

## Servers

| Key | Directory | What it does |
|-----|-----------|--------------|
| `codebase-index-local` | `codebase-index-mcp/` | Code graph indexing: symbols, call chains, impact analysis, safe rule-based refactors. **No runtime LLM.** |
| `postgres-mcp` | `postgres-mcp/` | Read-only Postgres access with SQL guardrails; gated data writes + EF Core migration tooling. `prod` is force read-only. |
| `observe-mcp` | `observe-mcp/` | Read-only log/trace search over OpenObserve for the CommunicationHub backend. |
| `bitbucket-mcp` | `bitbucket-mcp/` | Read repositories / pull requests and **create PRs** on Bitbucket Cloud (write gated). |

The source of truth for every server (dir, entry point, tools, env vars, skill template) is
`packages/manifest` (`@mcp/manifest`). The installer, doctor, updater, and skill generator all
read from it.

## Workspace commands

Run these from the **workspace root**. Each dispatches to a data-driven script over the manifest.

| Command | Script | Purpose |
|---------|--------|---------|
| `npm run setup` | `install-mcp.mjs` | Install deps → build (+ guards) → detect agents → prompt for env → write MCP config → generate & install skills → verify start → smoke test. Runs **all** servers by default. |
| `npm run mcp:install` | `install-mcp.mjs` | Alias of `setup`. |
| `npm run mcp:doctor` | `mcp-doctor.mjs` | Health report per server: `build` / `config` / `env` / `skill` / `start`. Never prints secret values. |
| `npm run mcp:update` | `update-mcp.mjs` | Rebuild → regenerate & reinstall skill → verify start, **in place**. Does not touch your configured env. |
| `npm run mcp:uninstall` | `uninstall-mcp.mjs` | Remove a server from every detected agent config and delete its skill. Config is backed up first; source/`dist/` left untouched. |

### Scoping to one server

`install` and `doctor` act on **all** servers when no target is given.
`update` and `uninstall` **require** an explicit `--server <key>` or `--all`.

Pass npm script args after `--`:

```bash
# One server only
node scripts/install-mcp.mjs --server postgres-mcp
npm run mcp:doctor -- --server codebase-index-local
npm run mcp:update -- --server observe-mcp
npm run mcp:uninstall -- --server bitbucket-mcp

# All servers (update/uninstall need it explicitly)
npm run mcp:update -- --all
npm run mcp:uninstall -- --all
```

Known keys: `codebase-index-local`, `postgres-mcp`, `observe-mcp`, `bitbucket-mcp`.

### Command flags

| Command | Flags |
|---------|-------|
| `install` | `--server <key>` (repeatable), `--yes` / `-y` (non-interactive, use defaults), `--skip-smoke` |
| `doctor` | `--server <key>`, `--skip-start` (skip the spawn/`initialize` check) |
| `update` | `--server <key>`, `--all` |
| `uninstall` | `--server <key>`, `--all` |

### Typical flows

```bash
# First-time setup of everything, interactive prompts for env
npm run setup

# Non-interactive install of just the codebase index server with defaults
node scripts/install-mcp.mjs --server codebase-index-local --yes

# Check health after a machine change or config edit
npm run mcp:doctor

# After pulling new code: rebuild + refresh skills for all servers
npm run mcp:update -- --all
```

## What install writes

- **MCP config** into each detected agent (`~/.claude.json` for Claude Code) — this is where
  env values (including secrets) live, per the workspace convention.
- **Native skills** rendered from each `<server>/skill/SKILL.md` template into
  `~/.claude/skills/<key>/` (global) and `.claude/skills/<key>/` (project). These generated
  dirs are gitignored (machine-specific paths); the committed source of truth is the template.

Restart your code agent after install/update/uninstall so the config change takes effect.

## Per-server development

Each server builds and runs on its own:

```bash
cd codebase-index-mcp        # or postgres-mcp / observe-mcp / bitbucket-mcp
npm run build                # tsc → dist/
npm run typecheck            # type check only
npm run dev                  # run from source with tsx
node scripts/smoke-test.mjs  # integration test (requires build first)
```

`codebase-index-mcp` additionally has `npm run guard:no-llm-runtime` (enforces the no-LLM policy)
and `npm run benchmark:plan:check` (compact-mode token-savings gate). See its `CLAUDE.md` /
`README.md` for the full pre-commit sequence and tool catalog.

## Generated files

A server's `.env.example`, its README's `<!-- BEGIN/END GENERATED -->` blocks, and its tool list
are rendered from the manifest — edit `packages/manifest/src/envSpecs/<server>.ts`, then run
`npm run generate:all`. `npm run generate:check` fails on drift and runs inside `verify:all`.

## Adding a new server

```bash
npm run new:server -- --key myserver      # scaffold + build + typecheck + test + smoke
```

The scaffold is **not registered** — that is a separate step, and it has an ordering constraint:
`servers.ts` throws for a server with no generated tool list, the list comes from `contracts/`, and
a snapshot needs a built server. The generated README spells out the four commands. See the
`mcp-skill-authoring` skill.

## References

- `CLAUDE.md` — workspace guidance, critical constraints, MCP-first operating rules
- `AGENTS.md` — env var reference, common pitfalls, integration config examples
- `packages/manifest/README.md` — single source of truth for all servers and their env vars
- `<server>/README.md` — per-server tool catalog and usage
