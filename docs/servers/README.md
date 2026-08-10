# Servers

The four MCP servers, and how to add or change one.

## Building and changing

| | |
|---|---|
| [Server development](server-development.md) | Scaffolding, registering, and operating a server — including the ordering constraint that makes registration a separate step |
| [Tool development](tool-development.md) | Declaring, gating, testing and snapshotting a tool |

## The four servers

Each server's own `README.md` is its reference — the tool catalogue and env table there are
**generated from `@mcp/manifest`**, so they cannot drift. This table links out rather than restating
them.

| Key | Directory | What it does | Docs |
|---|---|---|---|
| `codebase-index` | `codebase-index-mcp/` | Code graph indexing: symbols, call chains, impact analysis, safe rule-based refactors. **No runtime LLM.** | [README](../../codebase-index-mcp/README.md) · [CLAUDE.md](../../codebase-index-mcp/CLAUDE.md) · [decision tree](../../codebase-index-mcp/docs/decision-tree.md) · [examples](../../codebase-index-mcp/docs/examples.md) · [issue registry](../../codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md) |
| `postgres-mcp` | `postgres-mcp/` | Read-only Postgres with SQL guardrails; gated writes + EF Core migrations. `prod` is force read-only. | [README](../../postgres-mcp/README.md) · [issue registry](../../postgres-mcp/docs/mcp-postgres-issue-registry.md) |
| `observe-mcp` | `observe-mcp/` | Read-only log/trace search over OpenObserve. | [README](../../observe-mcp/README.md) · [issue registry](../../observe-mcp/docs/mcp-observe-issue-registry.md) |
| `bitbucket-mcp` | `bitbucket-mcp/` | Read repositories / pull requests and **create PRs** (write gated). | [README](../../bitbucket-mcp/README.md) |

Counts (76 tools, 98 env vars) come from the manifest, not from this page —
[Architecture › As built](../architecture/as-built.md) §1 names the command.

## Operational skills

Each server also ships `<server>/skill/SKILL.md`, the committed template the installer renders into
`~/.claude/skills/<key>/`. It is the document an agent loads to *use* the server, as opposed to the
README, which is for a human reading about it. See [server-development.md](server-development.md) §3.

## Related

- [Reference › Folder convention](../reference/folder-convention.md) §2 — the nine-slot `src/` layout
- [`../../contracts/README.md`](../../contracts/README.md) — the golden `tools/list` snapshots
- [Development](../development/README.md) — the gate every server change must pass
