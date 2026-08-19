# ADR 0004 — The T-SQL guardrail policy for `sqlserver-mcp`

**Status** — Accepted
**Date** — 2026-08-19

## Context

`sqlserver-mcp` is the fifth server and the fourth to run a read-only SQL guard on the shared
mechanism in `@mcp/shared` (`scanSql` → `isSelectLike` → `hasMultipleStatements` →
`findForbiddenToken`). [ADR 0002](./0002-sql-guardrail-token-lists.md) says a new dialect must argue
its token list rather than inherit one, under a two-part rule:

1. the dialect can execute the token as a statement, and
2. it is not a valid identifier or function name in that dialect's ordinary read queries.

This ADR answers that for T-SQL, and records two things ADR 0002 did not have to: a **scanner**
setting that is not a token at all, and a **shape** rule that a token list cannot express.

The evidence base is an audit of the deployment this server was built for — 2,106 `.sql` files
across a 23-catalog SQL Server instance, plus the .NET services that query it. Where a decision below
cites a count, that is the source.

## Part 1 — the scanner switches (not tokens, but they decide what the tokens see)

`scanSql` blanks out what it believes are literals before any token check runs. Claiming a syntax the
engine does not have therefore *erases real statement text*, and a forbidden token inside the erased
span disappears from the check. Getting these wrong weakens the guard rather than merely changing it.

| Switch | Postgres default | T-SQL | Why |
|---|---|---|---|
| `dollarQuotedStrings` | `true` | **`false`** | T-SQL has no `$$…$$`. `$` is an ordinary character and a legal identifier character. |
| `escapeStrings` | `true` | **`false`** | T-SQL does not treat a backslash as an escape inside a string literal. |
| `bracketQuotedIdentifiers` | `false` | **`true`** | T-SQL quotes identifiers as `[Name]`, with `]]` escaping a literal `]`. |

The third one is new, added to `@mcp/shared` for this server. It is not an optimisation: SQL Server
lets a reserved word be a column name when bracketed, so `select [Update], [Delete] from dbo.Audit`
is a legal read that the token check would otherwise refuse. It defaults to `false` precisely because
`[` means something else in the other three dialects — in Postgres it is array subscripting — and
turning it on for them would blank out real text, which is the failure this table exists to prevent.

## Part 2 — the token list

Applying the ADR 0002 rule to T-SQL. Grouped by what each group prevents.

| Group | Tokens | Rule 1 (executable?) | Rule 2 (safe as an identifier?) |
|---|---|---|---|
| Data / schema change | `insert` `update` `delete` `truncate` `merge` `alter` `drop` `create` `grant` `revoke` `deny` | Yes, all statement verbs | Reserved words in T-SQL; a column so named must be bracketed, and bracketed identifiers are now blanked before the check |
| Table creation without a verb | `into` | Yes — `SELECT … INTO #t` creates a table | Reserved; `INTO` cannot appear unbracketed in a read |
| Executing something else | `exec` `execute` `sp_executesql` | Yes | Reserved (`exec`/`execute`); `sp_executesql` is a procedure name |
| Reaching another server | `openquery` `openrowset` `opendatasource` `openxml` | Yes, as rowset functions | Reserved function names |
| Instance administration / DoS | `shutdown` `dbcc` `backup` `restore` `kill` `waitfor` `reconfigure` `sp_configure` `xp_cmdshell` `bulk` | Yes | Reserved, or `sys`-owned procedure names |

Two entries deserve their reasoning stated rather than tabulated.

**`waitfor`.** Not a write. It is on the list because `WAITFOR DELAY '23:59:59'` is a read-only
statement that occupies a connection for a day, and this server holds a bounded pool per catalog —
so the denial-of-service is against the tool, not only against the database.

**The `OPEN*` family.** The audit measured **zero** occurrences across all 2,106 SQL files, so
forbidding them costs nothing real and removes the entire "read a remote system through the
database" class from the tool's reach. `health_check` reports `linkedServerCount` so an operator
can see what the instance actually offers that class.

> **Corrected 2026-08-19.** This paragraph also claimed *"zero linked servers configured on the
> instance (`sys.servers` has only the local entry)"*. That was never measured — the audit read
> 2,106 SQL files, not the server — and it is false. The first `health_check` against a real
> instance reported `linkedServerCount: 2` (`BMWDataLake`, `dataprocess-dev-1`).
>
> The decision does not change; its justification gets stronger. "Reading a remote system through
> the database" was written up as a hypothetical class being closed off pre-emptively. It is not
> hypothetical on this instance — an `OPENQUERY` against `BMWDataLake` would have reached a data
> lake through a read-only SQL login, and a four-part name would have done it without any `OPEN*`
> token at all. The zero that carries the argument is the **corpus** zero, which was measured. The
> instance zero was an assumption, and reporting `linkedServerCount` is what caught it — which is
> the only reason that field exists.

