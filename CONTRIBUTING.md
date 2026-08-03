# Contributing

Internal workspace. No external contributions, no published packages, no telemetry — every package
is `"private": true` and stays that way.

This page is the process. The rules the process enforces are in
[docs/conventions.md](docs/conventions.md), and the day-to-day mechanics are in
[docs/development.md](docs/development.md).

---

## The one rule underneath all the others

> **Measure, do not reason.**

Every claim in this repository's documentation cites the command or observation that proves it. That
is not a stylistic preference — it is the practice that caught five shared-package defects before any
consumer existed, and four tests that passed for the wrong reason.

A test that has never failed is a guess. A guard that has never rejected a violation is a guard on
trust. When you add either, break the thing it protects once and confirm it goes red
(`scripts/prove-guards.sh` is the worked example).

---

## Before you start

```bash
npm install && npm run build:packages
npm run verify:all          # confirm you are starting from green
```

If `verify:all` is red before you touch anything, fix or report that first. Starting from red means
you cannot tell what you broke.

---

## While you work

Match the surrounding code: its comment density, its naming, its idioms. Then:

| | |
|---|---|
| **Comments explain *why*** | The mechanism is readable from the code. The reason a check exists, or why a divergence is intentional, is not |
| **Named exports only** | No default exports — they are not greppable and survive renames badly |
| **Never write to stdout** | It is the MCP transport. `console.log` is a guard finding; use the injected logger, which writes to stderr |
| **Never log a secret** | Redaction lives in the logger, not at each call site, so it cannot be forgotten |
| **No `any`** | Prefer explicit unions; `unknown` at the edges, narrowed immediately |
| **`Result<T,E>` at boundaries, exceptions inside** | A tool handler returns a `Result`; it does not throw across a package boundary |
| **Validate external input with zod** before business logic | Hand-written JSON Schema is only what `tools/list` advertises |
| **Mechanism, not policy, in shared code** | `@mcp/shared` ships no forbidden-token list; the caller supplies one. That is what lets one implementation serve three servers with three different rules |
| **Fail fast on invalid config** | A missing credential is a startup error, not a per-call error |

### Shared code must be characterized against its consumers

"Mechanism, not policy" is necessary but not sufficient. Extraction proved that shared code is *not*
automatically better than the copies it replaces — three examples, all now pinned by tests:

- a finite `maxDepth` default in shared JSON normalization **truncated real data** the server copies
  rendered in full
- `shouldDropNullish` as `profile !== "verbose"` **changed the `standard` profile's response shape**
  for all four servers
- enabling Postgres dollar-quote scanning on a SQLite/DataFusion dialect **weakens** the guard: it
  blanks the span between `$…$` markers and hides a forbidden token

So: before a consumer adopts shared code, prove the mechanism equivalent against that consumer.

---

## One change, one commit

Three requirements inherited from the migration plan, and worth keeping:

- **Reversible** — one item = one commit = one `git revert`
- **Independently testable** — validation passes on that commit alone
- **Low risk** — the blast radius is named in the message

Batch size matters. Migrating 43 tools went out as **five** commits in risk order, not one.
Converting handlers in backlog B-03 is explicitly one commit per tool.

### Commit messages

