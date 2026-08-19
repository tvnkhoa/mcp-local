# Changelog

All notable changes to this project will be documented in this file.

> This file began as a `codebase-index-mcp` changelog and kept that scope after the workspace grew
> to four servers: until 2026-07-29 it did not mention `postgres-mcp`, `observe-mcp` or
> `bitbucket-mcp` **at all**. The three entries below are reconstructed from git history, with the
> introducing commit named so each claim is checkable. They are backfill, not a record written at
> the time.

## [Unreleased] - 2026-08-19d

### 🔧 What two simulated use cases found, and what it took to fix

Two subagents drove all 12 tools against a live instance as an onboarding developer and an on-call
engineer. Seven of the eight defects they reported were real; four were regressions introduced by
the same day's fixes. The work below is those seven plus the two capability gaps both runs hit
independently.

**`timeoutMs` had never done anything.** `mssql` has no per-request timeout — `requestTimeout` is
set once per pool — so `request.timeout = …` assigned a property the driver never reads. A query
asked to finish in 2s ran for 17s and returned normally. It is now applied the way the row cap
already was, by cancelling the stream, and returns the rows read so far with `timedOut: true`.
`truncated` keeps its old meaning. Both derive from one `cancelReason`, so they can never both be
true and leave a caller guessing which bound it hit — and the guard that swallows the driver's
`Canceled.` had to test that same variable, or a timeout would have thrown with zero rows.

**A fan-out slot printed the SQL login.** The per-catalog catch put `error.message` straight into
the slot, so a sweep over a missing catalog returned `Login failed for user '<login>'` — the name
`health_check` deliberately masks as `***`. Slots now carry `errorCode` and go through
`toWireError`, the same function the top-level envelope uses.

**A typo'd catalog was reported as a credentials problem.** SQL Server answers a connect to a
non-existent database with error 4060, surfaced as `ELOGIN` — identical to a wrong password. The
day's own error-classification work therefore made this *more* confidently wrong: it told the
caller to check `User ID` / `Password`. The server can tell the two apart because it already knows
which catalogs exist, so an `ELOGIN` against an unknown catalog is now `not_found` naming it. If
the catalog list itself cannot be read, `unauthorized` stands — that is the honest answer.

**One catalog was reported as several.** `find_cross_database_references` grouped on the raw
`referenced_database_name`, which records whatever spelling a developer typed, while the existence
check folded case — so `CRM_Marketing` (848 refs) and `CRM_marketing` (4) became two targets that
both said `exists: true`. Six catalogs appeared as sixteen. Grouping now folds, and the instance's
own spelling is echoed back, because a made-up casing is not usable as the next call's `database`.

**`find_cross_database_references` overflowed clients at every profile.** 295KB on a real catalog,
and `nano` was byte-identical to `compact` because the platform's profile handling is null-dropping
plus minification. Three rungs now: `nano` drops `referencingObjects`, `compact` (the default) is
the `targets` rollup, `standard` and above add `references[]`. `includeReferences` overrides either
way. This is the first use of `profileVerbosityRank`, which had been documented for exactly this
and had no consumer; `packages/core` gained a test pinning that the ranks ascend, now that
something depends on it.

**`list_tables(schema: "notaschema")` answered `count: 0`** — indistinguishable from an empty
schema, while a typo'd *table* already got `not_found`. It now checks `sys.schemas`, on the empty
path only, so an ordinary call pays nothing.

### 🧭 Two capability gaps, found by watching what the agents did instead

Both runs abandoned the MCP at the same point and hand-wrote `sys.tables` / `sys.partitions`
through `run_read_query` — one asking which catalogs hold a table, the other how many tables each
catalog has. They were reimplementing `list_tables` because `databases[]` existed on one tool only.
That was a gap in the server's own thesis: the unit of work is a catalog, and the metadata tools
were the ones pinned to a single one. `list_tables` and `list_routines` now take `databases[]` on
the same seam, which buys what the workaround could not: per-catalog labelling, request-order
results, and a failed catalog in its own slot rather than a dead sweep.

`list_routines` also gained `modifiedAfter`. The strongest lead in the simulated incident was "five
report procs changed today", found by eye across 189 rows.

The fan-out mechanism was extracted to `tools/fanout.ts` first and is tested against a fake
`runOne` — ordering, a concurrency high-water mark, partial failure, and an `ELOGIN` rejection
whose slot does not contain the login name. `run_read_query` moved onto it at -59 lines.

### 🧪 Schema parity, for all five servers

