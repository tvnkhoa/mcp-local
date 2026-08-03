# Architecture Decision Records

Decisions with a rationale, kept so they are not re-litigated every six months.

An ADR is written when a choice will look wrong to someone who does not know why it was made — and
in this workspace, when the obvious alternative is the *conventional* one. All three below reject
something a reasonable reviewer would suggest.

**Reopening one needs a new ADR, not a backlog item.** `docs/backlog.md` lists the accepted debt
these cover precisely so it stays decided.

---

## Index

| # | Decision | Status | Step | Rejects |
|---|---|---|---|---|
| [0001](0001-workspace-native-deps.md) | Servers stay outside the npm workspace | Accepted, implemented **+ amended** | S-07 / S-09 | making all nine directories workspace members |
| [0002](0002-sql-guardrail-token-lists.md) | SQL guardrail forbidden-token lists stay per-dialect | Accepted | S-18 | unioning three drifted lists into one |
| [0003](0003-single-root-gitignore.md) | One root `.gitignore`; no per-server copies | Accepted | S-37 | the migration plan's own instruction to add two |

---

## 0001 — Servers stay outside the npm workspace

`workspaces` is `["packages/*"]` only. Servers consume shared code through `file:` dependencies.

**Why.** `better-sqlite3`, `tree-sitter` and `sqlite-vec` are compiled. Hoisting relocates the native
binary and risks a rebuild that needs VS C++ Build Tools.

**Accepted costs.**

- Four separate copies of `zod` and `@modelcontextprotocol/sdk`.
- **`instanceof` fails across the package boundary** — a `ZodError` thrown in a server is not an
  instance of any `ZodError` a shared package imported. This is not theoretical; it is why the error
  mapper is shaped the way it is.
- Five lockfiles, all cached separately in CI.

**Benefits.** A native build failure is contained to one server. And `build:packages` before servers
is a real ordering enforced by the filesystem, not a convention people remember.

> **Amendment — injection is the third option.** The `instanceof` consequence was read for a while
> as *"a shared error mapper is impossible"*, which put `createErrorMapper` out of reach and left
> three servers with hand-copied branch orders. The constraint is narrower than that: *a shared
> module must not `instanceof` against a class it imported itself*. Passing the classes **in** as
> parameters satisfies it directly. `createErrorMapper` imports neither `zod` nor the protocol SDK,
> and three servers now share the branch order.
>
> ADR 0001 originally suggested duck-typing on `.name` as the escape hatch. Injection is strictly
> safer: `errorMapper.test.ts` pins a same-named, same-shaped `RivalZodError` reaching
> `internal_error`, which `.name` matching would have misclassified as a validation error.
>
> S-09 (deduplicating `zod`) was recorded as the prerequisite for this. **It was not**, and waiting
> for it was the real cost of the wrong reading.

Consequences you will meet in practice are in [Dependency Rules](../dependency-rules.md) §4.

---

## 0002 — SQL guardrail token lists stay per-dialect

Three servers run a read-only SQL guard on the same mechanism in `@mcp/shared/sql`
(`stripStringsAndComments` → `isSelectLike` → `hasMultipleStatements` → `findForbiddenToken`), and
their forbidden-token lists had drifted: **18** (PostgreSQL) / **16** (SQLite) / **13** (DataFusion).

**Decision: no change.** All five of `observe-mcp`'s omissions — `comment`, `do`, `analyze`,
`reindex`, `refresh` — are correct for DataFusion. This reversed the plan's provisional guess that
`do` and `comment` "likely go in".

**The two-part rule for adding a token**, and the second part is the one that is easy to miss:

1. **The dialect can execute it as a statement.** A token the engine cannot parse guards nothing.
2. **It is not a valid identifier or function name in that dialect's ordinary read queries.**
   `findForbiddenToken` matches on word boundaries in the cleaned statement; strings and comments
   are stripped, **identifiers are not**. So every token added also rejects any column, alias or
   function with that name.

Point 2 is why "union all three lists" is wrong.

The divergence is pinned by two tests, which is the difference between a per-dialect list and an
accidental fork. This ADR is also the origin of the workspace's sharpest rule: *a convention nobody
checks is a preference* — these three lists drifted precisely because the rule against duplicating
them was written down and not enforced.

---

## 0003 — One root `.gitignore`

The migration plan instructed adding `.gitignore` to `codebase-index-mcp` and `postgres-mcp`. The
premise had expired: the root file's `**/`-prefixed patterns already decide every path, confirmed
with `git check-ignore -v` per path.

**Decision: do not add them.** The two existing per-server files (`observe-mcp`, `bitbucket-mcp`) are
left in place — redundant but harmless, and deleting them is churn.

Adding two more would have been four copies of the same rules with nothing checking they agree —
exactly the duplication S-35 and S-36 had just removed from the env and tool contracts.

**Consequences.** One place to change an ignore rule. A server directory copied out of the workspace
on its own would lose its ignores — accepted, since no workflow does that. The scaffold generator
emits no `.gitignore`, for the same reason.

One thing was verified rather than assumed: all four `.env.example` files are **tracked**, so an
ignore bug affecting them would have been invisible until server #5. Creating a fresh directory
confirmed `git add -n` picks up `.env.example` while `.env` stays ignored.

---

## Writing one

Copy the shape the three share — it is what makes them readable in a hurry:

```markdown
# ADR NNNN — <the decision, as a statement>

**Status** — Proposed | Accepted | Superseded by ADR NNNN
**Step** — the plan/backlog item that forced it, if any
**Date** — YYYY-MM-DD

## Context
What is true, with the measurement that establishes it. Numbers, not adjectives.

## Decision
What was decided, in one sentence, then the detail.

## Consequences
Costs and benefits, each labelled. Name the accepted costs explicitly — an ADR that lists
only benefits is advocacy.

## Alternatives rejected
The option a reviewer would suggest, and why it does not work here.
```

Amend rather than rewrite when a decision's *reading* turns out to be wrong but the decision stands —
ADR 0001's amendment is the worked example. Supersede with a new number when the decision itself
changes.

An ADR is warranted when:

- `@mcp/core` would acquire a runtime dependency (the guard requires one by name)
- something in `docs/backlog.md`'s *"Explicitly NOT in this backlog"* table is being reopened
- a convention is being deliberately broken rather than fixed
- a plan instruction is being skipped (S-42 and S-37 are both recorded this way)

---

## Related

- [`../backlog.md`](../backlog.md) — the accepted debt these decisions cover, in the
  *Explicitly NOT in this backlog* table
- [`../architecture/target-architecture.md`](../architecture/target-architecture.md) — the design
  these decisions constrain
- [`../migration/README.md`](../migration/README.md) — the migration that forced them
