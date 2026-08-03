# Documentation

Four MCP servers on a six-package platform. This is the map.

Every number in these documents should be re-derivable from a named command. Where one is not, treat
it as a bug and re-derive it — counts drift, commands do not.

---

## Start here

| | |
|---|---|
| [Onboarding](onboarding.md) | Fresh clone → four working servers, in three commands |
| [Architecture](architecture.md) | What this is, as built |
| [Conventions](conventions.md) | Every rule, sorted by whether something actually checks it |

## Working in the repo

| | |
|---|---|
| [Development Guide](development.md) | The loop, the test layers, the gate, and the failures that cost an afternoon |
| [Contribution Guide](../CONTRIBUTING.md) | Commits, review, what a change has to carry with it |
| [Server Development Guide](server-development.md) | Scaffolding, registering and operating a server |
| [Tool Development Guide](tool-development.md) | Declaring, gating, testing and snapshotting a tool |

## Reference

| | |
|---|---|
| [Package Overview](packages.md) | What each of the six packages is for |
| [Folder Convention](folder-convention.md) | Where a file goes, and what decides it |
| [Dependency Rules](dependency-rules.md) | What may import what, and the guard that enforces it |
| [Architecture Decision Records](adr/README.md) | Three decisions, each rejecting the conventional alternative |

## History and state

| | |
|---|---|
| [Migration Notes](migration/README.md) | The 44-step migration, its per-phase records, and the findings worth carrying forward |
| [Backlog](backlog.md) | What is left, and what is explicitly *not* left |
| [Target Architecture](architecture/target-architecture.md) | The design and its reasoning; §9 reconciles it against what was built |
| [Audit Report](architecture/audit-report.md) | The pre-migration repository at `01c532e` |
| [Standard Structure Report](refactor/standard-structure-report.md) | The nine-slot `src/` layout: per-server map, N/A slots, compatibility evidence |
| [Duplication Extraction Report](refactor/duplication-extraction-report.md) | The shared-component extraction, its measured behaviour deltas, and the cluster left alone |
| [CHANGELOG](../CHANGELOG.md) | Dated entries, with the introducing commit named |

## Elsewhere in the repo

| | |
|---|---|
| `../README.md` | The workspace overview and the installer commands |
| `../CLAUDE.md` · `../AGENTS.md` | Agent guidance: constraints, env reference, MCP-first operating rules |
| `../.claude/rules/` | Always-on policy — `mcp-hard-mode`, `mcp-base`, `typescript-mcp`, `db-guardrails`, `codebase-index` |
| `../.claude/skills/` | MCP **authoring** skills (scaffold, security review, release checklist, …) |
| `../packages/<name>/README.md` | The per-package reference |
| `../<server>/README.md` | The per-server tool catalogue |
| `../codebase-index-mcp/CLAUDE.md` | The largest server's internals |
| `../contracts/README.md` | What the golden `tools/list` snapshots are, and how to update them |

---

## Which document answers what

| Question | Read |
|---|---|
| How do I get this running? | [Onboarding](onboarding.md) |
| What is the shape of the system? | [Architecture](architecture.md) |
| Why is it shaped this way? | [Target Architecture](architecture/target-architecture.md) |
| What must I run before committing? | [Development Guide](development.md) §4 |
| Where does this new file go? | [Folder Convention](folder-convention.md) |
| May this package import that one? | [Dependency Rules](dependency-rules.md) |
| How do I add a tool? | [Tool Development Guide](tool-development.md) |
| How do I add a server? | [Server Development Guide](server-development.md) |
| Why does `instanceof` not work here? | [ADR 0001](adr/0001-workspace-native-deps.md) |
| Why do three SQL token lists differ? | [ADR 0002](adr/0002-sql-guardrail-token-lists.md) |
| Why did the migration do X? | [Migration Notes](migration/README.md) |
| What is still broken? | [Backlog](backlog.md), plus the two issue registries |

---

## Kinds of document, and how each is maintained

| Kind | Examples | Rule |
|---|---|---|
| **Current-state** | `architecture.md`, `conventions.md`, the four guides, the READMEs | Update when the state changes. Cite the command each number comes from |
| **Historical** | `CHANGELOG.md`, `migration/*`, `refactor/*`, the issue registries | **Do not rewrite.** An entry was accurate at the commit it describes |
| **Decision** | `adr/*` | Amend when a decision's *reading* was wrong; supersede with a new number when the decision changes |
| **Generated** | `<server>/.env.example`, the `<!-- BEGIN/END GENERATED -->` blocks, tool lists | Never hand-edit. Edit `packages/manifest/` and run `npm run generate:all` |
