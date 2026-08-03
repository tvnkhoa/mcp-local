# Documentation

Four MCP servers on a six-package platform. **This page is the entry point** — every document in the
repository is reachable from here in at most two hops.

Every number in these documents should be re-derivable from a named command. Where one is not, treat
it as a bug and re-derive it — counts drift, commands do not.

---

## Start here

| | |
|---|---|
| **[Guides › Onboarding](guides/onboarding.md)** | Fresh clone → four working servers, in three commands |
| **[Architecture › As built](architecture/as-built.md)** | What this is, as it actually stands |
| **[Reference › Conventions](reference/conventions.md)** | Every rule, sorted by whether something checks it |

---

## The portal

| Section | For | Contents |
|---|---|---|
| **[guides/](guides/README.md)** | Getting running | Onboarding |
| **[development/](development/README.md)** | The working loop | Workflow · CI · Backlog |
| **[servers/](servers/README.md)** | The four servers | Server development · Tool development · links to all four server READMEs |
| **[architecture/](architecture/README.md)** | The shape, and why | As built · Target architecture (§9 reconciles them) |
| **[reference/](reference/README.md)** | Normative lookups | Conventions · Folder convention · Dependency rules · Packages |
| **[decisions/](decisions/README.md)** | The ADR log | 0001 native deps · 0002 SQL token lists · 0003 one `.gitignore` |
| **[reports/](reports/README.md)** | Reviews of the docs | Audit → cleanup plan → cleanup report → review |
| **[archive/](archive/README.md)** | Closed records | The 44-step migration · two refactor reports · the pre-migration audit · four superseded docs. **Not maintained** |

---

## Which document answers what

| Question | Read |
|---|---|
| How do I get this running? | [Guides › Onboarding](guides/onboarding.md) |
| What must I run before committing? | [Development › Workflow](development/workflow.md) §4 |
| What does CI cover, and not? | [Development › CI](development/ci.md) |
| What is left to do? | [Development › Backlog](development/backlog.md) |
| How do I add a server? / a tool? | [Servers › Server development](servers/server-development.md) · [Tool development](servers/tool-development.md) |
| What is the shape of the system? | [Architecture › As built](architecture/as-built.md) |
| Why is it shaped this way? | [Architecture › Target architecture](architecture/target-architecture.md) |
| Where does this new file go? | [Reference › Folder convention](reference/folder-convention.md) |
| May this package import that one? | [Reference › Dependency rules](reference/dependency-rules.md) |
| What is each package for? | [Reference › Packages](reference/packages.md) |
| Why does `instanceof` not work here? | [ADR 0001](decisions/0001-workspace-native-deps.md) |
| Why do three SQL token lists differ? | [ADR 0002](decisions/0002-sql-guardrail-token-lists.md) |
| Why did the migration do X? | [Archive › Migration](archive/migration/README.md) |
| What is still broken? | [Development › Backlog](development/backlog.md), plus the two issue registries |
| How do I commit and get reviewed? | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

---

## Elsewhere in the repo

Documents that live next to the code they describe, rather than in `docs/`.

| | |
|---|---|
| [`../README.md`](../README.md) | Workspace overview and the installer commands |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Commits, review, and what a change has to carry with it |
| [`../CLAUDE.md`](../CLAUDE.md) · [`../AGENTS.md`](../AGENTS.md) | Agent guidance: constraints, env reference, MCP-first operating rules |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Dated entries, with the introducing commit named |
| `../.claude/rules/` | Always-on policy — `mcp-hard-mode`, `mcp-base`, `typescript-mcp`, `db-guardrails`, `codebase-index` |
| `../.claude/skills/` | MCP **authoring** skills. The four **operational** skills are generated per server from `<server>/skill/SKILL.md` and are gitignored — edit the template, then `npm run mcp:update` |
| `../packages/<name>/README.md` | Per-package reference — all six linked from [Reference › Packages](reference/packages.md) |
| `../<server>/README.md` | Per-server reference — all four linked from [Servers](servers/README.md) |
| [`../contracts/README.md`](../contracts/README.md) | What the golden `tools/list` snapshots are, and how to update them |

---

## How each kind of document is maintained

The rule that decides whether you may edit a page, and how.

| Kind | Where | Rule |
|---|---|---|
| **Current-state** | `guides/` · `development/` · `servers/` · `architecture/` · `reference/` and the section READMEs | Update when the state changes. Cite the command each number comes from |
| **Decision** | [`decisions/`](decisions/README.md) | Amend when a decision's *reading* was wrong; supersede with a new number when the decision itself changes |
| **Historical** | [`archive/`](archive/README.md) · [`reports/`](reports/README.md) · [`../CHANGELOG.md`](../CHANGELOG.md) · the two issue registries | **Do not rewrite.** An entry was accurate at the commit it describes. Paths *may* be retargeted when a file moves — a path is an address, not an assertion — but no claim, number or date may change |
| **Generated** | `<server>/.env.example` · the `<!-- BEGIN/END GENERATED -->` blocks · tool lists | Never hand-edit. Edit `packages/manifest/` and run `npm run generate:all` |

**Every section directory has a `README.md` index.** A new document gets a home by being added to the
section it belongs to and linked from that index — which is also what keeps this page from growing.