```
<type>(<scope>): <what changed, and the consequence>
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `test`. Scope is a server key, a
package, or a subsystem (`ci`, `install`, `doctor`, `registry`).

The subject earns its space by stating a consequence or a number, not a category:

```
fix(codebase-index): stop comparing tree-sitter nodes with === (MCP-ISSUE-032)
perf(codebase-index): memoize TYPE_REF fallbacks — 112s of type resolution back to 11.5s
feat(doctor): validate env VALUES, not just key presence
fix(install): stop a reinstall from silently resetting a server's configured env
```

Reference the issue or backlog id when there is one (`MCP-ISSUE-034`, `B-09`, `S-43`).

### Branching

Work on a branch; `main` is the default and the PR target. Do not commit or push unless you were
asked to.

---

## Before you commit

```bash
npm run verify:all
```

That is the gate. It covers packages, servers, tool contracts and generated docs, and it is
credential-free so it means the same thing on your machine as in CI.

**A green CI does not replace it.** CI does not run `generate:check` or `test:scripts`, so
generated-file drift is caught locally or not at all. See
[Development Guide](docs/development.md) §4 for the exact difference.

Before a **release**, additionally:

```bash
npm run verify:live     # real Postgres / OpenObserve / Bitbucket
```

---

## Changes that need something extra

| If you changed… | Also do |
|---|---|
| A tool's name, description, schema or annotations | `contracts:update -- --server <key>`, **read the diff**, then `generate:all` |
| An env var | edit `packages/manifest/src/envSpecs/<server>.ts`, then `generate:all`. Never a generated file directly |
| Added a package | a tier row in `packages/cli/src/guards/rules.ts`, a root `tsconfig.json` reference, and the pinned list in `packages/cli/src/cli.test.ts` |
| Added a server | see [Server Development Guide](docs/server-development.md) §2 — snapshot **before** registering |
| Moved or renamed a file | `rm -rf dist && npm run build`, then `npm run mcp:doctor`. `tsc` does not prune, and a stale module still loads |
| Anything destructive | it goes behind an env flag (off by default, strict parsing) and `preview → apply → rollback` with an HMAC token |
| A decision you expect to be re-litigated | an ADR in `docs/adr/`, not a comment |

### Never re-snapshot a contract to make a red check green

`contracts:check` failing is the mechanism working. Read `git diff contracts/` first. If the change
was not intended, you just caught a defect.

---

## Documentation is part of the change

Three kinds of document, with different rules:

| Kind | Rule |
|---|---|
| **Current-state** (`README.md`, `docs/architecture.md`, `docs/conventions.md`, the guides) | Update when the state changes. Every number should be re-derivable from a named command |
| **Historical** (`CHANGELOG.md`, `docs/migration/*`, `docs/refactor/*`, the issue registries) | **Leave alone.** An entry describing a past state was accurate at the commit it describes; rewriting it makes the record claim something that never happened |
| **Generated** (`.env.example`, the marked README blocks, tool lists) | Never hand-edit. Edit the manifest and run `generate:all` |

If a doc states a count — env vars, tools, guard findings — state the command it came from. Counts
drift; commands do not. Prefer:

> `guard:all`: 0 errors, 20 warnings, 1 accepted exemption across 508 files

over an unattributed number.

---

## Reviewing

Read the diff for these, in this order:

1. **Annotations.** `readOnly` / `idempotent` / `destructive` decide what a client may auto-approve.
   A wrong one is a safety bug, not a doc bug.
2. **Guards.** Every gate should be a declared `guard`, not an `if` inside a handler. A security
   review reads the guard list.
3. **Secrets.** Nothing in a response, a log line, a `describeConfig`, or a committed default.
   `assertNoLeak` checks the captured logs as well as the body.
4. **The contract diff.** `contracts/` changes are the API changing.
5. **What the tests would catch.** Not whether tests exist.

---

## Filing a defect

Two registries, both checked into the repo:

- `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`
- `postgres-mcp/docs/mcp-postgres-issue-registry.md`

Use a stable id (`MCP-ISSUE-NNN`). Record: scenario · tool/query attempted · expected vs actual ·
impact · workaround · enhancement proposal. If the same pattern occurs three or more times, mark it
an enhancement candidate.

Work that is scoped but not scheduled goes in [docs/backlog.md](docs/backlog.md), which sorts by
whether a tool reports something untrue, a gate does not bite, or it is only a cost. That file also
lists what is **explicitly not** in it, so decided questions stay decided — reopening one of those
needs a new ADR, not a backlog item.

---

## Working with agents in this repo

`.claude/rules/mcp-hard-mode.md` is the MCP-first operating policy for code analysis in this
workspace, and `CLAUDE.md` is the entry point an agent reads. If you change something either one
describes — a command, a repoId, a tool name — update it in the same commit. A stale rule file makes
an agent confidently wrong.

---

## Related

- [Development Guide](docs/development.md) — the loop, the layers, the failures
- [Conventions](docs/conventions.md) — every rule, sorted by what enforces it
- [Dependency Rules](docs/dependency-rules.md) · [Folder Convention](docs/folder-convention.md)
- [Server Development Guide](docs/server-development.md) · [Tool Development Guide](docs/tool-development.md)
- [Architecture Decision Records](docs/adr/README.md)