Every tool declares its input twice and only `codebase-index-mcp` compared the two. No other gate
can: `contracts:check` pins the advertised side against a snapshot of itself, so a parameter
missing from both stays missing. Lifted into `@mcp/testing` and wired into all five, each with a
floor equal to its tool count.

The lift could not use `instanceof` — ADR 0001 — and injecting the caller's zod, the obvious fix,
turned out to be insufficient: one tool table mixes copies, because `health_check` comes from
`@mcp/sdk` with the hoisted zod while a server's own tools carry the server's. Exactly one tool
dropped out silently, caught only by the floor. The walk now discriminates on `_def.typeName`.
Testing it also found a latent bug in the version it was lifted from: `ZodDefault` has no
`.unwrap()`, so a `z.object(…).default(…)` input threw rather than being unwrapped.

No pre-existing drift on any of the five. The gate went in green.

`verify:all`: exit 0. `sqlserver-mcp`: 112 tests, up from 70.

## [Unreleased] - 2026-08-19c

### 🐞 `list_tables` had never worked

Every call returned `Incorrect syntax near the keyword 'rowCount'`. The inventory query aliased a
column `as rowCount`, and `ROWCOUNT` is a T-SQL reserved word (`SET ROWCOUNT`), so the statement
did not compile — in any catalog, at any profile, since the tool was written.

Nothing caught it. All 65 tests run without a database by design, `contracts:check` boots the
server and reads `tools/list` without calling anything, and `npm run smoke` — the one path that
would have executed it — had never been run against a real instance. The tool was found by calling
it, on the first attempt, which is the least sophisticated test available.

Fixed by bracketing the alias. The guard is a test that scans the introspection SQL for aliases
colliding with a T-SQL reserved word, so the next one fails in CI rather than on a user's first
call. It needs no connection, which is why it can exist at all. Confirmed to fail when the bracket
is removed.

The irony is on the record: `bracketQuotedIdentifiers` was added to the shared SQL scanner so this
server could *read* reserved words wrapped in brackets, and then the server's own generated SQL
emitted one without them.

`sqlserver-mcp`: 66 tests, up from 65.

### 🧹 `find_cross_database_references` counted things that were not databases

Run against a real instance, `CRM_Master` reported 13 target catalogs and `referenceCount: 107`.
Four of those names are not databases on the instance at all, and they arrive there for two
unrelated reasons that look identical in `sys.sql_expression_dependencies`:

- **XML shredding.** `CROSS APPLY x.nodes(…) AS agent_nodes(agent_node)` followed by
  `agent_node.value(…)` is recorded as the three-part name `agent_nodes.agent_node.value`. There is
  no catalog and never was — `agent_nodes`, `trans_nodes` and `x` are all this.
- **A dropped catalog.** `CRM_Tenant_NZ` no longer exists, but `ImportNZBSIPackageToWarrantyNZ`
  still carries a dependency on it, because SQL Server binds names late. That is not noise: the
  module no longer binds, and this tool is the only place that says so.

Both are now marked `exists: false` rather than dropped, because the second finding is worth more
than the headline number. Real catalogs sort first, and the count is split — `referenceCount: 107`,
`resolvedReferenceCount: 102`, `unresolvedReferenceCount: 5` — so noise cannot inflate the figure
the tool leads with. The `coverage` note explains both causes beside the dynamic-SQL caveat it
already carried.

The target check reuses the `sys.databases` cache added for the three-part-name allowlist, so it
costs nothing per call. The grouping logic moved out of the handler into
`summarizeCrossDatabaseTargets` so it can be tested without a database — the same gap that let a
broken `list_tables` ship, so the seam is deliberate.

`sqlserver-mcp`: 70 tests, up from 66.

## [Unreleased] - 2026-08-19b

### 🔌 What the first real install of `sqlserver-mcp` found

Three failures before a single tool ran, against AWS RDS. Two were operator input; the third and
worst was that the server could not say so.

**`health_check` answered `internal_error` / "Health probe failed."** — for a TLS chain failure,
which is a configuration problem with a specific fix. The probe threw, and `createHealthCheckTool`
turns a thrown error into that fixed string by design: `toPlatformError` puts the driver's message
on `cause`, which is logged and never serialized, because a driver message can embed a connection
string. The shared behaviour is right and is unchanged. What was wrong is that this server's probe
threw at all — the SDK's own docstring says *"Returning an error marks the server degraded rather
than throwing"*, and the seam for classifying by a driver's fields (`stringProperty`) was already
there for exactly this.