### What is deliberately NOT on the list

| Postgres has it | Why not here |
|---|---|
| `copy` | T-SQL's bulk import is `BULK INSERT` / `OPENROWSET(BULK …)`, both already covered |
| `vacuum` `analyze` `reindex` `refresh` | Not T-SQL statements. `DBCC` is the nearest analogue and is listed |
| `do` | No anonymous-block statement in T-SQL |
| `comment` | `COMMENT ON` is not T-SQL. And `Comment` is a very common column name — adding it would fail rule 2 outright |

## Part 3 — the shape rule a token list cannot express

**Four-part names are refused; three-part names are not.**

A token list operates on words. `server.database.schema.object` is a *shape*, so it is matched as
one — on the bracket-preserving pass described below, not on the token-check text:

```
/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\.[A-Za-z_]\w*\.[A-Za-z_]\w*\b/
```

The important half of this rule is what it must **not** catch. On the instance audited, the
three-part name `Database.dbo.Table` is the *only* mechanism joining catalogs, used roughly 4,000
times — the tenant catalog alone reaches `CRM_Marketing` 1,625 times and `CRM_Master` 403 times.
A guard that treated cross-catalog reads as suspicious would make the server useless for the
schema it exists to query. So three parts are ordinary and four parts are refused.

### The interaction with bracket scanning — and the bypass it caused

The first implementation ran this pattern against the *token-check* text, which has bracketed
identifiers blanked out. That is a bypass: `[srv].[db].[dbo].[t]` contains no word characters after
blanking, so the pattern matched nothing and the linked-server read was accepted. So was any
partially-bracketed form — `srv.db.dbo.[t]`, `[srv].db.dbo.t`.

The two checks want opposite things from the scanner, and the fix is to give them separate passes:

| Check | Brackets | Why |
|---|---|---|
| forbidden tokens | blanked | `[Update]` is a column name, not a verb |
| name shape | preserved, each `[…]` reduced to one placeholder word | a bracketed segment is still a name part |

Reducing to a placeholder rather than stripping the delimiters matters in the other direction too:
a bracketed name may legally contain a dot, so `[my.db].dbo.t` is three parts, and stripping would
make it read as four.

### The known false positive

`Database.schema.Table.Column` is also legal T-SQL and is indistinguishable from a linked-server
reference by shape alone. Accepted, on evidence: a survey of all 2,106 files found no real four-part
object reference. Every match was a permission code (`crm.social.ads.view`) or a hostname
(`crm.vw.com.vn`) inside a string literal — and literals are blanked before the test runs. The
refusal message names the one-line workaround (alias the table, reference `alias.column`).

## Part 4 — what the guardrail does not, and cannot, do

Postgres has `BEGIN TRANSACTION READ ONLY`; `postgres-mcp` uses it, so its guardrail is a second
line of defence behind an engine-enforced one. **T-SQL has no equivalent.** `ApplicationIntent=ReadOnly`
only routes to an Availability Group replica and is not an enforcement mechanism.

So for this server the syntactic guardrail is the *first* line, not the second, and the honest
statement of the control is:

1. the guardrail refuses anything that is not a single `SELECT` / `WITH … SELECT`;
2. **the deployment recommendation is a SQL login holding only `db_datareader`** — this is the
   enforcement, and it is the one that survives a bug in point 1;
3. `SQLSERVER_ALLOWED_DATABASES` bounds which catalogs are reachable at all, because a SQL Server
   login is scoped to the instance rather than to a database.

### The allowlist has to cover three-part names, or it covers nothing

Bounding the catalog a *connection* opens against is not enough once three-part names are permitted:
one connection to an allowed catalog can read every other catalog on the instance by name. So when
`SQLSERVER_ALLOWED_DATABASES` is set, `run_read_query` also extracts the first segment of every
three-part name and refuses any that names a catalog outside the list.

The filter is against the instance's **real catalog list** (`sys.databases`, cached per environment),
not against the raw segments — because `dbo.Customer.Name` and `Payroll.dbo.Salaries` are the same
shape. Refusing every unrecognised first segment would reject ordinary schema-qualified column
references, which is a worse failure than the gap it closes.

The server's README and its skill both say this rather than implying parity with `postgres-mcp`.

## Consequences

- `@mcp/shared` gains one option, `bracketQuotedIdentifiers`, default `false`. No existing server's
  behaviour changes; `packages/shared/src/sql.test.ts` pins both the new behaviour and the default.
- `sqlserver-mcp` owns a 29-token list, larger than the other three, for reasons argued above rather
  than by union.
- `execute_routine` does **not** pass through this validator. It takes a routine name and typed
  parameters and never accepts statement text, so there is no statement to validate — its controls
  are the three guards in `src/tools/execTools.ts`.
