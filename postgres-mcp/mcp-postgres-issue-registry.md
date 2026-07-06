# MCP Postgres — Issue & Verification Registry

Findings, defects, and verified behaviors for the `postgres-mcp` server
(`D:\1.SourceCode\mcp-local\postgres-mcp`), raised from consuming repos (primarily
`wec.communication-hub`). Each entry: Scenario · Tool/query · Expected vs actual · Impact ·
Resolution. Mirrors the format of `codebase-index-mcp/mcp-codebase-index-issue-registry.md`.

> Consuming repos document day-to-day usage in `CLAUDE.md` (PostgreSQL MCP Operations section) and
> the `postgres-mcp-operations` skill. This file tracks server behavior/config truth and gaps.

---

## PG-ENV-001 — Single environment disabled `compare_environments` / `data_diff`

- **Status:** fixed 2026-06-29 (config, not code) — a local `dev` environment was registered.
- **First observed:** 2026-06-29 (`list_environments` on the live server).
- **Scenario:** Cross-environment schema/data drift checks before deploy.
- **Tool/query:** `compare_environments(source, target)`, `data_diff(source, target, table)`.
- **Expected vs actual:** Expected two comparable envs. Actual: only `default` existed
  (`CH_DB_CONNECTION` → shared RDS `CommunicationHubDb`), so both tools — which require two distinct
  envs — could never run.
- **Root cause:** server env defined only the legacy single connection; no `PG_ENV_<NAME>` or
  `CH_APPSETTINGS_ROOTS` providing a second env. Note `appsettings.Development.json` points at the
  **same** RDS, and `appsettings.Staging.json`/`.ss.json` are tokenized CI placeholders
  (`#{DB_INSTANCE_HOST}#`) — none usable as a real second env.