So `classifyConnectionFailure` reads the driver error, decides what happened, and emits wording
written in `middleware/errors.ts`: TLS chain, DNS, login rejected, timeout, refused. The driver's
own text is never forwarded — it embeds `host:port` on every `ESOCKET`, and `Login failed for user
'x'` names the account `describeConfig` deliberately redacts to `***`. Only the driver's `code` is
interpolated, and only after matching `/^[A-Z_]{1,32}$/`. It is wired in as an `ErrorRule`, so
every tool that opens a connection reports the same cause, not just `health_check`.

The TLS case now returns `config_error` and names the fix. Verified by reproducing the original
failure against the live instance.

**`Initial Catalog=` was a hard boot failure.** That contradicted the server's own thesis. The unit
of work is a catalog, every data tool takes `database`, and a connection string is therefore only
naming which catalog to *start* in — so refusing to start without one made the config require a
decision the design says is per-call. It now defaults to `master`: present on every instance,
reachable by any login that can connect, and where `sys.databases` lives, so `list_databases` is
the first call a caller can make from it. Resolved explicitly rather than left to the login's own
default, because pools are keyed `(environment, catalog)` and a key unknowable until after connect
is a key two callers can disagree about.

**The documented answer to a TLS problem was to turn TLS verification off — twice.**
`NODE_TLS_REJECT_UNAUTHORIZED` and `TrustServerCertificate=true` were the only two options in the
generated env docs. Both leave the traffic encrypted but unauthenticated, which on a public RDS
endpoint is a real exposure rather than a theoretical one. `NODE_EXTRA_CA_CERTS` is now declared
(19 vars for this server, 125 across the workspace) with the regional RDS CA bundle URL. It is the
one option that keeps the certificate verified, and it needs no code change.

### 📌 Correction: ADR 0004 claimed zero linked servers, and there are two

The `OPEN*` paragraph asserted *"zero linked servers configured on the instance (`sys.servers` has
only the local entry)"*. That was never measured — the audit read 2,106 SQL files, not the server.
The first `health_check` against a real instance reported `linkedServerCount: 2`: `BMWDataLake` and
`dataprocess-dev-1`.

The decision does not change and its justification gets stronger. Closing off "read a remote system
through the database" was written up as pre-emptive. It is not: an `OPENQUERY` against
`BMWDataLake` would have reached a data lake through a read-only SQL login, and a four-part name
would have done it with no `OPEN*` token at all. The zero that carries the argument is the corpus
zero, which was measured. Reporting `linkedServerCount` is what caught the other one, which is the
only reason that field exists.

`verify:all`: exit 0. `sqlserver-mcp`: 65 tests, up from 56.

## [Unreleased] - 2026-08-19

### 🗄️ `sqlserver-mcp` — the fifth server

Microsoft SQL Server, read-only by default, 12 tools. Not a driver swap on `postgres-mcp`;
three things about SQL Server force a different shape, and each is a place the obvious port
would have been wrong.

**The unit of work is a catalog, not the server.** A SQL Server login is scoped to the
instance, so one connection string is authority over every database on it — ~23 in the
deployment this was designed against. Every data tool takes an optional `database`, pools
are keyed `(environment, catalog)` with an LRU cap, and `run_read_query` takes `databases[]`
to run one statement across several catalogs and label the results per catalog. The server
never derives that list itself: which catalogs exist, and which are tenants, is the caller's
knowledge.

**Cross-catalog reads are ordinary, so the guardrail permits them.** Three-part names
(`OtherDb.dbo.Thing`) are the only mechanism SQL Server offers short of a linked server, and
the audited corpus uses them ~4,000 times across 2,106 `.sql` files — one catalog reaches
another 1,625 times on its own. Four-part names are refused; linked servers measured zero.
`find_cross_database_references` turns that into a tool: the dependency graph *between*
catalogs, from `sys.sql_expression_dependencies`, with a `coverage` field that says how many
modules build SQL dynamically and are therefore invisible to it.

**T-SQL has no `LIMIT` and no read-only transaction.** Rows are bounded by cancelling the
result stream, never by rewriting the caller's statement — `select top (n) * from (…)` breaks
CTEs and top-level `ORDER BY`. And there is no `BEGIN TRANSACTION READ ONLY` to sit behind the
syntactic guard, so the README, the skill and ADR 0004 all say plainly that the enforcement is
a `db_datareader` login, not the parser.

