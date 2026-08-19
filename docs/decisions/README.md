# Architecture Decision Records

Decisions with a rationale, kept so they are not re-litigated every six months.

An ADR is written when a choice will look wrong to someone who does not know why it was made — and
in this workspace, when the obvious alternative is the *conventional* one. All four below reject
something a reasonable reviewer would suggest.

**Reopening one needs a new ADR, not a backlog item.** `docs/development/backlog.md` lists the accepted debt
these cover precisely so it stays decided.

---

## Index

| # | Decision | Status | Step | Rejects |
|---|---|---|---|---|
| [0001](./0001-workspace-native-deps.md) | Servers stay outside the npm workspace | Accepted, implemented **+ amended** | S-07 / S-09 | making all nine directories workspace members |
| [0002](./0002-sql-guardrail-token-lists.md) | SQL guardrail forbidden-token lists stay per-dialect | Accepted | S-18 | unioning three drifted lists into one |
| [0003](./0003-single-root-gitignore.md) | One root `.gitignore`; no per-server copies | Accepted | S-37 | the migration plan's own instruction to add two |
| [0004](./0004-tsql-guardrail-policy.md) | The T-SQL guardrail policy for `sqlserver-mcp` | Accepted | — | reusing the Postgres scanner switches and token list for a fourth dialect |

---

## The four, in brief

Each summary is one paragraph by design. **The ADR file is the single home for its reasoning** — this
page previously restated all three at 20–35 lines each, which meant two copies of every argument and
nothing checking they agreed.

### [0001 — Servers stay outside the npm workspace](./0001-workspace-native-deps.md)

`workspaces` is `["packages/*"]` only; servers consume shared code through `file:` dependencies,
because hoisting relocates `better-sqlite3`'s native binary. The accepted cost that bites in practice
is that **`instanceof` does not cross the package boundary** — which is why `createErrorMapper` takes
its error classes as parameters. **Amended**: injection, not duck-typing, is the resolution, and
S-09 was never the prerequisite it was assumed to be.

### [0002 — SQL guardrail token lists stay per-dialect](./0002-sql-guardrail-token-lists.md)

Four servers share the mechanism in `@mcp/shared/sql` but keep their own forbidden-token lists
(18 PostgreSQL / 16 SQLite / 13 DataFusion / 29 T-SQL — see [0004](./0004-tsql-guardrail-policy.md)). Unioning them is wrong because `findForbiddenToken`
matches word boundaries in the cleaned statement and **does not strip identifiers** — so every token
added also rejects any column, alias or function of that name. Read the ADR for the two-part rule
before adding one.

### [0003 — One root `.gitignore`](./0003-single-root-gitignore.md)

The migration plan instructed adding two per-server files; the premise had expired, since the root
file's `**/`-prefixed patterns already decide every path (verified per-path with
`git check-ignore -v`). Decision: do not add them, and leave the two existing ones alone.

### [0004 — The T-SQL guardrail policy](./0004-tsql-guardrail-policy.md)

Applies ADR 0002's two-part rule to T-SQL, and records two things a token list cannot express: the
scanner switches (all three differ from the Postgres defaults, and `bracketQuotedIdentifiers` was
added to `@mcp/shared` for this), and the shape rule that refuses four-part names while permitting
three-part ones — because cross-catalog reads are the normal case on SQL Server, measured at ~4,000
occurrences in the deployment audited. Also states plainly what the guard cannot do: T-SQL has no
read-only transaction, so the enforcement is a `db_datareader` login, not the parser.

## Writing one

Copy the shape the four share — it is what makes them readable in a hurry:

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
- something in `docs/development/backlog.md`'s *"Explicitly NOT in this backlog"* table is being reopened
- a convention is being deliberately broken rather than fixed
- a plan instruction is being skipped (S-42 and S-37 are both recorded this way)

---

## Related

- [`../development/backlog.md`](../development/backlog.md) — the accepted debt these decisions cover, in the
  *Explicitly NOT in this backlog* table
- [`../architecture/target-architecture.md`](../architecture/target-architecture.md) — the design
  these decisions constrain
- [`../archive/migration/README.md`](../archive/migration/README.md) — the migration that forced them