- **Resolution:** provisioned a local Postgres (native PostgreSQL 17 on `127.0.0.1:5432`, role
  `admin`/`password`, db `CommunicationHubDb`, schema applied via `dotnet ef database update` — 47
  migrations, 19 tables) and registered it as `PG_ENV_DEV`. `compare_environments("default","dev")`
  initially had two envs (and surfaced real drift: RDS 24 tables vs dev's 19 EF-managed tables).
- **Update 2026-06-29:** superseded by the PG-SEC-001 reversal — `PG_ENV_DEV` now points at the same
  RDS as `default`, so the two envs are one database again and `compare_environments`/`data_diff` are
  no longer meaningful. Re-add a distinct `PG_ENV_<NAME>` (e.g. staging, or a fresh local DB) to make
  them useful again.
- **Update 2026-06-30:** topology changed again — `dev` is gone, and `PG_ENV_UAT` was registered
  pointing at a **genuinely distinct** RDS (`wecrm-uat-postgres…rds…/CommunicationHubDb`), separate
  from `default` (`sscrm-postgresql…`). `list_environments` now shows `default` (isDefault) + `uat`,
  both `["read","write"]`. So `compare_environments`/`data_diff` are meaningful again.
- **Update 2026-07-02 (correction — the "legacy non-EF-model objects" theory above was wrong):** now
  that PG-CMP-001's false-positive constraint noise is fixed, `compare_environments("default","uat")`
  shows the two schemas are almost entirely identical — `addedTables:[]`, only one genuinely
  `removedTables` entry (`public.embedding`), and only 4 tables with real column/index drift. None of
  the previously-"noisy" tables (`mcp_ops.audit_log`, `ai_conversations`, `chat_costs`, etc.) turned
  out to be legacy/non-EF objects unique to `default` — they exist identically on both sides and were
  only ever flagged due to the PG-CMP-001 bug. `schemaIdentical:false` between `default`/`uat` reflects
  a small amount of real, specific drift, not systemic legacy divergence.

## PG-SEC-001 — Shared RDS `default` was marked writable (latent write-to-prod risk)

- **Status:** fixed 2026-06-29 (config) — writes locked to `dev`; `default` demoted to read-only.
- **First observed:** 2026-06-29 (`list_environments` → `default: capabilities ["read","write"]`).
- **Scenario:** Any future enabling of writes would target shared production-like RDS.
- **Root cause (confirmed in `src/config/environments.ts`):** `PG_WRITABLE_ENVIRONMENTS` defaults to
  `["dev","staging","default"]` when unset, so the legacy `default` env is marked writable by default.
  The capability array is independent of the `PG_WRITE_ENABLED` feature flag.
- **Important nuance:** writes were **not actually live** — `PG_WRITE_ENABLED` was unset, so
  `writeConfig.enabled=false` and `write_preview`/`write_apply` would have refused with the feature
  disabled. The `["read","write"]` capability was a *latent* marking, not an active write path. The
  danger: turning on `PG_WRITE_ENABLED` without scoping `PG_WRITABLE_ENVIRONMENTS` would expose RDS.
- **Resolution:** set `PG_WRITABLE_ENVIRONMENTS=dev` (RDS `default` → `["read"]`), enabled writes
  with `PG_WRITE_ENABLED=true` scoped to the `dev` env only, and `PG_DEFAULT_ENVIRONMENT=default`
  so casual reads land on the read-only RDS and writes must name `environment:"dev"` explicitly.
  `prod` is force-demoted to read-only unconditionally by the server regardless of config.
- **Update 2026-06-29 (decision reversed by user):** `PG_ENV_DEV` was repointed from the local
  Postgres to the **shared RDS** (the team uses the RDS as their working/dev DB; maintaining a
  separate local DB was not wanted). The local-DB isolation is therefore **lifted** — `dev` and
  `default` now resolve to the same RDS, so `write_apply`/`migration_apply` on `dev` commit to shared
  data. Residual mitigations: `default` stays read-only (write requires an explicit `environment:"dev"`
  opt-in) and the preview→apply→rollback / migration dry-run gates remain. This is an accepted risk,
  not a defect. To re-isolate, point `PG_ENV_DEV` back at a non-shared DB.
- **Update 2026-07-02 (stale — topology moved on again, live-verified via `list_environments`):** `dev`
  no longer exists as an environment at all (superseded by the PG-ENV-001 2026-06-30 topology change —
  `uat` replaced it as the genuinely-distinct env). The residual mitigation described above ("`default`
  stays read-only; write requires an explicit `environment:"dev"` opt-in") **no longer holds**: live
  config (`PG_WRITABLE_ENVIRONMENTS=default,uat`) and a live `list_environments` call both confirm
  `default` — the shared, prod-like `sscrm-postgresql` RDS — now has `capabilities:["read","write"]`
  directly, with no alias indirection to opt into. This is a deliberate config choice, not a code
  regression, but readers should not rely on the older "`default` is read-only" framing above; the only
  remaining protections on `default` are the preview→apply→rollback gate (writes) and
  dry-run/drift-guard (migrations) — see PG-MIG-003 for a live example of why the migration side of that
  gate still matters.

## PG-DOC-001 — `postgres-mcp-operations` skill stale on write gating & approval secret

- **Status:** fixed 2026-06-29 (docs) — skill + new CLAUDE.md section reconciled with source.
- **Scenario:** Following the skill's gating guidance.
- **Expected vs actual:** Skill claimed (a) `default` is read-only, (b) a **two-layer** gate where
  `PG_WRITE_APPROVAL_SECRET` is **mandatory** and the server fails fast (`APPROVAL_SECRET_REQUIRED`)
  without it. Both are **stale**:
  - `default` was actually marked writable (see PG-SEC-001).
  - `src/write/approval.ts:resolveApprovalSecret` **auto-generates** a strong random per-process
    secret when `PG_WRITE_APPROVAL_SECRET` is unset. The only write "on switch" is `PG_WRITE_ENABLED`.
    Consequence: approval tokens are in-memory and **per-process — they do not survive a server
    restart**; a `previewId`/`approvalToken` from before a restart will fail verification.
- **Resolution:** corrected the skill and added a verified gating section to CLAUDE.md.

## PG-CMP-001 — `compare_environments` flags `constraintChanged:true` on (nearly) every table

- **Status:** fixed 2026-07-02 (code) — `src/migration/schemaSnapshot.ts` now sources constraints
  from `pg_constraint`/`pg_get_constraintdef` and diffs by semantic definition instead of by name.
- **First observed:** 2026-06-30, `compare_environments(source:"default", target:"uat")` after applying
  a migration to `uat`.
- **Scenario:** Post-migration drift check between two real, distinct RDS envs (see PG-ENV-001 update).
- **Tool/query:** `compare_environments("default","uat")`, `profile:"compact"`.
- **Expected vs actual:** Expected `constraintChanged` only on tables whose constraints genuinely
  differ. Actual: **`constraintChanged:true` on all 23 `changedTables`** — including `__EFMigrationsHistory`,
  and `email_signatures` which is defined identically on both sides (created from the same EF model).
  The systematic, every-table nature points to a comparison artifact, not real drift.
- **Likely root cause (unconfirmed):** constraint comparison is sensitive to representation rather than
  semantics — e.g. comparing `pg_get_constraintdef` / catalog text without normalizing whitespace,
  argument casts (`(x)::text = ANY ((ARRAY[...])::text[])`), constraint **ordering**, or auto-generated
  constraint names that differ per server. Two servers built at different times/PG minor versions can
  render semantically identical CHECKs differently.
- **Impact:** The top-level `schemaIdentical:false` and the per-table `constraintChanged` flags are
  unreliable as a go/no-go signal; a human must ignore the blanket constraint noise and inspect
  `addedColumns`/`removedColumns`/`changedColumns` instead. Erodes trust in the tool's headline verdict.
- **Confirmed root cause (2026-07-02, proven, not just hypothesized):** the old query sourced
  constraints from `information_schema.table_constraints`, which synthesizes a pseudo `CHECK` row
  for every `NOT NULL` column, auto-named `{schema_oid}_{table_oid}_{column_position}_not_null`.
  This name embeds the **table's OID**, which differs between any two independently-created Postgres
  databases by definition — e.g. `email_signatures` had identical real constraints
  (`pk_email_signatures` / `PRIMARY KEY (id)`) on both `default` and `uat`, verified via
  `pg_get_constraintdef`, yet `information_schema.table_constraints` returned 8 differently-named
  synthetic rows per side (`2200_420095_*_not_null` vs `2200_29786_*_not_null`) purely because the
  table OIDs differ. The old code compared these name-bearing strings via `JSON.stringify` equality,
  guaranteeing a false `constraintChanged:true` on any table with a `NOT NULL` column — i.e. nearly
  every table, on any two servers, regardless of real drift.
- **Fix (2026-07-02):** `captureSchema` in `src/migration/schemaSnapshot.ts` now queries
  `pg_constraint` joined to `pg_class`/`pg_namespace`, fetching `pg_get_constraintdef(oid, ...)` for
  the real definition (initially `pretty=true`; **switched to `pretty=false` by PG-REV-001 item 9**
  below — this description was left stale until this correction). `pg_constraint` has **no row at all**
  for column-level `NOT NULL` in Postgres
  12+ (it's just the `attnotnull` flag on `pg_attribute`, already tracked separately via
  `ColumnInfo.isNullable`/`changedColumns`), so the synthetic rows are excluded by construction —
  this isn't just added normalization, it removes the false-positive source entirely.
  `diffSnapshots` now compares constraints by a normalized `type:definition` key (never by name) and
  surfaces `addedConstraints`/`removedConstraints` (semantic diffs) on `changedTables`, replacing the
  previous unexplained boolean.
- **Verified live (2026-07-02) against `default` vs `uat`:** self-compare (`default` vs `default`)
  still returns `schemaIdentical:true` (non-regression). Cross-compare (`default` vs `uat`) dropped
  from **23/23 `changedTables` flagged `constraintChanged:true`** to **0/4** — `email_signatures` and
  `__EFMigrationsHistory` no longer appear in `changedTables` at all (no real drift), while genuine
  drift on the remaining 4 tables (real `removedColumns`/`changedColumns`/`indexChanged`, e.g.
  `public.conversations` missing `country_id`/`created_at`/`dealer_id`/`email`/`last_msg_at`) still
  surfaces correctly. `indexes` comparison was left untouched — no evidence of false positives there
  (EF names indexes deterministically from the model) — noted as a residual risk if that assumption
  ever changes.

## PG-MIG-001 — `migration_status` reads 0-applied (and `migration_apply` would fail) on a DB whose `__EFMigrationsHistory` uses snake_case columns

- **Status:** closed 2026-07-02 (external, non-actionable) — confirmed postgres-mcp has zero code
  touching `__EFMigrationsHistory`; the tool only parses `dotnet ef`'s stdout. Non-standard column
  casing in that table is entirely a `dotnet ef`/EF Core design-time behavior, outside this server's
  code. Already contradicted once by direct evidence (see 2026-06-30 update below: `appliedCount:45`
  succeeded correctly). Live re-check today (`migration_status(environment:"default")`) again shows
  correct behavior (`pendingCount:3`, all three genuinely marked `(Pending)` in `raw`). No further
  action planned in this repo.
- **First observed:** 2026-06-30 on `default` (`sscrm-postgresql` RDS).
- **Scenario:** Checking applied vs pending migrations before a deploy.
- **Tool/query:** `migration_status(environment:"default")`.
- **Expected vs actual:** `default` is fully at the latest schema (all tables/columns/indexes present),
  yet `migration_status` reported **`appliedCount:0, pendingCount:2`** (both `DeployUatBaseline` and the
  new squash listed as pending). Its `__EFMigrationsHistory` has **snake_case columns**
  (`migration_id`, `product_version`) instead of EF's standard `"MigrationId"`/`"ProductVersion"`, so
  `dotnet ef` (which the tool shells out to) queries the standard names, finds nothing, and reports
  0 applied. (Confirmed: `SELECT "MigrationId" …` errors `column "MigrationId" does not exist`;
  `information_schema.columns` shows `migration_id`/`product_version`.)
- **Impact:** **Dangerous if trusted.** Acting on the 0-applied report — i.e. running `migration_apply`
  on `default` — would make `dotnet ef database update` attempt to apply ALL migrations and fail
  immediately on `CREATE TABLE … already exists` (or worse, partially run pre-table DML). The status
  output gives no hint that the history table is non-standard / unreadable by EF.
- **Suggested fix:** on `migration_status`/`migration_apply`, detect when `__EFMigrationsHistory` exists
  but has non-canonical column names (or 0 rows while user tables exist) and surface a clear warning
  (“history table column casing is non-standard — EF cannot read applied migrations; apply will likely
  fail”). Optionally support a configurable history-table column mapping.
- **Workaround in use:** treat `default` as already-migrated; only run migrations against `uat`
  (standard EF history, reads correctly: 1→2 applied as expected). Verify true schema state with
  `run_read_query` against `information_schema`, not `migration_status` alone.
- **Update 2026-06-30 (CONTRADICTED by direct evidence — likely misdiagnosis):** a later session on the
  same `default` RDS observed the OPPOSITE. `migration_status(environment:"default")` returned
  **`appliedCount:45, pendingCount:4`** (not 0), with a correct 45-id `applied` array, and a full
  `migration_dry_run` → `migration_preview` → `migration_apply` **succeeded**, applying two new index
  migrations and skipping all already-applied ones via the idempotent history guards. So `dotnet ef` on
  this project *does* read `default`'s history. The history table is `public."__EFMigrationsHistory"`
  with a **PascalCase table name but snake_case columns** (`migration_id`/`product_version`); the project
  is configured for snake-case history, so EF reads/writes those columns correctly. (Querying
  `"MigrationId"` errors precisely because the real columns are snake_case — that error is expected, not
  proof EF is blind.) **The real failure observed was a parser bug, not unreadable history — see
  PG-MIG-002.** Recommend re-scoping PG-MIG-001 to "non-standard history *column casing* is cosmetically
  confusing" rather than "EF reads 0 / apply will fail."

## PG-MIG-002 — `migration_status` mis-classifies migrations whose NAME contains "Pending" as pending

- **Status:** fixed 2026-07-02 (code) — classification now anchors to the literal trailing
  `(Pending)` marker instead of an unanchored substring match.
- **First observed:** 2026-06-30, `migration_status(environment:"default")`.
- **Scenario:** Checking applied vs pending before applying two new index migrations.
- **Tool/query:** `migration_status(environment:"default")`.
- **Expected vs actual:** Two old migrations `20260410031707_SyncPendingModelChanges` and
  `20260416041332_SyncPendingModelChanges_20260416` **are applied** — both are present in
  `__EFMigrationsHistory` (`SELECT migration_id … IN (…)` returns both) and `dotnet ef`'s own `raw`
  output does **not** append `(Pending)` to their lines. Yet the structured response put **all four**
  migrations in the `pending` array (those two + the two genuinely-pending `20260630…` index
  migrations) and reported `appliedCount:45, pendingCount:4` (should be `47`/`2`).
- **Root cause (high confidence):** the parser that splits `dotnet ef migrations list` output into
  applied vs pending detects "pending" by substring-matching the token **"Pending"** in the line —
  which also matches the migration **name** `SyncPendingModelChanges`. The authoritative marker is the
  trailing ` (Pending)` suffix `dotnet ef` appends, which in the `raw` field appears **only** on the two
  truly-pending ids.
- **Impact:** misleading `pending`/`pendingCount`. Here it manufactured a false alarm that
  `migration_apply` would replay two old table-creating migrations and fail on `CREATE TABLE … already
  exists`. In reality `migration_apply` applied **only** the two genuinely-pending migrations (idempotent
  history guards skipped the already-applied `SyncPendingModelChanges` ones) and verified cleanly. Net
  effect is wasted triage / unnecessary blocking, and it can mask the real pending count.
- **Fix (2026-07-02):** `handleMigrationStatus` in `src/migration/migrationHandlers.ts` now tests
  `/\(Pending\)\s*$/i` (anchored at end-of-line) instead of the unanchored `/pending/i`. Verified with
  a fabricated case: a line `"20260101000000_SyncPendingModelChanges"` (no trailing marker) now
  classifies as applied, while `"...(Pending)"` lines — including one whose migration name itself
  contains "Pending" — still classify as pending. No test framework exists in this package, so this
  was verified via an isolated `node -e` snippet, not a committed unit test. Live re-check against
  `default` (which currently has 3 genuinely-pending migrations, all correctly marked) shows no
  regression.
- **Not addressed (out of scope):** consuming a machine-readable format from `dotnet ef` (e.g.
  `--json`) instead of scraping human text remains a good follow-up if `dotnet ef` ever adds one, but
  wasn't necessary for this fix.

## PG-MIG-003 — Migration squashing invalidates `migration_status`'s ledger-based check (guidance, not a bug)

- **Status:** documented 2026-07-02 — workflow guidance only, no source change.
- **Scenario:** consolidating/squashing many old EF migrations into one baseline migration.
- **Issue:** `migration_status` (and `dotnet ef migrations list`) determines applied/pending by
  matching **migration IDs** against rows in `__EFMigrationsHistory`. A database migrated *before* a
  squash carries the old individual migration IDs in its history but will **never** have the new
  squashed migration's ID — even though its actual schema is already current. `migration_status`
  would misreport the new squashed migration as "pending" on an already-current database, and
  blindly trusting that to drive `migration_apply` would fail on "relation already exists" (or worse).
- **Recommendation:** after any migration squash, verify state with **schema-structural comparison**
  (`compare_environments`, see PG-CMP-001 — now trustworthy after the constraint-diff fix) and/or
  **`migration_dry_run`** (runs the idempotent script in a rolled-back transaction; each block
  self-guards on its own migration ID via `IF NOT EXISTS (... WHERE migration_id = '…')`, so it's safe
  to run regardless of squash state). Do **not** rely on `migration_status`'s applied/pending count
  across a squash boundary — it is fundamentally ID/ledger-based and doesn't survive a squash by
  design, not by defect.
- **Live-confirmed 2026-07-02 (this scenario is currently active on `default`, not just historical):**
  re-ran the full check live via MCP. `migration_status(environment:"default")` reports
  `appliedCount:0, pendingCount:3` (`DeployUatBaseline`, `migration_deploy_Uat_202606301548`,
  `migration_deploy_Uat_202607011448`) — but `run_read_query` against `public."__EFMigrationsHistory"`
  on `default` shows **49 genuinely-applied pre-squash migration rows** (`20260325103154_InitialCreate`
  through `20260630053144_RekeyOsbOpenThreadIndexByBookingMessageId`), none of which match the 3 new
  squashed IDs — exactly the ledger-ID mismatch this entry predicts, reproduced live rather than
  inferred. Confirmed the practical danger by actually calling `migration_dry_run(environment:"default")`
  (safe: rolled back, no schema change persisted): it **failed** with
  `error: relation "conversations" already exists` — i.e. `DeployUatBaseline`'s `CREATE TABLE` ran
  because its migration ID isn't in `default`'s history, colliding with the table already created under
  the old lineage. `compare_environments(default, uat)` confirms `default`'s real schema is already
  near-current (only `embedding` table + 4 tables' worth of real column drift vs `uat`, which does have
  all 3 squashed IDs applied cleanly — `migration_status(uat)` → `appliedCount:3, pendingCount:0`). Net:
  the guidance above is not just theoretical — `migration_apply(environment:"default")` would fail today
  exactly as described, and `default` is directly writable (see PG-SEC-001 2026-07-02 update), so this
  guard is live-load-bearing, not academic.

## PG-MIG-004 — `migration_status` now sources `dotnet ef migrations list --json` instead of scraping text

- **Status:** fixed 2026-07-02 (code) — `src/migration/efRunner.ts` (`efMigrationsListConnected`) and
  `src/migration/migrationHandlers.ts` (`handleMigrationStatus`). Discovered live, not from a prior
  report: a `/mcp` reconnect picked up a server rebuild mid-session and `migration_status`'s `raw` field
  changed shape (JSON array with `applied:true/false/null` per entry, instead of the old plain-text
  `id (Pending)` lines) — this closes the "not addressed" follow-up explicitly flagged in PG-MIG-002
  ("consuming a machine-readable format from `dotnet ef` (e.g. `--json`) ... remains a good follow-up").
- **What changed:** `efMigrationsListConnected` now runs `migrations list --json` (EF Core tools 3.0+)
  instead of `migrations list`. `handleMigrationStatus` `JSON.parse`s the result into
  `{id, name, safeName, applied}[]` and buckets by the structured `applied` boolean, replacing the
  regex classification PG-MIG-002 fixed (`/\(Pending\)\s*$/i`). A malformed/non-JSON response now throws
  `EF_OUTPUT_UNPARSEABLE` instead of silently misclassifying. This is strictly more robust than the
  regex approach: immune to CLI-locale translation of "(Pending)" and to any future change in where/how
  `dotnet ef` renders the marker in human text.
- **Verified live (2026-07-02, same session as the PG-MIG-003 re-verification above, non-regression):**
  `migration_status(environment:"default")` → `appliedCount:0, pendingCount:3`, `applied:[]`, `pending`
  lists the same 3 squashed IDs; `migration_status(environment:"uat")` → `appliedCount:3, pendingCount:0`
  with all 3 IDs `applied:true` in the raw JSON. Identical bucketing to the pre-rebuild text-scraping
  result obtained earlier in this session — the format change did not alter behavior, only its
  robustness.

## PG-DIF-001 — `data_diff` checksum vulnerable to representation-vs-semantics false positives (+ dead `keyColumns` param)

- **Status:** fixed 2026-07-02 (code) — `src/db/introspection.ts`.
- **Scenario:** found while auditing for the same bug class as PG-CMP-001 (comparing by representation
  instead of semantics) after that fix landed. Not reported by a consumer yet; found proactively.
- **Findings (all confirmed by reading `tableFingerprint`/`handleDataDiff`, not hypothesized):**
  1. **Dead parameter:** `keyColumns` was declared in the tool's zod schema and JSON `inputSchema`
     but never read anywhere in `handleDataDiff`/`tableFingerprint` — passing it silently did nothing.
  2. **TimeZone/float-precision false positives:** the checksum casts each row to `::text`
     (`row(...)::text`), whose rendering of `timestamptz` and `float4`/`float8` columns depends on the
     session's `TimeZone`/`extra_float_digits` GUCs. Two servers with byte-identical data but different
     defaults for those settings would produce different checksums and falsely report `identical:false`.
     Currently masked against `default`/`uat` only because both happen to run `TimeZone=UTC`,
     `extra_float_digits=1`, PG 17.9 — verified live via `pg_settings`.
  3. **Column-order (attnum) false positives:** when `columns` wasn't supplied, the code fell back to
     `t::text` (whole-row cast in physical storage order). A column dropped-and-re-added on one side
     (common after manual hotfixes) gets a new attnum, which would shift the physical column order and
     falsely report `identical:false` even with logically-identical data.
- **Fix:** `resolveDiffColumns` now always resolves an explicit, alphabetically-sorted column list —
  the caller-supplied `columns`, or (when omitted) the intersection of columns present on both sides,
  surfaced via new `columnsOnlySource`/`columnsOnlyTarget` response fields when the two tables' column
  sets differ. `tableFingerprint` now runs inside a read-only transaction with
  `set local time zone 'UTC'; set local extra_float_digits = 3` before computing the checksum, so
  identical data can no longer diverge due to per-server session defaults. `keyColumns` was removed
  from the tool schema rather than given real behavior (implementing genuine per-row keyed diffing —
  i.e. reporting *which* rows differ, not just whether the table differs — would be a larger feature;
  out of scope here).
- **Verified live (2026-07-02):** `data_diff(default, uat, email_signatures)` now returns a resolved
  `columns` array (previously `columns:null` when unspecified) and correctly reports `identical:false`
  with real `sourceCount:4`/`targetCount:1` (genuine data drift, not a false positive). Self-diff
  (`default` vs `default`) still returns `identical:true` with matching checksums (non-regression).
- **Not addressed (out of scope):** unbounded full-table scan (`string_agg` over every row, no
  sampling/paging) remains a cost/memory concern on very large tables — a correctness-neutral
  performance limitation, not fixed here. **Fixed in PG-DIF-002 below.**

## PG-DIF-002 — `data_diff` checksum used an O(n log n) sort + unbounded in-memory string on large tables

- **Status:** fixed 2026-07-02 (code) — `src/db/introspection.ts`, `tableFingerprint`.
- **Scenario:** follow-up on the PG-DIF-001 "not addressed" note — an exact-comparison tool inherently
  must scan every row on both sides (correct, unavoidable), but the checksum aggregate did more work
  than that scan required.
- **Root cause (confirmed by reading `tableFingerprint`):** the old aggregate was
  `md5(string_agg(md5(row(...)::text), '' order by md5(row(...)::text)))`. Two costs existed purely to
  make the aggregate order-independent, neither actually necessary: (1) `order by md5(...)` forces
  Postgres to sort every row's hash before aggregating — O(n log n), with `work_mem` disk spill on large
  tables; (2) `string_agg(...)` concatenates every row's 32-char MD5 hex digest into one in-memory text
  value — O(n) memory, a real OOM risk and a path toward Postgres's 1 GB `text` ceiling on large tables.
  Current table sizes in `default`/`uat` are small (max ~18k rows via `pg_class.reltuples`), so this
  hadn't caused an incident — a hardening fix ahead of scale, not a live outage.
- **Fix:** replaced the sort+concat aggregate with `sum()` of each row's hash, split into two 64-bit
  halves (so the full 128-bit MD5 digest still contributes, not just a truncated 64 bits) and cast to
  `numeric` before summing (avoids `bigint out of range` on high row counts — `sum(numeric)` has
  unlimited precision):
  ```sql
  sum(('x' || substr(md5(row(...)::text), 1, 16))::bit(64)::bigint::numeric)::text
    || ':' ||
  sum(('x' || substr(md5(row(...)::text), 17, 16))::bit(64)::bigint::numeric)::text
  ```
  wrapped in an outer `md5(...)` to keep the returned `checksum` shape unchanged. `sum()` is
  commutative/associative, so **no `ORDER BY` is needed at all** (zero added sort cost), and the query
  keeps only two numeric accumulators in memory regardless of table size (O(1) vs. the old O(n)). `sum`
  was chosen over `bit_xor` (available on PG16+, both `default`/`uat` run PG 17.9) specifically because
  XOR cancels to zero for any value repeated an even number of times — i.e. two tables with different
  content but the same even-multiplicity duplicate-row pattern could falsely checksum equal under XOR,
  which would defeat the tool's purpose. Sum doesn't have that structural weakness.
- **Verified live (2026-07-02):** the `('x'||hex)::bit(64)::bigint` idiom confirmed to work at runtime
  (not just as a literal) against `public.email_signatures`. After rebuilding and reconnecting the MCP
  server, cross-checked the tool's live checksum against the same SQL run manually via
  `run_read_query` — exact match, confirming the new code path is what's executing. Self-diff
  (`default` vs `default`) still `identical:true`, checksum stable across repeated calls (proves genuine
  order-independence, not incidental stability). Cross-diff (`default` vs `uat`) still correctly reports
  the same genuine drift as before (`identical:false`, `sourceCount:4`/`targetCount:1`) — no new false
  positive/negative introduced. `run_read_query(explain:true)` on the new query shape shows a plain
  `Aggregate` directly over a `Seq Scan`, with **no `Sort` node** — confirming the removed cost.
- **Not addressed (accepted, inherent to the tool):** the full sequential scan itself is not eliminated
  (nor should it be — sampling would break the tool's exact-equality guarantee). No row-count/size
  advisory was added; current environments are far from a scale where this matters, and adding a
  threshold/config knob wasn't justified without a concrete need.

## PG-REV-001 — Code-review sweep of PG-DIF-001/002/PG-CMP-001 changes (8-angle review, 10 confirmed fixes)

- **Status:** fixed 2026-07-02 (code) — `src/db/introspection.ts`, `src/migration/schemaSnapshot.ts`,
  `src/migration/migrationHandlers.ts`, `src/migration/efRunner.ts`, `src/write/writeHandlers.ts`,
  `src/index.ts`.
- **Scenario:** ran an 8-angle finder + 1-vote verifier review over the uncommitted diff from the
  PG-CMP-001/PG-DIF-001/PG-DIF-002 fixes. 21 candidates found, 2 refuted (dead-connection-to-pool —
  `pg-pool` already destroys clients whose socket died; unbounded-scan timeout — `ConnectionManager`
  already sets a pooled `statement_timeout`), 10 confirmed/plausible fixed below.
- **`data_diff` (`src/db/introspection.ts`):**
  1. Missing table (both sides) previously fell through to a misleading `NO_COMPARABLE_COLUMNS`
     ("no common columns") error. `resolveDiffColumns` now checks for zero columns on either side
     first and throws `TABLE_NOT_FOUND` naming which side(s) lack the table.
  2. An explicit `columns` request with a typo'd or one-side-only name previously surfaced as a raw
     Postgres `42703` from inside the checksum query. Requested columns are now validated against
     both sides' column sets up front, throwing a clear `UNKNOWN_COLUMN` error; the input array is
     also no longer mutated in place (`[...requestedColumns].sort()`).
  3. When `columns` was omitted and the two tables' column sets differed, the checksum silently
     covered only the intersection while the response still said `identical:true` — a side-only
     column full of divergent data was invisible to the headline verdict. Added a `columnsMismatch`
     field; `identical` is now forced `false` whenever it's `true`, since a partial-column comparison
     can't honestly claim full identity.
  4. GUC canonicalization (from PG-DIF-001) only covered `TimeZone`/`extra_float_digits`; `DateStyle`,
     `IntervalStyle`, `bytea_output`, and `lc_monetary` also affect `row(...)::text` rendering and
     were left uncanonicalized. All six are now set inside the checksum transaction.
  5. The checksum SQL called `md5(row(...)::text)` twice (once per 64-bit half) — doubling the
     per-row cost of the scan. Now computed once in a derived subquery and reused for both halves.
  6. Transaction setup was 4 sequential awaited round trips (`begin`, `set transaction read only`,
     2× `set local`). Combined into a single multi-statement round trip (safe here — no bind params).
  7. The inline `client.query("rollback").catch(() => {})` duplicated an existing `safeRollback`
     helper (previously private, duplicated once already between `src/index.ts` and
     `src/write/writeHandlers.ts`). Exported it from `writeHandlers.ts` and reused it in all three
     places, removing the third copy instead of adding a fourth.
- **`compare_environments` (`src/migration/schemaSnapshot.ts`):**
  8. The `pg_constraint` query added in PG-CMP-001 had no `contype` filter. PostgreSQL 18 catalogues
     NOT NULL as a real `pg_constraint` row (`contype 'n'`, not in `CONSTRAINT_TYPE_LABELS` — already
     double-tracked via `ColumnInfo.isNullable`), and constraint triggers (`'t'`) are also constraints
     in that catalog. Comparing a PG18 server against an older one would report spurious drift on
     every NOT NULL column. Query now filters `contype = any(array['p','f','u','c','x'])`.
  9. `pg_get_constraintdef(oid, true)` (pretty-printed) is documented by Postgres as not guaranteed
     stable/comparable across versions (`pg_dump` deliberately uses the non-pretty form for this
     reason); whitespace normalization alone can't bridge parenthesization/cast-rendering
     differences a cross-version comparison could hit. Switched to `pg_get_constraintdef(oid, false)`.
  10. Constraint identity (`type:definition`, name-insensitive — the PG-CMP-001 fix) was compared as
      a `Set`, so two constraints with the same definition under different names (Postgres allows
      this) collapsed to one entry — dropping one of them was invisible to the diff. Now compared as
      a multiset (occurrence counts), so multiplicity changes are caught while names are still
      ignored.
- **`migration_status` (`src/migration/migrationHandlers.ts`, `src/migration/efRunner.ts`):** the
  `/\(Pending\)\s*$/i` marker match (from PG-MIG-002) assumes English `dotnet ef` output; EF Core
  tools ship localized satellite resources, so a non-English CLI locale would render a translated
  marker and misclassify every pending migration as applied. `dotnet ef migrations list --json` has
  been available since EF Core tools 3.0 (verified live: `{id, name, safeName, applied}` per entry) —
  the registry's own PG-MIG-002 note ("if `dotnet ef` ever adds one") was factually wrong. Switched to
  `--json` and parse structurally; `applied` (not `applied === true`) drives the pending/applied split,
  so an unexpected `null` is treated as pending rather than silently assumed applied. The regex is
  gone entirely.
- **`handleMigrationApply`'s `schemaChanged` field:** derived from `!diff.identical` (name-insensitive)
  while `preSnapshotId`/`postSnapshotId` are name-sensitive (the hash includes constraint names, kept
  for the preview→apply drift guard, which correctly must catch a same-DB rename as drift). A
  rename-only change could report `schemaChanged:false` next to two different snapshot IDs. Now
  derived from `preSnapshotId !== postSnapshotId` directly, so it can never contradict the IDs shown
  beside it.
- **Not fixed (accepted trade-off, not a regression):** compare_environments' semantic (name-insensitive)
  constraint diff means a rename-only change between two *different* environments (e.g. a foreign key
  manually recreated under a new name on `uat`) is invisible to `compare_environments` — this is the
  deliberate, necessary cost of the PG-CMP-001 fix (auto-generated names differing per server was the
  original 23/23 false-positive bug); reintroducing name-sensitivity there would regress PG-CMP-001.
  The `schema://<env>` MCP resource's raw `TableSnapshot` JSON shape also changed (`constraints`
  went from `string[]` to `ConstraintInfo[]` objects) as an unavoidable consequence of PG-CMP-001 —
  no in-repo consumer exists, and no external consumer is documented.
- **Verified live (2026-07-02):** `data_diff` against a nonexistent table now returns
  `TABLE_NOT_FOUND` (was a misleading `NO_COMPARABLE_COLUMNS`); against an invalid explicit column
  now returns `UNKNOWN_COLUMN` (was a raw Postgres error); self-diff (`default` vs `default`) still
  `identical:true` with `columnsMismatch:false` (non-regression); cross-diff (`default` vs `uat`,
  `email_signatures`) still correctly reports genuine drift. `migration_status(default)` via the new
  `--json` path returns the same `pendingCount:3` as before (non-regression), now with structured
  `raw` JSON. `compare_environments` self-diff still `schemaIdentical:true`; cross-diff (`default` vs
  `uat`) still reports the same 4 genuinely-changed tables with `constraintChanged:false` (no new
  noise from the `contype` filter or `pretty=false` switch — non-regression).

## PG-PRV-001 — `migration_preview` response too large (~50 KB), ignores `profile`, forces file-dump + manual token extraction

- **Status:** fixed 2026-07-06 — reported same day from `wec.communication-hub` (consumer-side observation).
- **First observed:** 2026-07-06, applying a single-column migration (`migration_deploy_Uat_202607061454`,
  adds `outbox_outbound_message.trace_parent varchar(55) NULL`) to `uat`.
- **Scenario:** normal `dry_run → preview → apply` flow; preview is called only to obtain the
  `previewId`/`approvalToken` needed by `migration_apply`.
- **Tool/query:** `migration_preview(environment:"uat", profile:"standard")`, then retried with
  `profile:"compact"`.
- **Expected vs actual:** expected a compact payload (ids/token/expiry + the *pending* SQL delta).
  Actual: **50,277 characters on a single line, both times** — the MCP client rejected it
  (`exceeds maximum allowed tokens`) and dumped it to a tool-results file. `profile:"compact"` produced
  the **identical 50,277-char size** as `standard`, i.e. `profile` has no effect on preview size.
- **Root cause (high confidence, from inspecting the dumped payload):** the response embeds the full
  **idempotent** migration script in `script` — every migration regenerated and guarded with
  `IF NOT EXISTS(SELECT 1 FROM "__EFMigrationsHistory" WHERE "migration_id"='…')`, including the large
  `DeployUatBaseline` `CREATE TABLE`/index statements — even though only one tiny column is actually
  pending. The pending delta was ~2 lines; the other ~50 KB is already-applied baseline DDL that will
  be skipped by its own guards at apply time. Keys present: `previewId`, `approvalToken`,
  `preSnapshotId`, `script`, `expiresAt`.
- **Impact:** every migration preview on a project with a non-trivial baseline overflows the token
  budget and can't be read inline; the consumer must shell out (python/jq on the dumped file) just to
  extract `previewId`+`approvalToken`. Turns a one-call step into a file-parse workaround on every apply.
- **Suggested fix:** (a) make `profile:"compact"/"nano"` return only `{previewId, approvalToken,
  expiresAt, preSnapshotId}` plus the **net pending SQL** (the delta that isn't already guarded-out),
  omitting the full idempotent `script`; (b) or expose the full script via the `preSnapshotId`/a
  separate fetch (or the `schema://<env>` resource pattern) instead of inlining it; (c) at minimum,
  emit the SQL multi-line rather than one 50 KB line so partial reads are chunkable.
- **Fix (2026-07-06, followed suggestion (a)):** `handleMigrationPreview`
  (`src/migration/migrationHandlers.ts`) now runs `migrations list --json` (shared `listMigrations`
  helper, also used by `migration_status`) to find the last-applied migration, then generates a
  **non-idempotent delta** via new `efMigrationsScriptDelta` (`dotnet ef migrations script
  <lastApplied>`, `src/migration/efRunner.ts`) — only the truly-pending SQL. The response returns
  `{previewId, approvalToken, environment, preSnapshotId, pendingCount, pendingMigrations,
  pendingScript, expiresAt}` at all profiles; the full idempotent `script` is generated + included
  **only at `profile:"verbose"`** (omitted elsewhere via `undefined`, dropped by `JSON.stringify`).
  Default profile changed `standard` → `compact` (aligns with every other read tool). The approval
  digest now binds the **pending delta** instead of the full idempotent script — more accurate, since
  `migration_apply` runs `dotnet ef database update` (exactly the pending set) and the real
  correctness check is the `preSnapshotId` drift guard. When nothing is pending, preview short-circuits
  to `{status:"no_pending"}` and mints no token (mirrors `migration_dry_run`). `fromMigration` is
  validated (`sanitizeMigrationId`, `^\d+_[A-Za-z0-9_]+$`) as arg-injection defense-in-depth even
  though it comes from EF's own JSON. Suggestion (c) is moot — a JSON string can't carry literal
  newlines, and the delta is now small enough to read inline. `migration_apply`/`migration_dry_run`
  unchanged. Typecheck + build pass. PG-PRV-002 (token TTL vs human-approval race) is a separate,
  still-open issue.

## PG-PRV-002 — Approval-token TTL (~15 min, in-memory) races against the human-approval gate on `migration_apply`

- **Status:** fixed 2026-07-06 — reported same day; design/UX suggestion, interacts with PG-DOC-001 token semantics.
- **Scenario:** `migration_apply` against the shared, prod-like `uat` RDS is (correctly) gated behind an
  explicit human confirmation — in this session the Claude Code auto-mode classifier blocked the first
  `migration_apply` as a "production deploy" and required the user to approve before it could run.
- **Tool/query:** `migration_preview(uat)` → [blocked `migration_apply`, wait for human "apply đi"] →
  `migration_apply(uat, previewId, approvalToken)`.
- **Expected vs actual:** expected the previewed plan to still be applyable after the human approves.
  Actual: the approval token TTL is ~15 min and per-process (see PG-DOC-001 / Verified-working notes),
  so a preview generated *before* asking the human can expire *during* the wait — forcing a second
  `migration_preview` (which, per PG-PRV-001, re-dumps ~50 KB) purely to mint a fresh token. Observed
  here: preview `expiresAt` 08:24:10Z / 08:25:51Z; had to regenerate the preview after user confirmation.
- **Impact:** the two safety mechanisms compound into friction — a flow that is *designed* to pause for
  human review uses a token that assumes no pause. Every human-gated apply risks a wasted
  preview→expire→re-preview cycle (each re-preview being the 50 KB PG-PRV-001 payload).
- **Suggested fix:** for migration previews specifically, either (a) lengthen the TTL (or make it
  configurable) to accommodate a human-in-the-loop approval, or (b) let `migration_apply` re-validate
  against the `preSnapshotId` digest / re-run the drift guard instead of a hard time-boxed token, so an
  expired token can be transparently refreshed as long as the schema hasn't drifted since preview. The
  drift guard already exists and is the real correctness check; the TTL is the redundant blocker here.
- **Fix (2026-07-06, both (a) and (b)):** `migration_apply` now makes the **drift guard the
  authoritative freshness check** and no longer hard-fails on the token's time-box. `verifyApprovalToken`
  (`src/write/approval.ts`) gained an `options.ignoreExpiry` flag; `handleMigrationApply` passes
  `{ignoreExpiry:true}` and the redundant `PREVIEW_EXPIRED` (`preview.expiresAt < now`) throw was
  removed. So within the preview record's in-memory lifetime, a human-gated approval can pause as long
  as needed and apply still succeeds **iff** the live schema still matches `preSnapshotId` (else
  `MIGRATION_DRIFT` → re-preview). No security loss: the token is still HMAC-signed and bound to
  `previewId + digest` (digest = env+preSnapshotId+pendingScript), so an old token can only apply the
  exact previewed plan against an unchanged schema — the TTL was a redundant staleness lever, not a
  security control. **`write_apply` is untouched** — it calls `verifyApprovalToken` with no options
  (strict expiry preserved), because data writes have no drift guard and their digest binds
  `rowsAffected`. Fix (a) too: migration record lifetime is now a **separate, longer, configurable**
  `PG_MIGRATION_PREVIEW_TTL_MS` (default 3_600_000 = 1h) instead of sharing the 15-min
  `PG_WRITE_PREVIEW_TTL_MS`; this bounds how long the record survives (memory) — freshness is the drift
  guard's job. `PREVIEW_NOT_FOUND` (record swept after the TTL, or server restart) still forces a fresh
  preview. Typecheck + build pass.
- **Post-review hardening (2026-07-06, high-effort code review of the PRV-001/002 diff):**
  1. **Non-contiguous pending set (correctness):** `applied.at(-1)` assumed applied migrations are a
     contiguous chronological prefix. With out-of-order application (branch merges: a pending migration
     whose id sorts *before* an already-applied one), `dotnet ef migrations script <lastApplied>` would
     omit that earlier-id pending migration from `pendingScript` while `database update` still applied it.
     `handleMigrationPreview` now detects contiguity from the EF-ordered `entries` (`listMigrations` now
     returns them) and **falls back to the idempotent full script** when non-contiguous — the only correct
     representation of a non-contiguous subset (no `script <from>` range can express it).
  2. **Stale-record leak (correctness):** `sweepExpiredMigrationPreviews()` ran *after* the `no_pending`
     early return, and apply no longer evicts on expiry, so on an env with nothing pending the only sweep
     site was skipped and records leaked (and, with `ignoreExpiry`, stayed applicable indefinitely). Sweep
     now runs at the top of `handleMigrationPreview`, before any early return.
  3. **Pending-set drift (correctness):** the snapshot drift guard only catches *schema* changes; a
     migration `migration_add`-ed between preview and apply leaves the schema untouched, so `database
     update` would apply un-previewed migrations. `handleMigrationApply` now stores `pendingMigrations` in
     the preview record and re-checks it at apply (alongside the schema guard) → `MIGRATION_DRIFT` if the
     set changed.
  4. **Cleanups:** dropped the never-read `script` field from `MigrationPreviewRecord`; parallelized the
     independent `captureSchema` + `listMigrations` calls (both preview and apply) and the delta + verbose
     full-script invocations via `Promise.all`. Typecheck + build pass.

## PG-STA-001 — `migration_status.raw` duplicates parsed arrays as an escaped JSON blob even at `profile:"compact"`

- **Status:** fixed 2026-07-06 — reported same day; low priority / nice-to-have.
- **Scenario:** routine `migration_status` before a deploy.
- **Tool/query:** `migration_status(environment:"uat", profile:"compact")`.
- **Expected vs actual:** expected compact profile to trim redundant fields. Actual: the response
  returns `appliedCount`/`pendingCount`/`applied[]`/`pending[]` **and** a `raw` field that is the
  escaped-JSON `dotnet ef … --json` output (post PG-MIG-004) carrying the same id/applied data again —
  even under `profile:"compact"`. For a 4-migration project it's a few hundred wasted bytes; scales with
  migration count.
- **Impact:** minor token waste; the parsed arrays already carry everything a caller needs.
- **Suggested fix:** gate `raw` behind `profile:"verbose"` (drop it at `nano`/`compact`/`standard`);
  keep it available for debugging the parse.
- **Correction to the original report:** `raw` is the `dotnet ef migrations list --json` stdout, which
  lists **every migration in the project (working tree)** with `{id, name, safeName, applied}` per entry
  — so its weight scales with the **total migration-file count**, not the DB. On a squashed branch (~4
  migrations) it's only ~700 bytes; on a granular/un-squashed branch (~40) it's ~5 KB of pure duplication
  (`applied[]`/`pending[]` already carry every id). Worth trimming on the heavy branches.
- **Fix (2026-07-06):** added a `verboseOnly(value, profile)` helper (`src/migration/migrationHandlers.ts`)
  that returns the value only at `profile:"verbose"` and `undefined` elsewhere (dropped by
  `JSON.stringify` — same idiom as `migration_preview`'s full `script`). Applied to **all three** `raw`
  fields for tool-wide consistency: `migration_status`, `migration_add` (`ef migrations add` stdout), and
  `migration_apply` (`database update` stdout). `raw` is kept available at `verbose` for debugging the
  parse. Typecheck + build pass.

---

## Verified-working behaviors (confirmed against the live server / source, 2026-06-29)

- **SSL is per-connection via the URI `sslmode`, overriding global `PGSSLMODE`.** `parseConnection`
  (`src/config/environments.ts`) ignores SSL keys in the `Server=…;` (Npgsql) format, so SSL is
  controlled by `PGSSLMODE` for that format. A `postgresql://…?sslmode=disable` **URI** sets
  `ssl:false` explicitly (via `pg-connection-string`), which node-postgres honors over `PGSSLMODE`.
  Verified with a local DB: a `?sslmode=disable` URI connected even with `PGSSLMODE=require` set
  globally. (After the PG-SEC-001 reversal, `dev` points at the RDS with `?sslmode=require`, but the
  per-connection override remains the mechanism for ever re-adding a non-SSL local env.)
- **`run_read_query` is hard-sandboxed:** wrapped in `begin; set transaction read only; set
  statement_timeout; … rollback`. Always rolled back; `limit` capped at `MAX_LIMIT` (2000);
  `explain:true` returns the plan + `estimatedTotalCost` and never executes.
- **Write guardrails (`src/sql/writeGuardrails.ts`):** single statement only; DDL rejected (must go
  through migrations); `SELECT`/`WITH` rejected (use `run_read_query`); UPDATE/DELETE require a WHERE
  unless `allowFullTable:true`. Apply returns a `rollbackId`; rollback is capture-based.
- **Approval token:** HMAC over `{previewId, digest, expiresAt}`; digest binds env+sql+params+
  statementType+rowsAffected, so a token only applies the exact previewed plan. TTL default 900s.
- **Undocumented capability — `schema://<env>` MCP resource.** The server exposes one schema-snapshot
  resource per environment (`ListResources`/`ReadResource`), letting a client read full structure once
  instead of repeating `describe_table`. Not surfaced as a tool — a token saver worth using.
- **Migration tools** require `PG_MIGRATION_ENABLED=true` plus `CH_DOTNET_PROJECT` (Infrastructure,
  holds `ApplicationDbContext`) and `CH_DOTNET_STARTUP_PROJECT` (Web). `dotnet ef` must be on PATH
  (verified: EF Core 10.0.4 present).
- **Migration pipeline verified end-to-end against a real RDS (2026-06-30, `uat`).**
  `migration_dry_run` → `migration_preview` → `migration_apply` of one pending migration onto a DB
  already holding the baseline behaved correctly: the preview SQL guards **every** statement with
  `IF NOT EXISTS(SELECT 1 FROM "__EFMigrationsHistory" WHERE "migration_id" = '…')`, so the
  already-applied `DeployUatBaseline` blocks were skipped and only the pending squash ran; `apply`
  returned a real `preSnapshotId`/`postSnapshotId` + accurate `diff` (added/removed/changed columns,
  indexChanged, constraintChanged), and `migration_status` went `1→2` applied / `0` pending. The
  approval token TTL is ~15 min and per-process (consistent with PG-DOC-001) — preview+apply in one
  session. dry_run correctly executes in a rolled-back tx and caught nothing because the migration was
  valid.