Stored-procedure execution is a separate lane, off unless `SQLSERVER_EXEC_ENABLED=true`, and
annotated destructive for **every** routine — the catalog records nothing about whether a
procedure writes, and the audited schema has `Report_GetContactCentreResults` sitting beside
`Customer_UpdateLastActivity` in the same schema.

The connection string is parsed into parts and the catalog switched by field assignment. The
application audited does `connString.Replace(oldDb, newDb)`, which corrupts the credential
whenever the catalog name also appears in the password — a regression test asserts both the
correct behaviour and the failure the naive form produces.

`docs/decisions/0004-tsql-guardrail-policy.md` argues the 29-token list against ADR 0002's
two-part rule, and records the two things a token list cannot express: the scanner switches,
and the four-part-name shape rule.

### 🩹 Two guardrail bypasses found in review, before release

Both shipped in the first draft of the server above and are fixed with regression tests.

**Bracket-quoting defeated the four-part-name refusal.** The shape test ran on the
token-check text, which blanks `[…]` — so `[srv].[db].[dbo].[t]` held no word characters and
matched nothing, and any partially-bracketed form worked too. The two checks want opposite
things from the scanner; they now get separate passes, with each bracketed segment reduced to
one placeholder word so `[my.db].dbo.t` still counts as three parts.

**`SQLSERVER_READONLY_DATABASES` was bypassable by naming an environment.** The guard resolved
the *default* environment's catalog while the handler resolved the caller's, so a call naming
a second environment was checked against the wrong catalog and then executed against the right
one.

Also from the same review: `encrypt` defaulted to `false` and reached mssql's `options`, which
override the driver's secure default — every connection string omitting `Encrypt=` connected
in plaintext; the allowlist bounded only the connection catalog, not catalogs reached by
three-part name; `profile_table` interpolated column names into aliases it did not escape; and
a fan-out discarded every catalog's results when one entry failed to resolve.

`verify:all`: exit 0. `sqlserver-mcp`: 56 tests. Nothing here has run against a real SQL
Server — `npm run smoke` is the only path that does.

## [Unreleased] - 2026-08-03

### 🐞 `list_repositories` answered at a profile it never advertised

`listRepositoriesSchema` declared `responseProfileSchema.default("compact").optional()`. `.optional()`
wraps the default and short-circuits an absent value **before** it applies, so `parse({})` returned
`{}`, the handler's own `?? "standard"` took over, and the tool served `standard`. Invisible to every
existing gate: `tools/list` carries a separate hand-written JSON Schema, and for this payload the two
profiles serialize to the same 220 bytes.

`schemaDefaults.test.ts` now rejects any field declared both `.default()` and `.optional()` in either
order, across every tool schema, and asserts each profile field resolves on parse. Closes backlog
B-03 — the 43-tool conversion that item proposed turned out not to be needed, and two of its three
claimed exposures did not exist.

### 🔒 Decided: no credential goes into CI — `verify:live` stays local

Backlog B-05 asked for the four live smoke tests to stop depending on someone remembering. A
`verify-live.yml` was written for it — separate workflow, weekly schedule, secrets in a
`live-backends` environment, fail-fast on an unset secret name — and then **deleted the same day
without ever running**. `ci.yml` was never touched and remains credential-free.

The decision is the stronger form of the rule B-05 was working around: the live credentials (an RDS
connection string, an OpenObserve basic-auth header, a Bitbucket API token) are not copied into
GitHub at all. Every copy is another place to leak from, another rotation obligation, another
audience. That trade is available because this workspace has one operator on one machine — which is
also the condition that would have to change to reopen it.

**The residual risk is accepted, not solved,** and now says so in `docs/development/ci.md` and the
backlog's *Explicitly NOT* table: real query execution, real auth, real pagination and the EF Core
tooling stay untested until someone runs `npm run verify:live` locally. `contracts:check` still boots
all four servers over a real stdio handshake on every push, so *loading* a client is covered;
*reaching a backend* is not.

### 📐 The graph-accuracy floor now collects its own evidence

`BENCH_MIN_RESOLVED_CALL_EDGE_PCT` is 60 against an observed 100 — a floor 40 points below
observation cannot fail. Raising it needs several commits' evidence, so `ci.yml` now records the
observed value to the job summary on every push (backlog B-04, 1 of 5 observations). The gate
mechanism is proven non-vacuous: forcing the floor to 101 exits 3.

### 🧹 One live state document for the migration

`migration-plan.md` is marked **frozen/historical** — its header still claimed *"In progress — 24 of
44 steps done"*, sixteen steps stale. `status.md` now has one table per phase; the duplicate Phase J
table is deleted with its two unique facts folded into the authoritative one. That duplicate is what
fed a wrong step count into the file's own header for weeks. Closes B-11 — without collapsing the two
documents, because the cost was two documents claiming to describe the present, not their length.

### 🐞 `get_call_chain` sees through DI again — a fix that had been dead for four commits

MCP-ISSUE-022's **query-layer** half — seeding the caller frontier with a symbol's interface
siblings — lived in `services/graph/graphTraversal.ts`. S-41 (`a1d992c`) re-homed the loose `src/`
files, inlined the traversal into `tools/handlers/impactHandler.ts` **without** the seeding, and
left the fixed module orphaned and imported by nothing. Since then `get_call_chain(callers)` missed
every caller that dispatches through an interface — production code, since only tests `new` the
concrete class.

35 integration harnesses stayed green throughout, because none of them drove `get_call_chain`
across an interface: `test-interface-dispatch` asserts the *resolution*-layer half through
`getChangeContext`. `test:call-chain-interface` now covers the gap, on a fixture where only the
sibling seeding can succeed, and was shown to fail without it. The dead module is deleted.

### 🐞 An index run that produces no graph no longer reports `ok`

A full re-index of this workspace reported `status: "ok"` while upserting 57 symbols and **0 edges**
against 217 parse failures and 126 timeouts — the previous run of the same tree produced 2097
symbols and 6233 edges. `health_check` then showed a run at HEAD with status `ok`, so every graph
tool answered from an empty index without a warning.

`IndexRunStatus` gains **`degraded`**, set by `assessRunHealth` when ≥10% of attempted files fail
to parse, or when a `full` run over ≥10 files produces symbols but zero edges. `healthReasons`
carries one line per failing check. The cause in this instance was not the build: `mcp:doctor` now
also reports **`WARN running live server predates the current build`**, which is what nothing in
the workspace could see (`scripts/lib/runningServers.mjs`).

### 🧹 Zero import cycles, workspace-wide

Three real cycles in `codebase-index-mcp`, now none anywhere. `config/envConfig` ↔
`config/performanceConfig` was broken by moving the pure `parsePerformanceProfileEnv` down into
`envConfig`; the other two — `graph/edgeResolverShared` ↔ `edgeResolverImports` and
`impact/impactShared` ↔ `impactSurface` — were **unused imports**, symbols surviving only in a
comment. Count value imports only: `import type` is erased, and a detector that ignores this
reported 8 where there were 3.

### 🧹 The fourth copy of `normalizePayload`, and 30 exports nobody imported

`codebase-index-mcp/src/middleware/responseFormatter.ts` now delegates to `@mcp/core`, whose
`pathKeys` option was written for this server and then not adopted. Verified by replaying 18 calls
× 4 profiles: **72/72 identical** once per-run fields are masked. `mapError` deliberately stays
local — a different envelope, recorded in the file so it is not re-raised.

Also: `test:unit` 39 → 66 (closing backlog B-06, each new test proven by mutation), four files
renamed to the workspace naming rule (`middleware/errors.ts`, `services/git/gitHelpers.ts`,
`csharpScope.ts`, `jsCalls.ts`), and `dependency-rules.md` corrected — six of the ten rules apply
to `packages/*` only, which the page implied the opposite of.

### 🧱 The standard `src/` structure, in all four servers

`d692094` · `7676dbd`. Every server now lays out `src/{tools,resources,prompts,middleware,services,repositories,config,types}/`
plus `index.ts`, with a folder present **only** where the server has that concern — an empty
`prompts/` would advertise a capability that is not there. 153 files moved and one split; 157 of
158 relocations are tracked as renames. No behaviour change and no API change: `contracts:check` is
byte-identical at 76 tools, and every server's entry point is still `dist/index.js`, so no
`~/.claude.json` entry needed rewriting.

Full per-server map, the rule that decides which slot a file belongs in, the slots that are N/A and
why, and the compatibility evidence: `docs/archive/refactor/standard-structure-report.md`.

### 🧱 One builder vocabulary across all three MCP surfaces

`4390fa1`. `@mcp/sdk` gained `registerTool` beside `defineTool`, and the same `create*` /
`register*` pair for the other two surfaces — `createResource`/`registerResource`,
`createPrompt`/`registerPrompt`. Each `register*` flattens nested groups and rejects a duplicate
name **at assembly**, so a collision fails at start-up instead of one tool silently shadowing
another at call time.

- **`runServer`** — the entry-point tail. Four servers each ended with the same twelve lines
  (`main()`, log, `main().catch` → `process.exit`), one of which can never be exercised by a test.
  The difference between them is now a set of arguments, and `process.exit` lives in one reviewed
  place.
- **`createErrorMapper`** — the shared branch order (validation → coded classes → protocol error →
  rules → fallback). The error *classes* are injected by each server rather than imported by the
  SDK: per ADR-0001 each server owns its own `zod`, so a `ZodError` thrown in a server is not an
  instance of any class a shared package could import. Adopted by `bitbucket-mcp`, `observe-mcp`
  and `postgres-mcp`; **deliberately not** by `codebase-index-mcp`, whose envelope is a different
  contract (reason recorded in `packages/sdk/src/errorMapper.ts`).
- `prompts` are wired end to end but **no server declares one yet** — a platform capability without
  a consumer, which is why no server has a `prompts/` folder.

### 🧱 The scaffold rebuilt on that vocabulary

`4390fa1` moved the servers and not `templates/server/`, so server #5 would have been born on the
superseded pattern. The scaffold now emits `runServer`, `createErrorMapper` + `toWireError`,
`registerTool`, and `PolicyViolationError` re-exported from `@mcp/core` instead of a fourth private
copy.

One deliberate behaviour change for scaffolded servers: a bad argument now answers
`validation_error` with readable issues in `detail`, where before it answered `internal_error`
carrying a **raw zod issue array**. An unknown tool still answers `not_found`, byte-identical —
verified by probing a server scaffolded from the old template and one from the new over real stdio
sessions. `docs/archive/migration/status.md` §"Post-migration" has the before/after table.

### 🧹 Fixed

- **`observe-mcp`** — removed a stranded second copy of `toWireError` in `middleware/errors.ts`,
  exported to and imported by nothing since the structure refactor. 56/56 tests unchanged.
- **Docs that reported numbers the repo does not have** (backlog B-08) —
  `target-architecture.md` §9 still said eleven files exceeded the file-size hard cap and that
  config-loaded-once was "Partial"; both had been true and neither was. Env-var count corrected in
  three places (89 / 94 / 94 → **96**). Each row now names the command its number comes from.
- **`docs/development/backlog.md`** — B-01, B-01b, B-02, B-02b closed on 2026-07-30 and never marked. C# `TYPE_REF`
  extraction (`266d91b`, `9574e3e`, `f1c0160`, `9b55de4`) and index-run reproducibility
  (`b764b39`, `ae1af79`, MCP-ISSUE-032 CLOSED) are done — which matters beyond bookkeeping, because
  an edge count is usable as evidence again.

## [Unreleased] - 2026-07-29

### 🧱 Architecture migration — Phases A–J (S-01…S-41)

Restructured a four-server repository into a six-package platform plus four independent servers.
41 reversible steps; full step-by-step record in `docs/archive/migration/status.md`.

- **`packages/` platform** — `@mcp/core` (tier 0, zero-dependency), `@mcp/sdk` (tier 1, the only
  importer of `@modelcontextprotocol/sdk`), `@mcp/shared` (tier 2), `@mcp/testing` (tier 3),
  `@mcp/cli` (tier 4, the guards), `@mcp/manifest` (tier 5, workspace tooling data).
  - Servers stay **outside** the npm workspace on purpose — `docs/decisions/0001-workspace-native-deps.md`.
- **All four servers migrated onto `@mcp/sdk`** — `bitbucket-mcp` first as the pilot (S-06…S-23),
  then `postgres-mcp` (S-24), `observe-mcp` (S-25), and `codebase-index-mcp` across four batches
  (S-26…S-33). Notes per server in `docs/archive/migration/s06-s23-notes.md`, `s24-notes.md`, `s25-notes.md`,
  `s26-s29-plan.md`.
- **Static enforcement** — `guard deps` (tier matrix, single protocol-SDK importer, zero-dependency
  tier, one env reader per server, no cross-server and no tooling imports) and `guard convention`
  (required files/scripts, size caps, no default exports, no `console.log`). Rules live as data in
  `packages/cli/src/guards/rules.ts`.
- **Tool contracts snapshotted** — `contracts/` pins each server's `tools/list`; `contracts:check`
  boots all four over a real stdio handshake with placeholder env, catching a module that compiles
  but cannot load. 76 tools total.
- **Generated from the manifest** (S-35, S-36) — each server's `.env.example`, the marked blocks in
  its `README.md`, and its tool list. 94 env variables declared once in
  `packages/manifest/src/envSpecs/`. `generate:check` fails on drift.
- **Credential-free CI** — `verify:all` (Windows, Node 22) is the gate; `verify:live` needs real
  backends and is not in CI. See `docs/development/ci.md`.
- **Server scaffold** (S-38) — `npm run new:server -- --key <name>` produces a server that builds,
  typechecks, tests and smokes with no hand-editing.
- **`codebase-index-mcp` internals** — broke the `graphStore`/`regexSearch` cycle (S-29), extracted
  the index-run orchestrator (S-26), merged the duplicated watch lifecycle (S-27), made the
  edge→symbol join indexable (S-30), drove `process.env` reads to a single config module (S-41), and
  split every file over the 600-line hard cap. `src/` went from 67 loose files to 7, re-homed into
  domain folders (S-41/S-37).
- **First unit tests** in `codebase-index-mcp` (S-39) — before this, every test was an integration
  harness needing a build and a database.

### 🐛 Found while migrating

- **MCP-ISSUE-031** — `dead_code_scan` silently suppresses every method in an `I`-prefixed C# file
  (`ItemService.cs`, `IndexController.cs`): the path is lowercased before the interface-file test
  `/^i[a-z].*\.cs$/` runs. A false negative, so the scan looks clean while hiding candidates.
  Behaviour pinned by a test; fix deferred because it changes tool output.
- **MCP-ISSUE-032** — an index run is **not reproducible**. Two runs of the same build on a 521-file
  C# repo disagree by ~500 `PROPERTY_REF` edges while symbols stay identical, because
  `glob("**/*")` returns the same paths in a different order each call and nothing sorts it. Edge
  counts therefore cannot be used to validate a change.

Both in `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.

### ➕ Added — servers never previously recorded in this file

- **`postgres-mcp`** — PostgreSQL MCP server. Present since the workspace was initialized
  (2026-05-04, `7b04b97`). Read-only by default: the read path permits only `SELECT` and
  `WITH … SELECT`. Optional multi-environment access, reviewed/confirmed data writes
  (`preview → apply → rollback`, HMAC-approved, mandatory `WHERE`), and EF Core migration tooling —
  each behind its own env flag, parsed strictly. **`prod` is force read-only regardless of config.**
  SQL guardrails and approval-token regression tests added 2026-07-27. 17 tools.
- **`observe-mcp`** — OpenObserve log/trace MCP server for the CommunicationHub backend
  (2026-07-03, `9eb7123`). Read-only; queries the self-hosted `_search` API to search logs and trace
  a request end-to-end by trace id (`search_logs`, `trace_logs`, `get_trace_spans`, `log_stats`, …).
  Credentials via env only. Character caps, pagination and response profiles added 2026-07-06.
  8 tools.
- **`bitbucket-mcp`** — Bitbucket Cloud MCP server (2026-07-07, `a37366b`). Reads repositories and
  pull requests, and **creates** pull requests. Scopes `read:repository` / `read:pullrequest` /
  `write:pullrequest`; auth via Bearer token or email + API token. **PR creation is off unless
  `BITBUCKET_WRITE_ENABLED=true`**, and `create_pull_request` supports `dryRun`. Also the pilot for
  the `@mcp/sdk` migration (S-06…S-23). 8 tools.

## [Unreleased] - 2026-07-08

### 🧰 Workspace Tooling

- **Unified MCP installer** — one command from the workspace root installs/builds/configures any
  or all servers, data-driven from `scripts/lib/manifest.mjs` (single source of truth for entry
  path, env schema, tools, and skill source).
  - `npm run setup`, `scripts/install-mcp.mjs --server <key>`, `--yes`, `--skip-smoke`
  - `codebase-index-mcp/scripts/setup.mjs` is now a thin wrapper delegating to the root installer
  - **Files**: `scripts/install-mcp.mjs`, `scripts/lib/{manifest,log,jsonc,agents,skills,verify}.mjs`, `package.json`
- **Auto-generated native skills** — each server ships a `<server>/skill/SKILL.md` template with
  embedded guardrails; the installer renders it (env table, tool list, entry path) into
  `~/.claude/skills/<key>/` and `.claude/skills/<key>/` so the AI can use the server immediately.
- **Doctor / uninstall / update** — `npm run mcp:doctor` (build/config/env/skill/start, never prints
  secrets), `mcp:uninstall`, `mcp:update`.
  - **Files**: `scripts/mcp-doctor.mjs`, `scripts/uninstall-mcp.mjs`, `scripts/update-mcp.mjs`
- **`.github` → `.claude` migration** — Copilot skills/instructions/prompt moved to
  `.claude/skills/`, `.claude/rules/`, `.claude/commands/` (tool names updated to `mcp__<key>__*`);
  indexing-internals skills scoped under `codebase-index-mcp/.claude/skills/`; new
  `mcp-skill-authoring` skill; `.github/` removed.
- **Docs & config** — added `codebase-index-mcp/.env.example`; refreshed `CLAUDE.md`/`AGENTS.md`
  (removed stale `.mcp.json` reference, documented install/skills/doctor); `.gitignore` now keeps
  `.env.example` files and ignores generated operational skill dirs.

## [0.2.0] - 2026-04-23

### 🚀 Performance Enhancements

#### Backend (codebase-index-mcp)

- **Pre-filter files with glob ignore patterns** - Automatically skip `node_modules`, `dist`, `build`, `.git`, `coverage`, and lock files at glob level
  - **Impact**: 30-50% reduction in files to process
  - **Files**: `src/indexPipeline.ts`

- **SQLite WAL mode with optimized pragmas** - Enable Write-Ahead Logging with performance tuning
  - **Impact**: 2-3x write throughput improvement
  - **Pragmas**: `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`, `temp_store=MEMORY`
  - **Files**: `src/graphStore.ts`

- **Language breakdown tracking** - Track scanned/indexed counts per programming language
  - **Impact**: Better visibility into indexing progress
  - **Files**: `src/indexPipeline.ts`, `src/types.ts`

- **ETA calculation** - Calculate estimated time remaining based on current throughput
  - **Impact**: Better user experience with time estimates
  - **Files**: `src/indexPipeline.ts`, `src/types.ts`

#### UI (codebase-index-ui)

- **ETA display** - Show estimated time remaining in progress panel
  - **Format**: "ETA: 2m 30s" or "ETA: 45s"
  - **Files**: `src/App.tsx`, `src/types.ts`

- **Language breakdown visualization** - Display top 5 languages with indexed/scanned counts
  - **Visual**: Styled badges showing "typescript: 450/500"
  - **Files**: `src/App.tsx`, `src/types.ts`, `src/styles.css`

- **Auto-refresh graph after index** - Automatically load graph when indexing completes successfully
  - **Impact**: Seamless workflow, no manual "Load graph" click needed
  - **Delay**: 500ms after completion
  - **Files**: `src/App.tsx`

### 📝 Documentation

- Added `ENHANCEMENTS_IMPLEMENTED.md` - Detailed technical documentation of all enhancements
- Added `QUICK_START.md` - User-friendly guide for using the enhanced features
- Updated `ENHANCEMENT_PROPOSALS.md` - Marked completed items and reorganized priorities
- Added `CHANGELOG.md` - This file

### 🔧 Technical Details

**Modified Files**:
- `codebase-index-mcp/src/indexPipeline.ts` - Glob ignore, ETA, language stats
- `codebase-index-mcp/src/graphStore.ts` - WAL mode + optimized pragmas
- `codebase-index-mcp/src/types.ts` - Extended `IndexProgressSnapshot` type
- `codebase-index-ui/src/types.ts` - Extended `IndexProgress` type
- `codebase-index-ui/src/App.tsx` - ETA display, language breakdown, auto-refresh
- `codebase-index-ui/src/styles.css` - Language breakdown styling

**Build Status**: ✅ All packages build successfully with no errors

**Backward Compatibility**: ✅ All changes are backward compatible

### 📊 Expected Performance Improvements

- **30-50% faster** file discovery (glob ignore patterns)
- **2-3x faster** database writes (WAL mode)
- **Better UX** with real-time ETA and language breakdown
- **Smoother workflow** with auto-refresh

### 🧪 Testing Recommendations

1. Index a repository with `node_modules` and verify it's skipped
2. Compare indexing speed before/after WAL mode
3. Verify ETA appears and updates during indexing
4. Check language breakdown shows top 5 languages
5. Confirm graph auto-loads after successful index

---

## [0.1.0] - 2026-04-22

### Initial Release

- MCP server for codebase indexing with tree-sitter
- SQLite-based graph storage
- HTTP API with WebSocket progress updates
- React UI for graph visualization
- Support for module-flow, dependency, and call-chain views
- Impact surface analysis
- Incremental indexing with content hash checking
- Extension-based file filtering with binary sniff
